/**
 * MultiPassLlmParser — извлечение из «длинных» документов через два прохода.
 *
 * Зачем:
 *   - Стандартный single-pass extract на счёте с 200+ позициями превышает
 *     эффективный context window недорогих моделей (Qwen-7B, Llama-8B) и
 *     стоит дорого даже на Claude/GPT — весь текст уходит в каждый запрос.
 *   - Часто модель «теряет середину»: первые и последние строки извлекает
 *     правильно, а в середине пропускает или галлюцинирует.
 *
 * Стратегия:
 *   1. Pass 1 — header. Подаём первую и последнюю страницы (≈ первые 4KB
 *      и последние 2KB текста) + урезанную схему БЕЗ items[]. Модель
 *      возвращает шапку: parties, totals, vat_summary, currency, flags.
 *   2. Pass 2 — items батчами. Текст разбивается на куски ~10-15KB по
 *      двойным переводам строк (граница между табличными блоками или
 *      страницами). Каждый кусок идёт отдельным extract-вызовом с
 *      минимальной схемой { items: [...] }, параллельно (max 3).
 *   3. Merge. Результаты items[] конкатенируются с пересчётом line_no.
 *      Header'ные поля из Pass 1 побеждают.
 *
 * Когда активируется:
 *   - В Document Type Registry для типа задано `parser_kind='llm_extract_multipass'`
 *   - ИЛИ автоматически: если `parser_kind='llm_extract'` И размер OCR-текста
 *     > MULTIPASS_AUTO_THRESHOLD (env, default 30_000 байт).
 *
 * Защита:
 *   - MAX_PASSES (default 10) — не разбиваем на > 10 кусков, чтобы не уйти
 *     в timeout-цепочку. Если документ требует больше — обрезается с
 *     _truncated=true в extracted.
 *   - MAX_ITEMS_TOTAL (default 1000) — финальный items[] не превышает.
 *   - Если Pass 1 провалился — fallback на single-pass extract.
 *   - Если кусок Pass 2 вернул не-массив или упал — в issues идёт
 *     `multipass_chunk_failed:N`, остальные куски продолжают работать.
 */

import type { DocumentTypeSlug } from '../../types/documents.js';
import type { LlmClient, LlmExtractDebug } from '../llm/types.js';
import type { DocumentParser, ParseResult, ParserOverride } from './types.js';
import {
  itemFieldNames,
  chooseRegionsAndMapColumns,
  regionToCandidate,
  applyColumnMapping,
  validateMappedItems,
} from './xlsx-table-map.js';
import { analyzeWorkbook } from './xlsx-analyze.js';

/** Пороги multipass — приходят из config.multipass (env), см. config.ts. */
export type MultipassConfig = {
  headerHeadBytes: number;
  headerTailBytes: number;
  chunkSizeBytes: number;
  maxPasses: number;
  maxItemsTotal: number;
  itemsParallelism: number;
  /**
   * SPEED-1 (2026-07-21, по ExtractBench): предиктор провала извлечения —
   * объём ВЫХОДА, не входа (883 вых. токена → 56% успеха, 25К → 21%).
   * Поэтому кусок закрывается при N строках-кандидатах (≈ N позиций × 20
   * полей ≈ 2-4К выходных токенов), а chunkSizeBytes остаётся верхним
   * пределом для прозы (длинные .doc без табличных строк).
   */
  targetRowsPerChunk: number;
  /**
   * XLSX-FAST: пробовать раскладку позиций по структуре таблицы Excel.
   * Когда движок отдал матрицу (`override.tables`), модель отвечает на ОДИН
   * вопрос «где шапка и что в колонках», а строки раскладывает код — вместо
   * 20+ вызовов на перепечатку таблицы. Любая неуверенность (не нашли таблицу,
   * модель не разметила, проверка не прошла) → молчаливый откат на нарезку,
   * то есть худший исход равен сегодняшнему поведению.
   * Выключено по умолчанию — включаем флагом после замера на боевых доках.
   */
  xlsxFastPath: boolean;
};

/** Дефолты на случай прямого инстанцирования (тесты) без явного config'а. */
const DEFAULT_MULTIPASS_CONFIG: MultipassConfig = {
  headerHeadBytes: 4_000,
  headerTailBytes: 2_000,
  chunkSizeBytes: 12_000,
  // 24 (было 10): куски стали мельче (по строкам), а параллелизм вырос —
  // 24 куска при parallelism 6 = 4 волны. Молчаливый обрез хвоста на
  // больших доках (>10 кусков) терял товарные строки без следа.
  maxPasses: 24,
  maxItemsTotal: 1_000,
  itemsParallelism: 3,
  targetRowsPerChunk: 30,
  xlsxFastPath: false,
};

