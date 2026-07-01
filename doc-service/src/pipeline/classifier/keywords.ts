import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { DocumentTypeSlug } from '../../types/documents.js';
import { documentTypeResolver } from '../document-type-resolver.js';
import type { Classifier, ClassificationResult } from './types.js';
import {
  markerFromFileName,
  FILENAME_SIGNAL_WEIGHT,
  FILENAME_AGREE_BOOST,
} from './filename-signal.js';

/**
 * KeywordClassifier — две стадии:
 *
 *   1. **DB-resolved keywords**. Берём список активных типов из БД
 *      (через DocumentTypeResolver, кэш TTL 60s) и компилируем
 *      `classification_keywords` каждого типа в RegExp'ы. Это позволяет
 *      админу через UI:
 *        - добавить новый тип (commercial_invoice, packing_list, …) и
 *          сразу включить его в классификацию;
 *        - подкрутить regex для существующего типа без релиза кода.
 *
 *   2. **Hardcoded fallback**. Если БД пустая (только что развёрнутый
 *      инстанс без миграций) или если ни одно DB-правило не подошло,
 *      пробуем встроенные правила для шести builtin-типов. Это значит,
 *      что админ может всё снести и платформа всё равно классифицирует
 *      базовые российские документы.
 *
 * Выбор лучшего матча:
 *   - DB-правила с большим `weight` побеждают. По умолчанию `weight=1.0`
 *     для всех (нет UI для этого, можно потом добавить в metadata.weight).
 *   - При равенстве выбирается тип с **более длинным** совпавшим текстом
 *     — длиннее = специфичнее.
 *
 * Производительность: regex-компиляция кэшируется внутри resolver-TTL
 * window'а (60s по умолчанию). На каждый classify-call — один проход по
 * скомпилированному списку без новых allocations.
 */

const HEADER_WINDOW = 4000; // первые 4 KB обычно достаточно — header всегда в начале

/**
 * Position-based weight boost (2026-05-18). Real-case: контракт ВЭД
 * содержит ссылку «согласно действующему Прайс-листу» во 2-м KB текста.
 * Если оба keyword'а («КОНТРАКТ №» в title chars 0-300 и «Прайс-лист»
 * в chars 1500-2000) имеют equal weight, побеждает first-found или
 * длиннее match — неустойчиво.
 *
 * Решение: pattern matched в первых TITLE_BOOST_WINDOW chars
 * (default 500) получает effective weight × TITLE_BOOST_MULTIPLIER (1.5).
 * Это даёт title-position priority — signature pattern в заголовке
 * естественно побеждает упоминание в body.
 */
const TITLE_BOOST_WINDOW = 500;
const TITLE_BOOST_MULTIPLIER = 1.5;

// A6: единый источник правил — shared/classifier-rules.json в корне репо.
// При загрузке из dist/ путь: dist/pipeline/classifier/ → ../../../../shared/
// При загрузке через ts-node/tsx: src/pipeline/classifier/ → ../../../../shared/
// Docker-образ doc-service должен включать COPY shared/ /app/shared/ в Dockerfile.
// При ошибке чтения — fallback к встроенному набору (не ломает деплой).
type RuleEntry = { slug: string; pattern: string; weight: number };

function loadFallbackRules(): Array<{ type: DocumentTypeSlug; pattern: RegExp; weight: number }> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const rulesPath = resolve(__dirname, '../../../../shared/classifier-rules.json');
  try {
    const raw = JSON.parse(readFileSync(rulesPath, 'utf-8')) as RuleEntry[];
    return raw.map((r) => ({
      type: r.slug as DocumentTypeSlug,
      pattern: new RegExp(r.pattern, 'i'),
      weight: r.weight,
    }));
  } catch {
    // File not found (Docker without shared/ mount, or unit test without repo layout).
    // Return hardcoded list so the classifier still works.
    return [
      { type: 'UPD',         pattern: /универсальный\s+передаточный\s+документ|(?<![а-яёa-z])упд(?![а-яёa-z])/i, weight: 1.0 },
      { type: 'CMR',         pattern: /\bCMR\b|международная\s+товарно-транспортная/i,    weight: 1.0 },
      { type: 'TTN',         pattern: /транспортная\s+накладная|товарно-транспортная\s+накладная|(?<![а-яёa-z])ттн(?![а-яёa-z])/i, weight: 1.0 },
      { type: 'factInvoice', pattern: /счет-фактура|счёт-фактура/i,                       weight: 1.0 },
      { type: 'AKT',         pattern: /(?<![а-яёa-z])акт(?![а-яёa-z])\s+(оказанных|выполненных|сдачи)|акт\s+об\s+оказании/i, weight: 0.95 },
      { type: 'invoice',     pattern: /сч[её]т\s+на\s+оплату|сч[её]т\s+№/i,              weight: 0.9 },
      { type: 'invoice',     pattern: /сч[её]т/i,                                         weight: 0.6 },
    ];
  }
}

