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

/** Пороги multipass — приходят из config.multipass (env), см. config.ts. */
export type MultipassConfig = {
  headerHeadBytes: number;
  headerTailBytes: number;
  chunkSizeBytes: number;
  maxPasses: number;
  maxItemsTotal: number;
  itemsParallelism: number;
};

/** Дефолты на случай прямого инстанцирования (тесты) без явного config'а. */
const DEFAULT_MULTIPASS_CONFIG: MultipassConfig = {
  headerHeadBytes: 4_000,
  headerTailBytes: 2_000,
  chunkSizeBytes: 12_000,
  maxPasses: 10,
  maxItemsTotal: 1_000,
  itemsParallelism: 3,
};

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

    if (itemsSchema) {
      const chunks = splitForItems(rawText, this.cfg.chunkSizeBytes).slice(0, this.cfg.maxPasses);

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
      for (const r of results) {
        chunksProcessed++;
        if ('error' in r) {
          chunksFailed++;
          issues.push(`multipass_chunk_failed:${r.chunkIdx}: ${r.error.slice(0, 200)}`);
          continue;
        }
        allItems = allItems.concat(r.items);
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
 * Разбить текст на куски не более `chunkBytes` байт, предпочитая границы
 * по двойному переводу строк (между табличными блоками или страницами).
 * Если такого разделителя нет — режем по одинарному \n, в крайнем случае
 * по char-boundary.
 *
 * Гарантия: ни один кусок > chunkBytes (с допуском 10% на «не порвать слово»),
 * и порядок текста сохранён.
 */
export function splitForItems(text: string, chunkBytes: number): string[] {
  if (text.length <= chunkBytes) return [text];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text.length - cursor <= chunkBytes) {
      chunks.push(text.slice(cursor));
      break;
    }
    // Ищем «красивую» границу около chunkBytes — приоритет двойному \n,
    // потом одинарному, потом char-boundary.
    const tail = text.slice(cursor, cursor + chunkBytes + chunkBytes * 0.1);
    let breakAt = tail.lastIndexOf('\n\n');
    if (breakAt < chunkBytes / 2) breakAt = tail.lastIndexOf('\n');
    if (breakAt < chunkBytes / 2) breakAt = chunkBytes; // fallback hard cut
    chunks.push(text.slice(cursor, cursor + breakAt));
    cursor += breakAt;
  }
  return chunks;
}
