/**
 * SPEED-2: дедуп повторяющихся длинных ячеек в xlsx-сериализации (@N-словарь)
 * + страховочный разворот рефов в normalize.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { parseXlsxInWorker } from '../src/pipeline/ocr/xlsx.js';
import { expandXlsxRefs, parseXlsxRefLegend } from '../src/pipeline/normalize/xlsx-ref-expand.js';

const MANUFACTURER = 'POWERMAN INTERNATIONAL LIMITED';
const ADDRESS = 'Room 605, Shangyou building, Youson district, Shenzhen, China';

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'xlsx-dedup-'));
  file = join(dir, 'invoice.xlsx');
  const rows: unknown[][] = [['No', 'Description', 'Manufacturer', 'Address', 'Qty']];
  for (let i = 1; i <= 12; i++) {
    rows.push([i, `Power board model PB-${i}`, MANUFACTURER, ADDRESS, i * 2]);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'INVOICE');
  XLSX.writeFile(wb, file);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('xlsx дедуп повторяющихся ячеек', () => {
  it('повторённые ≥5 раз длинные значения уходят в словарь, строки несут @N', async () => {
    const { text } = await parseXlsxInWorker(file, 50_000, 30_000);
    expect(text).toContain('Словарь повторов');
    // производитель и адрес — в легенде, в строках заменены на @N
    expect(text).toContain(`= ${MANUFACTURER}`);
    const bodyAfterLegend = text.split(MANUFACTURER).length;
    // полное значение встречается ровно 1 раз (в легенде), не 12
    expect(bodyAfterLegend).toBe(2);
    // текст стал существенно короче наивного повторения
    expect(text.length).toBeLessThan(12 * (MANUFACTURER.length + ADDRESS.length));
  });

  it('уникальные значения не трогаются', async () => {
    const { text } = await parseXlsxInWorker(file, 50_000, 30_000);
    expect(text).toContain('Power board model PB-7');
  });

  it('легенда парсится, рефы разворачиваются в extracted', async () => {
    const { text } = await parseXlsxInWorker(file, 50_000, 30_000);
    const dict = parseXlsxRefLegend(text);
    expect(dict.size).toBeGreaterThanOrEqual(2);

    const extracted: Record<string, unknown> = {
      exporter: { name: [...dict.keys()][0] },
      items: [{ name: 'PB-1', manufacturer: [...dict.keys()][0] }],
      note: 'плоский текст без рефов',
    };
    const n = expandXlsxRefs(extracted, text);
    expect(n).toBe(2);
    expect((extracted.exporter as { name: string }).name).not.toMatch(/^@\d+$/);
    expect(JSON.stringify(extracted)).not.toMatch(/@\d+/);
  });

  it('без легенды в raw_text — no-op', () => {
    const extracted = { name: '@1 останется как есть' };
    expect(expandXlsxRefs(extracted, 'обычный текст без словаря')).toBe(0);
    expect(extracted.name).toBe('@1 останется как есть');
  });

  it('@10 не путается с @1 при развороте', () => {
    const raw = ['[Словарь повторов листа: тест]', '@1 = КОРОТКОЕ', '@10 = ДЛИННОЕ ЗНАЧЕНИЕ ДЕСЯТЬ'].join('\n');
    // подделываем маркер, чтобы parseLegend сработал
    const rawText = 'Словарь повторов\n' + raw;
    const extracted = { a: '@10', b: '@1' };
    expandXlsxRefs(extracted, rawText);
    expect(extracted.a).toBe('ДЛИННОЕ ЗНАЧЕНИЕ ДЕСЯТЬ');
    expect(extracted.b).toBe('КОРОТКОЕ');
  });
});
