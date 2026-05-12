/**
 * Unit-тесты на operational-сводку: проверяем shape-трансформацию и
 * rate-математику без живой БД (db.query замокан).
 *
 * SQL сам не проверяем — он будет проверен интеграционным smoke'ом
 * против реальной БД при первом серверном прогоне. Здесь — что Node
 * правильно собирает финальный объект.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

// Минимальный env, чтобы config.ts не падал на zod-валидации при импорте.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

// Замокаем db.query. Должно быть СТРОГО до импорта jobs.ts.
const queryMock = vi.fn();
vi.mock('../src/db.js', () => ({
  db: { query: (...args: unknown[]) => queryMock(...args) },
}));

let jobsRepo: typeof import('../src/storage/jobs.js').jobsRepo;
beforeAll(async () => {
  const mod = await import('../src/storage/jobs.js');
  jobsRepo = mod.jobsRepo;
});

describe('jobsRepo.getOperationalSummary', () => {
  it('returns zero-filled empty summary on empty projects scope WITHOUT hitting DB', async () => {
    queryMock.mockReset();
    const s = await jobsRepo.getOperationalSummary(168, {
      kind: 'projects',
      projectIds: new Set(),
    });
    expect(queryMock).not.toHaveBeenCalled();
    expect(s.window_hours).toBe(168);
    expect(s.totals.total).toBe(0);
    expect(s.totals.done).toBe(0);
    expect(s.rates.done_rate).toBe(0);
    expect(s.rates.needs_review_rate).toBe(0);
    expect(s.latency.p50_ms).toBeNull();
    expect(s.latency.p95_ms).toBeNull();
    expect(s.llm.tokens_in_p95).toBeNull();
    expect(s.throughput_per_hour).toBe(0);
    expect(s.by_type).toEqual([]);
  });

  it('shapes a typical response with totals/rates/percentiles/by_type', async () => {
    queryMock.mockReset();
    // Первый вызов: тоталы. Второй: per-type breakdown.
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            total: '100',
            pending: '2',
            processing: '3',
            done: '70',
            needs_review: '20',
            failed: '5',
            validation_issues: '15',
            llm_used: '30',
            lat_p50: '4500.7',
            lat_p95: '12000.4',
            tok_in_p95: '1800.0',
            tok_out_p95: '450.0',
            llm_dur_p95: '850.0',
            avg_confidence: '0.872',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            slug: 'invoice',
            total: '60',
            done: '50',
            needs_review: '8',
            failed: '2',
            validation_issues: '5',
            llm_used: '10',
            lat_p50: '3500.0',
            lat_p95: '9000.0',
            avg_confidence: '0.91',
          },
          {
            slug: '_unknown',
            total: '10',
            done: '0',
            needs_review: '5',
            failed: '5',
            validation_issues: '5',
            llm_used: '8',
            lat_p50: null,
            lat_p95: null,
            avg_confidence: null,
          },
        ],
      });

    const s = await jobsRepo.getOperationalSummary(168, { kind: 'all' });

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(s.window_hours).toBe(168);
    expect(s.totals).toEqual({
      total: 100,
      pending: 2,
      processing: 3,
      done: 70,
      needs_review: 20,
      failed: 5,
      validation_issues: 15,
      llm_used: 30,
    });
    expect(s.rates.done_rate).toBeCloseTo(0.7, 5);
    expect(s.rates.needs_review_rate).toBeCloseTo(0.2, 5);
    expect(s.rates.failed_rate).toBeCloseTo(0.05, 5);
    expect(s.rates.validation_issue_rate).toBeCloseTo(0.15, 5);
    expect(s.rates.llm_fallback_rate).toBeCloseTo(0.3, 5);
    expect(s.latency.p50_ms).toBe(4501); // round to int
    expect(s.latency.p95_ms).toBe(12000);
    expect(s.llm.tokens_in_p95).toBe(1800);
    expect(s.llm.tokens_out_p95).toBe(450);
    expect(s.llm.duration_p95_ms).toBe(850);
    expect(s.avg_confidence).toBeCloseTo(0.872, 3);
    expect(s.throughput_per_hour).toBeCloseTo(100 / 168, 2);

    expect(s.by_type).toHaveLength(2);
    const inv = s.by_type[0]!;
    expect(inv.slug).toBe('invoice');
    expect(inv.total).toBe(60);
    expect(inv.done_rate).toBeCloseTo(50 / 60, 5);
    expect(inv.needs_review_rate).toBeCloseTo(8 / 60, 5);
    expect(inv.failed_rate).toBeCloseTo(2 / 60, 5);
    expect(inv.llm_fallback_rate).toBeCloseTo(10 / 60, 5);
    expect(inv.latency_p50_ms).toBe(3500);
    expect(inv.latency_p95_ms).toBe(9000);
    expect(inv.avg_confidence).toBeCloseTo(0.91, 3);

    const unk = s.by_type[1]!;
    expect(unk.slug).toBe('_unknown');
    expect(unk.latency_p50_ms).toBeNull();
    expect(unk.latency_p95_ms).toBeNull();
    expect(unk.avg_confidence).toBeNull();
  });

  it('handles total=0 row without /0 errors', async () => {
    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            total: '0',
            pending: '0',
            processing: '0',
            done: '0',
            needs_review: '0',
            failed: '0',
            validation_issues: '0',
            llm_used: '0',
            lat_p50: null,
            lat_p95: null,
            tok_in_p95: null,
            tok_out_p95: null,
            llm_dur_p95: null,
            avg_confidence: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const s = await jobsRepo.getOperationalSummary(24, { kind: 'all' });
    expect(s.totals.total).toBe(0);
    expect(s.rates.done_rate).toBe(0);
    expect(s.rates.failed_rate).toBe(0);
    expect(s.rates.llm_fallback_rate).toBe(0);
    expect(s.throughput_per_hour).toBe(0);
    expect(s.latency.p50_ms).toBeNull();
    expect(s.by_type).toEqual([]);
  });

  it('passes organization_id as scope param for kind:org', async () => {
    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            total: '0',
            pending: '0',
            processing: '0',
            done: '0',
            needs_review: '0',
            failed: '0',
            validation_issues: '0',
            llm_used: '0',
            lat_p50: null,
            lat_p95: null,
            tok_in_p95: null,
            tok_out_p95: null,
            llm_dur_p95: null,
            avg_confidence: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await jobsRepo.getOperationalSummary(24, {
      kind: 'org',
      orgId: '11111111-1111-1111-1111-111111111111',
    });
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(sql).toContain('organization_id =');
    expect(params).toContain('11111111-1111-1111-1111-111111111111');
  });

  it('passes project_ids ANY-array for kind:projects', async () => {
    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            total: '0',
            pending: '0',
            processing: '0',
            done: '0',
            needs_review: '0',
            failed: '0',
            validation_issues: '0',
            llm_used: '0',
            lat_p50: null,
            lat_p95: null,
            tok_in_p95: null,
            tok_out_p95: null,
            llm_dur_p95: null,
            avg_confidence: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await jobsRepo.getOperationalSummary(24, {
      kind: 'projects',
      projectIds: new Set([
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
      ]),
    });
    const [sql, params] = queryMock.mock.calls[0]!;
    expect(sql).toContain('project_id = ANY');
    const arr = (params as unknown[]).find((p) => Array.isArray(p)) as string[];
    expect(arr).toHaveLength(2);
    expect(arr).toContain('22222222-2222-2222-2222-222222222222');
  });
});
