/**
 * Stall-guard (2026-07-22): «точный подвисон» — зависшая в processing джоба
 * после stallMaxReclaims безуспешных reclaim'ов метится failed + _stall_
 * deferred (батч-перепроверка), а не ретраится вечно.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { startPendingJobSweeper } from '../src/workers/pending-job-sweeper.js';
import type { JobRow } from '../src/storage/jobs.js';

const log = { child: () => log, info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function row(id: string, reclaims: number): JobRow {
  return { id, metadata: reclaims > 0 ? { _reclaim_count: reclaims } : null } as JobRow;
}

function makeRepo(stuck: JobRow[]) {
  return {
    findStalePending: vi.fn(async () => []),
    findStuckProcessing: vi.fn(async () => stuck),
    bumpReclaimCount: vi.fn(async () => 1),
    markStalledDeferred: vi.fn(async () => true),
  };
}

describe('stall-guard в pending-sweeper', () => {
  let enqueue: ReturnType<typeof vi.fn>;
  let onStallDeferred: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    enqueue = vi.fn(async () => {});
    onStallDeferred = vi.fn();
  });

  it('reclaims < max → восстановительный re-enqueue + bump, НЕ метим', async () => {
    const repo = makeRepo([row('j1', 0)]);
    const s = startPendingJobSweeper({ log, jobsRepo: repo, enqueue, onStallDeferred, stallMaxReclaims: 2 });
    await s.runOnce();
    s.stop();
    expect(repo.bumpReclaimCount).toHaveBeenCalledWith('j1');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(repo.markStalledDeferred).not.toHaveBeenCalled();
    expect(onStallDeferred).not.toHaveBeenCalled();
  });

  it('reclaims >= max → метим stalled/failed, НЕ ретраим', async () => {
    const repo = makeRepo([row('j2', 2)]);
    const s = startPendingJobSweeper({ log, jobsRepo: repo, enqueue, onStallDeferred, stallMaxReclaims: 2 });
    await s.runOnce();
    s.stop();
    expect(repo.markStalledDeferred).toHaveBeenCalledOnce();
    expect(repo.markStalledDeferred.mock.calls[0]![0]).toBe('j2');
    expect(enqueue).not.toHaveBeenCalled();
    expect(repo.bumpReclaimCount).not.toHaveBeenCalled();
    expect(onStallDeferred).toHaveBeenCalledOnce();
  });

  it('markStalledDeferred=false (гонка: сама финализировалась) → метрику не бьём', async () => {
    const repo = makeRepo([row('j3', 5)]);
    repo.markStalledDeferred.mockResolvedValueOnce(false);
    const s = startPendingJobSweeper({ log, jobsRepo: repo, enqueue, onStallDeferred, stallMaxReclaims: 2 });
    await s.runOnce();
    s.stop();
    expect(onStallDeferred).not.toHaveBeenCalled();
  });

  it('stallMaxReclaims=0 → выключено, всегда re-enqueue (старое поведение)', async () => {
    const repo = makeRepo([row('j4', 9)]);
    const s = startPendingJobSweeper({ log, jobsRepo: repo, enqueue, onStallDeferred, stallMaxReclaims: 0 });
    await s.runOnce();
    s.stop();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(repo.markStalledDeferred).not.toHaveBeenCalled();
  });
});
