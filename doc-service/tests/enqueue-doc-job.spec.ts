/**
 * enqueueDocJob — устойчивость к terminal-дубликату BullMQ (2026-07-22).
 * Баг: reprocess/sweeper звали queue.add с тем же jobId, BullMQ дедупил об
 * completed/failed запись → строка навечно pending. Фикс снимает terminal-
 * джобу перед add.
 */
import { describe, it, expect, vi } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { enqueueDocJob, type EnqueueableQueue } from '../src/queue.js';

function fakeQueue(existingState: string | null) {
  const removed = { called: false };
  const added: Array<{ jobId: string }> = [];
  const existing =
    existingState === null
      ? null
      : {
          getState: vi.fn(async () => existingState),
          remove: vi.fn(async () => {
            removed.called = true;
          }),
        };
  const queue: EnqueueableQueue = {
    getJob: vi.fn(async () => existing),
    add: vi.fn(async (_n, _p, opts) => {
      added.push({ jobId: opts.jobId });
    }),
  };
  return { queue, removed, added, existing };
}

describe('enqueueDocJob', () => {
  it('нет существующей джобы → просто add', async () => {
    const { queue, added } = fakeQueue(null);
    const r = await enqueueDocJob({ jobId: 'j1' }, 'j1', queue);
    expect(r).toBe('enqueued');
    expect(added).toEqual([{ jobId: 'j1' }]);
  });

  it('completed-дубликат снимается перед add (корень бага)', async () => {
    const { queue, removed, added } = fakeQueue('completed');
    const r = await enqueueDocJob({ jobId: 'j2' }, 'j2', queue);
    expect(removed.called).toBe(true);
    expect(added).toEqual([{ jobId: 'j2' }]);
    expect(r).toBe('enqueued');
  });

  it('failed-дубликат тоже снимается', async () => {
    const { queue, removed, added } = fakeQueue('failed');
    await enqueueDocJob({ jobId: 'j3' }, 'j3', queue);
    expect(removed.called).toBe(true);
    expect(added).toHaveLength(1);
  });

  it('active/waiting джоба НЕ трогается — законный no-op', async () => {
    for (const state of ['active', 'waiting', 'delayed', 'prioritized']) {
      const { queue, removed, added } = fakeQueue(state);
      const r = await enqueueDocJob({ jobId: 'j' }, 'j', queue);
      expect(r).toBe('skipped');
      expect(removed.called).toBe(false);
      expect(added).toHaveLength(0);
    }
  });

  it('getState бросил (джоба исчезла между вызовами) → add всё равно проходит', async () => {
    const { queue, added } = fakeQueue('completed');
    (queue.getJob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      getState: vi.fn(async () => {
        throw new Error('gone');
      }),
      remove: vi.fn(),
    });
    const r = await enqueueDocJob({ jobId: 'j4' }, 'j4', queue);
    expect(r).toBe('enqueued');
    expect(added).toHaveLength(1);
  });
});
