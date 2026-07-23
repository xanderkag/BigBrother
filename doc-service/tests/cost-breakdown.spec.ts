/**
 * BILL-1 — приёмка модели себестоимости (ТЗ docs/BILLING_INTERNAL_TZ.md).
 *
 * Проверяем ровно то, что записано в приёмке эпика:
 *   1. задача через Yandex → строки по двум провайдерам, сумма lines === total;
 *   2. провайдер без прайса → estimate=true и НЕ ноль;
 *   3. смена ставки не меняет уже посчитанную задачу (снимок самодостаточен);
 *   4. локальный провайдер идёт с cost_basis='amortized'.
 * Плюс решение владельца: валюта сводится к рублям по курсу из снимка.
 */
import { describe, it, expect } from 'vitest';
import {
  computeCostBreakdown,
  type ProviderRates,
  type CostRates,
} from '../src/pipeline/cost.js';

const FALLBACK: CostRates = {
  ocrPageRub: 0.13,
  ocrTableRub: 1.22,
  llmInputPer1kRub: 0.2,
  llmOutputPer1kRub: 0.3,
};

const RATES: Record<string, ProviderRates> = {
  'yandex-vision': { currency: 'RUB', cost_basis: 'vendor', ocr_page: 0.13, ocr_page_table: 1.22 },
  'yandex-ai-studio': {
    currency: 'RUB', cost_basis: 'vendor', llm_input_per_1k: 0.2, llm_output_per_1k: 0.3,
  },
  'local-qwen3-6-27b': {
    currency: 'RUB', cost_basis: 'amortized', llm_input_per_1k: 0.2, llm_output_per_1k: 0.3,
  },
  anthropic: {
    currency: 'USD', cost_basis: 'vendor', llm_input_per_1k: 0.003, llm_output_per_1k: 0.015,
  },
  tesseract: { currency: 'RUB', cost_basis: 'free' },
};

const deps = (over: Partial<Parameters<typeof computeCostBreakdown>[1]> = {}) => ({
  getRates: (id: string) => RATES[id] ?? null,
  fallback: FALLBACK,
  tableTypes: new Set(['UPD', 'FACTINVOICE']),
  now: new Date('2026-07-23T10:00:00Z'),
  ...over,
});

const sumLines = (b: { lines: Array<{ sum: number }> }) =>
  Math.round(b.lines.reduce((s, l) => s + l.sum, 0) * 100) / 100;

describe('BILL-1 приёмка №1 — два провайдера, сумма строк === total', () => {
  it('Yandex OCR (таблица) + Yandex LLM', () => {
    const b = computeCostBreakdown(
      {
        llmUsage: { prompt_tokens: 3800, output_tokens: 1200, calls_without_usage: 0 },
        llmProviderId: 'yandex-ai-studio',
        ocrEngine: 'yandex',
        ocrProviderId: 'yandex-vision',
        ocrPages: 2,
        documentType: 'UPD',
      },
      deps(),
    );
    // OCR: 2 × 1.22 = 2.44 · вход: 3.8 × 0.2 = 0.76 · выход: 1.2 × 0.3 = 0.36
    expect(b.lines).toHaveLength(3);
    expect(b.total).toBe(3.56);
    expect(sumLines(b)).toBe(b.total);
    expect(b.estimate).toBe(false);
    expect(new Set(b.lines.map((l) => l.provider_id))).toEqual(
      new Set(['yandex-ai-studio', 'yandex-vision']),
    );
    expect(b.lines.find((l) => l.kind === 'ocr_page_table')?.rate).toBe(1.22);
  });

  it('не-табличный тип идёт по дешёвой постраничной ставке', () => {
    const b = computeCostBreakdown(
      {
        llmUsage: null, llmProviderId: null,
        ocrEngine: 'yandex', ocrProviderId: 'yandex-vision',
        ocrPages: 4, documentType: 'invoice',
      },
      deps(),
    );
    expect(b.lines[0]!.kind).toBe('ocr_page');
    expect(b.total).toBe(0.52);
  });
});

describe('BILL-1 приёмка №2 — нет прайса → estimate, а НЕ ноль', () => {
  it('неизвестный провайдер считается по общим ставкам с пометкой', () => {
    const b = computeCostBreakdown(
      {
        llmUsage: { prompt_tokens: 10_000, output_tokens: 2000, calls_without_usage: 0 },
        llmProviderId: 'provider-without-price',
        ocrEngine: null, ocrProviderId: null, ocrPages: null, documentType: null,
      },
      deps(),
    );
    expect(b.estimate).toBe(true);
    expect(b.total).toBeGreaterThan(0); // молчаливый ноль запрещён
    expect(b.total).toBe(2.6); // 10×0.2 + 2×0.3
    expect(b.lines.every((l) => l.fallback === true)).toBe(true);
    expect(b.estimate_reasons?.join(' ')).toContain('provider-without-price');
  });

  it('неполный usage помечает оценку, но сумму сохраняет', () => {
    const b = computeCostBreakdown(
      {
        llmUsage: { prompt_tokens: 1000, output_tokens: 500, calls_without_usage: 2 },
        llmProviderId: 'yandex-ai-studio',
        ocrEngine: null, ocrProviderId: null, ocrPages: null, documentType: null,
      },
      deps(),
    );
    expect(b.estimate).toBe(true);
    expect(b.total).toBe(0.35);
    expect(b.estimate_reasons?.join(' ')).toContain('без usage');
  });

  it('облачный OCR без числа страниц → estimate', () => {
    const b = computeCostBreakdown(
      {
        llmUsage: null, llmProviderId: null,
        ocrEngine: 'yandex', ocrProviderId: 'yandex-vision',
        ocrPages: null, documentType: 'invoice',
      },
      deps(),
    );
    expect(b.estimate).toBe(true);
    expect(b.estimate_reasons?.join(' ')).toContain('числа страниц');
  });
});

