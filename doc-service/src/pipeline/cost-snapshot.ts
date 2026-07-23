/**
 * BILL-1: сборка снимка себестоимости задачи перед finalize.
 *
 * Тонкая прослойка между orchestrator'ом (знает, кто отработал) и чистой
 * `computeCostBreakdown` (знает, как считать): резолвит прайс-листы
 * задействованных провайдеров и подставляет legacy-fallback из config.
 *
 * Провайдеров на задачу максимум два (LLM + облачный OCR), поэтому берём их
 * точечно по id, а не грузим весь список.
 */
import { config } from '../config.js';
import { providerSettingsRepo } from '../storage/provider-settings.js';
import {
  computeCostBreakdown,
  type CostBreakdown,
  type ProviderRates,
  type JobUsageForCost,
} from './cost.js';

/** Слаги, у которых OCR идёт через дорогую табличную модель. */
const COST_TABLE_TYPES: ReadonlySet<string> = new Set(
  (config.yandex.tableModelTypes ?? []).map((t) => t.toUpperCase()),
);

function parseRates(raw: unknown): ProviderRates | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const currency = r.currency === 'USD' ? 'USD' : 'RUB';
  const basis = r.cost_basis;
  const cost_basis =
    basis === 'amortized' || basis === 'free' || basis === 'vendor' ? basis : 'vendor';
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    currency,
    cost_basis,
    llm_input_per_1k: num(r.llm_input_per_1k),
    llm_output_per_1k: num(r.llm_output_per_1k),
    ocr_page: num(r.ocr_page),
    ocr_page_table: num(r.ocr_page_table),
  };
}

export interface CostSnapshotInput {
  llmUsage: JobUsageForCost | null;
  /** Провайдер, которому приписываем LLM-токены (forced/preferred). */
  extractProviderId: string | null;
  ocrEngine: string | null;
  ocrPages: number | null;
  documentType: string | null;
}

/**
 * Собрать снимок. Fail-soft: любая ошибка резолва ставок не роняет джобу —
 * возвращаем расчёт по legacy-fallback с `estimate=true`.
 */
export async function buildJobCostSnapshot(
  input: CostSnapshotInput,
): Promise<CostBreakdown> {
  const cache = new Map<string, ProviderRates | null>();

  const load = async (id: string): Promise<void> => {
    if (cache.has(id)) return;
    try {
      const row = await providerSettingsRepo.findById(id);
      cache.set(id, parseRates(row?.rates));
    } catch {
      cache.set(id, null); // не роняем джобу из-за прайса
    }
  };

  // LLM-провайдер: явно заданный, иначе дефолтный активный.
  let llmProviderId: string | null = input.extractProviderId;
  if (!llmProviderId) {
    try {
      llmProviderId = (await providerSettingsRepo.findDefault('llm'))?.id ?? null;
    } catch {
      llmProviderId = null;
    }
  }
  if (llmProviderId) await load(llmProviderId);

  const ocrProviderId = input.ocrEngine === 'yandex' ? 'yandex-vision' : null;
  if (ocrProviderId) await load(ocrProviderId);

  return computeCostBreakdown(
    {
      llmUsage: input.llmUsage,
      llmProviderId,
      ocrEngine: input.ocrEngine,
      ocrProviderId,
      ocrPages: input.ocrPages,
      documentType: input.documentType,
    },
    {
      getRates: (id) => cache.get(id) ?? null,
      fallback: config.cost,
      tableTypes: COST_TABLE_TYPES,
      fxUsdRub: config.cost.fxUsdRub || null,
      fxSource: 'config:COST_FX_USD_RUB',
    },
  );
}
