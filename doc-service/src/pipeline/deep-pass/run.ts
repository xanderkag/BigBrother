/**
 * DEEP-PASS Фаза 1 (docs/DEEP-PASS-SPEC.md): глубокий разбор нераспознанного
 * остатка. Вызывается оркестратором ПОСЛЕ того как рабочий классификатор
 * (включая §P2-2 VLM-фолбэк) не дал тип, либо OCR кончился refusal'ом.
 *
 * Два пути чтения:
 *   - text: OCR-текста достаточно → llm.extract с deep-схемой (берём больше
 *     текста, чем classify: 8k против 2.5k — у классификатора мог просто
 *     не поместиться дискриминатор).
 *   - vision: текста мало/нет → локальная VL-модель по картинке первой
 *     страницы (тот же withVisionProvider-контур, что §P2-2; не облако).
 *
 * Выход: широкая категория + резюме + опциональный маппинг на рабочий
 * каталог. Fail-soft: ЛЮБАЯ ошибка → null, пайплайн живёт как раньше.
 *
 * ПДн (152-ФЗ): id_document → резюме заменяется константой, маппинг на
 * каталог не выполняется; все резюме проходят scrubPassportPatterns.
 */
import type { Logger } from 'pino';
import type { LlmExtractResult, LlmVisionResult } from '../llm/types.js';
import { scrubPassportPatterns } from '../normalize/pii-redact.js';
import { broadCatalogText, normalizeBroadSlug } from './broad-catalog.js';

export type DeepPassVerdict = 'mapped' | 'foreign_document' | 'not_a_document';

/** Кладётся в extracted._deep как есть (snake_case — это wire-формат). */
export interface DeepPassResult {
  broad_type: string;
  broad_label: string;
  language: string | null;
  summary: string;
  /** Валидный slug рабочего каталога → оркестратор вернёт док в конвейер. */
  catalog_slug: string | null;
  verdict: DeepPassVerdict;
  via: 'text' | 'vision';
  /** Почему запустился второй ярус. */
  reason: 'classify_unknown' | 'ocr_refused';
}

export interface DeepPassDeps {
  extract: (input: {
    text: string;
    schema: Record<string, unknown>;
    promptOverride?: string;
  }) => Promise<LlmExtractResult>;
  visionOcr: (input: { imagePath: string; prompt?: string }) => Promise<LlmVisionResult>;
  /** Обёртка vision-провайдера (dynamicLlm.withVisionProvider), как в §P2-2. */
  withVisionProvider?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Валидатор slug'ов рабочего каталога (makeCatalogSlugValidator). */
  isCatalogSlug: (slug: string) => Promise<boolean>;
}

export interface DeepPassInput {
  text: string;
  imagePath?: string;
  /** Текст рабочего каталога (getCatalogForOrg) — для маппинга обратно. */
  workingCatalog: string;
  /** Сколько первых символов текста уходит в text-путь. */
  textChars: number;
  /** Меньше этого — text-пути не верим, идём в vision по картинке. */
  minTextForTextPath: number;
  /**
   * Форс vision-пути даже когда текста хватает. Для картинок/фото OCR-текст
   * обманчив (надписи на мешках/коробках → текст-путь примет фото за документ);
   * истина — само изображение. Оркестратор ставит для image-input. Без картинки
   * (imagePath пуст) флаг игнорируется — deep-pass вернёт null.
   */
  forceVision?: boolean;
  reason: DeepPassResult['reason'];
}

const PII_SUMMARY = 'Удостоверение личности — содержимое не сохраняется (ПДн)';

/** JSON-схема deep-ответа — общая для text-пути (extract) и vision-промпта. */
const DEEP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    broad_type: {
      type: 'string',
      description: 'РОВНО один slug из списка широких категорий',
    },
    catalog_slug: {
      type: ['string', 'null'],
      description: 'slug РАБОЧЕГО типа, если документ ему соответствует, иначе null',
    },
    language: {
      type: ['string', 'null'],
      description: 'основной язык документа: ru / en / zh / …',
    },
    summary: {
      type: 'string',
      description: '2-3 предложения по-русски: что это за документ и о чём он',
    },
  },
  required: ['broad_type', 'summary'],
};

function buildInstruction(workingCatalog: string): string {
  return (
    'Определи, что это за документ, и составь короткое резюме. Документ может быть ' +
    'на ЛЮБОМ языке — смотри на структуру и содержание.\n\n' +
    'Широкие категории (broad_type — верни РОВНО один slug):\n' +
    broadCatalogText() +
    '\n\nРабочие типы (catalog_slug — верни slug ТОЛЬКО если документ точно ' +
    'соответствует одному из них, иначе null):\n' +
    (workingCatalog || '(каталог недоступен)') +
    '\n\nЕсли это удостоверение личности (паспорт и т.п.) — broad_type=id_document, ' +
    'персональные данные (ФИО, номера, даты рождения) в summary НЕ включай.'
  );
}