/** Hardcoded fallback для случая пустой БД. Загружается из shared/classifier-rules.json (A6). */
const FALLBACK_RULES: Array<{ type: DocumentTypeSlug; pattern: RegExp; weight: number }> =
  loadFallbackRules();

type CompiledRule = {
  type: DocumentTypeSlug;
  pattern: RegExp;
  weight: number;
};

/**
 * Best content match для одного типа: raw weight (не клампленный) + текст матча.
 * `titleBoosted` — совпадение попало в первые TITLE_BOOST_WINDOW chars
 * (definitive-заголовок). Это «сильный сигнал»: filename-маркер НЕ переворачивает
 * title-boosted контент-победителя (защита от ложных флипов).
 */
type TypeScore = { weight: number; matched: string; titleBoosted: boolean };

export class KeywordClassifier implements Classifier {
  async classify(
    text: string,
    organizationId?: string | null,
    fileName?: string | null,
  ): Promise<ClassificationResult> {
    const haystack = text.slice(0, HEADER_WINDOW);
    const nameMarker = markerFromFileName(fileName);

    // --- Stage 1: DB-driven rules (scoped к организации job'а, CP7) ---
    // Возвращает null когда БД недоступна ИЛИ ни одно DB-правило не сматчилось —
    // тогда падаем в hardcoded fallback (сохраняем исходный контракт fallthrough).
    const dbScores = await this.scoreByDbRules(haystack, organizationId ?? null);
    if (dbScores && dbScores.scores.size > 0) {
      return this.pickWithFilename(dbScores.scores, dbScores.candidates, nameMarker);
    }

    // --- Stage 2: hardcoded fallback ---
    const scores = new Map<DocumentTypeSlug, TypeScore>();
    let candidates = 0;
    for (const rule of FALLBACK_RULES) {
      const m = rule.pattern.exec(haystack);
      if (!m) continue;
      candidates += 1;
      const isInTitle = m.index !== undefined && m.index < TITLE_BOOST_WINDOW;
      const effectiveWeight = isInTitle ? rule.weight * TITLE_BOOST_MULTIPLIER : rule.weight;
      this.recordScore(scores, rule.type, effectiveWeight, m[0], isInTitle);
    }
    return this.pickWithFilename(scores, candidates, nameMarker);
  }

  /** Обновить per-type best score, если новый кандидат сильнее (weight, при равенстве — длиннее match). */
  private recordScore(
    scores: Map<DocumentTypeSlug, TypeScore>,
    type: DocumentTypeSlug,
    weight: number,
    matched: string,
    titleBoosted: boolean,
  ): void {
    const cur = scores.get(type);
    if (!cur || weight > cur.weight || (weight === cur.weight && matched.length > cur.matched.length)) {
      scores.set(type, { weight, matched, titleBoosted });
    }
  }

  /**
   * Выбор победителя с учётом filename-сигнала (weighted booster / tie-breaker,
   * НЕ override). Сначала находим контент-победителя, затем решаем, переворачивает
   * ли имя файла.
   *
   * Правило флипа (имя ≠ контент-победитель):
   *   - Контент-победитель **title-boosted** (definitive-заголовок в первых
   *     TITLE_BOOST_WINDOW chars) — это СИЛЬНЫЙ сигнал, имя его НЕ бьёт.
   *     Защищает `Заявка_ИСТ-ВЕСТ.pdf`: заголовок «Приложение к Договору» →
   *     contract_specification (title-boosted) остаётся, несмотря на «Заявка» в имени.
   *   - Контент-победитель НЕ title-boosted (совпал ссылкой в теле — ДТ-номер
   *     в счёт-фактуре, SWIFT в акте) ИЛИ контента нет — имя переворачивает.
   *     Реальные кейсы: `ТТН_*` (OCR не поймал «накладную»), `VAT_invoice_*`
   *     (customs-ключ ссылкой на ДТ), `Act_*` (SWIFT в акте), `*MBL.xls` (без типа).
   *
   * Boost имени к weight маркер-типа (когда флип разрешён):
   *   - тип имеет контент-поддержку → +FILENAME_AGREE_BOOST (усиление);
   *   - тип без контент-поддержки → FILENAME_SIGNAL_WEIGHT (одиночный сигнал).
   *
   * Generic-имена не дают маркер (см. filename-signal.ts) — тип не форсится.
   */
  private pickWithFilename(
    scores: Map<DocumentTypeSlug, TypeScore>,
    candidates: number,
    marker: DocumentTypeSlug | null,
  ): ClassificationResult {
    const contentBest = this.bestScore(scores);

    // Нет маркера имени — чистый результат контент-классификации.
    if (!marker) return this.toResult(contentBest, candidates);

    const markerScore = scores.get(marker) ?? null;

    // Имя совпало с контент-победителем → усиливаем уверенность (agree-boost),
    // тип не меняется.
    if (contentBest && contentBest.type === marker) {
      return this.toResult(
        { type: marker, weight: contentBest.weight + FILENAME_AGREE_BOOST, matched: contentBest.matched },
        candidates,
      );
    }

    // Имя расходится с контентом. Флип запрещён, если контент-победитель —
    // strong (title-boosted definitive-заголовок). Тогда контент побеждает.
    if (contentBest && contentBest.titleBoosted) {
      return this.toResult(contentBest, candidates);
    }

    // Флип разрешён: контент слабый (не title-boosted) или отсутствует.
    // Вес маркера: контент-поддержка → +agree-boost, иначе одиночный сигнал.
    const markerWeight = markerScore
      ? markerScore.weight + FILENAME_AGREE_BOOST
      : FILENAME_SIGNAL_WEIGHT;
    // Флипаем только если маркер реально сильнее контент-победителя.
    if (!contentBest || markerWeight >= contentBest.weight) {
      return this.toResult(
        {
          type: marker,
          weight: markerWeight,
          matched: markerScore ? markerScore.matched : `filename:${marker}`,
        },
        candidates,
      );
    }
    return this.toResult(contentBest, candidates);
  }

