import type { OcrTable } from '../ocr/types.js';

/**
 * XLSX-ANALYZE: структурный разбор книги Excel ДО обращения к модели.
 *
 * Зачем понадобился (боевой замер 2026-07-24). Первая версия быстрого пути
 * выбирала «самую длинную таблицу» и на реальном прайсе из шести листов
 * (PRICE LIST, перевод, PACKING, pl, INVOICE, Лист3) взяла служебный «Лист3»:
 * вместо 176 позиций извлеклось 10. Проверка это пропустила — выбранные строки
 * были внутренне корректны, просто НЕ ТА таблица.
 *
 * Вывод: выбор области — не задача эвристики. Код должен ПЕРЕЧИСЛИТЬ все
 * кандидаты (это он умеет надёжно), а какой из них таблица позиций — решает
 * модель, видя шапки всех листов сразу. Плюс код обязан посчитать, сколько
 * строк в файле есть на самом деле, чтобы поймать недобор.
 *
 * Здесь только детерминированная часть: ни сети, ни LLM.
 */

/** Найденная табличная область — кандидат на таблицу позиций. */
export type TableRegion = {
  /** Индекс в `WorkbookReport.regions` — им модель и отвечает. */
  index: number;
  sheet: string;
  /** Индекс строки-шапки внутри строк листа. */
  headerRowIndex: number;
  /** Первая строка данных. */
  dataStartIndex: number;
  /** Сколько строк данных в области (основа сторожа полноты). */
  dataRowCount: number;
  /** Рабочая ширина (число заполненных колонок в теле). */
  width: number;
  /** Ячейки строки-шапки — по ним модель понимает, что это за таблица. */
  header: string[];
  /** Пара строк-образцов, чтобы отличить товары от служебных списков. */
  samples: string[][];
};

export type WorkbookReport = {
  /** Краткая сводка по листам — включая пропущенные (пустые/узкие). */
  sheets: Array<{ name: string; rows: number; regions: number }>;
  /** Все найденные области, отсортированы по убыванию числа строк. */
  regions: TableRegion[];
  /** Сумма строк по ВСЕМ областям — верхняя оценка «сколько позиций в файле». */
  totalDataRows: number;
};

export type AnalyzeOptions = {
  /** Минимум строк данных, чтобы область считалась таблицей. */
  minDataRows?: number;
  /** Минимум колонок (одна-две — это список, а не таблица позиций). */
  minWidth?: number;
  /** Сколько строк-образцов класть в отчёт. */
  sampleRows?: number;
  /** Потолок числа областей в отчёте (чтобы промпт не разбухал). */
  maxRegions?: number;
};

const DEFAULTS = {
  minDataRows: 4,
  minWidth: 3,
  sampleRows: 2,
  maxRegions: 12,
};

/**
 * Какую долю от максимальной ширины блока должна иметь строка, чтобы считаться
 * телом таблицы. Ниже — это преамбула («Условия поставки: FOB»), выше — данные.
 * Доля, а не «±1 колонка»: в живых таблицах часть ячеек законно пуста.
 */
const BODY_WIDTH_RATIO = 0.5;

function filled(row: string[] | undefined): number {
  if (!row) return 0;
  let n = 0;
  for (const c of row) if (c !== undefined && c !== null && String(c).trim() !== '') n++;
  return n;
}

/**
 * Находит на листе ВСЕ табличные блоки.
 *
 * ВАЖНО про «рваные» строки. Первая версия рвала блок при любом изменении
 * ширины больше чем на ±1 — и на боевой книге раздробила таблицу из 29 строк
 * на огрызки по 8 и 6 (в живых таблицах часть ячеек пуста: нет артикула, нет
 * страны, объединённые ячейки). Последствия были хуже, чем «нашли не всё»:
 * сторож полноты сравнивал извлечённое с этим же заниженным счётом и считал
 * потерю 84% полным охватом.
 *
 * Теперь блок рвётся ТОЛЬКО на разрыве содержимого — пустой строке или строке
 * с одной заполненной ячейкой (подзаголовок/разделитель). Ширина блока — МАКСИМУМ
 * по его строкам, а не «мода». Соседние таблицы без пустой строки между ними
 * могут слипнуться — это допустимо: какие строки брать, решает разметка колонок,
 * а лишние отсеются (строка без единого размеченного значения пропускается).
 */