function buildVisionPrompt(workingCatalog: string): string {
  return (
    buildInstruction(workingCatalog) +
    '\n\nОтветь ТОЛЬКО валидным JSON без пояснений и markdown:\n' +
    '{"broad_type": "...", "catalog_slug": null, "language": "...", "summary": "..."}'
  );
}

/** Толерантный парс JSON из ответа VL-модели (может обернуть в ```json…```). */
export function salvageJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/** Из сырого ответа модели — валидированный DeepPassResult (без catalog-маппинга). */
async function shapeResult(
  raw: Record<string, unknown>,
  via: DeepPassResult['via'],
  reason: DeepPassResult['reason'],
  isCatalogSlug: DeepPassDeps['isCatalogSlug'],
): Promise<DeepPassResult> {
  const broad = normalizeBroadSlug(asStringOrNull(raw.broad_type));
  const isPii = broad.slug === 'id_document';

  // ПДн-гейт: удостоверение — содержимое не сохраняем и в каталог не мапим
  // (рабочий driver_passport и так идёт через §8.5b-allowlist, но фаза 1
  // сознательно не возвращает ID-доки в конвейер).
  let catalogSlug: string | null = null;
  if (!isPii) {
    const candidate = asStringOrNull(raw.catalog_slug)
      ?.toLowerCase()
      .replace(/[^a-z0-9_]/g, '');
    if (candidate && candidate !== 'null' && candidate !== 'unknown') {
      catalogSlug = (await isCatalogSlug(candidate)) ? candidate : null;
    }
  }

  const summary = isPii
    ? PII_SUMMARY
    : scrubPassportPatterns(asStringOrNull(raw.summary) ?? '').slice(0, 1000);

  const verdict: DeepPassVerdict = catalogSlug
    ? 'mapped'
    : broad.slug === 'not_a_document'
      ? 'not_a_document'
      : 'foreign_document';

  return {
    broad_type: broad.slug,
    broad_label: broad.label,
    language: asStringOrNull(raw.language)?.slice(0, 16) ?? null,
    summary,
    catalog_slug: catalogSlug,
    verdict,
    via,
    reason,
  };
}

/**
 * Запустить глубокий разбор. null = не смогли (нет ни текста, ни картинки,
 * либо модель упала/вернула мусор) — caller продолжает как раньше.
 */
export async function runDeepPass(
  input: DeepPassInput,
  deps: DeepPassDeps,
  log: Logger,
): Promise<DeepPassResult | null> {
  const text = input.text.trim();
  // forceVision (image-input) обходит text-путь: фото коробок/мешков имеет
  // достаточно OCR-текста (>300), но текст обманывает — смотрим на картинку.
  // Если картинки нет — text-путь остаётся (иначе вернём null ниже).
  const useText = (!input.forceVision || !input.imagePath) && text.length >= input.minTextForTextPath;

  try {
    if (useText) {
      const res = await deps.extract({
        text: text.slice(0, input.textChars),
        schema: DEEP_SCHEMA,
        promptOverride: buildInstruction(input.workingCatalog),
      });
      const raw = res.extracted;
      if (!asStringOrNull(raw.summary) && !asStringOrNull(raw.broad_type)) {
        log.warn({ via: 'text' }, 'deep-pass: модель вернула пустой ответ');
        return null;
      }
      return await shapeResult(raw, 'text', input.reason, deps.isCatalogSlug);
    }

    if (!input.imagePath) {
      log.info('deep-pass: текста мало и картинки нет — пропуск');
      return null;
    }
    const run = () =>
      deps.visionOcr({ imagePath: input.imagePath as string, prompt: buildVisionPrompt(input.workingCatalog) });
    const res = deps.withVisionProvider ? await deps.withVisionProvider(run) : await run();
    const raw = salvageJson(res.text);
    if (!raw) {
      // Модель проигнорировала JSON-формат, но что-то увидела — забираем как
      // резюме (честнее, чем выбросить): категория other, без маппинга.
      const seen = asStringOrNull(res.text);
      if (!seen) return null;
      return await shapeResult(
        { broad_type: 'other', summary: seen.slice(0, 400) },
        'vision',
        input.reason,
        deps.isCatalogSlug,
      );
    }
    return await shapeResult(raw, 'vision', input.reason, deps.isCatalogSlug);
  } catch (err) {
    log.warn({ err, via: useText ? 'text' : 'vision' }, 'deep-pass упал — пропуск (fail-soft)');
    return null;
  }
}
