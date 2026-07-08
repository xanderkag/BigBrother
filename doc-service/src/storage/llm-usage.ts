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

/**
 * Generic единица учёта коннектора (INTEGRATION_HUB_VISION). LLM кладёт
 * tokens, DaData/Яндекс — calls; geocodes/routes под Ф2.
 */
// 'pages' — страницы, отправленные во внешний OCR (коннектор yandex_vision).
export type GatewayUnitKind = 'tokens' | 'calls' | 'geocodes' | 'routes' | 'pages';

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
  /**
   * Коннектор-источник (gateway_connectors.slug). По умолчанию 'llm' —
   * существующий LLM-путь не передаёт это поле и остаётся 'llm'.
   */
  connector?: string;
  /**
   * Сколько generic-units списано этим вызовом. По умолчанию для LLM —
   * promptTokens+completionTokens (если хоть одно задано), иначе NULL.
   */
  units?: number | null;
  /** Единица units; по умолчанию 'tokens' (LLM-путь). */
  unitKind?: GatewayUnitKind | null;
};

class LlmGatewayUsageRepo {
  /**
   * Вставить строку usage. Бросает только при сбое БД — caller обязан
   * обернуть в try/catch (usage не должен ронять ответ клиенту).
   *
   * connector/units/unit_kind имеют LLM-дефолты, чтобы существующие
   * LLM-вызовы (которые их не передают) писались как и раньше:
   * connector='llm', unit_kind='tokens', units = сумма токенов.
   */
  async record(input: GatewayUsageInput): Promise<void> {
    const connector = input.connector ?? 'llm';
    const unitKind = input.unitKind !== undefined ? input.unitKind : 'tokens';
    const units =
      input.units !== undefined
        ? input.units
        : computeTokenUnits(input.promptTokens, input.completionTokens);
    await db.query(
      `INSERT INTO llm_gateway_usage
         (caller, alias, model, prompt_tokens, completion_tokens,
          latency_ms, status, error_code, connector, units, unit_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        input.caller,
        input.alias,
        input.model,
        input.promptTokens ?? null,
        input.completionTokens ?? null,
        input.latencyMs,
        input.status,
        input.errorCode ?? null,
        connector,
        units,
        unitKind,
      ],
    );
  }
}

/** units для LLM-пути: сумма токенов, NULL если обоих нет. */
function computeTokenUnits(
  prompt?: number | null,
  completion?: number | null,
): number | null {
  if ((prompt === undefined || prompt === null) && (completion === undefined || completion === null)) {
    return null;
  }
  return (prompt ?? 0) + (completion ?? 0);
}

export const llmGatewayUsageRepo = new LlmGatewayUsageRepo();
