import type { Logger } from 'pino';
import type { DocumentTypeSlug } from '../../types/documents.js';
import type { LlmClient } from '../llm/types.js';
import type { Classifier, ClassificationResult } from './types.js';
import { getCatalogForOrg } from './catalog.js';
import { config } from '../../config.js';

/**
 * LlmDocClassifier — production LLM-классификатор (design ТЗ).
 *
 * Прогоняется на КАЖДОМ документе после OCR, перед extract. Схема:
 *   1. Keyword-prior — быстрый keyword+filename классификатор (мгновенный).
 *      Даёт кандидата + score + runners-up. Остаётся как PRIOR и FALLBACK.
 *   2. LLM classify — динамический каталог типов + имя файла + prior-подсказка.
 *      qwen3.6:27b, reasoning_effort:"none", temp=0, ~30 max_tokens. Модель
 *      возвращает РОВНО ОДИН slug из каталога либо `unknown`.
 *   3. Решение:
 *      - валидный slug из каталога → финальный тип, method='llm'.
 *      - `unknown` → документ «не опознан» (flag), тип null.
 *      - LLM упал / timeout / невалидный slug → fallback на keyword-prior,
 *        method='keyword'|'filename'|'fallback'. НИКОГДА не роняем документ.
 *
 * Метаданные (`classification`) пишутся оркестратором в jobs.classification
 * (jsonb) — для UI. См. ClassificationMetadata.
 */

/** Один кандидат keyword-prior'а (для UI). */
export type ClassificationCandidate = {
  type: DocumentTypeSlug;
  score: number;
};

/**
 * Метаданные классификации — идут в jobs.classification (jsonb), UI их читает.
 * Всё что нужно оператору чтобы понять «почему этот тип».
 */
export type ClassificationMetadata = {
  /** Финальный slug (или null если unknown / ничего не выбрано). */
  type: DocumentTypeSlug | null;
  /** Уверенность: LLM'а (1.0 на выбор) либо prior'а при fallback. */
  confidence: number;
  /** Как выбран финальный тип. */
  method: 'llm' | 'keyword' | 'filename' | 'fallback' | 'hint' | 'vlm' | 'deep_pass';
  /** Время именно LLM-вызова классификации (мс). null если LLM не звали. */
  duration_ms: number | null;
  /** Сырой ответ LLM (включая `unknown` / невалидный slug). null если не звали. */
  llm_said: string | null;
  /** Что сказал keyword-prior: {type, score}. */
  keyword_said: ClassificationCandidate | null;
  /** Топ-кандидаты prior'а (для UI). */
  candidates: ClassificationCandidate[];
  /** Документ не опознан (LLM=unknown и prior без уверенного типа). */
  unknown: boolean;
};

/** Итог классификации: финальный тип + богатые метаданные. */
export type LlmClassificationOutcome = {
  documentType: DocumentTypeSlug | null;
  metadata: ClassificationMetadata;
};

/**
 * Порог уверенности prior'а, ниже которого prior НЕ считается «уверенным типом».
 * Используется в unknown-решении: если LLM сказал unknown И у prior confidence
 * ниже этого — документ помечается «не опознан». Если prior уверенный — берём
 * его тип (fallback), но всё равно фиксируем llm_said=unknown в метаданных.
 *
 * Значения ниже (порог/лимит символов/таймаут) вынесены в config.classifier —
 * env-tunable в одном месте. Дефолты = прежние хардкоды (behavior-preserving).
 */
const PRIOR_CONFIDENT_THRESHOLD = config.classifier.priorConfidentThreshold;

/** Первые ~2500 chars raw-текста в prompt (как в probe). */
const LLM_TEXT_CHARS = config.classifier.llmTextChars;

/** Таймаут одного classify-вызова (мс) — hung classify не должен стопорить очередь. */
const CLASSIFY_TIMEOUT_MS = config.classifier.classifyTimeoutMs;

/** ~30 токенов достаточно для голого slug'а. */
const CLASSIFY_MAX_TOKENS = 30;

export class LlmDocClassifier {
  constructor(
    private readonly keyword: Classifier,
    private readonly llm: LlmClient,
    private readonly opts: {
      timeoutMs?: number;
      textChars?: number;
      maxTokens?: number;
    } = {},
  ) {}

