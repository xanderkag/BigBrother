import type { OcrTable } from '../ocr/types.js';
import type { LlmClient } from '../llm/types.js';
import type { DocumentTypeSlug } from '../../types/documents.js';
import { renderReportForPrompt, type TableRegion, type WorkbookReport } from './xlsx-analyze.js';

/**
 * XLSX-FAST (замер 2026-07-24): у Excel таблица уже структурирована, но мы
 * расплющивали её в текст и платили модели 20+ вызовов, чтобы она эту структуру
 * восстановила. У проформ/прайсов/спецификаций это 2-7 минут на документ, при
 * том что само чтение файла — 0.2с. Время растёт строго с числом вызовов;
 * размер файла ни при чём (самые медленные — самые лёгкие, ~334 КБ).
 *
 * Идея: модель отвечает на ОДИН короткий вопрос — «где шапка и какая колонка
 * что означает» — а все строки раскладывает код. 20 вызовов → 1.
 *
 * Здесь — чистая часть (без сети и LLM):
 *   · pickItemTable       — найти на листах область, похожую на таблицу позиций;
 *   · applyColumnMapping  — разложить строки по готовой разметке колонок;
 *   · validateMappedItems — убедиться, что разложили осмысленно, иначе откат.
 *
 * Откат обязателен: кривые листы (объединённые ячейки, несколько таблиц на
 * листе, шапка в середине) быстрым путём не берутся — там работает прежний
 * multipass. Быстрый путь — оптимизация, а не замена.
 */

/** Разметка колонок: где шапка и какое поле схемы в какой колонке. */
export type ColumnMapping = {
  /** Индекс строки-шапки внутри `rows` кандидата. */
  headerRow: number;
  /** Поле схемы (`name`, `quantity`, `price`, …) → индекс колонки. */
  columns: Record<string, number>;
};

/** Область листа, похожая на таблицу позиций. */
export type TableCandidate = {
  sheet: string;
  rows: string[][];
  /** Индекс предполагаемой строки-шапки. */
  headerRowIndex: number;
  /** Первая строка данных (обычно headerRowIndex + 1). */
  dataStartIndex: number;
  /** Сколько строк данных ниже шапки. */
  dataRowCount: number;
  /** Рабочая ширина таблицы (модальное число заполненных колонок). */
  width: number;
  /**
   * Граница области (не включая). Обязательна при множественном выборе: без
   * неё раскладка читала бы до конца листа и захватывала соседние таблицы —
   * позиции задвоились бы.
   */
  dataEndIndex?: number;
};

export type PickOptions = {
  /** Минимум строк данных, чтобы считать область таблицей позиций. */
  minDataRows?: number;
  /** Минимум колонок (одна колонка — это список, а не таблица позиций). */
  minWidth?: number;
};

const DEFAULT_MIN_DATA_ROWS = 5;
const DEFAULT_MIN_WIDTH = 3;

/** Сколько колонок в строке реально заполнено. */
function filledCount(row: string[]): number {
  let n = 0;
  for (const c of row) if (c !== undefined && c !== null && String(c).trim() !== '') n++;
  return n;
}

/**
 * Ищет на одном листе самый длинный подряд идущий блок строк одинаковой
 * «рабочей ширины» — это и есть тело таблицы. Шапкой считаем строку прямо
 * над блоком (если она есть и не пустая).
 *
 * Почему по модальной ширине, а не по первой строке: в реальных прайсах сверху
 * почти всегда шапка документа («Поставщик …», «Прайс-лист от …»), иногда на
 * несколько строк, и она короче тела таблицы. Блок одинаковой ширины отделяет
 * тело от этой шапки надёжнее, чем «первая непустая строка».
 */
