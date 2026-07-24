/**
 * XLSX-FAST: чистая раскладка таблицы Excel по разметке колонок.
 *
 * Смысл фичи: у Excel структура уже есть, а мы гоняли модель 20+ раз, чтобы она
 * перепечатала таблицу (замер 2026-07-24: проформы/прайсы — 2-7 мин на документ,
 * чтение файла при этом 0.2с). Модель отвечает на один вопрос — «где шапка и что
 * в колонках», строки раскладывает код.
 *
 * Тут — без сети и LLM: поиск тела таблицы, раскладка, и главное — проверка,
 * что кривые случаи ЧЕСТНО отбраковываются (тогда наверху сработает откат на
 * прежний multipass, и хуже сегодняшнего не станет).
 */
import { describe, it, expect } from 'vitest';

import {
  pickItemTable,
  applyColumnMapping,
  validateMappedItems,
  headerPreview,
} from '../src/pipeline/parsers/xlsx-table-map.js';

/** Типовой прайс: шапка документа сверху, потом шапка таблицы, потом позиции. */
const PRICE_LIST = [
  {
    sheet: 'Прайс',
    rows: [
      ['ООО «Поставщик»', '', '', ''],
      ['Прайс-лист от 01.07.2026', '', '', ''],
      ['', '', '', ''],
      ['Артикул', 'Наименование', 'Кол-во', 'Цена'],
      ['A-100', 'Насос центробежный', '10', '1500.50'],
      ['A-101', 'Клапан обратный', '25', '340'],
      ['A-102', 'Фланец DN50', '4', '1200,75'],
      ['A-103', 'Прокладка', '100', '35'],
      ['A-104', 'Болт М12', '500', '12'],
      ['A-105', 'Гайка М12', '500', '8'],
      ['', '', 'ИТОГО', '99999'],
    ],
  },
];

describe('pickItemTable — находит тело таблицы, а не шапку документа', () => {
  it('пропускает верхнюю шапку документа и берёт строку заголовков', () => {
    const cand = pickItemTable(PRICE_LIST, { minDataRows: 5 });
    expect(cand).not.toBeNull();
    expect(cand!.sheet).toBe('Прайс');
    // Строка 3 — «Артикул/Наименование/Кол-во/Цена».
    expect(cand!.rows[cand!.headerRowIndex]?.[0]).toBe('Артикул');
    expect(cand!.dataRowCount).toBeGreaterThanOrEqual(6);
    expect(cand!.width).toBe(4);
  });

  it('из нескольких листов выбирает тот, где таблица длиннее', () => {
    const two = [
      { sheet: 'Мелкий', rows: [['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['1', '1', '1'], ['2', '2', '2']] },
      ...PRICE_LIST,
    ];
    const cand = pickItemTable(two, { minDataRows: 5 });
    expect(cand!.sheet).toBe('Прайс');
  });

  it('нет структуры (пусто / слишком короткая) → null, работает прежний путь', () => {
    expect(pickItemTable(undefined)).toBeNull();
    expect(pickItemTable([])).toBeNull();
    expect(pickItemTable([{ sheet: 'S', rows: [['a', 'b', 'c'], ['1', '2', '3']] }])).toBeNull();
  });

  it('одна колонка — это список, а не таблица позиций', () => {
    const rows = Array.from({ length: 20 }, (_, i) => [`строка ${i}`]);
    expect(pickItemTable([{ sheet: 'S', rows }])).toBeNull();
  });
});

describe('applyColumnMapping — строки раскладывает код', () => {
  const cand = pickItemTable(PRICE_LIST, { minDataRows: 5 })!;
  const mapping = {
    headerRow: 3,
    columns: { article: 0, name: 1, quantity: 2, price: 3 },
  };

  it('раскладывает все позиции по полям', () => {
    const items = applyColumnMapping(cand, mapping);
    expect(items.length).toBe(7); // 6 позиций + строка ИТОГО (её отсеет валидация)
    expect(items[0]).toEqual({
      article: 'A-100',
      name: 'Насос центробежный',
      quantity: '10',
      price: '1500.50',
    });
    expect(items[2]?.price).toBe('1200,75'); // запятую не трогаем — это работа normalize
  });

  it('пустая разметка → пусто (не выдумываем)', () => {
    expect(applyColumnMapping(cand, { headerRow: 3, columns: {} })).toEqual([]);
  });

  it('строки без единого размеченного значения пропускаются', () => {
    const withBlanks = {
      ...cand,
      rows: [...cand.rows, ['', '', '', ''], ['', '', '', '']],
    };
    const items = applyColumnMapping(withBlanks, mapping);
    expect(items.every((it) => Object.keys(it).length > 0)).toBe(true);
  });
});

describe('validateMappedItems — кривая разметка честно отбраковывается', () => {
  const cand = pickItemTable(PRICE_LIST, { minDataRows: 5 })!;
  const good = applyColumnMapping(cand, {
    headerRow: 3,
    columns: { article: 0, name: 1, quantity: 2, price: 3 },
  });

  it('нормальная раскладка проходит', () => {
    const r = validateMappedItems(good, {
      requiredFields: ['name'],
      numericFields: ['quantity', 'price'],
    });
    expect(r.ok).toBe(true);
  });

  it('съехавшие колонки (в «цене» текст) → отказ, наверху сработает откат', () => {
    const shifted = applyColumnMapping(cand, {
      headerRow: 3,
      columns: { name: 0, price: 1 }, // в price поедет наименование
    });
    const r = validateMappedItems(shifted, { numericFields: ['price'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not_numeric:price/);
  });

  it('обязательное поле пустое у большинства строк → отказ', () => {
    const sparse = good.map((it, i) => (i === 0 ? it : { ...it, name: '' }));
    const r = validateMappedItems(sparse, { requiredFields: ['name'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/required_sparse:name/);
  });

  it('слишком мало строк → быстрый путь не оправдан', () => {
    const r = validateMappedItems(good.slice(0, 2), { minItems: 5 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too_few_items/);
  });

  it('поля нет в таблице вовсе — это не ошибка разметки', () => {
    const r = validateMappedItems(good, { numericFields: ['weight'] });
    expect(r.ok).toBe(true);
  });

  it('число с пробелом-разделителем и запятой считается числом', () => {
    const items = [
      { price: '1 500,50' },
      { price: '340' },
      { price: '1200,75' },
      { price: '35' },
      { price: '12' },
    ];
    expect(validateMappedItems(items, { numericFields: ['price'] }).ok).toBe(true);
  });
});

describe('headerPreview — что показываем модели для разметки', () => {
  it('шапка + несколько строк данных, а не весь лист', () => {
    const cand = pickItemTable(PRICE_LIST, { minDataRows: 5 })!;
    const preview = headerPreview(cand, 3);
    expect(preview[0]?.[0]).toBe('Артикул');
    expect(preview.length).toBeLessThanOrEqual(4);
    expect(preview[1]?.[0]).toBe('A-100');
  });
});