/**
 * Токены имён полей для проверки раскладки XLSX-FAST. Сравниваем именно
 * токенами (`country_of_origin` → [country, of, origin]), а не подстрокой:
 * подстрочная версия ловила «count» внутри «country» и браковала верную
 * разметку боевого прайса.
 */
/**
 * Пороги сторожей полноты.
 *
 * `REGION_COVERAGE_MIN` — сколько строк выбранной области обязано доехать до
 * результата (почти все; запас на дубли и хвостовые «Итого»).
 *
 * `DOC_COVERAGE_MIN` — доля табличных строк ТЕКСТА документа, ниже которой в
 * маркер пишется расхождение. Это уже НЕ порог отказа: в книге лежат не только
 * позиции (справочники, упаковочные листы, переводы), и сравнение со всеми
 * строками текста браковало правильный ответ.
 */
const REGION_COVERAGE_MIN = 0.9;
const DOC_COVERAGE_MIN = 0.25;

const NUMERIC_TOKENS = new Set([
  'qty', 'quantity', 'count', 'price', 'amount', 'sum', 'total', 'cost',
  'rate', 'weight', 'netweight', 'grossweight', 'volume', 'pcs', 'value',
]);
/**
 * Поля-наименования В ПОРЯДКЕ ПРИОРИТЕТА. Обязательным для проверки берём
 * первое найденное ПО ЭТОМУ СПИСКУ, а не первое попавшееся «name-подобное».
 *
 * Откуда правило (боевой замер 2026-07-24). В списке были ещё `article`, `sku`,
 * `model` — идентификаторы, а не наименования. Проверка брала первое совпадение
 * в порядке, в котором поля вернула модель, и на боевых прайсах требовала
 * заполненный **артикул**: `xlsx_fast_rejected:required_sparse:sku:0.60`.
 * Артикул есть не у каждого товара — 60% это норма, а не промах разметки.
 * Быстрый путь из-за этого не сработал НИ РАЗУ, оба замера показали прежний
 * путь. Идентификатор обязательным полем быть не может: нет наименования в
 * разметке — не требуем ничего, полноту стерегут другие проверки.
 */
const PRIMARY_NAME_TOKENS = ['name', 'description', 'title', 'goods', 'product'];

/** Поле-наименование для проверки обязательности (по приоритету, не по порядку модели). */
export function pickNameField(fields: string[]): string | undefined {
  for (const token of PRIMARY_NAME_TOKENS) {
    const hit = fields.find((f) => fieldTokens(f).includes(token));
    if (hit) return hit;
  }
  return undefined;
}

