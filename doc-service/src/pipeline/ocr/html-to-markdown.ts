/**
 * Узкий HTML→Markdown конвертер для вывода mammoth.convertToHtml (P1-A ТЗ
 * OFFICE_FILES_V2). Задача одна: НЕ плющить таблицы Word в поток строк, а
 * отдавать их pipe-таблицами, чтобы LLM видел «строка × колонка».
 *
 * НЕ универсальный HTML-парсер. Заточен под чистый и предсказуемый выход
 * mammoth: <p>, <h1..6>, <table><tr><td>, <ul>/<ol><li>, <strong>/<em>,
 * <a>, <br>, <img>. Никаких новых тяжёлых зависимостей (jsdom/turndown) —
 * project ethos «лёгкий стек».
 *
 * Стратегия по таблицам: конвертируем ВНУТРЕННИЕ таблицы первыми (regex,
 * не содержащий вложенного <table>), заменяя их на markdown-текст; тогда
 * внешняя таблица видит вложенную уже как текст ячейки.
 * KNOWN LIMITATION: при вложенности внутренняя таблица схлопывается cleanCell'ом
 * в ОДНУ строку ячейки (pipe-разметка теряется) — структура вложенной таблицы
 * не сохраняется, только её текст. В ВЭД-доках вложенные таблицы редки, поэтому
 * приемлемо: разбор не ломается, контент не теряется, деградирует только форма.
 */

/** Декодирует базовые HTML-сущности. &amp; — последним, чтобы не двойного декода. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => safeCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function safeCodePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/** Содержимое ячейки → одна плоская строка. Экранирует pipe, чтобы не рвать колонку. */
function cleanCell(html: string): string {
  const text = decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|tr)>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  );
  return text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

/** Тело одной таблицы (без вложенных <table>) → markdown pipe-таблица. */
function tableBodyToMarkdown(body: string): string {
  const rowMatches = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  const rows: string[][] = [];
  for (const rm of rowMatches) {
    const cells = [...(rm[1] ?? '').matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
      cleanCell(c[1] ?? ''),
    );
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return '';

  const cols = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]): string[] => {
    const out = r.slice(0, cols);
    while (out.length < cols) out.push('');
    return out;
  };
  const line = (r: string[]): string => `| ${pad(r).join(' | ')} |`;

  const out: string[] = [];
  out.push(line(rows[0]!));
  out.push(`| ${Array(cols).fill('---').join(' | ')} |`);
  for (let i = 1; i < rows.length; i++) out.push(line(rows[i]!));
  return out.join('\n');
}

/** Все таблицы (внутренние → внешние) заменяются на markdown-текст. */
function convertTables(html: string): string {
  // Таблица без вложенного <table> = самая внутренняя. Крутим, пока есть.
  const innermost = /<table\b[^>]*>((?:(?!<table\b)[\s\S])*?)<\/table>/i;
  let out = html;
  // Ограничитель на случай патологического ввода — не крутить бесконечно.
  for (let guard = 0; guard < 1000; guard++) {
    const m = out.match(innermost);
    if (!m || m.index === undefined) break;
    const full = m[0] ?? '';
    const md = tableBodyToMarkdown(m[1] ?? '');
    out = out.slice(0, m.index) + `\n\n${md}\n\n` + out.slice(m.index + full.length);
  }
  return out;
}

/**
 * Конвертирует HTML (выход mammoth) в markdown-текст, пригодный для
 * classifier + LLM extract. Таблицы → pipe-таблицы; заголовки/списки/абзацы
 * сохранены; картинки и inline-разметка выброшены.
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  let s = html;

  // 1. Убираем картинки (mammoth инлайнит base64 — не тащим в текст) и комменты.
  s = s.replace(/<img\b[^>]*>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // 2. Таблицы → markdown (до общей обработки блоков).
  s = convertTables(s);

  // 3. Заголовки → '#'-разметка.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lvl: string, inner: string) => {
    const text = cleanInline(inner);
    return text ? `\n\n${'#'.repeat(Number(lvl))} ${text}\n\n` : '\n\n';
  });

  // 4. Списки → '- item'.
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => {
    const text = cleanInline(inner);
    return text ? `\n- ${text}` : '';
  });
  s = s.replace(/<\/(ul|ol)>/gi, '\n');

  // 5. Абзацы / переводы строк.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/p>/gi, '\n\n');

  // 6. Снимаем остатки тегов, декодируем сущности.
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);

  // 7. Нормализация пробелов: обрезаем хвосты строк, схлопываем 3+ пустых.
  s = s
    .split('\n')
    .map((ln) => ln.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return s;
}

/** Inline-содержимое (заголовок/пункт списка) → плоский текст без тегов. */
function cleanInline(html: string): string {
  return decodeEntities(
    html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}
