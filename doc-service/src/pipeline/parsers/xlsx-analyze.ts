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
 * Сколько строк-разделителей допускается между шапкой и телом таблицы.
 * Нужно, когда шапка отделена от данных пустой строкой или строкой-заголовком
 * («ГРУЗ»): тогда шапка остаётся в предыдущем блоке, и её надо подобрать.
 */
const MAX_SEPARATOR_ROWS = 2;

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

    // Границу «преамбула / данные» задаёт СТРОКА ЗАГОЛОВКОВ — самая широкая
    // строка блока. Всё, что выше неё, к таблице не относится.
    //
    // Почему не по ширине строк (боевой прайс 2026-07-24). Сверху к таблице
    // примыкает преамбула документа («Contract: EWL-ZBF/250423»,
    // «Terms of delivery: FOB, Shanghai») — по две заполненные ячейки, разрыва
    // между ней и таблицей нет. Напрашивалось «считать телом только достаточно
    // широкие строки», но данные это опровергли: в том же прайсе узкие строки
    // по две ячейки — это КОМПЛЕКТУЮЩИЕ набора («CX0898H/white ┃ plastic
    // armrest»), цена стоит только у головной строки. Структурно они
    // неотличимы от преамбулы, и порог по ширине резал таблицу с 18 строк до 8.
    //
    // Строка заголовков различает их надёжно: она шире всех (заполнены все
    // колонки), и она ровно там, где начинается таблица.
    let headerIdx = from;
    let headerWidth = 0;
    for (let i = from; i < endExclusive; i++) {
      const w = filled(rows[i]);
      if (w > headerWidth) {
        headerWidth = w;
        headerIdx = i;
      }
    }

    // Шапка могла остаться в ПРЕДЫДУЩЕМ блоке — если между ней и данными есть
    // строка-разделитель. Тогда весь текущий блок это данные, а шапку берём
    // сверху (боевой инвойс: шапка на строке 9, разделитель на 10, товары с 11).
    let k = from - 1;
    let skipped = 0;
    while (k >= 0 && filled(rows[k]) <= 1 && skipped < MAX_SEPARATOR_ROWS) {
      k--;
      skipped++;
    }
    const aboveWidth = k >= 0 ? filled(rows[k]) : 0;
    const useAbove = k >= 0 && aboveWidth > headerWidth;

    const headerRowIndex = useAbove ? k : headerIdx;
    const dataStartIndex = useAbove ? from : headerIdx + 1;
    const dataRowCount = endExclusive - dataStartIndex;
    if (dataRowCount < opts.minDataRows) return;

    const samples: string[][] = [];
    for (let i = dataStartIndex; i < endExclusive && samples.length < opts.sampleRows; i++) {
      const r = rows[i];
      if (r && filled(r) > 0) samples.push(r);
    }
    out.push({
      sheet,
      headerRowIndex,
      dataStartIndex,
      dataRowCount,
      width: Math.max(width, headerWidth),
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