  /**
   * Классифицировать документ. НИКОГДА не бросает из-за классификатора —
   * при любой ошибке LLM возвращает keyword-fallback.
   *
   * @param isCatalogSlug предикат «slug есть в активном каталоге орг». Нужен
   *   для валидации LLM-ответа. Обычно `(s) => resolver.get(s) !== null`, но
   *   инъектится, чтобы classifier не тянул resolver напрямую (тестируемость).
   */
  async classify(
    input: {
      text: string;
      fileName?: string | null;
      organizationId?: string | null;
    },
    isCatalogSlug: (slug: string) => Promise<boolean>,
    log: Logger,
    context: Record<string, unknown> = {},
  ): Promise<LlmClassificationOutcome> {
    // --- 1. Keyword-prior (мгновенный) ---
    const prior = await this.keyword.classify(
      input.text,
      input.organizationId ?? null,
      input.fileName ?? null,
    );
    const keywordSaid: ClassificationCandidate | null = prior.type
      ? { type: prior.type, score: round3(prior.confidence) }
      : null;
    // candidates[] — реальные top-N кандидаты prior'а из ranked score-map
    // (winner-first): победитель + top-2 runners-up. `keyword_said` остаётся
    // отдельным полем (= best prior). Если ranked нет (старый путь / нет
    // матчей) — падаем на единственного кандидата (прежний контракт).
    const candidates: ClassificationCandidate[] = buildCandidates(prior, keywordSaid);

    // --- 2. LLM classify ---
    const { text: catalog, count } = await this.getCatalog(input.organizationId ?? null);
    if (!catalog || count === 0 || !this.llm.isAvailable()) {
      // Нет каталога (пустая БД) или LLM недоступен → keyword-only.
      return this.fromPrior(prior, keywordSaid, candidates, {
        reason: !catalog || count === 0 ? 'empty_catalog' : 'llm_unavailable',
      }, log, context);
    }

    let llmSaid: string | null = null;
    let durationMs: number | null = null;
    try {
      const startedAt = Date.now();
      const res = await this.withTimeout(
        this.llm.classifyWithCatalog({
          text: input.text.slice(0, this.opts.textChars ?? LLM_TEXT_CHARS),
          catalog,
          fileName: input.fileName ?? null,
          keywordHint: prior.type ?? null,
          maxTokens: this.opts.maxTokens ?? CLASSIFY_MAX_TOKENS,
        }),
        this.opts.timeoutMs ?? CLASSIFY_TIMEOUT_MS,
      );
      durationMs = Date.now() - startedAt;
      llmSaid = (res.slug ?? '').trim() || null;
    } catch (err) {
      // Timeout / network / backend error → fallback на prior. Никогда не роняем.
      log.warn(
        { ...context, err: String((err as Error)?.message ?? err) },
        'llm classify failed — falling back to keyword prior',
      );
      return this.fromPrior(prior, keywordSaid, candidates, { reason: 'llm_error' }, log, context, {
        llm_said: null,
        duration_ms: durationMs,
      });
    }

    // --- 3. Решение ---
    const normalized = llmSaid?.toLowerCase() ?? null;
    if (normalized === 'unknown' || normalized === 'null' || normalized === null) {
      // LLM явно сказал unknown (или пусто). Если prior уверенный — берём его
      // тип (fallback), иначе документ «не опознан».
      //
      // ВАЖНО (2026-07-17): при включённом deep-pass keyword НЕ перебивает явный
      // «unknown» модели. Модель ЧИТАЛА документ — её «не знаю» надёжнее случайного
      // совпадения слов (фото мешков DAIKIN со строкой «COUNTRY OF ORIGIN» →
      // keyword ошибочно давал cert_of_origin). Уводим в null → агрессивный
      // vision-проход/deep-pass посмотрит на картинку и решит (реальный тип
      // вернётся обратно verdict=mapped — потерь нет). При выключенном deep-pass
      // остаётся прежний keyword-fallback (чтобы unknown не был тупиком).
      const priorConfident =
        !config.deepPass.enabled &&
        prior.type !== null &&
        prior.confidence >= PRIOR_CONFIDENT_THRESHOLD;
      if (priorConfident) {
        log.info(
          { ...context, llm_said: llmSaid, keyword_type: prior.type, classify_duration_ms: durationMs },
          'llm said unknown but keyword prior is confident — using prior (fallback)',
        );
        return {
          documentType: prior.type,
          metadata: {
            type: prior.type,
            confidence: round3(prior.confidence),
            method: 'fallback',
            duration_ms: durationMs,
            llm_said: llmSaid ?? 'unknown',
            keyword_said: keywordSaid,
            candidates,
            unknown: false,
          },
        };
      }
      // Не опознан — flag, тип null. НЕ выдумываем тип.
      log.info(
        { ...context, llm_said: llmSaid ?? 'unknown', keyword_type: prior.type ?? null, classify_duration_ms: durationMs },
        'document not recognized (llm=unknown, prior not confident)',
      );
      return {
        documentType: null,
        metadata: {
          type: null,
          confidence: 0,
          method: 'llm',
          duration_ms: durationMs,
          llm_said: llmSaid ?? 'unknown',
          keyword_said: keywordSaid,
          candidates,
          unknown: true,
        },
      };
    }

    // После unknown-ветки llmSaid гарантированно не null (normalized===null там
    // возвращает). TS не сужает через производную normalized — фиксируем локально.
    const chosenSlug: string = llmSaid as string;

    // LLM вернул конкретный slug — валидируем по каталогу.
    const valid = await isCatalogSlug(chosenSlug);
    if (!valid) {
      // Модель галлюцинировала slug вне каталога → fallback на prior.
      log.warn(
        { ...context, llm_said: chosenSlug, classify_duration_ms: durationMs },
        'llm returned slug not in catalog — falling back to keyword prior',
      );
      return this.fromPrior(prior, keywordSaid, candidates, { reason: 'invalid_slug' }, log, context, {
        llm_said: chosenSlug,
        duration_ms: durationMs,
      });
    }

    // Валидный выбор — финальный тип от LLM.
    log.info(
      { ...context, type: chosenSlug, method: 'llm', classify_duration_ms: durationMs, keyword_type: prior.type ?? null },
      'classified by llm',
    );
    return {
      documentType: chosenSlug,
      metadata: {
        type: chosenSlug,
        confidence: round3(llmConfidence(prior, chosenSlug)),
        method: 'llm',
        duration_ms: durationMs,
        llm_said: chosenSlug,
        keyword_said: keywordSaid,
        candidates,
        unknown: false,
      },
    };
  }

