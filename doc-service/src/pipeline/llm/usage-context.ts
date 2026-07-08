/**
 * Учёт токенов LLM в рамках ОДНОЙ джобы.
 *
 * Проблема, которую это решает. Токены возвращались только внутри
 * `ExtractDebug`, а `multipass-llm.ts` гонит Pass 1 (шапку) с
 * `includeDebug: true`, но все N чанков с позициями — с `includeDebug: false`.
 * Их расход не приходил вовсе, а `jobs.last_llm_call` хранит лишь ПОСЛЕДНИЙ
 * вызов. В итоге «токены на документ» показывали стоимость одной шапки, и
 * занижение росло с числом позиций: инвойс на 53 позиции считался как один
 * маленький запрос. Любые ₽/док, посчитанные из этого, были бы ложью.
 *
 * Теперь inference-service отдаёт `usage` в КАЖДОМ ответе, а этот модуль
 * складывает их по всем вызовам джобы (classify + все проходы extract + verify
 * + vision), используя AsyncLocalStorage — как `forceProviderContext` и
 * `inlineCredentialsContext` рядом.
 *
 * ── Главное свойство: счётчик знает, чего он не знает ──────────────────
 * Не всякий backend сообщает usage (`stub`, `qwen_vl` — нет). Такие вызовы
 * попадают в `calls_without_usage`, а НЕ считаются нулевыми. Итог всегда
 * самоописателен: «7 вызовов, из них 2 не измерены» — по нему видно, что
 * рублёвая оценка неполна. Молча занулять — ровно тот способ соврать,
 * от которого мы и уходим.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Накопленный расход токенов за джобу. Пишется в `jobs.llm_usage`. */
export type JobLlmUsage = {
  /** Всего LLM-вызовов за джобу (classify + extract-проходы + verify + vision). */
  calls: number;
  /** Сумма входных токенов по вызовам, где backend их сообщил. */
  prompt_tokens: number;
  /** Сумма выходных токенов по вызовам, где backend их сообщил. */
  output_tokens: number;
  /**
   * Сколько вызовов НЕ вернули usage (stub / qwen_vl / старый inference).
   * > 0 → суммы неполны, и любая производная оценка (₽/док) — нижняя граница.
   */
  calls_without_usage: number;
};

/** Форма `usage` в ответе inference-service. */
export type LlmCallUsage = {
  prompt_tokens?: number | null;
  output_tokens?: number | null;
};

const usageStore = new AsyncLocalStorage<JobLlmUsage>();

function emptyUsage(): JobLlmUsage {
  return { calls: 0, prompt_tokens: 0, output_tokens: 0, calls_without_usage: 0 };
}

/**
 * Выполнить `fn` в контексте учёта. Возвращает результат И накопленный расход.
 * Вне этого контекста `addLlmUsage` — no-op, поэтому smoke-CLI, тесты и
 * gateway-путь работают как раньше.
 */
export async function withJobLlmUsage<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; usage: JobLlmUsage }> {
  const acc = emptyUsage();
  const result = await usageStore.run(acc, fn);
  return { result, usage: acc };
}

/**
 * Учесть один LLM-вызов. Зовётся на КАЖДЫЙ ответ inference-service (в
 * `HttpLlmClient.post`), поэтому ловит и чанки multipass, которые раньше
 * были невидимы.
 *
 * `usage` отсутствует / пустой → вызов помечается неизмеренным.
 */
export function addLlmUsage(usage?: LlmCallUsage | null): void {
  const acc = usageStore.getStore();
  if (!acc) return; // вне джобы — не учитываем

  acc.calls += 1;

  const prompt = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null;
  const output = typeof usage?.output_tokens === 'number' ? usage.output_tokens : null;

  if (prompt === null && output === null) {
    acc.calls_without_usage += 1;
    return;
  }
  if (prompt !== null) acc.prompt_tokens += prompt;
  if (output !== null) acc.output_tokens += output;
}

/** Текущий накопленный расход (для логов по ходу джобы). Вне контекста — null. */
export function currentJobLlmUsage(): JobLlmUsage | null {
  const acc = usageStore.getStore();
  return acc ? { ...acc } : null;
}

/** Полностью ли измерен расход. `false` → суммы — нижняя граница. */
export function isUsageComplete(u: JobLlmUsage): boolean {
  return u.calls > 0 && u.calls_without_usage === 0;
}
