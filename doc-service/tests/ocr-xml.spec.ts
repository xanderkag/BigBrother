/**
 * XmlEngine — fast-xml-parser-based OCR для XML (электронные документы / ЭД,
 * таможенные декларации).
 *
 * Юнит-тесты пишут синтетический XML во временный файл и проверяют, что
 * уплощённый текст содержит значения полей и атрибутов. Без реальных
 * конфиденциальных данных — синтетика.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { XmlEngine } from '../src/pipeline/ocr/xml.js';

const engine = new XmlEngine();
let tmp: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'xml-test-'));
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeXml(name: string, content: string): string {
  const file = join(tmp, name);
  writeFileSync(file, content, 'utf-8');
  return file;
}

describe('XmlEngine', () => {
  describe('supports / availability', () => {
    it('supports application/xml', () => {
      expect(engine.supports({ filePath: 'x.xml', mimeType: 'application/xml' })).toBe(true);
    });

    it('supports text/xml', () => {
      expect(engine.supports({ filePath: 'x.xml', mimeType: 'text/xml' })).toBe(true);
    });

    it('rejects PDF / image / docx', () => {
      expect(engine.supports({ filePath: 'x.pdf', mimeType: 'application/pdf' })).toBe(false);
      expect(engine.supports({ filePath: 'x.png', mimeType: 'image/png' })).toBe(false);
      expect(
        engine.supports({
          filePath: 'x.docx',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
      ).toBe(false);
    });

    it('isAvailable() = true (fast-xml-parser — npm пакет)', () => {
      expect(engine.isAvailable()).toBe(true);
    });
  });

  describe('content extraction', () => {
    it('уплощает декларацию: поля + вложенный список товаров → значения в тексте', async () => {
      const file = writeXml(
        'declaration.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
<Declaration number="10702030/241225/0001234" type="ИМ40">
  <Declarant>
    <Name>ООО Импортёр</Name>
    <INN>7707083893</INN>
  </Declarant>
  <Goods>
    <Item>
      <Code>8471300000</Code>
      <Description>Ноутбук портативный</Description>
      <Quantity>10</Quantity>
    </Item>
    <Item>
      <Code>8528520000</Code>
      <Description>Монитор 27 дюймов</Description>
      <Quantity>5</Quantity>
    </Item>
  </Goods>
</Declaration>`,
      );
      const res = await engine.run({ filePath: file, mimeType: 'application/xml' });

      expect(res.engine).toBe('xml');
      expect(res.confidence).toBe(1.0);

      // Атрибуты корневого элемента.
      expect(res.text).toContain('Declaration@number: 10702030/241225/0001234');
      expect(res.text).toContain('Declaration@type: ИМ40');

      // Скалярные поля декларанта (path/element: value).
      expect(res.text).toContain('Declaration/Declarant/Name: ООО Импортёр');
      expect(res.text).toContain('Declaration/Declarant/INN: 7707083893');

      // Вложенный список товаров — обе позиции с индексами.
      expect(res.text).toContain('8471300000');
      expect(res.text).toContain('Ноутбук портативный');
      expect(res.text).toContain('8528520000');
      expect(res.text).toContain('Монитор 27 дюймов');
      // Позиции списка различимы по индексу.
      expect(res.text).toContain('Declaration/Goods/Item[0]/Code: 8471300000');
      expect(res.text).toContain('Declaration/Goods/Item[1]/Code: 8528520000');
    });

    it('сохраняет ведущие нули в кодах (parseTagValue=false)', async () => {
      const file = writeXml(
        'codes.xml',
        `<?xml version="1.0"?><Doc><Code>0042</Code><KPP>007707</KPP></Doc>`,
      );
      const res = await engine.run({ filePath: file, mimeType: 'application/xml' });
      expect(res.text).toContain('Doc/Code: 0042');
      expect(res.text).toContain('Doc/KPP: 007707');
    });

    it('узел с текстом и атрибутом → и атрибут, и текст', async () => {
      const file = writeXml(
        'mixed.xml',
        `<?xml version="1.0"?><Doc><Amount currency="RUB">15000.50</Amount></Doc>`,
      );
      const res = await engine.run({ filePath: file, mimeType: 'application/xml' });
      expect(res.text).toContain('Doc/Amount@currency: RUB');
      expect(res.text).toContain('Doc/Amount: 15000.50');
    });

    it('кириллица — без mojibake', async () => {
      const file = writeXml(
        'cyr.xml',
        `<?xml version="1.0" encoding="UTF-8"?><Прайс><Товар>Кресло офисное</Товар></Прайс>`,
      );
      const res = await engine.run({ filePath: file, mimeType: 'text/xml' });
      expect(res.text).toContain('Прайс/Товар: Кресло офисное');
    });

    it('durationMs ≥ 0', async () => {
      const file = writeXml('dur.xml', `<?xml version="1.0"?><a><b>x</b></a>`);
      const res = await engine.run({ filePath: file, mimeType: 'application/xml' });
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('edge cases (мягко, без падений)', () => {
    it('пустой файл → confidence 0, не падает', async () => {
      const file = writeXml('empty.xml', '');
      const res = await engine.run({ filePath: file, mimeType: 'application/xml' });
      expect(res.text).toBe('');
      expect(res.confidence).toBe(0);
    });

    it('битый XML (незакрытый тег) → не падает', async () => {
      const file = writeXml('broken.xml', `<?xml version="1.0"?><Doc><Field>value`);
      // Не бросает — мягкая деградация (как docx/xlsx на пустом).
      const res = await engine.run({ filePath: file, mimeType: 'application/xml' });
      expect(res.engine).toBe('xml');
      // fast-xml-parser может частично распарсить или вернуть пусто — главное,
      // что run() не падает и confidence в допустимом диапазоне.
      expect(res.confidence).toBeGreaterThanOrEqual(0);
      expect(res.confidence).toBeLessThanOrEqual(1);
    });

    it('XML только с декларацией без контента → confidence 0', async () => {
      const file = writeXml('decl-only.xml', `<?xml version="1.0" encoding="UTF-8"?>`);
      const res = await engine.run({ filePath: file, mimeType: 'application/xml' });
      expect(res.text).toBe('');
      expect(res.confidence).toBe(0);
    });
  });
});