/** Разбивает имя поля на токены: snake_case, camelCase, дефисы, цифры. */
export function fieldTokens(field: string): string[] {
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

function hasToken(field: string, tokens: Set<string>): boolean {
  return fieldTokens(field).some((t) => tokens.has(t));
}

export class MultiPassLlmParser implements DocumentParser {
  readonly type: DocumentTypeSlug;
  private readonly cfg: MultipassConfig;

  constructor(
    private readonly llm: LlmClient,
    slug: DocumentTypeSlug,
    cfg: MultipassConfig = DEFAULT_MULTIPASS_CONFIG,
  ) {
    this.type = slug;
    this.cfg = cfg;
  }

  /**
   * XLSX-FAST: разложить позиции по структуре таблицы Excel вместо перепечатки
   * её моделью. Анализатор перечисляет области, модель ОДНИМ вызовом выбирает
   * нужную и размечает колонки, код раскладывает все строки.
   *
   * Возвращает null при любой неуверенности → caller идёт прежней нарезкой,
   * то есть худший исход равен сегодняшнему поведению. Каждый выход именован:
   * по проду видно, где именно путь не сработал.
   */
  private async tryTableFastPath(
    override: ParserOverride,
    itemsSchema: { properties?: Record<string, unknown> },
    rawText: string,
    issues: string[],
  ): Promise<unknown[] | null> {
    const report = analyzeWorkbook(override.tables);
    if (report.regions.length === 0) {
      issues.push(`xlsx_fast_no_table:sheets=${override.tables?.length ?? 0}`);
      return null;
    }

    const fields = itemFieldNames(itemsSchema.properties?.items);
    if (fields.length === 0) {
      issues.push('xlsx_fast_no_item_fields');
      return null;
    }

    const choices = await chooseRegionsAndMapColumns(this.llm, report, fields, this.type);
    if (!choices || choices.length === 0) {
      issues.push('xlsx_fast_mapping_failed');
      return null;
    }

    // Позиции документа нередко разбиты по нескольким листам (продолжение
    // списка), поэтому собираем из всех выбранных областей.
    //
    // Дубли снимаем ТОЛЬКО МЕЖДУ областями. Внутри одной таблицы строка — это
    // строка: в боевом прайсе комплектующие набора («plastic armrest (1pair)»)
    // законно повторяются у белого и чёрного исполнения, и сквозной дедуп съел
    // их как дубли — 14 разложенных строк из 18, отказ по охвату области.
    // Между областями дедуп нужен: модель могла указать и перевод того же
    // перечня, несмотря на инструкцию.
    const items: Record<string, string>[] = [];
    const seen = new Set<string>();
    let expectedRows = 0;
    const usedRegions: string[] = [];
    for (const choice of choices) {
      const cand = regionToCandidate(override.tables, choice.region);
      if (!cand) continue;
      expectedRows += choice.region.dataRowCount;
      usedRegions.push(`${choice.region.index}:${choice.region.sheet}`);
      const first = items.length === 0;
      const fromRegion: Record<string, string>[] = [];
      for (const it of applyColumnMapping(cand, choice.mapping)) {
        const key = itemDedupKey(it);
        if (!first && key !== null && seen.has(key)) continue;
        fromRegion.push(it);
      }
      for (const it of fromRegion) {
        const key = itemDedupKey(it);
        if (key !== null) seen.add(key);
      }
      items.push(...fromRegion);
    }
    if (items.length === 0) {
      issues.push('xlsx_fast_region_lost');
      return null;
    }

    const mapped = Array.from(new Set(choices.flatMap((c) => Object.keys(c.mapping.columns))));
    // Числовыми считаем поля с «денежно-количественными» именами, обязательным —
    // первое поле-наименование. Сравниваем ТОКЕНЫ, а не подстроки: подстрочная
    // версия ловила «count» внутри «country» и браковала верную разметку.
    const numericFields = mapped.filter((f) => hasToken(f, NUMERIC_TOKENS));
    const nameLike = pickNameField(mapped);
    const validation = validateMappedItems(items, {
      requiredFields: nameLike ? [nameLike] : [],
      numericFields,
    });
    if (!validation.ok) {
      issues.push(`xlsx_fast_rejected:${validation.reason ?? 'unknown'}`);
      return null;
    }

    // ── Сторожа полноты ────────────────────────────────────────────────────
    // Без них «быстро» побеждало «правильно»: на боевом прайсе путь взял не ту
    // таблицу и извлёк горстку позиций — по времени это выглядело ускорением.
    // Полнота важнее скорости: не сошлось — идём медленным путём.

    // 1. Внутри выбранных областей не потеряли строки (дубли учтены — потому
    // сравниваем с запасом, а не один-в-один).
    if (expectedRows > 0 && items.length < expectedRows * REGION_COVERAGE_MIN) {
      issues.push(`xlsx_fast_incomplete_region:${items.length}/${expectedRows}`);
      return null;
    }

    // 2. Проверка САМОГО ВЫБОРА, без семантики: модель не вправе пропустить
    // область КРУПНЕЕ любой из взятых. Именно этим кончился первый боевой
    // промах — взяли служебную табличку, а таблицу товаров вчетверо больше
    // проигнорировали. Пропустить область поменьше — законно (упаковочный
    // лист, итоги, перевод того же перечня), пропустить самую большую — нет.
    const chosen = new Set(choices.map((c) => c.region.index));
    let biggestSkipped: { index: number; sheet: string; rows: number } | null = null;
    for (const r of report.regions) {
      if (chosen.has(r.index)) continue;
      if (!biggestSkipped || r.dataRowCount > biggestSkipped.rows) {
        biggestSkipped = { index: r.index, sheet: r.sheet, rows: r.dataRowCount };
      }
    }
    const maxChosen = choices.reduce((n, c) => Math.max(n, c.region.dataRowCount), 0);
    if (biggestSkipped && biggestSkipped.rows > maxChosen) {
      issues.push(
        `xlsx_fast_skipped_bigger:${biggestSkipped.index}:${biggestSkipped.sheet}:` +
          `${biggestSkipped.rows}>${maxChosen}`,
      );
      return null;
    }

    // 3. Сверка с текстом документа — ТОЛЬКО пометка, не отказ.
    //
    // Раньше здесь стоял жёсткий порог «извлеки хотя бы четверть табличных
    // строк текста», и он был неверен по существу: в книге лежат не только
    // позиции. На боевом прайсе (2026-07-24) отдельный лист оказался
    // справочником наименований на 112 строк — без цен и количеств. Прежний
    // (медленный) путь превращал их в «позиции»: из 176 строк 95 были без цены
    // и количества, 15 вообще без наименования. Порог, настроенный на такой
    // «эталон», браковал бы правильный ответ. Поэтому расхождение теперь
    // ВИДНО в маркере, но решения не принимает.
    const docRows = countTableRows(rawText);
    const docNote =
      docRows > 0 && items.length < docRows * DOC_COVERAGE_MIN
        ? `,doc_rows=${items.length}/${docRows}`
        : '';
    const skippedNote = biggestSkipped
      ? `,skipped_max=${biggestSkipped.sheet}:${biggestSkipped.rows}`
      : '';

    issues.push(
      `xlsx_fast_used:rows=${items.length},cols=${mapped.length},` +
        `regions=${usedRegions.join('+')}${skippedNote}${docNote}`,
    );
    return items;
  }

  async parse(rawText: string, override?: ParserOverride): Promise<ParseResult> {
    if (!this.llm.isAvailable()) {
      return { extracted: {}, confidence: 0, missing: [...(override?.expectedFields ?? [])] };
    }

    const schema = (override?.llmSchema ?? {}) as { type?: string; properties?: Record<string, unknown> };
    const properties = (schema.properties ?? {}) as Record<string, unknown>;

    // Делим схему на header (без items) и items-only для Pass 2.
    const headerProperties: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(properties)) {
      if (key !== 'items') headerProperties[key] = val;
    }
    const headerSchema = {
      type: 'object' as const,
      properties: headerProperties,
    };
    const itemsSchema = properties.items
      ? { type: 'object' as const, properties: { items: properties.items } }
      : null;

    // ── Pass 1: header ────────────────────────────────────────────────────
    const headerText = sliceHead(rawText, this.cfg.headerHeadBytes) +
      (rawText.length > this.cfg.headerHeadBytes + this.cfg.headerTailBytes
        ? '\n\n[…пропущена середина документа…]\n\n' + sliceTail(rawText, this.cfg.headerTailBytes)
        : '');

    let headerResult: ReturnType<LlmClient['extract']> extends Promise<infer R> ? R : never;
    try {
      headerResult = await this.llm.extract({
        text: headerText,
        schema: headerSchema,
        hint: this.type,
        promptOverride: override?.llmPrompt,
        includeDebug: true,
        // extraction-from-image: только Pass 1 (header) видит изображение —
        // image это одна страница (первая), а шапка как раз там. Pass 2
        // (items батчами) остаётся text-only.
        imagePath: override?.imagePath,
      });
    } catch (err) {
      // Pass 1 упал — возвращаем пустой результат с issue. Это означает что
      // даже шапку извлечь не получилось, а в Pass 2 без шапки идти нет смысла.
      return {
        extracted: { _issues: [`multipass_header_failed: ${stringifyErr(err)}`] },
        confidence: 0,
        missing: [...(override?.expectedFields ?? [])],
      };
    }

    const header = headerResult.extracted ?? {};
    const headerDebug = headerResult.debug;
    const headerConfidence = clamp01(headerResult.confidence);

    // ── Pass 2: items батчами ─────────────────────────────────────────────
    let allItems: unknown[] = [];
    let chunksProcessed = 0;
    let chunksFailed = 0;
    const issues: string[] = [];

    // ── XLSX-FAST: попытка разложить позиции по структуре таблицы ──────────
    // Если удалось — вместо 20+ вызовов на перепечатку строк уходит один
    // короткий вызов на разметку колонок. Не удалось — молча идём по-старому.
    let fastItems: unknown[] | null = null;
    if (itemsSchema && this.cfg.xlsxFastPath) {
      if (override?.tables?.length) {
        fastItems = await this.tryTableFastPath(override, itemsSchema, rawText, issues);
      } else {
        // Флаг включён, но структуры нет — значит документ не из Excel либо
        // структура не доехала. Без этого следа причина неотличима от «путь
        // попробовал и отказался».
        issues.push('xlsx_fast_no_tables_provided');
      }
    }

    if (fastItems) {
      allItems = fastItems;
    } else if (itemsSchema) {
      const allChunks = splitForItems(rawText, this.cfg.chunkSizeBytes, this.cfg.targetRowsPerChunk);
      const chunks = allChunks.slice(0, this.cfg.maxPasses);
      // Раньше хвост за maxPasses выбрасывался МОЛЧА — на 128КБ .xls терялись
      // товарные строки без единого следа в issues. Теперь обрез честный.
      if (allChunks.length > chunks.length) {
        issues.push(
          `multipass_chunks_truncated: документ дал ${allChunks.length} кусков, обработано ${chunks.length} (MULTIPASS_MAX_PASSES)`,
        );
        (header as Record<string, unknown>)._truncated = true;
      }

      // Параллельный пул с ограничением — больше 3 одновременных запросов к
      // inference-service увеличивает риск получить 429/timeout от модели.
      const results: Array<{ items: unknown[]; chunkIdx: number } | { error: string; chunkIdx: number }> = [];
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < chunks.length) {
          const idx = cursor++;
          const chunk = chunks[idx]!;
          try {
            const res = await this.llm.extract({
              text: chunk,
              schema: itemsSchema,
              hint: this.type,
              promptOverride: override?.llmPrompt,
              includeDebug: false,
            });
            const itemsField = (res.extracted as { items?: unknown })?.items;
            results.push({
              items: Array.isArray(itemsField) ? itemsField : [],
              chunkIdx: idx,
            });
          } catch (err) {
            results.push({ error: stringifyErr(err), chunkIdx: idx });
          }
        }
      };
      await Promise.all(Array.from({ length: this.cfg.itemsParallelism }, worker));

      // Сортируем результаты по индексу куска — порядок строк документа важен
      results.sort((a, b) => a.chunkIdx - b.chunkIdx);
      // Дедуп при склейке: соседние/перекрывающиеся куски и OCR, повторяющий
      // табличный блок на каждой странице, заставляют модель ре-эмитить одни
      // и те же строки в нескольких кусках (прод-кейс: 9 позиций × 3 = 27).
      // Ключ — нормализованная подпись содержимого (code|name|qty|price);
      // первое вхождение побеждает, порядок сохранён.
      const seen = new Set<string>();
      let duplicatesDropped = 0;
      for (const r of results) {
        chunksProcessed++;
        if ('error' in r) {
          chunksFailed++;
          issues.push(`multipass_chunk_failed:${r.chunkIdx}: ${r.error.slice(0, 200)}`);
          continue;
        }
        for (const item of r.items) {
          const key = itemDedupKey(item);
          if (key !== null) {
            if (seen.has(key)) {
              duplicatesDropped++;
              continue;
            }
            seen.add(key);
          }
          allItems.push(item);
        }
      }
      if (duplicatesDropped > 0) {
        issues.push(`multipass_items_deduped:${duplicatesDropped}`);
      }

      // Cap общий объём + нормализуем line_no
      let truncated = false;
      if (allItems.length > this.cfg.maxItemsTotal) {
        truncated = true;
        issues.push(`items_truncated: получено ${allItems.length} строк, оставлено ${this.cfg.maxItemsTotal}`);
        allItems = allItems.slice(0, this.cfg.maxItemsTotal);
      }
      allItems = allItems.map((item, i) => {
        if (!item || typeof item !== 'object') return item;
        const obj = item as Record<string, unknown>;
        if (obj.line_no === undefined || obj.line_no === null) {
          return { ...obj, line_no: i + 1 };
        }
        return obj;
      });
      if (truncated) (header as Record<string, unknown>)._truncated = true;
    }

    const extracted: Record<string, unknown> = {
      ...header,
      ...(allItems.length > 0 ? { items: allItems } : {}),
    };
    if (issues.length > 0) extracted._issues = issues;

    // Считаем missing
    const expected = override?.expectedFields ?? [];
    const present = new Set(Object.keys(extracted));
    const missing = expected.filter((f) => {
      if (!present.has(f)) return true;
      const v = extracted[f];
      return v === undefined || v === null || v === '' ||
        (Array.isArray(v) && v.length === 0) ||
        (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
    });

    // Confidence: средневзвешенное от Pass 1 + штраф за упавшие куски
    // Pass 2 confidence у каждого куска модель возвращает, но здесь мы не
    // храним их по отдельности — упрощённо: если хотя бы один кусок упал,
    // снижаем итог на 0.1 за каждый failed.
    const failedPenalty = chunksFailed * 0.1;
    const confidence = clamp01(headerConfidence - failedPenalty);

    return {
      extracted,
      confidence,
      missing,
      llmCall: headerDebug,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clamp01(x: number | undefined | null): number {
  if (x === undefined || x === null || Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function sliceHead(text: string, n: number): string {
  return text.length <= n ? text : text.slice(0, n);
}
function sliceTail(text: string, n: number): string {
  return text.length <= n ? text : text.slice(-n);
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err);
}

/**
 * Подпись позиции для дедупа при склейке кусков Pass 2. Берём наиболее
 * устойчивые идентифицирующие поля (артикул, наименование, кол-во, цена/сумма)
 * под разными именами (рус/eng варианты схем), нормализуем регистр/пробелы.
 *
 * Возвращает null если позиция не объект или из неё нечего извлечь — такие
 * элементы дедупу не подвергаются (нельзя надёжно сравнить — лучше оставить).
 */
function itemDedupKey(item: unknown): string | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const obj = item as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = obj[k];
      if (v !== undefined && v !== null && v !== '') {
        return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
      }
    }
    return '';
  };
  const code = pick('code', 'article', 'artikul', 'артикул', 'код', 'sku');
  const name = pick('name', 'title', 'description', 'наименование', 'товар', 'product');
  const qty = pick('quantity', 'qty', 'count', 'кол_во', 'количество');
  const price = pick('price', 'unit_price', 'цена', 'total', 'sum', 'amount', 'сумма');
  const parts = [code, name, qty, price].filter((p) => p !== '');
  if (parts.length === 0) return null;
  return parts.join('|');
}