  /** Победитель по score-map: максимальный weight, при равенстве — длиннее match. */
  private bestScore(
    scores: Map<DocumentTypeSlug, TypeScore>,
  ): { type: DocumentTypeSlug; weight: number; matched: string; titleBoosted: boolean } | null {
    let best:
      | { type: DocumentTypeSlug; weight: number; matched: string; titleBoosted: boolean }
      | null = null;
    for (const [type, s] of scores) {
      if (
        !best ||
        s.weight > best.weight ||
        (s.weight === best.weight && s.matched.length > best.matched.length)
      ) {
        best = { type, weight: s.weight, matched: s.matched, titleBoosted: s.titleBoosted };
      }
    }
    return best;
  }

  private toResult(
    best: { type: DocumentTypeSlug; weight: number; matched: string } | null,
    candidates: number,
  ): ClassificationResult {
    if (!best) {
      return { type: null, confidence: 0, source: 'keyword', candidatesCount: candidates };
    }
    // Outbound clamp: internal weight ∈ [0, ∞] (specific patterns 5.0 vs generic 1.0),
    // но confidence в API-контракте — [0, 1].
    return {
      type: best.type,
      confidence: Math.min(1.0, best.weight),
      source: 'keyword',
      matched: best.matched,
      candidatesCount: candidates,
    };
  }

  /**
   * Прогон DB-правил → per-type best score map. Возвращает null, если БД
   * недоступна / нет активных типов / ни одного скомпилированного правила
   * (тогда caller падает в hardcoded fallback). Пустой map (правила есть, но
   * ничего не сматчилось) — валидный результат: caller применит filename-сигнал.
   */
  private async scoreByDbRules(
    haystack: string,
    organizationId: string | null,
  ): Promise<{ scores: Map<DocumentTypeSlug, TypeScore>; candidates: number } | null> {
    const rows = await documentTypeResolver.listActiveForOrg(organizationId);
    if (rows.length === 0) return null;

    const compiled: CompiledRule[] = [];
    for (const row of rows) {
      // Per-keyword weights (migration 0023) — parallel array к
      // classification_keywords. Default 1.0 для missing/null/short entries.
      // Fallback: row.metadata.classification_weight (legacy single-value).
      const rowDefault = this.weightFromMetadata(row.metadata) ?? 1.0;
      const weights = row.classification_keyword_weights ?? [];
      for (let i = 0; i < row.classification_keywords.length; i += 1) {
        const raw = row.classification_keywords[i];
        if (raw === undefined) continue;
        const rawWeight = weights[i];
        const weight =
          rawWeight !== undefined && rawWeight !== null
            ? Number(rawWeight)
            : rowDefault;
        try {
          compiled.push({ type: row.slug, pattern: new RegExp(raw, 'i'), weight });
        } catch {
          // Bad regex — skip silently.
        }
      }
    }
    if (compiled.length === 0) return null;

    const scores = new Map<DocumentTypeSlug, TypeScore>();
    let candidates = 0;
    for (const rule of compiled) {
      const m = rule.pattern.exec(haystack);
      if (!m) continue;
      candidates += 1;
      // Position-based boost: match'и в title (первые TITLE_BOOST_WINDOW
      // chars) сильнее. `m.index` — позиция начала матча в haystack.
      const isInTitle = m.index !== undefined && m.index < TITLE_BOOST_WINDOW;
      const effectiveWeight = isInTitle ? rule.weight * TITLE_BOOST_MULTIPLIER : rule.weight;
      this.recordScore(scores, rule.type, effectiveWeight, m[0], isInTitle);
    }
    return { scores, candidates };
  }

  /**
   * Legacy fallback: row-level single weight via metadata.classification_weight.
   * Используется только когда per-keyword weights (classification_keyword_weights)
   * не заданы. Оставлен для backwards compat — миграция 0023 переводит на
   * per-keyword array.
   */
  private weightFromMetadata(metadata: Record<string, unknown> | null): number | null {
    if (!metadata) return null;
    const w = (metadata as Record<string, unknown>).classification_weight;
    if (typeof w === 'number' && w >= 0) return w;
    return null;
  }
}
