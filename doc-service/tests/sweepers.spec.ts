/**
 * Sweeper tests — exercise the pending-job and file-cleanup loops against
 * stub repositories and stub side effects. No real DB, no real Redis, no
 * real filesystem. We invoke `runOnce()` directly rather than waiting for
 * setInterval to fire, so tests are deterministic and fast.
 *
 * Required env is set before importing the workers because both modules
 * pull defaults from `config` at import time.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import pino from 'pino';
import type { JobRow } from '../src/storage/jobs.js';

// Minimal env to let config.ts pass zod validation without touching real infra.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

const log = pino({ level: 'silent' });

// Fabricate a JobRow with just the fields the sweepers actually read. The
// type-cast is fine — production code never touches the omitted columns
// on these specific rows.
function fakeRow(overrides: Partial<JobRow>): JobRow {
  return {
    id: overrides.id ?? '00000000-0000-0000-0000-000000000000',
    status: overrides.status ?? 'pending',
    file_name: 'doc.pdf',
    file_path: overrides.file_path ?? '/tmp/docsvc-test/uploads/abc/doc.pdf',
    file_size: '1000',
    mime_type: 'application/pdf',
    document_hint: null,
    document_type: null,
    ocr_engine: null,
    raw_text: null,
    confidence: null,
    extracted: null,
    extracted_corrected_at: null,
    metadata: null,
    webhook_url: null,
    webhook_attempts: 0,
    webhook_delivered_at: null,
    webhook_last_error: null,
    error: null,
    created_at: new Date(),
    updated_at: new Date(),
    started_at: null,
    finished_at: null,
    ...overrides,
  } as JobRow;
}

let startPendingJobSweeper: typeof import('../src/workers/pending-job-sweeper.js').startPendingJobSweeper;
let startFileCleanupSweeper: typeof import('../src/workers/file-cleanup.js').startFileCleanupSweeper;

beforeAll(async () => {
  ({ startPendingJobSweeper } = await import('../src/workers/pending-job-sweeper.js'));
  ({ startFileCleanupSweeper } = await import('../src/workers/file-cleanup.js'));
});

describe('pending-job sweeper', () => {
  it('does nothing when no stale rows', async () => {
    const enqueue = vi.fn();
    const sweeper = startPendingJobSweeper({
      log,
      jobsRepo: { findStalePending: async () => [], findStuckProcessing: async () => [] },
      enqueue,
      intervalMs: 1_000_000, // effectively disabled so test controls timing
    });

    const count = await sweeper.runOnce();
    expect(count).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    sweeper.stop();
  });

  it('re-enqueues every stale row with its own jobId', async () => {
    const rows = [
      fakeRow({ id: 'aaaa-1', status: 'pending' }),
      fakeRow({ id: 'aaaa-2', status: 'pending' }),
    ];
    const enqueue = vi.fn().mockResolvedValue(undefined);

    const sweeper = startPendingJobSweeper({
      log,
      jobsRepo: { findStalePending: async () => rows, findStuckProcessing: async () => [] },
      enqueue,
      intervalMs: 1_000_000,
    });

    const count = await sweeper.runOnce();
    expect(count).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
    // Each call: ({jobId, requestId}, bullId) with matching ids.
    expect(enqueue).toHaveBeenNthCalledWith(1, { jobId: 'aaaa-1', requestId: undefined }, 'aaaa-1');
    expect(enqueue).toHaveBeenNthCalledWith(2, { jobId: 'aaaa-2', requestId: undefined }, 'aaaa-2');
    sweeper.stop();
  });

  it('keeps going if one enqueue fails — others still processed', async () => {
    const rows = [
      fakeRow({ id: 'ok-1' }),
      fakeRow({ id: 'broken' }),
      fakeRow({ id: 'ok-2' }),
    ];
    const enqueue = vi.fn().mockImplementation(async (payload: { jobId: string }) => {
      if (payload.jobId === 'broken') throw new Error('Redis is sad');
    });

    const sweeper = startPendingJobSweeper({
      log,
      jobsRepo: { findStalePending: async () => rows, findStuckProcessing: async () => [] },
      enqueue,
      intervalMs: 1_000_000,
    });

    await sweeper.runOnce();
    expect(enqueue).toHaveBeenCalledTimes(3);
    sweeper.stop();
  });

  it('overlap guard: parallel runOnce is a no-op for the second caller', async () => {
    let resolveQuery!: (rows: JobRow[]) => void;
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const sweeper = startPendingJobSweeper({
      log,
      jobsRepo: {
        findStalePending: () =>
          new Promise<JobRow[]>((res) => {
            resolveQuery = res;
          }),
        findStuckProcessing: async () => [],
      },
      enqueue,
      intervalMs: 1_000_000,
    });

    const first = sweeper.runOnce();
    // While first is mid-flight, the second invocation must short-circuit.
    const secondPromise = sweeper.runOnce();
    expect(await secondPromise).toBe(0);

    resolveQuery([fakeRow({ id: 'late' })]);
    await first;
    expect(enqueue).toHaveBeenCalledTimes(1);
    sweeper.stop();
  });
});

describe('file-cleanup sweeper', () => {
  it('does nothing when no candidates', async () => {
    const removeFile = vi.fn();
    const markFileDeleted = vi.fn();

    const sweeper = startFileCleanupSweeper({
      log,
      jobsRepo: {
        findFinishedWithFileOlderThan: async () => [],
        markFileDeleted,
      },
      removeFile,
      intervalMs: 1_000_000,
    });

    expect(await sweeper.runOnce()).toBe(0);
    expect(removeFile).not.toHaveBeenCalled();
    expect(markFileDeleted).not.toHaveBeenCalled();
    sweeper.stop();
  });

  it('removes files and marks rows for each candidate', async () => {
    const rows = [
      fakeRow({ id: 'old-1', status: 'done', file_path: '/tmp/u/1/a.pdf' }),
      fakeRow({ id: 'old-2', status: 'failed', file_path: '/tmp/u/2/b.pdf' }),
    ];
    const removeFile = vi.fn().mockResolvedValue(true);
    const markFileDeleted = vi.fn().mockResolvedValue(undefined);

    const sweeper = startFileCleanupSweeper({
      log,
      jobsRepo: {
        findFinishedWithFileOlderThan: async () => rows,
        markFileDeleted,
      },
      removeFile,
      intervalMs: 1_000_000,
    });

    const cleaned = await sweeper.runOnce();
    expect(cleaned).toBe(2);
    expect(removeFile).toHaveBeenNthCalledWith(1, '/tmp/u/1/a.pdf');
    expect(removeFile).toHaveBeenNthCalledWith(2, '/tmp/u/2/b.pdf');
    // audit #9: done/failed → clearRawText=true (чистим и raw_text, ПДн).
    expect(markFileDeleted).toHaveBeenNthCalledWith(1, 'old-1', true);
    expect(markFileDeleted).toHaveBeenNthCalledWith(2, 'old-2', true);
    sweeper.stop();
  });

  it('audit #9: needs_review сохраняет raw_text (clearRawText=false), файл всё равно удаляется', async () => {
    const rows = [
      fakeRow({ id: 'nr-1', status: 'needs_review', file_path: '/tmp/u/3/c.pdf' }),
      fakeRow({ id: 'done-1', status: 'done', file_path: '/tmp/u/4/d.pdf' }),
    ];
    const removeFile = vi.fn().mockResolvedValue(true);
    const markFileDeleted = vi.fn().mockResolvedValue(undefined);
    const sweeper = startFileCleanupSweeper({
      log,
      jobsRepo: { findFinishedWithFileOlderThan: async () => rows, markFileDeleted },
      removeFile,
      intervalMs: 1_000_000,
    });
    await sweeper.runOnce();
    // Файл удаляется у обоих; raw_text чистится только у done, не у needs_review.
    expect(removeFile).toHaveBeenNthCalledWith(1, '/tmp/u/3/c.pdf');
    expect(markFileDeleted).toHaveBeenNthCalledWith(1, 'nr-1', false);
    expect(markFileDeleted).toHaveBeenNthCalledWith(2, 'done-1', true);
    sweeper.stop();
  });

  it('does NOT mark row deleted if filesystem unlink throws', async () => {
    const rows = [fakeRow({ id: 'unlink-broken', status: 'done' })];
    const removeFile = vi.fn().mockRejectedValue(new Error('EACCES'));
    const markFileDeleted = vi.fn();

    const sweeper = startFileCleanupSweeper({
      log,
      jobsRepo: {
        findFinishedWithFileOlderThan: async () => rows,
        markFileDeleted,
      },
      removeFile,
      intervalMs: 1_000_000,
    });

    const cleaned = await sweeper.runOnce();
    expect(cleaned).toBe(0);
    expect(removeFile).toHaveBeenCalledTimes(1);
    // Critical: the row stays untouched so the next sweep will retry.
    expect(markFileDeleted).not.toHaveBeenCalled();
    sweeper.stop();
  });

  it('skips rows that already have file_path NULL (defence-in-depth)', async () => {
    // The SQL already filters these out, but we don't trust shape from tests.
    const rows = [fakeRow({ id: 'cleaned-already', status: 'done', file_path: null as unknown as string })];
    const removeFile = vi.fn();
    const markFileDeleted = vi.fn();

    const sweeper = startFileCleanupSweeper({
      log,
      jobsRepo: {
        findFinishedWithFileOlderThan: async () => rows,
        markFileDeleted,
      },
      removeFile,
      intervalMs: 1_000_000,
    });

    await sweeper.runOnce();
    expect(removeFile).not.toHaveBeenCalled();
    expect(markFileDeleted).not.toHaveBeenCalled();
    sweeper.stop();
  });
});