function findTableInSheet(
  sheet: string,
  rows: string[][],
  minDataRows: number,
  minWidth: number,
): TableCandidate | null {
  if (rows.length < minDataRows + 1) return null;

  // Модальная ширина по всем непустым строкам.
  const freq = new Map<number, number>();
  for (const r of rows) {
    const w = filledCount(r);
    if (w >= minWidth) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  if (freq.size === 0) return null;
  let width = 0;
  let best = 0;
  for (const [w, count] of freq) {
    // При равенстве частот берём БОЛЬШУЮ ширину: тело таблицы шире служебных строк.
    if (count > best || (count === best && w > width)) {
      best = count;
      width = w;
    }
  }

  // Самый длинный подряд идущий блок строк этой ширины (±1 — хвостовые
  // «Итого» и строки с пропущенной ячейкой не должны рвать блок пополам).
  let runStart = -1;
  let runLen = 0;
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < rows.length; i++) {
    const w = filledCount(rows[i] ?? []);
    const near = Math.abs(w - width) <= 1 && w >= minWidth;
    if (near) {
      if (runStart < 0) runStart = i;
      runLen++;
      if (runLen > bestLen) {
        bestLen = runLen;
        bestStart = runStart;
      }
    } else {
      runStart = -1;
      runLen = 0;
    }
  }
  if (bestStart < 0 || bestLen < minDataRows) return null;

  // Шапка — строка над блоком. Если её нет (блок с самого верха) или она
  // пустая, считаем шапкой первую строку самого блока.
  let headerRowIndex = bestStart - 1;
  let dataStartIndex = bestStart;
  if (headerRowIndex < 0 || filledCount(rows[headerRowIndex] ?? []) === 0) {
    headerRowIndex = bestStart;
    dataStartIndex = bestStart + 1;
  }
  const dataRowCount = bestStart + bestLen - dataStartIndex;
  if (dataRowCount < minDataRows) return null;

  return { sheet, rows, headerRowIndex, dataStartIndex, dataRowCount, width };
}

/**
 * Выбирает среди листов книги наиболее похожий на таблицу позиций —
 * тот, где тело таблицы длиннее. Возвращает null, если ни один лист не
 * тянет (тогда работает прежний текстовый путь).
 */
export function pickItemTable(
  tables: OcrTable[] | undefined,
  opts: PickOptions = {},
): TableCandidate | null {
  if (!tables || tables.length === 0) return null;
  const minDataRows = opts.minDataRows ?? DEFAULT_MIN_DATA_ROWS;
  const minWidth = opts.minWidth ?? DEFAULT_MIN_WIDTH;

  let best: TableCandidate | null = null;
  for (const t of tables) {
    if (!t || !Array.isArray(t.rows)) continue;
    const cand = findTableInSheet(t.sheet, t.rows, minDataRows, minWidth);
    if (!cand) continue;
    if (!best || cand.dataRowCount > best.dataRowCount) best = cand;
  }
  return best;
}

/** Строки-шапки кандидата — то, что показываем модели для разметки колонок. */
export function headerPreview(cand: TableCandidate, sampleRows = 3): string[][] {
  const out: string[][] = [];
  const header = cand.rows[cand.headerRowIndex];
  if (header) out.push(header);
  for (let i = cand.dataStartIndex; i < cand.rows.length && out.length <= sampleRows; i++) {
    const r = cand.rows[i];
    if (r) out.push(r);
  }
  return out;
}

/**
 * Раскладывает строки данных по разметке колонок. Пустые строки и строки без
 * единого размеченного значения пропускаются (хвостовые «Итого»/разделители).
 * Возвращает массив объектов «поле → значение» в исходном строковом виде —
 * приведение типов и нормализация остаются за общим normalize-слоем.
 */
export function applyColumnMapping(
  cand: TableCandidate,
  mapping: ColumnMapping,
): Record<string, string>[] {
  const entries = Object.entries(mapping.columns).filter(
    ([, idx]) => Number.isInteger(idx) && idx >= 0,
  );
  if (entries.length === 0) return [];

  // Разметку могли прислать относительно строки-шапки, отличной от нашей —
  // доверяем присланной, если она валидна (модель видела те же строки).
  const start =
    Number.isInteger(mapping.headerRow) && mapping.headerRow >= 0
      ? mapping.headerRow + 1
      : cand.dataStartIndex;

  // Не выходим за границу области (см. dataEndIndex): при нескольких выбранных
  // областях чтение «до конца листа» захватило бы соседние таблицы.
  const end = Math.min(cand.rows.length, cand.dataEndIndex ?? cand.rows.length);

  const out: Record<string, string>[] = [];
  for (let i = start; i < end; i++) {
    const row = cand.rows[i];
    if (!row || filledCount(row) === 0) continue;
    const item: Record<string, string> = {};
    let any = false;
    for (const [field, idx] of entries) {
      const v = row[idx];
      const s = v === undefined || v === null ? '' : String(v).trim();
      if (s !== '') {
        item[field] = s;
        any = true;
      }
    }
    if (any) out.push(item);
  }
  return out;
}