/**
 * Разбить текст на куски для Pass 2 (items).
 *
 * SPEED-1 (2026-07-21): кусок закрывается по ПЕРВОМУ из двух пределов —
 *   1. `targetRows` строк-кандидатов (непустая строка с ≥2 разделителями
 *      колонок — табличная строка CSV/TSV-сериализации). Держит ВЫХОД
 *      вызова в безопасном коридоре ~2-4К токенов (ExtractBench: провал
 *      растёт с объёмом вывода, не входа): 30 строк × 20+ полей.
 *   2. `chunkBytes` байт — верхний предел для прозы (длинные .doc без
 *      табличных строк ведут себя как раньше: ~12КБ по границам \n\n/\n).
 *
 * Порядок текста сохранён, куски не перекрываются.
 */
/** Табличная строка-кандидат: непустая и ≥2 разделителей колонок. */
export function isTableRow(line: string): boolean {
  if (!line.trim()) return false;
  let seps = 0;
  for (const ch of line) if (ch === ',' || ch === '\t' || ch === ';' || ch === '|') seps++;
  return seps >= 2;
}

/**
 * Оценка числа табличных строк в тексте — прокси ожидаемого объёма ВЫХОДА
 * (SPEED-5): row-heavy сегмент даёт много items[] и упирается в потолок
 * вывода при single-shot. Используется для триггера multipass.
 */
