import type { Logger } from 'pino';
import { config } from '../config.js';
import { auditLogRepo as defaultRepo } from '../storage/audit-log.js';

/**
 * Audit log retention sweeper.
 *
 * Без чистки таблица `audit_log` растёт линейно — каждая правка через
 * админ-UI document_types / provider_settings добавляет строку с
 * before/after JSONB-снапшотами (5-20 KB на запись). При активной
 * работе админа за год выходит ~10k записей и сотни мегабайт; через
 * 3-5 лет — десятки гигабайт.
 *
 * Этот sweeper раз в `intervalMs` (по умолчанию 24ч) удаляет строки
 * старше `retentionDays` (по умолчанию 365). Параметры конфигурируются
 * через env — `AUDIT_LOG_RETENTION_DAYS` и `AUDIT_LOG_SWEEP_INTERVAL_MS`.
 *
 * Зачем `setInterval`, а не cron: тот же стиль, что у file-cleanup и
 * pending-job sweepers — один процесс воркера на инсталляцию, нет
 * нужды в распределённой координации. Если бы пошли в horizontal scale,
 * нужно было бы заворачивать в BullMQ repeatable jobs.
 *
 * `runOnce` экспонирован отдельно для:
 *   - тестов (нужно дёргать без таймера);
 *   - возможной админ-кнопки «прогнать сейчас» в UI (пока не сделано).
 */

export type AuditLogSweeperDeps = {
  log: Logger;
  repo?: {
    deleteOlderThan: (daysAgo: number) => Promise<number>;
  };
  intervalMs?: number;
  retentionDays?: number;
};

export function startAuditLogSweeper(
  deps: AuditLogSweeperDeps,
): { stop: () => void; runOnce: () => Promise<number> } {
  const log = deps.log.child({ sweeper: 'audit-log' });
  const repo = deps.repo ?? defaultRepo;
  const intervalMs = deps.intervalMs ?? config.sweepers.auditLogIntervalMs;
  const retentionDays = deps.retentionDays ?? config.sweepers.auditLogRetentionDays;

  let running = false;

  const runOnce = async (): Promise<number> => {
    if (running) return 0;
    running = true;
    try {
      const deleted = await repo.deleteOlderThan(retentionDays);
      if (deleted > 0) {
        log.info({ deleted, retention_days: retentionDays }, 'audit-log pruned');
      }
      return deleted;
    } catch (err) {
      log.error({ err }, 'audit-log sweeper iteration failed');
      return 0;
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => void runOnce(), intervalMs);
  handle.unref?.();

  log.info(
    { intervalMs, retentionDays },
    'audit-log sweeper started',
  );

  return {
    stop: () => clearInterval(handle),
    runOnce,
  };
}