export type ValidateOptions = {
  /** Поля, которые обязаны быть заполнены у большинства строк. */
  requiredFields?: string[];
  /** Поля, которые должны выглядеть числом у большинства строк. */
  numericFields?: string[];
  /** Какая доля строк должна проходить проверку (0..1). */
  minRatio?: number;
  /** Минимум строк, иначе быстрый путь не оправдан. */
  minItems?: number;
};

export type ValidateResult = {
  ok: boolean;
  /** Причина отказа — уходит в лог, чтобы было видно, почему сработал откат. */
  reason?: string;
  items: number;
};

/** Похоже ли значение на число (допускаем пробелы-разделители и запятую). */
function looksNumeric(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.replace(/[\s ]/g, '').replace(',', '.');
  if (s === '') return false;
  return /^-?\d+(\.\d+)?$/.test(s);
}

/**
 * Проверяет, что раскладка правдоподобна. Смысл — не «доказать корректность»
 * (её докажет обычная валидация полей ниже по пайплайну), а поймать грубый
 * промах разметки: съехали колонки, шапка не там, в «цене» текст. При отказе
 * caller откатывается на multipass — то есть худший исход быстрого пути равен
 * сегодняшнему поведению, а не потере данных.
 */
export function validateMappedItems(
  items: Record<string, string>[],
  opts: ValidateOptions = {},
): ValidateResult {
  const minItems = opts.minItems ?? DEFAULT_MIN_DATA_ROWS;
  const minRatio = opts.minRatio ?? 0.7;
  if (items.length < minItems) {
    return { ok: false, reason: `too_few_items:${items.length}<${minItems}`, items: items.length };
  }
  for (const f of opts.requiredFields ?? []) {
    const filled = items.filter((it) => (it[f] ?? '') !== '').length;
    const ratio = filled / items.length;
    if (ratio < minRatio) {
      return { ok: false, reason: `required_sparse:${f}:${ratio.toFixed(2)}`, items: items.length };
    }
  }
  for (const f of opts.numericFields ?? []) {
    const present = items.filter((it) => (it[f] ?? '') !== '');
    if (present.length === 0) continue; // поля может не быть в этой таблице — не наша забота
    const numeric = present.filter((it) => looksNumeric(it[f])).length;
    const ratio = numeric / present.length;
    if (ratio < minRatio) {
      return { ok: false, reason: `not_numeric:${f}:${ratio.toFixed(2)}`, items: items.length };
    }
  }
  return { ok: true, items: items.length };
}


/** Имена полей позиции из схемы типа — то, что ищем в колонках. */
export function itemFieldNames(itemsSchema: unknown): string[] {
  const s = itemsSchema as { items?: { properties?: Record<string, unknown> } } | undefined;
  const props = s?.items?.properties;
  if (!props || typeof props !== 'object') return [];
  return Object.keys(props);
}

/** Собирает кандидата (со строками листа) из области, найденной анализатором. */
export function regionToCandidate(
  tables: OcrTable[] | undefined,
  region: TableRegion,
): TableCandidate | null {
  const sheet = (tables ?? []).find((t) => t.sheet === region.sheet);
  if (!sheet || !Array.isArray(sheet.rows)) return null;
  return {
    sheet: region.sheet,
    rows: sheet.rows,
    headerRowIndex: region.headerRowIndex,
    dataStartIndex: region.dataStartIndex,
    dataRowCount: region.dataRowCount,
    width: region.width,
    dataEndIndex: region.dataStartIndex + region.dataRowCount,
  };
}

/** Выбор области + разметка колонок, полученные от модели. */
export type RegionChoice = {
  region: TableRegion;
  mapping: ColumnMapping;
};

