import { readFile } from 'node:fs/promises';
import { request } from 'undici';
import type {
  LlmClient,
  LlmClassifyResult,
  LlmCatalogClassifyInput,
  LlmCatalogClassifyResult,
  LlmExtractResult,
  LlmVerifyResult,
  LlmVisionResult,
} from './types.js';
import type { DocumentTypeSlug } from '../../types/documents.js';
import { llmCallDurationSeconds, llmCallsTotal } from '../../metrics.js';
import { addLlmUsage, type LlmCallUsage } from './usage-context.js';

export type HttpLlmClientOptions = {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  /**
   * Per-request model override. Если задан — клиент кладёт его в body
   * каждого вызова `{model: "phi4"}`, и inference-service.openai_compatible
   * подменит свой default из env на эту модель. Используется когда
   * `provider_settings.model` отличается от default'а — позволяет роутить
   * разные документы в Phi-4 / Gemma / Mistral / etc через один и тот же
   * inference-service контейнер без рестарта.
   *
   * Для backends с фиксированной моделью (claude/qwen_vl/stub) этот
   * параметр игнорируется на стороне inference-service.
   */
  model?: string;
  /**
   * Vision-capability этого провайдера (из provider_settings.vision).
   * Когда true, orchestrator может попросить extract из изображения
   * (передав `imagePath`). См. LlmClient.supportsVision.
   */
  vision?: boolean;
  /**
   * Per-provider knob для reasoning/thinking-моделей (provider_settings.extra.reasoning_effort).
   * Если задан — клиент кладёт его в body каждого вызова `{reasoning_effort: "none"}`,
   * inference-service пробрасывает в OpenAI-compat backend, и Ollama-шим
   * подавляет hidden reasoning-токены (qwen3.6: ~110s → ~7s, JSON остаётся
   * в message.content). Для не-reasoning моделей (phi4 и т.п.) row.extra
   * этого ключа не содержит, и поведение не меняется.
   */
  reasoningEffort?: string;
  /**
   * VANGA-LLM-2: per-request backend для inference-service
   * (provider_settings.extra.backend). "stub"|"claude"|"openai"|
   * "openai_compat"|"qwen". Если задан — клиент кладёт его в body каждого
   * вызова, и inference-service резолвит этот backend per-request вместо
   * своего env-синглтона. Позволяет разным инстансам быть в разных
   * режимах (cloud/local/gpu) без рестарта inference-service. Не задан →
   * inference использует env-дефолт (поведение как раньше).
   */
  backend?: string;
  /**
   * VANGA-LLM-2: per-request upstream endpoint для openai_compat-backend
   * (provider_settings.extra.upstream_base_url). Например один инстанс →
   * локальный Ollama, другой → GPU-vLLM. Уходит в body как `base_url`.
   * Не путать с `baseUrl` выше — тот адресует сам inference-service.
   */
  upstreamBaseUrl?: string;
};

export class HttpLlmClient implements LlmClient {
  constructor(private readonly opts: HttpLlmClientOptions) {}

  isAvailable(): boolean {
    return !!this.opts.baseUrl;
  }

  async supportsVision(): Promise<boolean> {
    return this.opts.vision === true;
  }

  /**
   * Проставляет per-request overrides в body:
   *   - `model` — provider_settings.model (ollama-tag).
   *   - `reasoning_effort` — knob для reasoning-моделей (qwen3.6). Пробрасываем
   *     во ВСЕ вызовы, чтобы provider был быстрым на любом hop'е.
   *   - `backend` + `base_url` — VANGA-LLM-2, cloud/local/gpu switch без
   *     рестарта inference. Оба опц; без них inference берёт свой env-дефолт.
   *   - `api_key` — MTI-3 (2026-07-08): унифицированная передача LLM-ключа.
   *     inference через `resolve_backend()` поднимает ephemeral SDK-клиент.
   *     Пока dual-write с `Authorization: Bearer` заголовком (back-compat),
   *     PR 2 разделит: Bearer → inter-service auth (INFERENCE_API_KEY),
   *     body.api_key → LLM-ключ. См. `MTI_TZ_2026-05-31.md` §3.1.
   *
   *   Все 5 полей — одной аллокацией через conditional-spread; None не
   *   попадает в JSON (undefined-поля пропускаются JSON.stringify).
   */
  private withModel<T extends Record<string, unknown>>(
    body: T,
  ): T & {
    model?: string;
    reasoning_effort?: string;
    backend?: string;
    base_url?: string;
    api_key?: string;
  } {
    return {
      ...body,
      ...(this.opts.model && { model: this.opts.model }),
      ...(this.opts.reasoningEffort && { reasoning_effort: this.opts.reasoningEffort }),
      ...(this.opts.backend && { backend: this.opts.backend }),
      ...(this.opts.upstreamBaseUrl && { base_url: this.opts.upstreamBaseUrl }),
      ...(this.opts.apiKey && { api_key: this.opts.apiKey }),
    };
  }

