/**
 * XlsxEngine — sheetjs-based OCR для xls/xlsx.
 *
 * Юнит-тесты используют in-memory workbook'и через XLSX.utils.book_new()
 * — без зависимостей от файлов на диске (и от docker-окружения).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as XLSX from 'xlsx';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { XlsxEngine, parseXlsxInWorker } from '../src/pipeline/ocr/xlsx.js';

const engine = new XlsxEngine();
let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'xlsx-test-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeXlsx(name: string, sheets: Record<string, unknown[][]>): string {
  const wb = XLSX.utils.book_new();
  for (const [sheetName, rows] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }
  const file = join(tmp, name);
  XLSX.writeFile(wb, file);
  return file;
}

describe('XlsxEngine', () => {
  describe('supports / availability', () => {
    it('supports application/vnd.ms-excel (legacy xls)', () => {
      expect(engine.supports({ filePath: 'x.xls', mimeType: 'application/vnd.ms-excel' })).toBe(
        true,
      );
    });

    it('supports OOXML xlsx', () => {
      expect(
        engine.supports({
          filePath: 'x.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      ).toBe(true);
    });

    it('supports xlsm (macro-enabled)', () => {
      expect(
        engine.supports({
          filePath: 'x.xlsm',
          mimeType: 'application/vnd.ms-excel.sheet.macroEnabled.12',
        }),
      ).toBe(true);
    });

    it('rejects PDF / image / text', () => {
      expect(engine.supports({ filePath: 'x.pdf', mimeType: 'application/pdf' })).toBe(false);
      expect(engine.supports({ filePath: 'x.png', mimeType: 'image/png' })).toBe(false);
      expect(engine.supports({ filePath: 'x.txt', mimeType: 'text/plain' })).toBe(false);
    });

    it('x-cfb + .xls → supported; x-cfb + .doc → NOT supported (routed to DocEngine)', () => {
      // x-cfb — общий OLE-контейнер для .xls и .doc. Разводим по расширению.
      expect(engine.supports({ filePath: 'a/988726MBL.xls', mimeType: 'application/x-cfb' })).toBe(true);
      expect(engine.supports({ filePath: 'a/Заявка_ИСТ-ВЕСТ.doc', mimeType: 'application/x-cfb' })).toBe(false);
    });

    it('isAvailable() = true (xlsx — npm пакет)', () => {
      expect(engine.isAvailable()).toBe(true);
    });
  });

  describe('content extraction', () => {
    it('читает один sheet → section header + CSV', async () => {
      const file = writeXlsx('one.xlsx', {
        Invoice: [
          ['No.', 'Item', 'Qty', 'Price'],
          [1, 'Office chair', 10, 99.5],
          [2, 'Desk lamp', 5, 19.0],
        ],
      });
      const res = await engine.run({
        filePath: file,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      expect(res.engine).toBe('xlsx');
      expect(res.confidence).toBe(1.0);
      expect(res.text).toContain('=== Sheet: Invoice ===');
      expect(res.text).toContain('No.,Item,Qty,Price');
      expect(res.text).toContain('Office chair');
      expect(res.text).toContain('99.5');
    });

    it('multi-sheet (CI + PL) — все sheets с headers', async () => {
      const file = writeXlsx('multi.xlsx', {
        'Commercial Invoice': [['Inv #', 'MP-701-62'], ['Date', '2025-12-24']],
        'Packing List': [['Cartons', '590'], ['Weight', '7938.69']],
      });
      const res = await engine.run({
        filePath: file,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      expect(res.text).toContain('=== Sheet: Commercial Invoice ===');
      expect(res.text).toContain('MP-701-62');
      expect(res.text).toContain('=== Sheet: Packing List ===');
      expect(res.text).toContain('7938.69');
    });

    it('кириллица — без mojibake', async () => {
      const file = writeXlsx('cyr.xlsx', {
        Прайс: [
          ['Артикул', 'Наименование', 'Цена'],
          ['MP-701', 'Кресло офисное', 12500],
        ],
      });
      const res = await engine.run({
        filePath: file,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      expect(res.text).toContain('Прайс');
      expect(res.text).toContain('Кресло офисное');
      expect(res.text).toContain('Артикул');
    });

    it('workbook с пустым sheet → confidence 0', async () => {
      // sheetjs запрещает workbook без sheets — даём sheet с пустым range
      const file = writeXlsx('empty.xlsx', { Empty: [[]] });
      const res = await engine.run({
        filePath: file,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      expect(res.text).toBe('');
      expect(res.confidence).toBe(0);
    });

    it.skip('большой sheet (>50k cells) → SKIPPED маркер', async () => {
      // TODO: sheetjs CE check_wb отвергает write workbook с >10k строк
      // на validate stage. Логика обрезки в engine работает (проверяется
      // через cellCount из !ref), но unit-тест через writeFile невозможен.
      // Альтернатива — мокать XLSX.readFile и подавать workbook напрямую.
      // На текущий момент покрыто smoke-тестом на реальном 19MB каталоге
      // запчастей из VED-кейса.
    });

    it('durationMs ≥ 0', async () => {
      const file = writeXlsx('dur.xlsx', { S: [['x']] });
      const res = await engine.run({
        filePath: file,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // Инцидент 2026-07-20: битый sync-.xls вешал event loop всего воркера.
  // Парсинг вынесен в worker_thread с таймаутом+terminate.
  describe('parse timeout (worker_thread)', () => {
    it('микро-таймаут → reject(timeout), процесс НЕ виснет', async () => {
      const file = writeXlsx('to.xlsx', { S: [['a', 'b'], [1, 2]] });
      // 1мс < времени спавна worker'а + парса → таймаут гарантированно первым.
      await expect(parseXlsxInWorker(file, 50_000, 1)).rejects.toThrow(/timeout/i);
    });

    it('нормальный таймаут → парсит через worker', async () => {
      const file = writeXlsx('okw.xlsx', { S: [['h'], ['v']] });
      const r = await parseXlsxInWorker(file, 50_000, 30_000);
      expect(r.text).toContain('=== Sheet: S ===');
      expect(r.pages.length).toBe(1);
    });
  });
});
