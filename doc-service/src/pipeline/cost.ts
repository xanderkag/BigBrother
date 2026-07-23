/**
 * Себестоимость разбора документа (BILL-1, ТЗ docs/BILLING_INTERNAL_TZ.md).
 *
 * **Что изменилось.** Раньше стоимость считалась НА ЧТЕНИЕ (`toApi`) по
 * глобальным ставкам из `config.cost`: смена тарифа задним числом молча
 * переписывала стоимость всех прошлых задач, а агрегировать было нечего.
 * Теперь прайс-лист висит на провайдере (`provider_settings.rates`), а в
 * задаче сохраняется **снимок** расчёта: построчно (провайдер × вид расхода)
 * со ставкой и курсом на момент разбора.
 *
 * **Решения владельца (2026-07-23):**
 *   - всё сводится к рублям; курс фиксируется на дату задачи и живёт в снимке;
 *   - своё железо тарифицируется по коммерческому эквиваленту
 *     (`cost_basis='amortized'`) — цифра отвечает «сколько стоило бы в облаке»,
 *     поэтому отчёт обязан отделять её от живых денег (`vendor`).
 *
 * **Честность цифры.** Нет ставки у провайдера → `estimate=true` и расчёт по
 * legacy-fallback (`config.cost`), но НИКОГДА молча не ноль: ноль неотличим от
 * «бесплатно». Неполный usage (`calls_without_usage>0`) или неизвестное число
 * страниц — тоже `estimate` (нижняя граница, UI показывает «≥»).
 *
 * **Известное упрощение.** `jobs.llm_usage` агрегатный — он не помнит, какой
 * вызов ушёл какому провайдеру. Поэтому все LLM-токены задачи относятся на
 * ЭФФЕКТИВНОГО extract-провайдера. Для композита с разными провайдерами по
 * сегментам это огрубление (риск отмечен в ТЗ, §BILL-1).
 */

export type CostBasis = 'vendor' | 'amortized' | 'free';

/** Прайс-лист провайдера (`provider_settings.rates`). */
export interface ProviderRates {
  currency: 'RUB' | 'USD';
  cost_basis: CostBasis;
  llm_input_per_1k?: number | null;
  llm_output_per_1k?: number | null;
  ocr_page?: number | null;
  ocr_page_table?: number | null;
}

export type CostLineKind = 'llm_input' | 'llm_output' | 'ocr_page' | 'ocr_page_table';

/** Строка снимка: один провайдер × один вид расхода. */
export interface CostLine {
  kind: CostLineKind;
  provider_id: string;
  qty: number;
  unit: 'token' | 'page';
  /** Делитель для токенов (1000). Отсутствует для постраничных строк. */
  per?: number;
  /** Ставка НА МОМЕНТ расчёта, в валюте провайдера. */
  rate: number;
  /** Итог строки в рублях (после конверсии). */
  sum: number;
  cost_basis: CostBasis;
  /** Исходная валюта, если не рубли. */
  currency?: string;
  /** Курс к рублю, применённый к этой строке. */
  fx?: number;
  /** Прайса у провайдера не было — считано по legacy-ставкам. */
  fallback?: true;
}

/** Снимок расчёта, который ложится в `jobs.cost_breakdown`. */
export interface CostBreakdown {
  currency: 'RUB';
  total: number;
  estimate: boolean;
  computed_at: string;
  lines: CostLine[];
  /** Курс, применённый в этом расчёте (фиксация на дату задачи). */
  fx?: { usd_rub?: number; source: string };
  /** Почему цифра неполна — подсказка оператору. */
  estimate_reasons?: string[];
}

/** Legacy-ставки из `config.cost` — fallback для провайдеров без прайса. */
export interface CostRates {
  ocrPageRub: number;
  ocrTableRub: number;
  llmInputPer1kRub: number;
  llmOutputPer1kRub: number;
}

export interface JobUsageForCost {
  prompt_tokens: number;
  output_tokens: number;
  calls_without_usage: number;
}

