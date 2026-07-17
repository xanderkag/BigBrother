/**
 * DEEP-PASS Фаза 1 (docs/DEEP-PASS-SPEC.md): второй ярус для нераспознанного
 * остатка. Покрываем: выбор пути text/vision, маппинг на рабочий каталог,
 * вердикты, ПДн-гейт (id_document), fail-soft, толерантный JSON-парс и
 * детерминированные ошибки без ретраев.
 */
import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { runDeepPass, salvageJson, type DeepPassDeps } from '../src/pipeline/deep-pass/run.js';
import { BROAD_TYPES, normalizeBroadSlug, broadCatalogText } from '../src/pipeline/deep-pass/broad-catalog.js';
import { isDeterministicJobError } from '../src/pipeline/orchestrator.js';
import { OcrRefusedError } from '../src/pipeline/ocr/refusal.js';

const log = pino({ level: 'silent' });

const baseInput = {
  workingCatalog: 'invoice — счёт-фактура\nCMR — международная накладная',
  textChars: 8000,
  minTextForTextPath: 300,
  reason: 'classify_unknown' as const,
};

function makeDeps(overrides: Partial<DeepPassDeps> = {}): DeepPassDeps {
  return {
    extract: vi.fn().mockResolvedValue({
      extracted: {
        broad_type: 'letter',
        catalog_slug: null,
        language: 'ru',
        summary: 'Официальное письмо о поставке.',
      },
      confidence: 0.8,
      issues: [],
    }),
    visionOcr: vi.fn().mockResolvedValue({
      text: '{"broad_type":"correspondence_screenshot","catalog_slug":null,"language":"zh","summary":"Скриншот переписки в мессенджере."}',
      confidence: 0.75,
    }),
    isCatalogSlug: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe('broad-catalog', () => {
  it('slug\'и уникальны и есть обязательные категории', () => {
    const slugs = BROAD_TYPES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const required of [
      'not_a_document',
      'other',
      'id_document',
      'correspondence_screenshot',
      'cargo_photo', // SLAI 2026-07-15: фото погрузки — отдельная сущность, не product_photo
    ]) {
      expect(slugs).toContain(required);
    }
  });

  it('normalizeBroadSlug: валидный → сам, мусор/null → other', () => {
    expect(normalizeBroadSlug('contract').slug).toBe('contract');
    expect(normalizeBroadSlug('`Contract`').slug).toBe('contract'); // чистка + регистр
    expect(normalizeBroadSlug('nonexistent').slug).toBe('other');
    expect(normalizeBroadSlug(null).slug).toBe('other');
  });

  it('broadCatalogText содержит все slug\'и (для промпта)', () => {
    const text = broadCatalogText();
    for (const t of BROAD_TYPES) expect(text).toContain(t.slug);
  });
});

describe('salvageJson', () => {
  it('парсит чистый JSON и JSON в markdown-обёртке', () => {
    expect(salvageJson('{"a":1}')).toEqual({ a: 1 });
    expect(salvageJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(salvageJson('Вот ответ: {"broad_type":"letter","summary":"х"} — готово')).toEqual({
      broad_type: 'letter',
      summary: 'х',
    });
  });

  it('мусор/пусто/массив → null', () => {
    expect(salvageJson('просто текст')).toBeNull();
    expect(salvageJson('')).toBeNull();
    expect(salvageJson(null)).toBeNull();
    expect(salvageJson('[1,2]')).toBeNull();
  });
});

describe('runDeepPass: выбор пути', () => {
  it('текста достаточно → text-путь (extract), vision не зовём', async () => {
    const deps = makeDeps();
    const res = await runDeepPass({ ...baseInput, text: 'x'.repeat(500) }, deps, log);
    expect(res).not.toBeNull();
    expect(res?.via).toBe('text');
    expect(res?.broad_type).toBe('letter');
    expect(res?.verdict).toBe('foreign_document');
    expect(deps.visionOcr).not.toHaveBeenCalled();
  });

  it('текста мало + есть картинка → vision-путь', async () => {
    const deps = makeDeps();
    const res = await runDeepPass({ ...baseInput, text: '', imagePath: '/tmp/p1.png' }, deps, log);
    expect(res?.via).toBe('vision');
    expect(res?.broad_type).toBe('correspondence_screenshot');
    expect(res?.language).toBe('zh');
    expect(deps.extract).not.toHaveBeenCalled();
  });

  it('текста мало и картинки нет → null (пропуск)', async () => {
    const res = await runDeepPass({ ...baseInput, text: 'коротко' }, makeDeps(), log);
    expect(res).toBeNull();
  });

  it('withVisionProvider оборачивает vision-вызов', async () => {
    const wrapped = vi.fn(<T,>(fn: () => Promise<T>) => fn());
    const deps = makeDeps({ withVisionProvider: wrapped });
    await runDeepPass({ ...baseInput, text: '', imagePath: '/tmp/p1.png' }, deps, log);
    expect(wrapped).toHaveBeenCalledOnce();
  });

  // 2026-07-17: для картинок OCR-текст обманчив (надписи на мешках/коробках →
  // text-путь примет фото за документ). forceVision смотрит на изображение,
  // даже когда текста хватило бы на text-путь.
  it('forceVision + картинка → vision, даже когда текста хватает (фото коробок)', async () => {
    const deps = makeDeps();
    const res = await runDeepPass(
      { ...baseInput, text: 'x'.repeat(500), imagePath: '/tmp/p1.png', forceVision: true },
      deps,
      log,
    );
    expect(res?.via).toBe('vision');
    expect(deps.extract).not.toHaveBeenCalled();
    expect(deps.visionOcr).toHaveBeenCalledOnce();
  });

  it('forceVision БЕЗ картинки → остаётся text-путь (не роняем)', async () => {
    const deps = makeDeps();
    const res = await runDeepPass(
      { ...baseInput, text: 'x'.repeat(500), forceVision: true },
      deps,
      log,
    );
    expect(res?.via).toBe('text');
    expect(deps.extract).toHaveBeenCalledOnce();
    expect(deps.visionOcr).not.toHaveBeenCalled();
  });
});

describe('runDeepPass: маппинг на рабочий каталог', () => {
  it('валидный catalog_slug → verdict mapped', async () => {
    const deps = makeDeps({
      extract: vi.fn().mockResolvedValue({
        extracted: { broad_type: 'invoice_like', catalog_slug: 'invoice', summary: 'Счёт.' },
        confidence: 0.8,
        issues: [],
      }),
      isCatalogSlug: vi.fn().mockResolvedValue(true),
    });
    const res = await runDeepPass({ ...baseInput, text: 'x'.repeat(500) }, deps, log);
    expect(res?.catalog_slug).toBe('invoice');
    expect(res?.verdict).toBe('mapped');
  });

  it('slug вне каталога → отброшен, verdict foreign_document', async () => {
    const deps = makeDeps({
      extract: vi.fn().mockResolvedValue({
        extracted: { broad_type: 'invoice_like', catalog_slug: 'hallucinated_type', summary: 'Счёт.' },
        confidence: 0.8,
        issues: [],
      }),
      isCatalogSlug: vi.fn().mockResolvedValue(false),
    });
    const res = await runDeepPass({ ...baseInput, text: 'x'.repeat(500) }, deps, log);
    expect(res?.catalog_slug).toBeNull();
    expect(res?.verdict).toBe('foreign_document');
  });

  it('not_a_document → одноимённый verdict', async () => {
    const deps = makeDeps({
      extract: vi.fn().mockResolvedValue({
        extracted: { broad_type: 'not_a_document', summary: 'Случайное фото.' },
        confidence: 0.8,
        issues: [],
      }),
    });
    const res = await runDeepPass({ ...baseInput, text: 'x'.repeat(500) }, deps, log);
    expect(res?.verdict).toBe('not_a_document');
    expect(res?.broad_label).toBe('Не документ');
  });
});

describe('runDeepPass: ПДн-гейт (152-ФЗ)', () => {
  it('id_document: резюме заменяется константой, маппинг не выполняется', async () => {
    const isCatalogSlug = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({
      extract: vi.fn().mockResolvedValue({
        extracted: {
          broad_type: 'id_document',
          catalog_slug: 'driver_passport',
          summary: 'Паспорт Иванова Ивана Ивановича, серия 1234 номер 567890',
        },
        confidence: 0.8,
        issues: [],
      }),
      isCatalogSlug,
    });
    const res = await runDeepPass({ ...baseInput, text: 'x'.repeat(500) }, deps, log);
    expect(res?.broad_type).toBe('id_document');
    expect(res?.summary).not.toContain('Иванов');
    expect(res?.summary).toContain('не сохраняется');
    expect(res?.catalog_slug).toBeNull();
    expect(res?.verdict).toBe('foreign_document');
    expect(isCatalogSlug).not.toHaveBeenCalled();
  });
});

describe('runDeepPass: fail-soft и деградации', () => {
  it('extract бросил → null, не исключение', async () => {
    const deps = makeDeps({ extract: vi.fn().mockRejectedValue(new Error('LLM down')) });
    await expect(runDeepPass({ ...baseInput, text: 'x'.repeat(500) }, deps, log)).resolves.toBeNull();
  });

  it('vision бросил → null, не исключение', async () => {
    const deps = makeDeps({ visionOcr: vi.fn().mockRejectedValue(new Error('vision down')) });
    await expect(
      runDeepPass({ ...baseInput, text: '', imagePath: '/tmp/p1.png' }, deps, log),
    ).resolves.toBeNull();
  });

  it('vision вернул не-JSON текст → берём как summary c broad_type=other', async () => {
    const deps = makeDeps({
      visionOcr: vi.fn().mockResolvedValue({ text: 'На изображении бланк письма.', confidence: 0.75 }),
    });
    const res = await runDeepPass({ ...baseInput, text: '', imagePath: '/tmp/p1.png' }, deps, log);
    expect(res?.broad_type).toBe('other');
    expect(res?.summary).toContain('бланк письма');
  });

  it('пустой ответ модели (нет ни broad_type, ни summary) → null', async () => {
    const deps = makeDeps({
      extract: vi.fn().mockResolvedValue({ extracted: {}, confidence: 0, issues: [] }),
    });
    await expect(runDeepPass({ ...baseInput, text: 'x'.repeat(500) }, deps, log)).resolves.toBeNull();
  });

  it('невалидный broad_type → other (не падаем)', async () => {
    const deps = makeDeps({
      extract: vi.fn().mockResolvedValue({
        extracted: { broad_type: 'made_up_stuff', summary: 'Что-то.' },
        confidence: 0.5,
        issues: [],
      }),
    });
    const res = await runDeepPass({ ...baseInput, text: 'x'.repeat(500) }, deps, log);
    expect(res?.broad_type).toBe('other');
  });
});

describe('isDeterministicJobError (ретраи впустую)', () => {
  it('OcrRefusedError → детерминированная (не ретраить)', () => {
    const err = new OcrRefusedError('vision-llm', {
      isRefusal: true,
      coverage: 1,
      preview: 'Извините…',
      pattern: 'test',
    });
    expect(isDeterministicJobError(err)).toBe(true);
  });

  it('неподдерживаемый mime → детерминированная', () => {
    expect(
      isDeterministicJobError(new Error('no OCR engine available for mime type application/zip')),
    ).toBe(true);
  });

  it('прочие ошибки (включая all OCR engines failed) → ретраи разрешены', () => {
    expect(isDeterministicJobError(new Error('all OCR engines failed'))).toBe(false);
    expect(isDeterministicJobError(new Error('ECONNREFUSED'))).toBe(false);
    expect(isDeterministicJobError('строка')).toBe(false);
  });
});
