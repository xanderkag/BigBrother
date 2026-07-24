/**
 * XLSX-ANALYZE: структурный разбор книги перед обращением к модели.
 *
 * Тесты построены вокруг боевого провала 2026-07-24: в книге из шести листов
 * (PRICE LIST, перевод, PACKING, pl, INVOICE, Лист3) прежняя эвристика «самая
 * длинная таблица» взяла служебный Лист3 — вместо 176 позиций извлеклось 10,
 * и проверка это пропустила (строки-то были корректные, просто не те).
 *
 * Поэтому здесь проверяем не «угадал ли код», а что он ЧЕСТНО ПЕРЕЧИСЛИЛ все
 * кандидаты и правильно посчитал объём — выбор делает модель, а счёт строк
 * нужен сторожу полноты.
 */
import { describe, it, expect } from 'vitest';

import {
  analyzeWorkbook,
  renderReportForPrompt,
} from '../src/pipeline/parsers/xlsx-analyze.js';
import type { OcrTable } from '../src/pipeline/ocr/types.js';

/** Реплика боевой книги: настоящий прайс + служебные листы-ловушки. */
function priceWorkbook(): OcrTable[] {
  const price: string[][] = [
    ['ООО «Поставщик»', '', '', '', ''],
    ['Артикул', 'Наименование', 'Страна', 'Кол-во', 'Цена'],
    ...Array.from({ length: 30 }, (_, i) => [
      `A-${i}`, `Товар ${i}`, 'Китай', String(i + 1), String(100 + i),
    ]),
  ];
  // Ловушка: длинный, но узкий служебный лист (как «Лист3» на 112 строк × 3).
  const junk: string[][] = [
    ['код', 'значение', 'примечание'],
    ...Array.from({ length: 60 }, (_, i) => [`k${i}`, `v${i}`, `n${i}`]),
  ];
  const packing: string[][] = [
    ['№', 'Место', 'Вес', 'Объём'],
    ...Array.from({ length: 8 }, (_, i) => [String(i), `PL-${i}`, String(10 + i), '1.2']),
  ];
  return [
    { sheet: 'PRICE LIST', rows: price },
    { sheet: 'Лист3', rows: junk },
    { sheet: 'PACKING', rows: packing },
  ];
}

describe('analyzeWorkbook — перечисляет ВСЕ кандидаты, а не угадывает один', () => {
  it('находит области на всех листах, включая настоящий прайс', () => {
    const rep = analyzeWorkbook(priceWorkbook());
    const sheets = rep.regions.map((r) => r.sheet);
    expect(sheets).toContain('PRICE LIST');
    expect(sheets).toContain('Лист3');
    expect(sheets).toContain('PACKING');
  });

  it('настоящий прайс НЕ теряется, даже если служебный лист длиннее', () => {
    const rep = analyzeWorkbook(priceWorkbook());
    const price = rep.regions.find((r) => r.sheet === 'PRICE LIST');
    expect(price).toBeDefined();
    expect(price!.dataRowCount).toBe(30);
    expect(price!.header).toContain('Наименование');
    // Ловушка длиннее — и в прежней версии победила бы. Теперь она лишь ОДИН
    // из кандидатов, а решает модель.
    const junk = rep.regions.find((r) => r.sheet === 'Лист3');
    expect(junk!.dataRowCount).toBeGreaterThan(price!.dataRowCount);
  });

  it('шапка отделена от шапки документа', () => {
    const rep = analyzeWorkbook(priceWorkbook());
    const price = rep.regions.find((r) => r.sheet === 'PRICE LIST')!;
    // Строка 0 — «ООО Поставщик», шапка таблицы должна быть строкой 1.
    expect(price.headerRowIndex).toBe(1);
    expect(price.dataStartIndex).toBe(2);
    expect(price.header[0]).toBe('Артикул');
  });

  it('считает суммарный объём строк — основа сторожа полноты', () => {
    const rep = analyzeWorkbook(priceWorkbook());
    // 30 (прайс) + 60 (ловушка) + 8 (packing) = 98.
    expect(rep.totalDataRows).toBe(98);
  });

  it('кладёт образцы строк, чтобы модель отличила товары от служебных списков', () => {
    const rep = analyzeWorkbook(priceWorkbook(), { sampleRows: 2 });
    const price = rep.regions.find((r) => r.sheet === 'PRICE LIST')!;
    expect(price.samples.length).toBe(2);
    expect(price.samples[0]?.[1]).toBe('Товар 0');
  });

  it('несколько таблиц на ОДНОМ листе — тоже разные кандидаты', () => {
    const rows: string[][] = [
      ['Позиции', '', '', ''],
      ['Артикул', 'Название', 'Кол-во', 'Цена'],
      ...Array.from({ length: 6 }, (_, i) => [`A${i}`, `T${i}`, '1', '10']),
      ['', '', '', ''],
      ['Итоги по складам', '', '', '', '', ''],
      ['Склад', 'Приход', 'Расход', 'Остаток', 'Резерв', 'Итого'],
      ...Array.from({ length: 5 }, (_, i) => [`S${i}`, '1', '2', '3', '4', '5']),
    ];
    const rep = analyzeWorkbook([{ sheet: 'Смесь', rows }]);
    expect(rep.regions.length).toBeGreaterThanOrEqual(2);
    const widths = rep.regions.map((r) => r.width).sort();
    expect(widths).toContain(4);
    expect(widths).toContain(6);
  });

  it('пусто / нет структуры → пустой отчёт, работает прежний путь', () => {
    expect(analyzeWorkbook(undefined).regions).toEqual([]);
    expect(analyzeWorkbook([]).totalDataRows).toBe(0);
    expect(analyzeWorkbook([{ sheet: 'S', rows: [['a', 'b', 'c']] }]).regions).toEqual([]);
  });

  it('узкие списки (1-2 колонки) таблицей позиций не считаются', () => {
    const rows = Array.from({ length: 40 }, (_, i) => [`строка ${i}`, '']);
    expect(analyzeWorkbook([{ sheet: 'S', rows }]).regions).toEqual([]);
  });
});

describe('renderReportForPrompt — компактно и по делу', () => {
  it('перечисляет листы, области, шапки и образцы', () => {
    const text = renderReportForPrompt(analyzeWorkbook(priceWorkbook()));
    expect(text).toContain('PRICE LIST');
    expect(text).toContain('Область 0');
    expect(text).toContain('шапка:');
    expect(text).toContain('пример:');
    // Промпт не должен раздуваться в весь файл.
    expect(text.split('\n').length).toBeLessThan(40);
  });
});
