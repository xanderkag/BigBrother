import { db } from '../db.js';

/**
 * EXT-LLM-GATEWAY (local): slim-учёт использования LLM-шлюза.
 *
 * Одна строка на каждый вызов /v1/chat/completions (и /v1/embeddings):
 * кто звал, какой алиас/модель, токены, латентность, исход. Контент
 * (messages[], текст ответа, ключи) НЕ пишем — это бэклог «полного учёта».
 *
 * Учёт НЕ критичен для ответа клиенту: роут зовёт record() в try/catch и
 * никогда не валит ответ из-за сбоя записи usage. См.
 * docs/EXT_LLM_GATEWAY_LOCAL_IMPL_TZ_2026-06-08.md §5.
 */

export type GatewayUsageStatus = 'success' | 'error' | 'timeout';

export type GatewayUsageInput = {
  /** Имя клиента из named key (API_KEYS_JSON); null для root-key. */
  caller: string | null;
  /** Опубликованный алиас, который запросил клиент (или дефолтный). */
  alias: string;
  /** Фактический backend ollama-tag, ушедший в Ollama. */
  model: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  latencyMs: number;
  status: GatewayUsageStatus;
  /** Код ошибки шлюза (upstream_error | timeout | network_error | ...). */
  errorCode?: string | null;
};

class LlmGatewayUsageRepo {
  /**
   * Вставить строку usage. Бросает только при сбое БД — caller обязан
   * обернуть в try/catch (usage не должен ронять ответ клиенту).
   */
  async record(input: GatewayUsageInput): Promise<void> {
    await db.query(
      `INSERT INTO llm_gateway_usage
         (caller, alias, model, prompt_tokens, completion_tokens,
          latency_ms, status, error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.caller,
        input.alias,
        input.model,
        input.promptTokens ?? null,
        input.completionTokens ?? null,
        input.latencyMs,
        input.status,
        input.errorCode ?? null,
      ],
    );
  }
}

export const llmGatewayUsageRepo = new LlmGatewayUsageRepo();