export function countTableRows(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) if (isTableRow(line)) n++;
  return n;
}

export function splitForItems(text: string, chunkBytes: number, targetRows = 0): string[] {
  if (text.length <= chunkBytes && targetRows <= 0) return [text];

  const isRowLike = isTableRow;

  const lines = text.split('\n');
  const chunks: string[] = [];
  let cur: string[] = [];
  let curBytes = 0;
  let curRows = 0;
  const flush = () => {
    if (cur.length > 0) {
      chunks.push(cur.join('\n'));
      cur = [];
      curBytes = 0;
      curRows = 0;
    }
  };
  for (const line of lines) {
    // Одиночная строка длиннее лимита (OCR-блоб без переводов строк) —
    // режем её жёстко по chunkBytes, иначе кусок выйдет неограниченным.
    if (line.length + 1 > chunkBytes) {
      flush();
      for (let i = 0; i < line.length; i += chunkBytes) {
        chunks.push(line.slice(i, i + chunkBytes));
      }
      continue;
    }
    cur.push(line);
    curBytes += line.length + 1;
    if (targetRows > 0 && isRowLike(line)) curRows++;
    if ((targetRows > 0 && curRows >= targetRows) || curBytes >= chunkBytes) flush();
  }
  flush();
  return chunks.length > 0 ? chunks : [text];
}
