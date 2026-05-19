import type { Logger } from 'pino';
import { config } from '../config.js';
import { jobsRepo as defaultJobsRepo, type JobRow } from '../storage/jobs.js';
import { fileStorage } from '../storage/files.js';

// Default через активный backend (local или s3). Сохраняем функциональную
// сигнатуру (path) → boolean для DI-совместимости со существующими тестами.
const defaultRemove = (path: string): Promise<boolean> => fileStorage.remove(path);

/**
 * Background sweeper that removes uploaded blobs after the job reaches a
 * terminal state and the retention window elapses.
 *
 * We keep the DB row indefinitely (audit / metrics / future reprocess
 * with corrections), but the source file occupies real disk. With ~10MB
 * scans at 1k docs/day, that's 10GB/day; without a cleanup loop the disk
 * fills up in weeks (TECH_DEBT C4).
 *
 * Semantics:
 *   - Removes file at `job.file_path` from disk (idempotent on ENOENT).
 *   - NULLs `file_path` so the next sweep doesn't re-find the same row.
 *   - Per-upload directory (`uploads/<storageId>/`) is rmdir'd if it
 *     becomes empty, keeping `uploads/` itself tidy.
 *
 * Same dependency-injection pattern as the pending-job sweeper for
 * testability.
 */
export type FileCleanupSweeperDeps = {
  log: Logger;
  jobsRepo?: {
    findFinishedWithFileOlderThan: (retentionDays: number, limit?: number) => Promise<JobRow[]>;
    markFileDeleted: (id: string) => Promise<void>;
  };
  removeFile?: (absolutePath: string) => Promise<boolean>;
  intervalMs?: number;
  retentionDays?: number;
};

export function startFileCleanupSweeper(
  deps: FileCleanupSweeperDeps,
): { stop: () => void; runOnce: () => Promise<number> } {
  const log = deps.log.child({ sweeper: 'file-cleanup' });
  const repo = deps.jobsRepo ?? defaultJobsRepo;
  const remove = deps.removeFile ?? defaultRemove;
  const intervalMs = deps.intervalMs ?? config.sweepers.fileCleanupIntervalMs;
  const retentionDays = deps.retentionDays ?? config.sweepers.fileRetentionDays;

  let running = false;

  const runOnce = async (): Promise<number> => {
    if (running) return 0;
    running = true;
    try {
      const candidates = await repo.findFinishedWithFileOlderThan(retentionDays);
      if (candidates.length === 0) return 0;
      log.info(
        { count: candidates.length, retention_days: retentionDays },
        'cleaning up retained files',
      );
      let cleaned = 0;
      for (const row of candidates) {
        if (!row.file_path) continue; // safety, query already filters
        try {
          await remove(row.file_path);
          await repo.markFileDeleted(row.id);
          cleaned += 1;
        } catch (err) {
          // Don't mark as deleted if the unlink failed — try again next sweep.
          log.error({ job_id: row.id, file_path: row.file_path, err }, 'file cleanup failed');
        }
      }
      log.info({ cleaned }, 'file cleanup iteration complete');
      return cleaned;
    } catch (err) {
      log.error({ err }, 'file-cleanup sweeper iteration failed');
      return 0;
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => void runOnce(), intervalMs);
  handle.unref?.();

  log.info(
    { intervalMs, retentionDays },
    'file-cleanup sweeper started',
  );

  return {
    stop: () => clearInterval(handle),
    runOnce,
  };
}
