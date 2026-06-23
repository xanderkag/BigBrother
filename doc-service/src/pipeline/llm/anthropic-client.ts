/**
 * EXT-LLM-GATEWAY-ANTHROPIC: backend для llm-gateway, переводящий
 * OpenAI-compatible chat-completions request ↔ Anthropic native /v1/messages.
 *
 * Зачем отдельный клиент: текущий GatewayChatClient — passthrough к
 * OpenAI-compatible upstream (Ollama/vLLM на корп-GPU). Anthropic
 * native API имеет другую форму:
 *   - URL: https://api.anthropic.com/v1/messages, не /v1/chat/completions
 *   - Headers: x-api-key + anthropic-version, не Authorization
 *   - Request: system отдельным top-level полем (а не в messages[]),
 *     max_tokens обязательный, content в каждом сообщении может быть
 *     строкой или массивом блоков
 *   - Response: content[] массив блоков (`text` / `tool_use`), а не
 *     choices[].message
 *   - Tools: input_schema vs OpenAI parameters
 *
 * Что НЕ делает (MVP под пилот SLAI):
 *   - Streaming (SSE) — клиент Asha-шлюза всегда отвечает единым JSON
 *   - Vision (image content blocks) — добавим если SLAI попросит
 *   - Tool-use streaming с partial JSON — обычный tool_use поддерживается
 *   - Cache control (Anthropic prompt caching) — добавим в Phase 2 для
 *     экономии токенов
 */

import { request } from 'undici';
import { llmCallsTotal, llmCallDurationSeconds } from '../../metrics.js';
import { openAiError, type GatewayUpstreamResult } from './chat-client.js';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export type AnthropicChatClientOptions = {
  /** https://api.anthropic.com (без /v1) или совместимый прокси. */
  baseUrl: string;
  /** Anthropic API key (sk-ant-...). */
  apiKey: string;
  timeoutMs: number;
};

export class AnthropicChatClient {
  constructor(private readonly opts: AnthropicChatClientOptions) {}

  isAvailable(): boolean {
    return !!(this.opts.baseUrl && this.opts.apiKey);
  }

  /**
   * Принимает OpenAI chat.completion request body (с уже подменённым
   * `model` на Anthropic-tag) и возвращает OpenAI chat.completion response.
   * Внутри: translator → POST /v1/messages → translator обратно.
   */
  async chatCompletions(body: unknown): Promise<GatewayUpstreamResult> {
    const endpointLabel = 'gateway/anthropic-chat';
    const startedAt = Date.now();

    let anthropicReq: AnthropicMessagesRequest;
    try {
      anthropicReq = openAiToAnthropic(body as OpenAiChatRequest);
    } catch (err) {
      llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });
      return {
        ok: false,
        status: 400,
        body: openAiError(
          err instanceof Error ? err.message : 'invalid request shape',
          'invalid_request_error',
          'invalid_request',
        ),
        errorCode: 'invalid_request',
      };
    }

    const url = this.resolveUrl('/v1/messages');
    try {
      const res = await request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.opts.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(anthropicReq),
        headersTimeout: this.opts.timeoutMs,
        bodyTimeout: this.opts.timeoutMs,
      });

      const elapsed = (Date.now() - startedAt) / 1000;
      llmCallDurationSeconds.observe({ endpoint: endpointLabel }, elapsed);

      const status = res.statusCode;
      const raw = await res.body.text();
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });
        return {
          ok: false,
          status: status >= 400 ? status : 502,
          body: openAiError(
            `Anthropic returned non-JSON response (${status})`,
            'upstream_error',
            'upstream_bad_response',
          ),
          errorCode: 'upstream_bad_response',
        };
      }

      if (status >= 400) {
        llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });
        // Транслируем Anthropic-error в OpenAI-shape чтобы клиент видел
        // обычный {error:{message,type,code}}.
        return {
          ok: false,
          status,
          body: anthropicErrorToOpenAi(parsed, status),
          errorCode: 'upstream_error',
        };
      }

      llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'success' });
      const openAiResponse = anthropicToOpenAi(
        parsed as AnthropicMessagesResponse,
        anthropicReq.model,
      );
      return { ok: true, status, body: openAiResponse };
    } catch (err) {
      const elapsed = (Date.now() - startedAt) / 1000;
      llmCallDurationSeconds.observe({ endpoint: endpointLabel }, elapsed);
      llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });

      const isTimeout =
        err instanceof Error &&
        (err.name === 'HeadersTimeoutError' ||
          err.name === 'BodyTimeoutError' ||
          /timeout/i.test(err.message));
      const errorCode = isTimeout ? 'timeout' : 'network_error';
      return {
        ok: false,
        status: isTimeout ? 504 : 502,
        body: openAiError(
          isTimeout ? 'Anthropic API timed out' : 'Could not reach Anthropic API',
          'upstream_error',
          errorCode,
        ),
        errorCode,
      };
    }
  }

  /**
   * Embeddings: Anthropic не предоставляет embeddings endpoint в native API.
   * Шлюз возвращает 501 — клиент должен взять отдельный provider.
   */
  async embeddings(_body: unknown): Promise<GatewayUpstreamResult> {
    return {
      ok: false,
      status: 501,
      body: openAiError(
        'Anthropic backend does not provide embeddings. Configure a separate provider (OpenAI, Voyage) for embeddings.',
        'invalid_request_error',
        'embeddings_not_supported',
      ),
      errorCode: 'embeddings_not_supported',
    };
  }

  private resolveUrl(path: string): string {
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    return `${base}${path}`;
  }
}