  /** Каталог с fail-soft (ошибка → пустой каталог, keyword-only). */
  private async getCatalog(orgId: string | null): Promise<{ text: string; count: number }> {
    try {
      return await getCatalogForOrg(orgId);
    } catch {
      return { text: '', count: 0 };
    }
  }

  /** Собрать outcome из одного keyword-prior'а (fallback-путь). */
  private fromPrior(
    prior: ClassificationResult,
    keywordSaid: ClassificationCandidate | null,
    candidates: ClassificationCandidate[],
    info: { reason: string },
    log: Logger,
    context: Record<string, unknown>,
    overrides: { llm_said?: string | null; duration_ms?: number | null } = {},
  ): LlmClassificationOutcome {
    // method='filename' если prior победил по имени файла (source keyword, но
    // matched начинается с 'filename:'); иначе 'keyword'. Точный источник —
    // информационный, финальный тип берём из prior.
    const method: ClassificationMetadata['method'] =
      prior.matched?.startsWith('filename:') ? 'filename' : 'keyword';
    log.info(
      { ...context, type: prior.type ?? null, method, reason: info.reason },
      'classified by keyword prior (fallback)',
    );
    return {
      documentType: prior.type,
      metadata: {
        type: prior.type,
        confidence: prior.type ? round3(prior.confidence) : 0,
        method,
        duration_ms: overrides.duration_ms ?? null,
        llm_said: overrides.llm_said ?? null,
        keyword_said: keywordSaid,
        candidates,
        unknown: prior.type === null,
      },
    };
  }

  /** Обернуть promise таймаутом. Reject('classify timeout') при просрочке. */
  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`classify timeout after ${ms}ms`)), ms);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }
}

/**
 * Уверенность для LLM-выбора как СОГЛАСИЕ ДВУХ ИСТОЧНИКОВ (keyword-prior + LLM).
 * Голый slug числа не несёт, поэтому сигнал строим из совпадения:
 *   - оба согласны (prior.type === LLM) → confidence prior'а, но не ниже 0.9
 *     (LLM подтвердил быстрый сигнал — максимальная уверенность);
 *   - keyword ничего не нашёл (prior.type === null) → 0.7 (LLM единственный
 *     источник, подтверждения нет — средняя);
 *   - keyword нашёл ДРУГОЙ тип → 0.5 (источники РАСХОДЯТСЯ, реальная
 *     неопределённость).
 * Раньше расхождение возвращало 0.9 — конфликт маскировался под уверенность, и
 * уверенно-неверный тип проходил как `done`. Теперь низкое число доходит до
 * needs_review-гейта (см. orchestrator: classify_uncertain).
 */
function llmConfidence(prior: ClassificationResult, llmSlug: string): number {
  if (prior.type && prior.type === llmSlug) return Math.max(0.9, prior.confidence);
  if (prior.type === null) return 0.7;
  return 0.5;
}

function round3(c: number): number {
  return Math.round(c * 1000) / 1000;
}

/**
 * Максимум кандидатов в `candidates[]` (победитель + runners-up). Держим
 * коротким — это UI-метаданные «почему этот тип», не полный дамп score-map.
 */
const MAX_CANDIDATES = 3;

/**
 * Собрать `candidates[]` из ranked score-map prior'а (winner-first): победитель +
 * top-(MAX_CANDIDATES-1) runners-up, все со score. Score округляем round3 —
 * так же как `keyword_said`. Fallback: если ranked нет (LLM-путь не давал его /
 * prior без матчей) — единственный кандидат = keyword_said (прежний контракт).
 * НЕ влияет на решение — только метаданные UI.
 */
function buildCandidates(
  prior: ClassificationResult,
  keywordSaid: ClassificationCandidate | null,
): ClassificationCandidate[] {
  const ranked = prior.ranked;
  if (ranked && ranked.length > 0) {
    return ranked
      .slice(0, MAX_CANDIDATES)
      .map((r) => ({ type: r.type, score: round3(r.score) }));
  }
  return keywordSaid ? [keywordSaid] : [];
}