function findRegionsInSheet(
  sheet: string,
  rows: string[][],
  opts: Required<AnalyzeOptions>,
): Omit<TableRegion, 'index'>[] {
  const out: Omit<TableRegion, 'index'>[] = [];
  if (rows.length < opts.minDataRows + 1) return out;

  let runStart = -1;
  let runWidth = 0;

  const closeRun = (endExclusive: number): void => {
    const from = runStart;
    const width = runWidth;
    runStart = -1;
    runWidth = 0;
    if (from < 0 || width < opts.minWidth) return;

    // Тело таблицы ВНУТРИ блока: самая длинная непрерывная полоса строк,
    // сопоставимых по ширине с максимумом блока.
    //
    // Зачем (боевой прайс 2026-07-24). Разрыв содержимого — надёжная граница
    // блока, но недостаточная: сверху к таблице примыкает преамбула документа
    // («Contract: EWL-ZBF/250423», «Terms of delivery: FOB, Shanghai») — по две
    // заполненные ячейки в строке, разрыва между ней и таблицей нет. Блок
    // склеивался целиком, и в отчёт для модели как шапка и примеры уходила
    // ПРЕАМБУЛА. Товаров в описании области видно не было, и модель разумно
    // выбирала другой лист, где примеры выглядели товарами (8 строк вместо 23).
    //
    // Порог по ДОЛЕ от максимума, а не «±1 колонка»: жёсткое равенство ширины
    // дробило живые таблицы на огрызки (часть ячеек законно пуста).
    const bodyThreshold = Math.max(2, Math.ceil(width * BODY_WIDTH_RATIO));
    let bodyStart = -1;
    let bodyLen = 0;
    let curStart = -1;
    let curLen = 0;
    for (let i = from; i < endExclusive; i++) {
      if (filled(rows[i]) >= bodyThreshold) {
        if (curStart < 0) curStart = i;
        curLen++;
        if (curLen > bodyLen) {
          bodyLen = curLen;
          bodyStart = curStart;
        }
      } else {
        curStart = -1;
        curLen = 0;
      }
    }
    if (bodyStart < 0) return;
    const bodyEnd = bodyStart + bodyLen;

    // Шапкой считаем строку НАД телом только если она сопоставимой ширины.
    // Иначе это преамбула или заголовок документа — принимать его за шапку
    // нельзя: данные съедут на строку. Тогда шапка — первая строка тела.
    const above = bodyStart - 1;
    const headerAbove = above >= from && filled(rows[above]) >= bodyThreshold;
    const headerRowIndex = headerAbove ? above : bodyStart;
    const dataStartIndex = headerAbove ? bodyStart : bodyStart + 1;
    const dataRowCount = bodyEnd - dataStartIndex;
    if (dataRowCount < opts.minDataRows) return;

    const samples: string[][] = [];
    for (let i = dataStartIndex; i < bodyEnd && samples.length < opts.sampleRows; i++) {
      const r = rows[i];
      if (r && filled(r) > 0) samples.push(r);
    }
    out.push({
      sheet,
      headerRowIndex,
      dataStartIndex,
      dataRowCount,
      width,
      header: rows[headerRowIndex] ?? [],
      samples,
    });
  };

  for (let i = 0; i < rows.length; i++) {
    const w = filled(rows[i]);
    // Разрыв содержимого: пусто или одна ячейка (разделитель/подзаголовок).
    if (w <= 1) {
      closeRun(i);
      continue;
    }
    if (runStart < 0) runStart = i;
    runWidth = Math.max(runWidth, w);
  }
  closeRun(rows.length);
  return out;
}

/**
 * Строит структурный отчёт по книге: какие листы, какие в них табличные
 * области, сколько в каждой строк. Отчёт компактен — его целиком можно
 * показать модели, чтобы она выбрала нужную область по смыслу.
 */
export function analyzeWorkbook(
  tables: OcrTable[] | undefined,
  options: AnalyzeOptions = {},
): WorkbookReport {
  const opts = { ...DEFAULTS, ...options } as Required<AnalyzeOptions>;
  const sheets: WorkbookReport['sheets'] = [];
  const all: Omit<TableRegion, 'index'>[] = [];

  for (const t of tables ?? []) {
    if (!t || !Array.isArray(t.rows)) continue;
    const found = findRegionsInSheet(t.sheet, t.rows, opts);
    sheets.push({ name: t.sheet, rows: t.rows.length, regions: found.length });
    all.push(...found);
  }

  // Крупные области вперёд: если модель почему-то не ответит, разумный дефолт —
  // самая большая. Но выбор всё равно за моделью (см. XLSX-ANALYZE-2).
  all.sort((a, b) => b.dataRowCount - a.dataRowCount);
  const regions = all.slice(0, opts.maxRegions).map((r, i) => ({ ...r, index: i }));

  return {
    sheets,
    regions,
    // Считаем по ВСЕМ найденным (не только попавшим в срез) — сторож полноты
    // должен знать реальный объём файла, а не усечённый для промпта.
    totalDataRows: all.reduce((n, r) => n + r.dataRowCount, 0),
  };
}

/**
 * Компактное текстовое представление отчёта для промпта: перечень областей с
 * шапками и образцами. Модель отвечает номером области — ей не нужно видеть
 * все строки, только «что где лежит».
 */
export function renderReportForPrompt(report: WorkbookReport, maxCells = 12): string {
  const lines: string[] = [];
  lines.push(
    `Листы: ${report.sheets.map((s) => `${s.name}(строк ${s.rows}, таблиц ${s.regions})`).join(', ')}`,
  );
  lines.push('');
  for (const r of report.regions) {
    const head = r.header.slice(0, maxCells).map((c, i) => `[${i}] ${c || '—'}`).join(' | ');
    lines.push(`Область ${r.index}: лист "${r.sheet}", строк данных ${r.dataRowCount}, колонок ${r.width}`);
    lines.push(`  шапка: ${head}`);
    for (const s of r.samples) {
      lines.push(`  пример: ${s.slice(0, maxCells).join(' | ')}`);
    }
  }
  return lines.join('\n');
}
