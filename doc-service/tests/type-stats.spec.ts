/**
 * Тесты для агрегационных методов jobsRepo, отвечающих за страницу
 * /document-types/:slug — listByDocumentType + getTypeStats + getFieldCoverage.
 *
 * Без живой БД — мокаем `db.query` через vi.spyOn и проверяем, что
 * генерируемый SQL/параметры соответствуют контракту. Реальные SQL-
 * прогоны проверяются интеграционными тестами.
 */

import { describe, it, expect, vi } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { db } from '../src/db.js';
import { jobsRepo } from '../src/storage/jobs.js';

function stubQuery<T extends Record<string, unknown>>(returnRows: T[]): {
  spy: ReturnType<typeof vi.spyOn>;
  capturedArgs: Array<{ sql: string; params?: unknown[] }>;
} {
  const capturedArgs: Array<{ sql: string; params?: unknown[] }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spy = vi.spyOn(db, 'query' as any).mockImplementation(((sql: string, params?: unknown[]) => {
    capturedArgs.push({ sql, params });
    return Promise.resolve({ rows: returnRows, rowCount: returnRows.length });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
  return { spy, capturedArgs };
}

describe('jobsRepo.listByDocumentType', () => {
  it('делает SELECT с WHERE document_type=ANY($1) LIMIT $2 (обе формы слага)', async () => {
    const { spy, capturedArgs } = stubQuery([]);
    await jobsRepo.listByDocumentType('commercial_invoice', 25);
    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0]!.sql).toMatch(/document_type\s*=\s*ANY\(\$1\)/);
    expect(capturedArgs[0]!.sql).toMatch(/ORDER BY created_at DESC/);
    expect(capturedArgs[0]!.sql).toMatch(/LIMIT \$2/);
    expect(capturedArgs[0]!.params).toEqual([['commercial_invoice'], 25]);
    spy.mockRestore();
  });

  it('алиасный слаг расширяется в обе формы (CMR → CMR+cmr)', async () => {
    const { spy, capturedArgs } = stubQuery([]);
    await jobsRepo.listByDocumentType('CMR', 25);
    expect(capturedArgs[0]!.params).toEqual([['CMR', 'cmr'], 25]);
    spy.mockRestore();
  });

  it('limit по умолчанию = 50', async () => {
    const { spy, capturedArgs } = stubQuery([]);
    await jobsRepo.listByDocumentType('invoice');
    expect(capturedArgs[0]!.params).toEqual([['invoice'], 50]);
    spy.mockRestore();
  });
});

describe('jobsRepo.getTypeStats', () => {
  it('возвращает структуру с total / breakdown / avg_confidence', async () => {
    const { spy } = stubQuery([
      { total_jobs: '156', done: '142', needs_review: '12', failed: '2', avg_confidence: '0.873' },
    ]);
    const stats = await jobsRepo.getTypeStats('invoice', 30);
    expect(stats).toEqual({
      total_jobs: 156,
      terminal_breakdown: { done: 142, needs_review: 12, failed: 2 },
      avg_confidence: 0.873,
    });
    spy.mockRestore();
  });

  it('avg_confidence=null когда нет терминальных jobs', async () => {
    const { spy } = stubQuery([
      { total_jobs: '0', done: '0', needs_review: '0', failed: '0', avg_confidence: null },
    ]);
    const stats = await jobsRepo.getTypeStats('invoice', 30);
    expect(stats.avg_confidence).toBeNull();
    spy.mockRestore();
  });

  it('параметризует slug и days (защита от SQL injection)', async () => {
    const { spy, capturedArgs } = stubQuery([
      { total_jobs: '0', done: '0', needs_review: '0', failed: '0', avg_confidence: null },
    ]);
    await jobsRepo.getTypeStats("'; DROP TABLE jobs; --", 30);
    // Слаг уходит массивом кандидатов в ANY($1) — по-прежнему параметром.
    expect(capturedArgs[0]!.params).toEqual([["'; DROP TABLE jobs; --"], '30']);
    spy.mockRestore();
  });
});

describe('jobsRepo.getFieldCoverage', () => {
  it('пустой expectedFields → пустой массив без SQL-вызова', async () => {
    const { spy } = stubQuery([]);
    const r = await jobsRepo.getFieldCoverage('invoice', [], 30);
    expect(r).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('строит dot-path как массив для jsonb #> path-индексации', async () => {
    const { spy, capturedArgs } = stubQuery([
      { total: '100', f0: '95', f1: '70' },
    ]);
    const r = await jobsRepo.getFieldCoverage('invoice', ['number', 'seller.inn'], 30);
    // params: [slug-кандидаты (обе формы), days, path0, path1, ...]
    expect(capturedArgs[0]!.params).toEqual([
      ['invoice'],
      '30',
      ['number'],
      ['seller', 'inn'],
    ]);
    expect(r).toEqual([
      { field: 'number', filled: 95, total: 100 },
      { field: 'seller.inn', filled: 70, total: 100 },
    ]);
    spy.mockRestore();
  });

  it('total=0 → каждое поле получает filled=0, total=0 (нет деления на ноль)', async () => {
    const { spy } = stubQuery([{ total: '0', f0: '0' }]);
    const r = await jobsRepo.getFieldCoverage('invoice', ['number'], 30);
    expect(r).toEqual([{ field: 'number', filled: 0, total: 0 }]);
    spy.mockRestore();
  });
});