describe('BILL-1 приёмка №3 — снимок самодостаточен', () => {
  it('ставка лежит в строке; пересчёт по новому тарифу даёт другой результат, старый снимок не меняется', () => {
    const input = {
      llmUsage: { prompt_tokens: 2000, output_tokens: 1000, calls_without_usage: 0 },
      llmProviderId: 'yandex-ai-studio',
      ocrEngine: null, ocrProviderId: null, ocrPages: null, documentType: null,
    };
    const before = computeCostBreakdown(input, deps());
    expect(before.total).toBe(0.7); // 2×0.2 + 1×0.3

    // Тариф провайдера поднялся вдвое
    const RAISED: ProviderRates = {
      currency: 'RUB', cost_basis: 'vendor', llm_input_per_1k: 0.4, llm_output_per_1k: 0.6,
    };
    const after = computeCostBreakdown(input, deps({ getRates: () => RAISED }));
    expect(after.total).toBe(1.4);

    // Ключевое: РАНЕЕ сохранённый снимок остался прежним — он не ссылается на
    // прайс, а несёт ставку внутри.
    expect(before.total).toBe(0.7);
    expect(before.lines.find((l) => l.kind === 'llm_input')?.rate).toBe(0.2);
    expect(sumLines(before)).toBe(before.total);
  });
});

describe('BILL-1 приёмка №4 — своё железо помечается amortized', () => {
  it('локальный провайдер: cost_basis=amortized, ставка коммерческая', () => {
    const b = computeCostBreakdown(
      {
        llmUsage: { prompt_tokens: 8452, output_tokens: 2118, calls_without_usage: 0 },
        llmProviderId: 'local-qwen3-6-27b',
        ocrEngine: 'tesseract', ocrProviderId: null, ocrPages: 3, documentType: 'invoice',
      },
      deps(),
    );
    expect(b.lines.every((l) => l.cost_basis === 'amortized')).toBe(true);
    expect(b.estimate).toBe(false);
    // локальный OCR (tesseract) строки не даёт — тарифицируется только облачный
    expect(b.lines.every((l) => l.unit === 'token')).toBe(true);
    // строки округляются до копеек по отдельности: 1.6904→1.69 + 0.6354→0.64
    expect(b.total).toBe(2.33);
    expect(sumLines(b)).toBe(b.total);
  });
});

describe('решение владельца — сведение валюты к рублям', () => {
  it('USD-провайдер сводится по курсу, курс фиксируется в снимке', () => {
    const b = computeCostBreakdown(
      {
        llmUsage: { prompt_tokens: 10_000, output_tokens: 2000, calls_without_usage: 0 },
        llmProviderId: 'anthropic',
        ocrEngine: null, ocrProviderId: null, ocrPages: null, documentType: null,
      },
      deps({ fxUsdRub: 100, fxSource: 'test' }),
    );
    // ($0.003×10 + $0.015×2) = $0.06 → ₽6,00
    expect(b.total).toBe(6);
    expect(b.currency).toBe('RUB');
    expect(b.fx).toEqual({ usd_rub: 100, source: 'test' });
    expect(b.lines[0]!.currency).toBe('USD');
    expect(b.lines[0]!.fx).toBe(100);
    expect(b.estimate).toBe(false);
  });

  it('курса нет → расход НЕ сводится и честно помечается estimate (не ноль молча)', () => {
    const b = computeCostBreakdown(
      {
        llmUsage: { prompt_tokens: 10_000, output_tokens: 2000, calls_without_usage: 0 },
        llmProviderId: 'anthropic',
        ocrEngine: null, ocrProviderId: null, ocrPages: null, documentType: null,
      },
      deps({ fxUsdRub: null }),
    );
    expect(b.estimate).toBe(true);
    expect(b.lines).toHaveLength(0);
    expect(b.estimate_reasons?.join(' ')).toContain('курса USD→RUB');
  });
});

describe('free-провайдер', () => {
  it('cost_basis=free не создаёт строк и не помечает оценку', () => {
    const b = computeCostBreakdown(
      {
        llmUsage: { prompt_tokens: 5000, output_tokens: 1000, calls_without_usage: 0 },
        llmProviderId: 'tesseract',
        ocrEngine: null, ocrProviderId: null, ocrPages: null, documentType: null,
      },
      deps(),
    );
    expect(b.lines).toHaveLength(0);
    expect(b.total).toBe(0);
    expect(b.estimate).toBe(false);
  });
});
