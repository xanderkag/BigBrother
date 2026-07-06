/**
 * P2.2: docxXmlToText — извлечение текста колонтитулов из header/footer XML.
 * Тестируем чистую функцию (zip-чтение — отдельно, на реальном docx в проде).
 */
import { describe, it, expect } from 'vitest';
import { docxXmlToText } from '../src/pipeline/ocr/docx-parts.js';

describe('docxXmlToText', () => {
  it('извлекает текст из <w:t>, абзац → перевод строки', () => {
    const xml =
      '<w:p><w:r><w:t>ООО «Ромашка»</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>ИНН 7701234567 КПП 770101001</w:t></w:r></w:p>';
    expect(docxXmlToText(xml)).toBe('ООО «Ромашка»\nИНН 7701234567 КПП 770101001');
  });

  it('склеивает несколько w:t внутри одного абзаца', () => {
    const xml = '<w:p><w:r><w:t>Р/с </w:t></w:r><w:r><w:t>40702810900000012345</w:t></w:r></w:p>';
    expect(docxXmlToText(xml)).toBe('Р/с 40702810900000012345');
  });

  it('декодирует XML-сущности', () => {
    const xml = '<w:p><w:r><w:t>ООО &quot;Ромашка&quot; &amp; Ко &lt;тест&gt;</w:t></w:r></w:p>';
    expect(docxXmlToText(xml)).toBe('ООО "Ромашка" & Ко <тест>');
  });

  it('<w:tab/> и <w:br/> → пробел', () => {
    const xml = '<w:p><w:r><w:t>Банк</w:t><w:tab/><w:t>Сбербанк</w:t></w:r></w:p>';
    expect(docxXmlToText(xml)).toBe('Банк Сбербанк');
  });

  it('игнорирует поля <w:instrText> (коды PAGE/DATE), не только w:t', () => {
    const xml =
      '<w:p><w:r><w:instrText>PAGE \\* MERGEFORMAT</w:instrText></w:r>' +
      '<w:r><w:t>Страница</w:t></w:r></w:p>';
    expect(docxXmlToText(xml)).toBe('Страница');
  });

  it('атрибуты w:t (xml:space) не мешают', () => {
    const xml = '<w:p><w:r><w:t xml:space="preserve"> с пробелами </w:t></w:r></w:p>';
    expect(docxXmlToText(xml)).toBe('с пробелами');
  });

  it('пустой/безтекстовый XML → пустая строка', () => {
    expect(docxXmlToText('')).toBe('');
    expect(docxXmlToText('<w:p><w:r></w:r></w:p>')).toBe('');
    expect(docxXmlToText('<w:hdr></w:hdr>')).toBe('');
  });

  it('схлопывает пустые абзацы', () => {
    const xml = '<w:p><w:t>A</w:t></w:p><w:p></w:p><w:p><w:t>B</w:t></w:p>';
    expect(docxXmlToText(xml)).toBe('A\nB');
  });
});
