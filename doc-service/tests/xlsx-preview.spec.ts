/**
 * xlsx-preview — грид листов для превью (GET /jobs/:id/sheets). Генерим
 * xlsx SheetJS'ом во временный файл и читаем обратно.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import xlsxPkg from 'xlsx';
const XLSX = xlsxPkg;
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSheetsForPreview,
  isSpreadsheet,
  PREVIEW_MAX_ROWS,
} from '../src/pipeline/ocr/xlsx-preview.js';

let dir: string;
let seq = 0;

function writeWb(sheets: Record<string, unknown[][]>): string {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  const p = join(dir, `wb-${seq++}.xlsx`);
  XLSX.writeFile(wb, p);
  return p;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sheetprev-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readSheetsForPreview', () => {
  it('одиночный лист: грид строк, размеры, без обрезки', () => {
    const p = writeWb({
      Invoice: [
        ['№', 'Товар', 'Кол-во', 'Цена'],
        [1, 'Кресло', 10, 5000],
        [2, 'Стол', 5, 12000],
      ],
    });
    const [s] = readSheetsForPreview(p);
    expect(s!.name).toBe('Invoice');
    expect(s!.rows.length).toBe(3);
    expect(s!.rows[0]).toEqual(['№', 'Товар', 'Кол-во', 'Цена']);
    expect(s!.rows[1]).toEqual(['1', 'Кресло', '10', '5000']);
    expect(s!.totalRows).toBe(3);
    expect(s!.totalCols).toBe(4);
    expect(s!.truncated).toBe(false);
  });

  it('несколько листов → несколько превью в порядке', () => {
    const p = writeWb({ CI: [['a']], PL: [['b']], Extra: [['c']] });
    const out = readSheetsForPreview(p);
    expect(out.map((s) => s.name)).toEqual(['CI', 'PL', 'Extra']);
  });

  it('пустой лист → rows=[]', () => {
    const p = writeWb({ Empty: [] });
    const [s] = readSheetsForPreview(p);
    expect(s!.rows).toEqual([]);
    expect(s!.totalRows).toBe(0);
  });

  it('лист длиннее лимита → truncated=true, rows обрезаны до лимита', () => {
    const many = Array.from({ length: PREVIEW_MAX_ROWS + 50 }, (_, i) => [i, `row${i}`]);
    const p = writeWb({ Big: many });
    const [s] = readSheetsForPreview(p);
    expect(s!.truncated).toBe(true);
    expect(s!.rows.length).toBe(PREVIEW_MAX_ROWS);
    expect(s!.totalRows).toBe(PREVIEW_MAX_ROWS + 50);
  });

  it('пустые ячейки → пустые строки в гриде (defval)', () => {
    const p = writeWb({ Gaps: [['a', '', 'c']] });
    const [s] = readSheetsForPreview(p);
    expect(s!.rows[0]).toEqual(['a', '', 'c']);
  });
});

describe('isSpreadsheet', () => {
  it('xlsx/xls mime → true', () => {
    expect(isSpreadsheet('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'x.xlsx')).toBe(true);
    expect(isSpreadsheet('application/vnd.ms-excel', 'x.xls')).toBe(true);
  });
  it('x-cfb → только с .xls-расширением (не .doc)', () => {
    expect(isSpreadsheet('application/x-cfb', 'Прайс.xls')).toBe(true);
    expect(isSpreadsheet('application/x-cfb', 'Заявка.doc')).toBe(false);
  });
  it('pdf/docx/image → false', () => {
    expect(isSpreadsheet('application/pdf', 'x.pdf')).toBe(false);
    expect(isSpreadsheet('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x.docx')).toBe(false);
    expect(isSpreadsheet('image/png', 'x.png')).toBe(false);
  });
});