// ─── Types: minimal subset we touch ──────────────────────────────────────

type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenAiContentBlock[] | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

type OpenAiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type OpenAiTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

type OpenAiChatRequest = {
  model: string;
  messages: OpenAiMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: OpenAiTool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
};

type AnthropicTextBlock = { type: 'text'; text: string };
type AnthropicToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};
type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string | AnthropicTextBlock[];
  is_error?: boolean;
};
type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

type AnthropicMessagesRequest = {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
};

type AnthropicMessagesResponse = {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

// ─── Translators ─────────────────────────────────────────────────────────

/**
 * OpenAI → Anthropic. Главные сложности:
 *   - system message в OpenAI лежит в messages[0] (или нескольких), в
 *     Anthropic — отдельный top-level `system` (склеиваем все system'ы).
 *   - tool/assistant с tool_calls в OpenAI — отдельные сообщения. В
 *     Anthropic — assistant.content[] с блоками tool_use, а tool result
 *     — это user.content[].tool_result.
 *   - max_tokens обязателен для Anthropic. Default 4096 если не задан.
 */
export function openAiToAnthropic(req: OpenAiChatRequest): AnthropicMessagesRequest {
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new Error('messages[] must be non-empty');
  }

  const systemParts: string[] = [];
  const anthropicMessages: AnthropicMessage[] = [];

  for (const msg of req.messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') {
        if (msg.content.trim().length > 0) systemParts.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === 'text' && b.text.trim().length > 0) systemParts.push(b.text);
        }
      }
      continue;
    }

    if (msg.role === 'user') {
      anthropicMessages.push({
        role: 'user',
        content: convertContent(msg.content) ?? '',
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: AnthropicContentBlock[] = [];
      const textContent = convertContent(msg.content);
      if (typeof textContent === 'string' && textContent.length > 0) {
        blocks.push({ type: 'text', text: textContent });
      } else if (Array.isArray(textContent)) {
        for (const b of textContent) {
          if (b.type === 'text') blocks.push(b);
        }
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let input: Record<string, unknown> = {};
          if (tc.function.arguments) {
            try {
              input = JSON.parse(tc.function.arguments);
            } catch {
              input = { _raw: tc.function.arguments };
            }
          }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }
      anthropicMessages.push({
        role: 'assistant',
        content: blocks.length > 0 ? blocks : '',
      });
      continue;
    }

    if (msg.role === 'tool') {
      // tool message → user.content[].tool_result. Если предыдущее
      // сообщение тоже tool — мерджим в один user.content[].
      const result: AnthropicToolResultBlock = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id ?? '',
        content:
          typeof msg.content === 'string'
            ? msg.content
            : msg.content && Array.isArray(msg.content)
              ? msg.content.flatMap((b) => (b.type === 'text' ? [{ type: 'text' as const, text: b.text }] : []))
              : '',
      };
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(result);
      } else {
        anthropicMessages.push({ role: 'user', content: [result] });
      }
      continue;
    }
  }

  const out: AnthropicMessagesRequest = {
    model: req.model,
    messages: anthropicMessages,
    max_tokens: req.max_tokens && req.max_tokens > 0 ? req.max_tokens : DEFAULT_MAX_TOKENS,
  };
  if (systemParts.length > 0) out.system = systemParts.join('\n\n');
  if (typeof req.temperature === 'number') out.temperature = req.temperature;
  if (typeof req.top_p === 'number') out.top_p = req.top_p;
  if (req.stop) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];

  if (Array.isArray(req.tools) && req.tools.length > 0) {
    out.tools = req.tools
      .filter((t) => t.type === 'function')
      .map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: (t.function.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} },
      }));
    if (req.tool_choice) {
      if (req.tool_choice === 'auto') out.tool_choice = { type: 'auto' };
      else if (req.tool_choice === 'required') out.tool_choice = { type: 'any' };
      else if (req.tool_choice === 'none') {
        // 'none' в Anthropic не имеет прямого аналога — просто убираем tools.
        delete out.tools;
      } else if (typeof req.tool_choice === 'object' && req.tool_choice.type === 'function') {
        out.tool_choice = { type: 'tool', name: req.tool_choice.function.name };
      }
    }
  }

  return out;
}

