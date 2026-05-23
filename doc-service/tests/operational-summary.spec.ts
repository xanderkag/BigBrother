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
    expect(s.by_engine).toEqual([]);
    expect(s.by_tier).toEqual([]);
  });

  it('shapes a typical response with totals/rates/percentiles/by_type', async () => {
    queryMock.mockReset();
    // Вызовы по порядку: totals, by_type, by_engine, by_tier.
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
            grp: 'invoice',
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
            grp: '_unknown',
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
      })
      .mockResolvedValueOnce({ rows: [] }) // by_engine
      .mockResolvedValueOnce({ rows: [] }); // by_tier

    const s = await jobsRepo.getOperationalSummary(168, { kind: 'all' });

    expect(queryMock).toHaveBeenCalledTimes(4);
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
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const s = await jobsRepo.getOperationalSummary(24, { kind: 'all' });
    expect(s.totals.total).toBe(0);
    expect(s.rates.done_rate).toBe(0);
    expect(s.rates.failed_rate).toBe(0);
    expect(s.rates.llm_fallback_rate).toBe(0);
    expect(s.throughput_per_hour).toBe(0);
    expect(s.latency.p50_ms).toBeNull();
    expect(s.by_type).toEqual([]);
    expect(s.by_engine).toEqual([]);
    expect(s.by_tier).toEqual([]);
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
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await jobsRepo.getOperationalSummary(24, {
      kind: 'org',
      orgId: '11111111-1111-1111-1111-111111111111',
    });
    // Каждый из 4 запросов (totals + 3 breakdown) получает тот же scope WHERE.
    expect(queryMock).toHaveBeenCalledTimes(4);
    for (const [sql, params] of queryMock.mock.calls) {
      expect(sql).toContain('organization_id =');
      expect(params).toContain('11111111-1111-1111-1111-111111111111');
    }
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
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await jobsRepo.getOperationalSummary(24, {
      kind: 'projects',
      projectIds: new Set([
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333',
      ]),
    });
    // Scope ANY-array применяется ко всем 4 запросам.
    expect(queryMock).toHaveBeenCalledTimes(4);
    for (const [sql, params] of queryMock.mock.calls) {
      expect(sql).toContain('project_id = ANY');
      const arr = (params as unknown[]).find((p) => Array.isArray(p)) as string[];
      expect(arr).toHaveLength(2);
      expect(arr).toContain('22222222-2222-2222-2222-222222222222');
    }
  });

  it('by_engine groups by ocr_engine; NULL/empty engine → _none label', async () => {
    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            total: '30',
            pending: '0',
            processing: '0',
            done: '25',
            needs_review: '3',
            failed: '2',
            validation_issues: '1',
            llm_used: '4',
            lat_p50: null,
            lat_p95: null,
            tok_in_p95: null,
            tok_out_p95: null,
            llm_dur_p95: null,
            avg_confidence: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // by_type
      .mockResolvedValueOnce({
        rows: [
          {
            grp: 'pdf-text',
            total: '20',
            done: '18',
            needs_review: '2',
            failed: '0',
            validation_issues: '1',
            llm_used: '0',
            lat_p50: '2000.0',
            lat_p95: '5000.0',
            avg_confidence: '0.95',
          },
          {
            grp: '_none',
            total: '10',
            done: '7',
            needs_review: '1',
            failed: '2',
            validation_issues: '0',
            llm_used: '4',
            lat_p50: null,
            lat_p95: null,
            avg_confidence: null,
          },
        ],
      }) // by_engine
      .mockResolvedValueOnce({ rows: [] }); // by_tier

    const s = await jobsRepo.getOperationalSummary(24, { kind: 'all' });

    // by_engine SQL — GROUP BY ocr_engine, NULL→_none.
    const engineSql = queryMock.mock.calls[2]![0] as string;
    expect(engineSql).toContain('ocr_engine');
    expect(engineSql).toContain("'_none'");

    expect(s.by_engine).toHaveLength(2);
    const pdf = s.by_engine[0]!;
    expect(pdf.engine).toBe('pdf-text');
    expect(pdf.total).toBe(20);
    expect(pdf.done_rate).toBeCloseTo(18 / 20, 5);
    expect(pdf.latency_p50_ms).toBe(2000);
    expect(pdf.avg_confidence).toBeCloseTo(0.95, 3);

    const none = s.by_engine[1]!;
    expect(none.engine).toBe('_none');
    expect(none.failed_rate).toBeCloseTo(2 / 10, 5);
    expect(none.latency_p50_ms).toBeNull();
    expect(none.avg_confidence).toBeNull();
  });

  it('by_tier LEFT JOINs document_types; no matching type → _untyped', async () => {
    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            total: '15',
            pending: '0',
            processing: '0',
            done: '12',
            needs_review: '2',
            failed: '1',
            validation_issues: '0',
            llm_used: '5',
            lat_p50: null,
            lat_p95: null,
            tok_in_p95: null,
            tok_out_p95: null,
            llm_dur_p95: null,
            avg_confidence: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // by_type
      .mockResolvedValueOnce({ rows: [] }) // by_engine
      .mockResolvedValueOnce({
        rows: [
          {
            grp: 'stable',
            total: '10',
            done: '9',
            needs_review: '1',
            failed: '0',
            validation_issues: '0',
            llm_used: '1',
            lat_p50: '1500.0',
            lat_p95: '4000.0',
            avg_confidence: '0.88',
          },
          {
            grp: '_untyped',
            total: '5',
            done: '3',
            needs_review: '1',
            failed: '1',
            validation_issues: '0',
            llm_used: '4',
            lat_p50: null,
            lat_p95: null,
            avg_confidence: null,
          },
        ],
      }); // by_tier

    const s = await jobsRepo.getOperationalSummary(24, { kind: 'all' });

    // by_tier SQL — LEFT JOIN document_types, GROUP BY tier, NULL→_untyped.
    const tierSql = queryMock.mock.calls[3]![0] as string;
    expect(tierSql).toContain('LEFT JOIN document_types dt');
    expect(tierSql).toContain('dt.tier');
    expect(tierSql).toContain("'_untyped'");

    expect(s.by_tier).toHaveLength(2);
    const stable = s.by_tier[0]!;
    expect(stable.tier).toBe('stable');
    expect(stable.total).toBe(10);
    expect(stable.done_rate).toBeCloseTo(9 / 10, 5);
    expect(stable.latency_p95_ms).toBe(4000);

    const untyped = s.by_tier[1]!;
    expect(untyped.tier).toBe('_untyped');
    expect(untyped.llm_fallback_rate).toBeCloseTo(4 / 5, 5);
    expect(untyped.latency_p50_ms).toBeNull();
  });
});
