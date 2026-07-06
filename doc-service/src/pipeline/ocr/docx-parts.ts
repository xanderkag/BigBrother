/**
 * Извлечение колонтитулов docx (P2.2 OFFICE_FILES_V2). mammoth.convertToHtml
 * НЕ отдаёт header/footer — а в русских договорах/актах реквизиты (ИНН/КПП/
 * банк/подпись) часто живут именно в футере. Дочитываем word/header*.xml и
 * word/footer*.xml напрямую из docx-zip (jszip — прямая зависимость mammoth)
 * и приклеиваем к тексту отдельной секцией.
 *
 * Видимый текст в OOXML — только внутри `<w:t>`. Разбираем последовательным
 * сканом: `<w:t>` → текст, `</w:p>` → перевод строки, `<w:tab>/<w:br>` → пробел.
 * `<w:instrText>` (коды полей PAGE/DATE) намеренно игнорируем — не `<w:t>`.
 */
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

/** Декод базовых XML-сущностей (5 предопределённых + числовые). */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => codePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => codePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/**
 * XML одного header/footer-парта → плоский текст. Чистая функция (юнит-тест
 * без реального docx). Только `<w:t>`-содержимое; абзац → перевод строки.
 */
export function docxXmlToText(xml: string): string {
  if (!xml) return '';
  const lines: string[] = [];
  let cur = '';
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<\/w:p>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== undefined) {
      cur += decodeXml(m[1]);
    } else if (m[0].startsWith('<w:tab') || m[0].startsWith('<w:br')) {
      cur += ' ';
    } else {
      // </w:p> — конец абзаца
      lines.push(cur.replace(/[ \t]+/g, ' ').trim());
      cur = '';
    }
  }
  const tail = cur.replace(/[ \t]+/g, ' ').trim();
  if (tail) lines.push(tail);
  return lines.filter((l) => l.length > 0).join('\n').trim();
}

/**
 * Читает все word/header*.xml и word/footer*.xml из docx и возвращает их текст
 * одной строкой (по абзацам). Пусто → ''. Не бросает: битый zip/парт → skip.
 */
export async function readDocxHeadersFooters(filePath: string): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await readFile(filePath));
  } catch {
    return '';
  }
  const names = Object.keys(zip.files)
    .filter((n) => /^word\/(header|footer)\d*\.xml$/i.test(n))
    .sort();
  const parts: string[] = [];
  for (const n of names) {
    try {
      const xml = await zip.files[n]!.async('string');
      const text = docxXmlToText(xml);
      if (text) parts.push(text);
    } catch {
      /* один битый парт не роняет остальное */
    }
  }
  return parts.join('\n');
}
