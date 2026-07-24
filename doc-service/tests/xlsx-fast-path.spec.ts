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

import {
  MultiPassLlmParser,
  fieldTokens,
  pickNameField,
  type MultipassConfig,
} from '../src/pipeline/parsers/multipass-llm.js';
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
  .concat(TABLES[0]!.rows.slice(2).map((r) => r.join(',')))
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
      if ('regions' in props) {
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
  regions: [
    {
      region: 0,
      header_row: 1,
      mapping: [
        { field: 'name', column: 0 },
        { field: 'quantity', column: 1 },
        { field: 'price', column: 2 },
      ],
    },
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
      regions: [
        {
          region: 0,
          header_row: 1,
          mapping: [
            { field: 'name', column: 1 },
            { field: 'price', column: 0 }, // в цену поедет наименование
          ],
        },
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

/**
 * Регрессия боевого случая: подстрочная проверка имён полей браковала ВЕРНУЮ
 * разметку прайса — `country_of_origin` считался числовым, потому что внутри
 * «country» сидит «count» (лог: xlsx_fast_rejected:not_numeric:country_of_origin:0.00).
 */
describe('имена полей разбираются по токенам, а не по подстрокам', () => {
  it('country_of_origin НЕ числовое (внутри «count»)', () => {
    expect(fieldTokens('country_of_origin')).toEqual(['country', 'of', 'origin']);
    expect(fieldTokens('country_of_origin')).not.toContain('count');
  });

  it('настоящие числовые поля распознаются', () => {
    expect(fieldTokens('quantity')).toContain('quantity');
    expect(fieldTokens('unit_price')).toContain('price');
    expect(fieldTokens('netWeight')).toContain('weight');
    expect(fieldTokens('total-amount')).toContain('amount');
  });

  it('accountant / discount не превращаются в «count»', () => {
    expect(fieldTokens('accountant')).not.toContain('count');
    expect(fieldTokens('discount_percent')).not.toContain('count');
  });
});

/**
 * Регрессия боевого замера 2026-07-24: РАЗНЫЕ СИСТЕМЫ КООРДИНАТ.
 *
 * Модель возвращала `header_row`, и код читал его как номер строки ЛИСТА. Но
 * номеров строк листа модель не видит вовсе — в промпте только перечень
 * областей с шапками и парой примеров. Её «0» означало «первая строка
 * показанной области», код начинал раскладку с самого верха листа, и в
 * артикул уезжала шапка бланка: «Morion Ltd.», «Ul. Nekrasova, 44…».
 *
 * Теперь границы данных задаёт анализатор. Тест держит именно это.
 */
describe('границы строк задаёт код, а не модель', () => {
  /** Лист с шапкой бланка сверху — как в боевом инвойсе. */
  const LETTERHEAD: OcrTable[] = [
    {
      sheet: 'INVOICE',
      rows: [
        ['Morion Ltd.', '', ''],
        ['Ul. Nekrasova, 44, liter A', '', ''],
        ['', '', ''],
        ['Артикул', 'Наименование', 'Цена'],
        ['RSB301', 'castors for chair', '0.65'],
        ['RSB302', 'gas lift 100mm', '1.20'],
        ['RSB303', 'base nylon 320', '3.40'],
        ['RSB304', 'armrest PP', '2.10'],
        ['RSB305', 'seat plate', '1.75'],
        ['RSB306', 'back frame', '4.90'],
      ],
    },
  ];
  const TEXT = ['Артикул,Наименование,Цена']
    .concat(LETTERHEAD[0]!.rows.slice(4).map((r) => r.join(',')))
    .join('\n');

  it('шапка бланка не попадает в позиции, даже если модель прислала header_row 0', async () => {
    const calls: Call[] = [];
    const parser = new MultiPassLlmParser(
      makeLlm({
        mapping: {
          regions: [
            {
              region: 0,
              header_row: 0, // ← «первая строка области» на языке модели
              mapping: [
                { field: 'name', column: 1 },
                { field: 'price', column: 2 },
              ],
            },
          ],
        },
        calls,
      }),
      'invoice',
      CFG,
    );

    const res = await parser.parse(TEXT, { llmSchema: SCHEMA, tables: LETTERHEAD });

    const items = res.extracted.items as Array<Record<string, string>>;
    expect(items).toHaveLength(6);
    expect(items[0]).toMatchObject({ name: 'castors for chair', price: '0.65' });
    // Ни адреса, ни строки заголовков среди позиций быть не может.
    const names = items.map((i) => i.name);
    expect(names).not.toContain('Наименование');
    expect(names.some((n) => (n ?? '').includes('Nekrasova'))).toBe(false);
  });
});

/**
 * Регрессия боевого замера 2026-07-24. «Обязательным» полем бралось первое
 * «name-подобное» в порядке ответа модели, а список включал идентификаторы —
 * на реальных прайсах требовался заполненный АРТИКУЛ
 * (`xlsx_fast_rejected:required_sparse:sku:0.60`). Артикул есть не у каждого
 * товара; быстрый путь из-за этого не срабатывал ни разу.
 */
describe('обязательное поле — наименование, а не идентификатор', () => {
  it('sku/article/model обязательными не становятся', () => {
    expect(pickNameField(['sku', 'article', 'model'])).toBeUndefined();
  });

  it('приоритет по смыслу, а не по порядку от модели', () => {
    expect(pickNameField(['sku', 'price', 'name', 'description'])).toBe('name');
    expect(pickNameField(['description', 'name'])).toBe('name');
  });

  it('нет наименования — не требуем ничего (стерегут другие проверки)', () => {
    expect(pickNameField(['price', 'quantity'])).toBeUndefined();
  });

  it('составные имена разбираются по токенам', () => {
    expect(pickNameField(['product_name'])).toBe('product_name');
    expect(pickNameField(['goodsDescription'])).toBe('goodsDescription');
  });
});

/**
 * Сторожа полноты — то, чего не хватило в боевом замере. Быстрый путь взял не
 * ту таблицу: извлёк 10 позиций вместо 176, и это выглядело ускорением втрое.
 * Правило: полнота важнее скорости. Не сошлось — идём медленным путём.
 */
describe('сторожа полноты: «быстро» не должно побеждать «правильно»', () => {
  /** Книга-ловушка: маленький служебный лист + большая таблица товаров. */
  const TRAP_TABLES: OcrTable[] = [
    {
      sheet: 'Служебный',
      // Числа намеренно правдоподобные: иначе отбракует проверка типов, а нам
      // нужно проверить именно СТОРОЖ ОХВАТА — что маленькая, но «валидная»
      // табличка не пройдёт вместо большой таблицы товаров.
      rows: [
        ['код', 'кол-во', 'сумма'],
        ...Array.from({ length: 6 }, (_, i) => [`k${i}`, String(i + 1), String(10 + i)]),
      ],
    },
    {
      sheet: 'ТОВАРЫ',
      rows: [
        ['Наименование', 'Кол-во', 'Цена'],
        ...Array.from({ length: 150 }, (_, i) => [`Товар ${i}`, '1', '100']),
      ],
    },
  ];
  /** В тексте документа ~156 табличных строк — столько же, сколько в файле. */
  const TRAP_TEXT = ['Инвойс № 7', 'Наименование,Кол-во,Цена']
    .concat(Array.from({ length: 156 }, (_, i) => `Товар ${i},1,100`))
    .join('\n');

  it('модель пропустила область КРУПНЕЕ выбранной → отказ, идём медленным путём', async () => {
    const calls: Call[] = [];
    // Область 0 — самая большая (ТОВАРЫ, 150 строк), область 1 — служебная.
    // Модель «ошибается» и берёт служебную.
    const wrongChoice = {
      regions: [
        {
          region: 1,
          header_row: 0,
          mapping: [
            { field: 'name', column: 0 },
            { field: 'quantity', column: 1 },
            { field: 'price', column: 2 },
          ],
        },
      ],
    };
    const parser = new MultiPassLlmParser(makeLlm({ mapping: wrongChoice, calls }), 'invoice', CFG);

    const res = await parser.parse(TRAP_TEXT, { llmSchema: SCHEMA, tables: TRAP_TABLES });

    // Сторож обязан поймать промах выбора и отправить документ по медленному пути.
    const issues = (res.extracted._issues ?? []) as string[];
    expect(issues.some((i) => i.startsWith('xlsx_fast_skipped_bigger'))).toBe(true);
    expect(calls.filter((c) => c.kind === 'chunk').length).toBeGreaterThan(0);
  });

  /**
   * Обратная сторона того же правила. Книга, где рядом с таблицей товаров лежит
   * справочник наименований — на боевом прайсе это был лист на 112 строк без
   * цен и количеств. Пропустить область МЕНЬШЕ выбранной — законно, отказывать
   * тут нельзя: прежний порог «извлеки четверть строк документа» именно на
   * таком файле забраковал бы правильный ответ.
   */
  it('пропущена область МЕНЬШЕ выбранной (справочник) → путь срабатывает', async () => {
    const calls: Call[] = [];
    const parser = new MultiPassLlmParser(
      makeLlm({
        mapping: {
          regions: [
            {
              region: 0,
              header_row: 0,
              mapping: [
                { field: 'name', column: 0 },
                { field: 'quantity', column: 1 },
                { field: 'price', column: 2 },
              ],
            },
          ],
        },
        calls,
      }),
      'invoice',
      CFG,
    );

    // Область 0 — ТОВАРЫ (150 строк), область 1 — служебная (6). Берём товары.
    const res = await parser.parse(TRAP_TEXT, { llmSchema: SCHEMA, tables: TRAP_TABLES });

    expect(calls.filter((c) => c.kind === 'chunk')).toHaveLength(0);
    const issues = (res.extracted._issues ?? []) as string[];
    const used = issues.find((i) => i.startsWith('xlsx_fast_used:'));
    expect(used).toBeDefined();
    // Пропущенное видно в маркере — молчаливых решений быть не должно.
    expect(used).toContain('skipped_max=Служебный:6');
  });

  it('модель выбрала правильную большую таблицу → путь срабатывает', async () => {
    const calls: Call[] = [];
    const rightChoice = {
      regions: [
        {
          region: 0,
          header_row: 0,
          mapping: [
            { field: 'name', column: 0 },
            { field: 'quantity', column: 1 },
            { field: 'price', column: 2 },
          ],
        },
      ],
    };
    const parser = new MultiPassLlmParser(makeLlm({ mapping: rightChoice, calls }), 'invoice', CFG);

    const res = await parser.parse(TRAP_TEXT, { llmSchema: SCHEMA, tables: TRAP_TABLES });

    expect(calls.filter((c) => c.kind === 'chunk')).toHaveLength(0);
    const items = res.extracted.items as unknown[];
    expect(items.length).toBe(150);
    const issues = (res.extracted._issues ?? []) as string[];
    expect(issues.some((i) => i.startsWith('xlsx_fast_used:'))).toBe(true);
  });
});
