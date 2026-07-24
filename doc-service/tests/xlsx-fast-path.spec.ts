/**
 * XLSX-FAST: врезка быстрого пути в multipass.
 *
 * Проверяем главное обещание фичи и её страховку:
 *   · при включённом флаге и разметке от модели позиции раскладываются КОДОМ —
 *     нарезки на куски не происходит вовсе (это и есть экономия 20 вызовов → 1);
 *   · если разметка не удалась / не прошла проверку — молча работает прежняя
 *     нарезка, то есть хуже сегодняшнего не становится;
 *   · при выключенном флаге поведение ровно прежнее.
 *
 * Сети нет — LlmClient подменён и считает вызовы по форме схемы.
 */
import { describe, it, expect } from 'vitest';

import { MultiPassLlmParser, type MultipassConfig } from '../src/pipeline/parsers/multipass-llm.js';
import type { LlmClient } from '../src/pipeline/llm/types.js';
import type { OcrTable } from '../src/pipeline/ocr/types.js';

const CFG: MultipassConfig = {
  headerHeadBytes: 4000,
  headerTailBytes: 2000,
  chunkSizeBytes: 12_000,
  maxPasses: 24,
  maxItemsTotal: 1000,
  itemsParallelism: 2,
  targetRowsPerChunk: 30,
  xlsxFastPath: true,
};

const SCHEMA = {
  type: 'object',
  properties: {
    number: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          quantity: { type: 'string' },
          price: { type: 'string' },
        },
      },
    },
  },
};

const TABLES: OcrTable[] = [
  {
    sheet: 'Позиции',
    rows: [
      ['Инвойс № 42', '', ''],
      ['Наименование', 'Кол-во', 'Цена'],
      ['Насос', '10', '1500'],
      ['Клапан', '25', '340'],
      ['Фланец', '4', '1200'],
      ['Прокладка', '100', '35'],
      ['Болт', '500', '12'],
      ['Гайка', '500', '8'],
    ],
  },
];

/** Текст, который БЫ нарезался на куски, если бы быстрый путь не сработал. */
const RAW_TEXT = ['Инвойс № 42', 'Наименование,Кол-во,Цена']
  .concat(Array.from({ length: 200 }, (_, i) => `Товар ${i},1,100`))
  .join('\n');

type Call = { kind: 'header' | 'mapping' | 'chunk' };

function makeLlm(opts: { mapping?: unknown; calls: Call[] }): LlmClient {
  return {
    isAvailable: () => true,
    supportsVision: async () => false,
    classify: async () => ({ type: null, confidence: 0 }),
    classifyWithCatalog: async () => ({ type: null, confidence: 0 }),
    visionOcr: async () => ({ text: '', confidence: 0 }),
    verify: async () => ({ ok: true, issues: [] }),
    extract: async ({ schema }: { schema: Record<string, unknown> }) => {
      const props = (schema.properties ?? {}) as Record<string, unknown>;
      if ('mapping' in props) {
        opts.calls.push({ kind: 'mapping' });
        return { extracted: (opts.mapping ?? {}) as Record<string, unknown>, confidence: 0.9 };
      }
      if ('items' in props) {
        opts.calls.push({ kind: 'chunk' });
        return { extracted: { items: [{ name: 'из-куска', quantity: '1', price: '1' }] }, confidence: 0.5 };
      }
      opts.calls.push({ kind: 'header' });
      return { extracted: { number: '42' }, confidence: 0.9 };
    },
  } as unknown as LlmClient;
}

const GOOD_MAPPING = {
  header_row: 1,
  mapping: [
    { field: 'name', column: 0 },
    { field: 'quantity', column: 1 },
    { field: 'price', column: 2 },
  ],
};

describe('XLSX-FAST врезка в multipass', () => {
  it('разметка удалась → позиции раскладывает код, нарезки НЕ было', async () => {
    const calls: Call[] = [];
    const parser = new MultiPassLlmParser(makeLlm({ mapping: GOOD_MAPPING, calls }), 'invoice', CFG);

    const res = await parser.parse(RAW_TEXT, { llmSchema: SCHEMA, tables: TABLES });

    // Главное: ни одного вызова на куски — вместо ~20 остался один на разметку.
    expect(calls.filter((c) => c.kind === 'chunk')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'mapping')).toHaveLength(1);

    const items = res.extracted.items as Array<Record<string, string>>;
    expect(items).toHaveLength(6);
    expect(items[0]).toMatchObject({ name: 'Насос', quantity: '10', price: '1500' });
    // Шапка документа по-прежнему берётся отдельным проходом.
    expect(res.extracted.number).toBe('42');
    // Маркер для замера «было/стало».
    const issues = (res.extracted._issues ?? []) as string[];
    expect(issues.some((i) => i.startsWith('xlsx_fast_used:'))).toBe(true);
  });

  it('модель не разметила → откат на нарезку, документ всё равно разобран', async () => {
    const calls: Call[] = [];
    const parser = new MultiPassLlmParser(makeLlm({ mapping: {}, calls }), 'invoice', CFG);

    const res = await parser.parse(RAW_TEXT, { llmSchema: SCHEMA, tables: TABLES });

    expect(calls.filter((c) => c.kind === 'mapping')).toHaveLength(1);
    expect(calls.filter((c) => c.kind === 'chunk').length).toBeGreaterThan(0);
    const issues = (res.extracted._issues ?? []) as string[];
    expect(issues.some((i) => i === 'xlsx_fast_mapping_failed')).toBe(true);
  });

  it('колонки съехали (в «цене» текст) → проверка отбраковывает, откат на нарезку', async () => {
    const calls: Call[] = [];
    const badMapping = {
      header_row: 1,
      mapping: [
        { field: 'name', column: 1 },
        { field: 'price', column: 0 }, // в цену поедет наименование
      ],
    };
    const parser = new MultiPassLlmParser(makeLlm({ mapping: badMapping, calls }), 'invoice', CFG);

    const res = await parser.parse(RAW_TEXT, { llmSchema: SCHEMA, tables: TABLES });

    expect(calls.filter((c) => c.kind === 'chunk').length).toBeGreaterThan(0);
    const issues = (res.extracted._issues ?? []) as string[];
    expect(issues.some((i) => i.startsWith('xlsx_fast_rejected:not_numeric'))).toBe(true);
  });

  it('флаг выключен → быстрый путь не пробуется вовсе', async () => {
    const calls: Call[] = [];
    const parser = new MultiPassLlmParser(makeLlm({ mapping: GOOD_MAPPING, calls }), 'invoice', {
      ...CFG,
      xlsxFastPath: false,
    });

    await parser.parse(RAW_TEXT, { llmSchema: SCHEMA, tables: TABLES });

    expect(calls.filter((c) => c.kind === 'mapping')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'chunk').length).toBeGreaterThan(0);
  });

  it('структуры таблиц нет (не xlsx) → прежнее поведение', async () => {
    const calls: Call[] = [];
    const parser = new MultiPassLlmParser(makeLlm({ mapping: GOOD_MAPPING, calls }), 'invoice', CFG);

    await parser.parse(RAW_TEXT, { llmSchema: SCHEMA });

    expect(calls.filter((c) => c.kind === 'mapping')).toHaveLength(0);
    expect(calls.filter((c) => c.kind === 'chunk').length).toBeGreaterThan(0);
  });
});