  async classify(text: string): Promise<LlmClassifyResult> {
    return this.post<LlmClassifyResult>('/v1/classify', this.withModel({ text }));
  }

  async classifyWithCatalog(
    input: LlmCatalogClassifyInput,
  ): Promise<LlmCatalogClassifyResult> {
    // catalog-режим /v1/classify: backend строит каталог-промпт и возвращает
    // {type: <slug|unknown|null>, confidence}. camelCase → snake_case на границе.
    const res = await this.post<{ type: string | null; confidence: number }>(
      '/v1/classify',
      this.withModel({
        text: input.text,
        catalog: input.catalog,
        ...(input.fileName ? { file_name: input.fileName } : {}),
        ...(input.keywordHint ? { keyword_hint: input.keywordHint } : {}),
        ...(input.maxTokens ? { max_tokens: input.maxTokens } : {}),
      }),
    );
    return { slug: res.type ?? null, confidence: res.confidence ?? 0 };
  }

  async extract(input: {
    text: string;
    schema: Record<string, unknown>;
    hint?: DocumentTypeSlug;
    promptOverride?: string;
    includeDebug?: boolean;
    imagePath?: string;
  }): Promise<LlmExtractResult> {
    // Inference-service ожидает snake_case (Python convention).
    // Перекладываем camelCase → snake_case на сетевой границе.
    const { promptOverride, includeDebug, imagePath, ...rest } = input;
    // extraction-from-image: если задан imagePath — base64-кодируем файл
    // и шлём как image_base64. Fail-soft: если файл нечитаем, продолжаем
    // text-only (изображение — улучшение, не обязательное условие).
    let imageBase64: string | undefined;
    if (imagePath) {
      try {
        const buf = await readFile(imagePath);
        imageBase64 = buf.toString('base64');
      } catch {
        imageBase64 = undefined;
      }
    }
    return this.post<LlmExtractResult>('/v1/extract', this.withModel({
      ...rest,
      ...(promptOverride ? { prompt_override: promptOverride } : {}),
      ...(includeDebug ? { include_debug: true } : {}),
      ...(imageBase64 ? { image_base64: imageBase64 } : {}),
    }));
  }

  async visionOcr(input: { imagePath: string; prompt?: string }): Promise<LlmVisionResult> {
    const buf = await readFile(input.imagePath);
    return this.post<LlmVisionResult>('/v1/vision-ocr', this.withModel({
      image_base64: buf.toString('base64'),
      prompt: input.prompt,
    }));
  }

  async verify(input: {
    extracted: Record<string, unknown>;
    rawText: string;
  }): Promise<LlmVerifyResult> {
    return this.post<LlmVerifyResult>('/v1/verify', this.withModel({
      extracted: input.extracted,
      raw_text: input.rawText,
    }));
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = new URL(path, this.opts.baseUrl).toString();
    const startedAt = Date.now();
    // `path` carries the leading slash; strip it for cleaner Prometheus labels.
    const endpointLabel = path.replace(/^\/+/, '');

    try {
      const res = await request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        headersTimeout: this.opts.timeoutMs,
        bodyTimeout: this.opts.timeoutMs,
      });

      const elapsed = (Date.now() - startedAt) / 1000;
      llmCallDurationSeconds.observe({ endpoint: endpointLabel }, elapsed);

      if (res.statusCode >= 400) {
        llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });
        const text = await res.body.text();
        throw new Error(`LLM ${path} ${res.statusCode}: ${text.slice(0, 500)}`);
      }
      llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'success' });
      const json = (await res.body.json()) as T & { usage?: LlmCallUsage | null };
      // Учёт токенов джобы. Единственная точка, через которую проходят ВСЕ
      // ответы inference-service — включая чанки multipass, которые идут с
      // includeDebug:false и раньше не приносили расход вовсе. Вне контекста
      // джобы (smoke-CLI, тесты) — no-op. Ответ без `usage` (stub/qwen_vl)
      // помечается неизмеренным, а не нулевым.
      addLlmUsage(json?.usage);
      return json;
    } catch (err) {
      // Network / timeout — already counted above when the response came
      // back with a >=400 status. Here we only count the path where the
      // request threw before completing (e.g. ECONNREFUSED, timeout).
      // Use a distinct outcome to differentiate from HTTP-error path.
      if (!(err instanceof Error && err.message.startsWith('LLM '))) {
        llmCallsTotal.inc({ endpoint: endpointLabel, outcome: 'error' });
      }
      throw err;
    }
  }
}
