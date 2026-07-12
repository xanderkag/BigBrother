/**
 * §P2-2 (CLASSIFIER-PACKET-V2): классификация документа ПО ИЗОБРАЖЕНИЮ (VLM).
 *
 * Для плохих фото (паттерны B/C корпуса: СТС/дозвол/TIR сфотканы телефоном),
 * где OCR-текст пуст/мусорный и text-классификатор не справляется. Vision-
 * модель (qwen3-vl, ЛОКАЛЬНАЯ на боксе) читает картинку и возвращает slug.
 *
 * Гейтится VLM_CLASSIFY (config.classifier.vlmClassify, default off) — vision
 * дороже text-classify. Использует существующий `visionOcr({imagePath,prompt})`
 * с classify-промптом (модель отдаёт slug как «OCR-текст»).
 *
 * ПДн: паспорт-изображение уходит только в ЛОКАЛЬНУЮ vision-модель (не в облако,
 * не нарушает §8.5b). Если VLM вернул driver_passport — downstream allowlist
 * (§8.3) и §8.5b всё равно не дадут извлечь персональные поля.
 */
import type { Logger } from 'pino';
import type { LlmVisionResult } from '../llm/types.js';

export interface VlmClassifyDeps {
  visionOcr: (input: { imagePath: string; prompt?: string }) => Promise<LlmVisionResult>;
  isCatalogSlug: (slug: string) => Promise<boolean>;
  /** Опц. обёртка vision-провайдера (dynamicLlm.withVisionProvider). */
  withVisionProvider?: <T>(fn: () => Promise<T>) => Promise<T>;
}

function buildPrompt(catalog: string): string {
  return (
    'Определи тип документа по изображению. Документ может быть на ЛЮБОМ языке — ' +
    'смотри на СТРУКТУРУ и содержание, не на язык. Верни ТОЛЬКО один slug из списка ' +
    'ниже, либо `unknown`, без пояснений.\nТипы:\n' +
    catalog
  );
}

/** Достать первый slug-подобный токен из ответа VLM. */
export function parseSlug(text: string | null | undefined): string | null {
  if (!text) return null;
  const first = text.trim().split(/\s+/)[0] ?? '';
  const slug = first.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!slug || slug === 'unknown') return null;
  return slug;
}

/**
 * Классифицировать документ по изображению. Возвращает валидный каталожный
 * slug либо null (unknown / вне каталога / ошибка vision).
 */
export async function classifyImageViaVlm(
  imagePath: string,
  catalog: string,
  deps: VlmClassifyDeps,
  log: Logger,
): Promise<string | null> {
  if (!imagePath || !catalog) return null;
  const prompt = buildPrompt(catalog);
  const run = () => deps.visionOcr({ imagePath, prompt });
  let res: LlmVisionResult;
  try {
    res = deps.withVisionProvider ? await deps.withVisionProvider(run) : await run();
  } catch (err) {
    log.warn({ err }, '§P2-2: VLM-classify упал, игнор');
    return null;
  }
  const slug = parseSlug(res.text);
  if (!slug) return null;
  if (await deps.isCatalogSlug(slug)) return slug;
  log.info({ slug }, '§P2-2: VLM вернул slug вне каталога, игнор');
  return null;
}