function convertContent(
  content: OpenAiMessage['content'],
): string | AnthropicContentBlock[] | null {
  if (content === null || content === undefined) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.flatMap((b) => {
      if (b.type === 'text') return [{ type: 'text' as const, text: b.text }];
      // image_url → Anthropic image block. MVP: пропускаем (vision добавим
      // отдельно, требует base64 или url scheme support).
      return [];
    });
  }
  return null;
}

/**
 * Anthropic → OpenAI response. Преобразуем content[] в либо message.content
 * (текст) либо message.tool_calls[] (если есть tool_use блоки).
 */
export function anthropicToOpenAi(
  res: AnthropicMessagesResponse,
  modelEcho: string,
): Record<string, unknown> {
  const textParts: string[] = [];
  const toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> = [];

  for (const block of res.content ?? []) {
    if (block.type === 'text') {
      textParts.push(block.text);
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  const finishReason =
    res.stop_reason === 'end_turn'
      ? 'stop'
      : res.stop_reason === 'max_tokens'
        ? 'length'
        : res.stop_reason === 'tool_use'
          ? 'tool_calls'
          : res.stop_reason === 'stop_sequence'
            ? 'stop'
            : 'stop';

  const message: Record<string, unknown> = { role: 'assistant' };
  if (textParts.length > 0) message.content = textParts.join('');
  else message.content = null;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: res.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelEcho,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: res.usage?.input_tokens ?? 0,
      completion_tokens: res.usage?.output_tokens ?? 0,
      total_tokens: (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0),
    },
  };
}

function anthropicErrorToOpenAi(
  parsed: unknown,
  status: number,
): { error: { message: string; type: string; code: string } } {
  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    const e = (parsed as { error?: { message?: string; type?: string } }).error;
    if (e && typeof e === 'object') {
      return openAiError(
        e.message ?? `Anthropic error (${status})`,
        e.type ?? 'upstream_error',
        e.type ?? 'upstream_error',
      );
    }
  }
  return openAiError(`Anthropic error (${status})`, 'upstream_error', 'upstream_error');
}