/**
 * ОДИН вызов модели на весь файл: она видит перечень областей (шапки всех
 * листов + образцы строк + сколько где строк) и отвечает, какая из них —
 * таблица позиций, и какая колонка что означает.
 *
 * Почему выбор отдан модели. Прежняя эвристика брала «самую длинную таблицу»
 * и на боевом прайсе из шести листов выбрала служебный лист: вместо 176
 * позиций извлеклось 10. Размер — плохой признак; понять, что «Артикул |
 * Наименование | Цена» это товары, а «код | значение | примечание» нет,
 * умеет модель. Код при этом по-прежнему считает строки и раскладывает их.
 *
 * Возвращает null при любой неуверенности → caller откатывается на нарезку.
 */
export async function chooseRegionsAndMapColumns(
  llm: LlmClient,
  report: WorkbookReport,
  fields: string[],
  hint?: DocumentTypeSlug,
): Promise<RegionChoice[] | null> {
  if (report.regions.length === 0 || fields.length === 0) return null;

  const text = renderReportForPrompt(report);
  const prompt =
    'Это структура книги Excel: перечислены табличные области с шапками и примерами строк. ' +
    'Найди ВСЕ области, которые содержат ПОЗИЦИИ документа (товары/услуги), и размести поля ' +
    'по колонкам каждой из них. Служебные области (упаковочные листы, справочники, итоги) не бери. ' +
    'ВАЖНО: если несколько областей содержат ОДИН И ТОТ ЖЕ перечень товаров (например перевод на ' +
    'другой язык или дубль того же списка) — верни только ОСНОВНУЮ, иначе позиции задвоятся. ' +
    'Если же позиции документа разбиты по нескольким областям (продолжение списка) — верни все. ' +
    `Доступные поля: ${fields.join(', ')}. ` +
    'Верни regions — массив объектов {region, header_row, mapping}, где region — номер области, ' +
    'header_row — индекс строки заголовков, mapping — массив пар {field, column} ' +
    '(column — номер колонки в квадратных скобках). ' +
    'Включай ТОЛЬКО поля, которые реально есть; не выдумывай отсутствующие. ' +
    'Ориентируйся на СМЫСЛ заголовков, а не на размер области.';

  const schema = {
    type: 'object',
    properties: {
      regions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            region: { type: 'number' },
            header_row: { type: 'number' },
            mapping: {
              type: 'array',
              items: {
                type: 'object',
                properties: { field: { type: 'string' }, column: { type: 'number' } },
              },
            },
          },
        },
      },
    },
  };

  let raw: Record<string, unknown>;
  try {
    const res = await llm.extract({ text, schema, hint, promptOverride: prompt });
    raw = (res.extracted ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }

  const list = raw.regions;
  if (!Array.isArray(list) || list.length === 0) return null;

  const allowed = new Set(fields);
  const out: RegionChoice[] = [];
  const seenRegions = new Set<number>();

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const idx = typeof e.region === 'number' ? e.region : Number.parseInt(String(e.region), 10);
    const region = report.regions.find((r) => r.index === idx);
    // Одну и ту же область дважды не берём — иначе позиции задвоятся.
    if (!region || seenRegions.has(idx)) continue;

    const pairs = e.mapping;
    if (!Array.isArray(pairs) || pairs.length === 0) continue;

    const width = Math.max(region.width, region.header.length);
    const columns: Record<string, number> = {};
    for (const p of pairs) {
      if (!p || typeof p !== 'object') continue;
      const field = (p as { field?: unknown }).field;
      const column = (p as { column?: unknown }).column;
      if (typeof field !== 'string' || !allowed.has(field)) continue;
      const c = typeof column === 'number' ? column : Number.parseInt(String(column), 10);
      // Колонка вне таблицы — промах модели; такое поле не берём.
      if (!Number.isInteger(c) || c < 0 || c >= width) continue;
      columns[field] = c;
    }
    if (Object.keys(columns).length === 0) continue;

    const hr = e.header_row;
    const headerRow =
      typeof hr === 'number' && Number.isInteger(hr) && hr >= 0 ? hr : region.headerRowIndex;

    seenRegions.add(idx);
    out.push({ region, mapping: { headerRow, columns } });
  }

  return out.length > 0 ? out : null;
}
