/**
 * Unit-тесты diffExtracted (operator corrections ledger) + toApi-форма
 * репозитория extraction_corrections.
 *
 * diffExtracted — чистая функция без БД. toApi — pure-форматтер строки.
 * Lifecycle (createMany/listByJob) требует живой БД — здесь не покрываем.
 */

import { describe, it, expect } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { diffExtracted } from '../src/pipeline/normalize/diff-extracted.js';
import {
  extractionCorrectionsRepo,
  type ExtractionCorrectionRow,
} from '../src/storage/extraction-corrections.js';

/** Сортируем по path — порядок обхода Set не гарантирован, тесты — по содержимому. */
function byPath(entries: ReturnType<typeof diffExtracted>) {
  return [...entries].sort((a, b) => a.path.localeCompare(b.path));
}

describe('diffExtracted — changed leaves', () => {
  it('меняет скаляр на верхнем уровне', () => {
    const d = diffExtracted({ number: '100' }, { number: '200' });
    expect(d).toEqual([{ path: 'number', before: '100', after: '200' }]);
  });

  it('не эмитит ничего когда значения равны', () => {
    expect(diffExtracted({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toEqual([]);
  });

  it('вложенные объекты → dot-path', () => {
    const before = { parties: { seller: { inn: '7700000000', name: 'ООО Ромашка' } } };
    const after = { parties: { seller: { inn: '7811111111', name: 'ООО Ромашка' } } };
    expect(diffExtracted(before, after)).toEqual([
      { path: 'parties.seller.inn', before: '7700000000', after: '7811111111' },
    ]);
  });

  it('массивы → index в пути', () => {
    const before = { items: [{ name: 'болт' }, { name: 'гайка' }] };
    const after = { items: [{ name: 'болт' }, { name: 'шайба' }] };
    expect(diffExtracted(before, after)).toEqual([
      { path: 'items.1.name', before: 'гайка', after: 'шайба' },
    ]);
  });
});

describe('diffExtracted — added / removed leaves', () => {
  it('ADDED → before=null', () => {
    const d = diffExtracted({ a: '1' }, { a: '1', b: '2' });
    expect(d).toEqual([{ path: 'b', before: null, after: '2' }]);
  });

  it('REMOVED → after=null', () => {
    const d = diffExtracted({ a: '1', b: '2' }, { a: '1' });
    expect(d).toEqual([{ path: 'b', before: '2', after: null }]);
  });

  it('добавление элемента в массив → ADDED по новому индексу', () => {
    const before = { items: [{ name: 'a' }] };
    const after = { items: [{ name: 'a' }, { name: 'b' }] };
    expect(diffExtracted(before, after)).toEqual([
      { path: 'items.1.name', before: null, after: 'b' },
    ]);
  });

  it('удаление хвоста массива → REMOVED', () => {
    const before = { items: [{ name: 'a' }, { name: 'b' }] };
    const after = { items: [{ name: 'a' }] };
    expect(diffExtracted(before, after)).toEqual([
      { path: 'items.1.name', before: 'b', after: null },
    ]);
  });

  it('смешанная правка: changed + added + removed', () => {
    const before = { a: '1', b: '2', c: '3' };
    const after = { a: '1', b: '20', d: '4' }; // b changed, c removed, d added
    expect(byPath(diffExtracted(before, after))).toEqual([
      { path: 'b', before: '2', after: '20' },
      { path: 'c', before: '3', after: null },
      { path: 'd', before: null, after: '4' },
    ]);
  });
});

describe('diffExtracted — leaf stringification', () => {
  it('number/bool → String, string как есть, null → null', () => {
    const before = { n: 1, b: true, s: 'x', z: null };
    const after = { n: 2, b: false, s: 'y', z: 'now-set' };
    expect(byPath(diffExtracted(before, after))).toEqual([
      { path: 'b', before: 'true', after: 'false' },
      { path: 'n', before: '1', after: '2' },
      { path: 's', before: 'x', after: 'y' },
      // null лист на before-стороне присутствует как ключ → CHANGED null→'now-set'
      { path: 'z', before: null, after: 'now-set' },
    ]);
  });

  it('0 / false / "" не считаются отсутствующими (CHANGED, не ADDED/REMOVED)', () => {
    const d = byPath(diffExtracted({ a: 0, b: false, c: '' }, { a: 1, b: true, c: 'x' }));
    expect(d).toEqual([
      { path: 'a', before: '0', after: '1' },
      { path: 'b', before: 'false', after: 'true' },
      { path: 'c', before: '', after: 'x' },
    ]);
  });

  it('число → строка, без изменения значения не эмитит', () => {
    expect(diffExtracted({ a: 100 }, { a: 100 })).toEqual([]);
  });
});

describe('diffExtracted — meta-key exclusion', () => {
  it('исключает мета-ключи на верхнем уровне', () => {
    const before = { a: '1', _issues: ['old'], _field_confidence: { a: 0.5 } };
    const after = { a: '2', _issues: ['new'], _field_confidence: { a: 0.9 } };
    expect(diffExtracted(before, after)).toEqual([{ path: 'a', before: '1', after: '2' }]);
  });

  it('исключает мета-ключи на любом уровне вложенности', () => {
    const before = { doc: { _match_signals: { x: 1 }, name: 'A' } };
    const after = { doc: { _match_signals: { x: 2 }, name: 'B' } };
    expect(diffExtracted(before, after)).toEqual([
      { path: 'doc.name', before: 'A', after: 'B' },
    ]);
  });

  it('исключает все зарезервированные ключи', () => {
    const meta = {
      _match_signals: { a: 1 },
      _normalized_fields: ['x'],
      _field_confidence: { a: 0.1 },
      _issues: ['e'],
      _multidoc_documents: [{ a: 1 }],
    };
    const before = { real: '1', ...meta };
    const after = {
      real: '2',
      _match_signals: { a: 9 },
      _normalized_fields: ['y'],
      _field_confidence: { a: 0.9 },
      _issues: ['e2'],
      _multidoc_documents: [{ a: 2 }],
    };
    expect(diffExtracted(before, after)).toEqual([{ path: 'real', before: '1', after: '2' }]);
  });
});

describe('diffExtracted — robustness to null / non-object', () => {
  it('before=null → все листья after как ADDED', () => {
    expect(byPath(diffExtracted(null, { a: '1', b: '2' }))).toEqual([
      { path: 'a', before: null, after: '1' },
      { path: 'b', before: null, after: '2' },
    ]);
  });

  it('after=undefined → все листья before как REMOVED', () => {
    expect(diffExtracted({ a: '1' }, undefined)).toEqual([
      { path: 'a', before: '1', after: null },
    ]);
  });

  it('обе стороны null/undefined → пусто', () => {
    expect(diffExtracted(null, null)).toEqual([]);
    expect(diffExtracted(undefined, undefined)).toEqual([]);
    expect(diffExtracted(null, undefined)).toEqual([]);
  });

  it('сторона-скаляр трактуется как отсутствие контейнера (не эмитит)', () => {
    expect(diffExtracted('a string', { a: '1' })).toEqual([
      { path: 'a', before: null, after: '1' },
    ]);
    expect(diffExtracted(42, 43)).toEqual([]);
  });

  it('не разворачивает и не эмитит целые объекты/массивы как листья', () => {
    // Меняется только вложенный лист — родительский объект не появляется как path.
    const d = diffExtracted({ obj: { x: '1' } }, { obj: { x: '2' } });
    expect(d).toEqual([{ path: 'obj.x', before: '1', after: '2' }]);
    expect(d.some((e) => e.path === 'obj')).toBe(false);
  });
});

function row(overrides: Partial<ExtractionCorrectionRow> = {}): ExtractionCorrectionRow {
  return {
    id: '7',
    job_id: '00000000-0000-0000-0000-000000000001',
    document_type: 'upd',
    field_path: 'parties.seller.inn',
    value_before: '7700000000',
    value_after: '7811111111',
    source_system: 'SLAI',
    corrected_by: 'operator@taipit.ru',
    created_at: new Date('2026-06-15T10:00:00Z'),
    ...overrides,
  };
}

describe('extractionCorrectionsRepo.toApi', () => {
  it('snake_case ключи + дата → ISO, id → строка', () => {
    expect(extractionCorrectionsRepo.toApi(row())).toEqual({
      id: '7',
      job_id: '00000000-0000-0000-0000-000000000001',
      document_type: 'upd',
      field_path: 'parties.seller.inn',
      value_before: '7700000000',
      value_after: '7811111111',
      source_system: 'SLAI',
      corrected_by: 'operator@taipit.ru',
      created_at: '2026-06-15T10:00:00.000Z',
    });
  });

  it('BIGSERIAL id числом → строка', () => {
    const api = extractionCorrectionsRepo.toApi(row({ id: 100 as unknown as string }));
    expect(api.id).toBe('100');
    expect(typeof api.id).toBe('string');
  });

  it('nullable поля (before/after/document_type/source/by) сохраняют null', () => {
    const api = extractionCorrectionsRepo.toApi(
      row({
        document_type: null,
        value_before: null,
        value_after: null,
        source_system: null,
        corrected_by: null,
      }),
    );
    expect(api.document_type).toBeNull();
    expect(api.value_before).toBeNull();
    expect(api.value_after).toBeNull();
    expect(api.source_system).toBeNull();
    expect(api.corrected_by).toBeNull();
  });
});
