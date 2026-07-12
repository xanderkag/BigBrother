/**
 * §P2-2 (CLASSIFIER-PACKET-V2): VLM-классификация по изображению.
 */
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { classifyImageViaVlm, parseSlug } from '../src/pipeline/classifier/vlm-classify.js';

const log = pino({ level: 'silent' });
const isCatalogSlug = (allowed: string[]) => async (s: string) => allowed.includes(s);

describe('parseSlug', () => {
  it('берёт первый токен, lower, чистит', () => {
    expect(parseSlug('  CMR \nещё текст')).toBe('cmr');
    expect(parseSlug('driver_passport')).toBe('driver_passport');
  });
  it('unknown / пусто → null', () => {
    expect(parseSlug('unknown')).toBeNull();
    expect(parseSlug('')).toBeNull();
    expect(parseSlug(null)).toBeNull();
  });
});

describe('classifyImageViaVlm', () => {
  it('валидный каталожный slug → возвращается', async () => {
    const visionOcr = vi.fn().mockResolvedValue({ text: 'vehicle_registration', confidence: 0.8 });
    const slug = await classifyImageViaVlm('img.png', 'vehicle_registration — СТС', { visionOcr, isCatalogSlug: isCatalogSlug(['vehicle_registration']) }, log);
    expect(slug).toBe('vehicle_registration');
    expect(visionOcr).toHaveBeenCalledOnce();
    // classify-промпт передан в visionOcr
    expect(visionOcr.mock.calls[0]![0].prompt).toContain('Типы:');
  });

  it('slug вне каталога → null', async () => {
    const visionOcr = vi.fn().mockResolvedValue({ text: 'выдуманный_тип', confidence: 0.5 });
    const slug = await classifyImageViaVlm('img.png', 'cmr — накладная', { visionOcr, isCatalogSlug: isCatalogSlug(['cmr']) }, log);
    expect(slug).toBeNull();
  });

  it('unknown → null', async () => {
    const visionOcr = vi.fn().mockResolvedValue({ text: 'unknown', confidence: 0.1 });
    const slug = await classifyImageViaVlm('img.png', 'cmr — x', { visionOcr, isCatalogSlug: isCatalogSlug(['cmr']) }, log);
    expect(slug).toBeNull();
  });

  it('ошибка vision → null (fail-soft)', async () => {
    const visionOcr = vi.fn().mockRejectedValue(new Error('vision down'));
    const slug = await classifyImageViaVlm('img.png', 'cmr — x', { visionOcr, isCatalogSlug: isCatalogSlug(['cmr']) }, log);
    expect(slug).toBeNull();
  });

  it('withVisionProvider оборачивает вызов', async () => {
    const visionOcr = vi.fn().mockResolvedValue({ text: 'cmr', confidence: 0.9 });
    const order: string[] = [];
    const withVisionProvider = async <T>(fn: () => Promise<T>): Promise<T> => {
      order.push('start');
      const r = await fn();
      order.push('end');
      return r;
    };
    const slug = await classifyImageViaVlm('img.png', 'cmr — x', { visionOcr, isCatalogSlug: isCatalogSlug(['cmr']), withVisionProvider }, log);
    expect(slug).toBe('cmr');
    expect(order).toEqual(['start', 'end']);
  });

  it('нет imagePath/catalog → null без вызова', async () => {
    const visionOcr = vi.fn();
    expect(await classifyImageViaVlm('', 'cat', { visionOcr, isCatalogSlug: isCatalogSlug([]) }, log)).toBeNull();
    expect(await classifyImageViaVlm('img', '', { visionOcr, isCatalogSlug: isCatalogSlug([]) }, log)).toBeNull();
    expect(visionOcr).not.toHaveBeenCalled();
  });
});
