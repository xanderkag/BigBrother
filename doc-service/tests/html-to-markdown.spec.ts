/**
 * htmlToMarkdown — конвертер выхода mammoth.convertToHtml (P1-A).
 * Главная цель: таблицы Word не плющатся, а становятся pipe-таблицами.
 */
import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from '../src/pipeline/ocr/html-to-markdown.js';

describe('htmlToMarkdown — таблицы', () => {
  it('простая таблица → pipe-таблица с шапкой и разделителем', () => {
    const html =
      '<table><tr><td><p>Показатель</p></td><td><p>Значение</p></td></tr>' +
      '<tr><td><p>Плотность</p></td><td><p>1.2</p></td></tr></table>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('| Показатель | Значение |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| Плотность | 1.2 |');
  });

  it('строки с разным числом ячеек паддятся до макс. колонок', () => {
    const html =
      '<table><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>x</td></tr></table>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('| a | b | c |');
    expect(md).toContain('| x |  |  |');
  });

  it('pipe внутри ячейки экранируется (не рвёт колонку)', () => {
    const html = '<table><tr><td>20|40 HC</td><td>ok</td></tr></table>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('20\\|40 HC');
    // одна разделительная граница на 2 колонки
    expect(md.split('\n')[0]!.match(/(?<!\\)\|/g)!.length).toBe(3);
  });

  it('вложенная таблица деградирует мягко (внутренняя → текст ячейки)', () => {
    const html =
      '<table><tr><td><table><tr><td>inner</td></tr></table></td><td>outer</td></tr></table>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('inner');
    expect(md).toContain('outer');
    // не осталось сырых тегов
    expect(md).not.toContain('<table');
    expect(md).not.toContain('<td');
  });
});

describe('htmlToMarkdown — блоки и inline', () => {
  it('заголовки → #-разметка', () => {
    expect(htmlToMarkdown('<h1>Паспорт безопасности</h1>')).toContain('# Паспорт безопасности');
    expect(htmlToMarkdown('<h3>Раздел 3</h3>')).toContain('### Раздел 3');
  });

  it('списки → "- item"', () => {
    const md = htmlToMarkdown('<ul><li>первый</li><li>второй</li></ul>');
    expect(md).toContain('- первый');
    expect(md).toContain('- второй');
  });

  it('абзацы разделяются пустой строкой', () => {
    const md = htmlToMarkdown('<p>Первый абзац.</p><p>Второй абзац.</p>');
    expect(md).toBe('Первый абзац.\n\nВторой абзац.');
  });

  it('inline-разметка (strong/em/a) разворачивается в текст', () => {
    const md = htmlToMarkdown('<p>Итого <strong>1000</strong> <em>руб</em> <a href="#">ссылка</a></p>');
    expect(md).toBe('Итого 1000 руб ссылка');
  });

  it('<br> → перевод строки', () => {
    expect(htmlToMarkdown('<p>строка1<br>строка2</p>')).toContain('строка1\nстрока2');
  });
});

describe('htmlToMarkdown — сущности и картинки', () => {
  it('декодирует HTML-сущности', () => {
    const md = htmlToMarkdown('<p>ООО &quot;Ромашка&quot; &amp; Ко &lt;тест&gt; &#8470;5 &nbsp;x</p>');
    expect(md).toContain('ООО "Ромашка" & Ко <тест> №5');
  });

  it('картинки (в т.ч. base64) выбрасываются — не попадают в текст', () => {
    const html =
      '<p>До</p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ" /><p>После</p>';
    const md = htmlToMarkdown(html);
    expect(md).not.toContain('base64');
    expect(md).not.toContain('iVBOR');
    expect(md).toContain('До');
    expect(md).toContain('После');
  });
});

describe('htmlToMarkdown — без регресса на простом doc', () => {
  it('бестабличный текст эквивалентен plain (кириллица цела)', () => {
    const md = htmlToMarkdown('<p>Акт оказанных услуг № 0401-260001</p>');
    expect(md).toBe('Акт оказанных услуг № 0401-260001');
  });

  it('пустой вход → пустая строка', () => {
    expect(htmlToMarkdown('')).toBe('');
    expect(htmlToMarkdown('<p></p>')).toBe('');
  });

  it('схлопывает лишние пустые строки', () => {
    const md = htmlToMarkdown('<p>a</p><p></p><p></p><p>b</p>');
    expect(md).toBe('a\n\nb');
  });
});