export interface CostComputeInput {
  llmUsage: JobUsageForCost | null;
  /** Провайдер, на которого относим LLM-токены (эффективный extract). */
  llmProviderId: string | null;
  ocrEngine: string | null;
  /** Провайдер облачного OCR (для `ocrEngine==='yandex'`). */
  ocrProviderId: string | null;
  ocrPages: number | null;
  documentType: string | null;
}

export interface CostComputeDeps {
  /** Прайс провайдера или null, если ставки нет. */
  getRates: (providerId: string) => ProviderRates | null;
  /** Legacy-ставки (config.cost) — когда у провайдера прайса нет. */
  fallback: CostRates;
  /** Слаги, идущие через табличную OCR-модель (дороже). */
  tableTypes: ReadonlySet<string>;
  /** Курс USD→RUB на дату задачи. Пусто → USD-расход не сведён (estimate). */
  fxUsdRub?: number | null;
  fxSource?: string;
  now?: Date;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Конверсия в рубли. null, если курса нет (→ estimate, но не молчаливый ноль). */
function toRub(
  amount: number,
  currency: 'RUB' | 'USD',
  fxUsdRub: number | null | undefined,
): { rub: number; fx?: number } | null {
  if (currency === 'RUB') return { rub: amount };
  if (!fxUsdRub || fxUsdRub <= 0) return null;
  return { rub: amount * fxUsdRub, fx: fxUsdRub };
}

/**
 * Снимок себестоимости задачи.
 *
 * Гарантии (закреплены тестами — приёмка BILL-1):
 *   1. сумма `lines[].sum` === `total`;
 *   2. провайдер без прайса → `estimate=true`, стоимость НЕ ноль (fallback);
 *   3. снимок самодостаточен: ставка и курс внутри — смена тарифа завтра не
 *      меняет уже сохранённые задачи;
 *   4. локальный провайдер даёт строки с `cost_basis='amortized'`.
 */
export function computeCostBreakdown(
  input: CostComputeInput,
  deps: CostComputeDeps,
): CostBreakdown {
  const lines: CostLine[] = [];
  const reasons: string[] = [];
  let estimate = false;
  let usedUsdFx: number | undefined;

  const pushLine = (
    kind: CostLineKind,
    pid: string,
    qty: number,
    unit: 'token' | 'page',
    rate: number,
    rawSum: number,
    basis: CostBasis,
    currency: 'RUB' | 'USD',
    isFallback: boolean,
    per?: number,
  ): void => {
    const conv = toRub(rawSum, currency, deps.fxUsdRub);
    if (!conv) {
      estimate = true;
      reasons.push(`нет курса ${currency}→RUB на дату задачи — расход «${pid}» не сведён`);
      return;
    }
    if (conv.fx) usedUsdFx = conv.fx;
    lines.push({
      kind,
      provider_id: pid,
      qty,
      unit,
      ...(per ? { per } : {}),
      rate,
      sum: round2(conv.rub),
      cost_basis: basis,
      ...(currency !== 'RUB' ? { currency } : {}),
      ...(conv.fx ? { fx: conv.fx } : {}),
      ...(isFallback ? { fallback: true as const } : {}),
    });
  };

  // ── LLM: токены задачи на эффективного extract-провайдера ────────────────
  const usage = input.llmUsage;
  if (usage && (usage.prompt_tokens > 0 || usage.output_tokens > 0)) {
    const pid = input.llmProviderId ?? 'unknown';
    const rates = input.llmProviderId ? deps.getRates(input.llmProviderId) : null;
    const isFallback = !rates;
    if (isFallback) {
      estimate = true;
      reasons.push(`нет прайса у провайдера «${pid}» — считано по общим ставкам`);
    }
    const basis: CostBasis = rates?.cost_basis ?? 'vendor';
    const currency: 'RUB' | 'USD' = rates?.currency ?? 'RUB';

    if (basis !== 'free') {
      const pairs: Array<[CostLineKind, number, number | null | undefined]> = [
        ['llm_input', usage.prompt_tokens, rates?.llm_input_per_1k ?? deps.fallback.llmInputPer1kRub],
        ['llm_output', usage.output_tokens, rates?.llm_output_per_1k ?? deps.fallback.llmOutputPer1kRub],
      ];
      for (const [kind, qty, rate] of pairs) {
        if (!qty || qty <= 0) continue;
        if (rate == null) {
          estimate = true;
          reasons.push(`у провайдера «${pid}» нет ставки для ${kind}`);
          continue;
        }
        pushLine(kind, pid, qty, 'token', rate, (qty / 1000) * rate, basis, currency, isFallback, 1000);
      }
    }

    if (usage.calls_without_usage > 0) {
      estimate = true;
      reasons.push(`${usage.calls_without_usage} LLM-вызов(ов) без usage — сумма неполна`);
    }
  }

  // ── OCR: только облачный постраничный движок. Локальный OCR (tesseract /
  // pdf-text / xlsx) не тарифицируется; vision-llm уже учтён как LLM-токены.
  if (input.ocrEngine === 'yandex') {
    const pid = input.ocrProviderId ?? 'yandex-vision';
    const rates = deps.getRates(pid);
    const isFallback = !rates;
    if (isFallback) {
      estimate = true;
      reasons.push(`нет прайса у OCR-провайдера «${pid}» — считано по общим ставкам`);
    }
    const basis: CostBasis = rates?.cost_basis ?? 'vendor';
    const currency: 'RUB' | 'USD' = rates?.currency ?? 'RUB';

    if (basis !== 'free') {
      if (input.ocrPages != null && input.ocrPages > 0) {
        const isTable =
          input.documentType != null && deps.tableTypes.has(input.documentType.toUpperCase());
        const kind: CostLineKind = isTable ? 'ocr_page_table' : 'ocr_page';
        const rate = isTable
          ? (rates?.ocr_page_table ?? deps.fallback.ocrTableRub)
          : (rates?.ocr_page ?? deps.fallback.ocrPageRub);
        if (rate == null) {
          estimate = true;
          reasons.push(`у провайдера «${pid}» нет ставки для ${kind}`);
        } else {
          pushLine(kind, pid, input.ocrPages, 'page', rate, input.ocrPages * rate, basis, currency, isFallback);
        }
      } else {
        estimate = true;
        reasons.push('облачный OCR без известного числа страниц');
      }
    }
  }

  const total = round2(lines.reduce((s, l) => s + l.sum, 0));

  return {
    currency: 'RUB',
    total,
    estimate,
    computed_at: (deps.now ?? new Date()).toISOString(),
    lines,
    ...(usedUsdFx ? { fx: { usd_rub: usedUsdFx, source: deps.fxSource ?? 'config' } } : {}),
    ...(reasons.length > 0 ? { estimate_reasons: reasons } : {}),
  };
}

// ── Legacy-путь ────────────────────────────────────────────────────────────
// Оставлен для задач БЕЗ сохранённого снимка (разобраны до BILL-1): `toApi`
// считает их на лету по общим ставкам, как раньше. Новые задачи читают снимок
// из `cost_breakdown` и этот путь не трогают.

export interface JobCostInput {
  llmUsage: JobUsageForCost | null;
  ocrEngine: string | null;
  ocrPages: number | null;
  documentType: string | null;
}

export interface JobCost {
  rub: number;
  estimate: boolean;
  breakdown: { llm: number; ocr: number };
}

export function computeJobCost(
  input: JobCostInput,
  rates: CostRates,
  tableTypes: ReadonlySet<string>,
): JobCost {
  let estimate = false;

  let llm = 0;
  if (input.llmUsage) {
    llm =
      (input.llmUsage.prompt_tokens / 1000) * rates.llmInputPer1kRub +
      (input.llmUsage.output_tokens / 1000) * rates.llmOutputPer1kRub;
    if (input.llmUsage.calls_without_usage > 0) estimate = true;
  }

  let ocr = 0;
  if (input.ocrEngine === 'yandex') {
    if (input.ocrPages != null && input.ocrPages > 0) {
      const isTable =
        input.documentType != null && tableTypes.has(input.documentType.toUpperCase());
      ocr = input.ocrPages * (isTable ? rates.ocrTableRub : rates.ocrPageRub);
    } else {
      estimate = true;
    }
  }

  return { rub: round2(llm + ocr), estimate, breakdown: { llm: round2(llm), ocr: round2(ocr) } };
}
