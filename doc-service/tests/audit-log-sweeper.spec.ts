/**
 * Audit-log sweeper tests.
 *
 * Без реальной БД — мокаем `auditLogRepo.deleteOlderThan` и проверяем,
 * что sweeper:
 *   - вызывает его раз в `runOnce()` с правильным `retentionDays`;
 *   - не падает при ошибке репозитория;
 *   - не запускает параллельные iterations (re-entrancy guard);
 *   - корректно стопается.
 *
 * Также — light validation на сам repo-метод (без БД): отрицательный
 * retention → throw.
 */

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';

// env обязателен ДО импорта config.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { startAuditLogSweeper } from '../src/workers/audit-log-sweeper.js';
import { auditLogRepo } from '../src/storage/audit-log.js';

const log = pino({ level: 'silent' });

describe('AuditLogSweeper', () => {
  it('runOnce вызывает deleteOlderThan с retentionDays и возвращает число удалённых', async () => {
    const deleteOlderThan = vi.fn().mockResolvedValue(42);
    const s = startAuditLogSweeper({
      log,
      repo: { deleteOlderThan },
      intervalMs: 60_000,
      retentionDays: 90,
    });
    try {
      const deleted = await s.runOnce();
      expect(deleted).toBe(42);
      expect(deleteOlderThan).toHaveBeenCalledTimes(1);
      expect(deleteOlderThan).toHaveBeenCalledWith(90);
    } finally {
      s.stop();
    }
  });

  it('возвращает 0 при ошибке репозитория, не пробрасывает', async () => {
    const deleteOlderThan = vi.fn().mockRejectedValue(new Error('db down'));
    const s = startAuditLogSweeper({
      log,
      repo: { deleteOlderThan },
      intervalMs: 60_000,
      retentionDays: 30,
    });
    try {
      const deleted = await s.runOnce();
      expect(deleted).toBe(0);
      // следующий вызов всё ещё работает — running-флаг сбросился
      const again = await s.runOnce();
      expect(again).toBe(0);
      expect(deleteOlderThan).toHaveBeenCalledTimes(2);
    } finally {
      s.stop();
    }
  });

  it('re-entrancy guard: параллельные runOnce не накладываются', async () => {
    let resolve: (v: number) => void = () => {};
    const blocked = new Promise<number>((r) => { resolve = r; });
    const deleteOlderThan = vi.fn().mockReturnValue(blocked);

    const s = startAuditLogSweeper({
      log,
      repo: { deleteOlderThan },
      intervalMs: 60_000,
      retentionDays: 10,
    });
    try {
      const first = s.runOnce();        // подвисает на blocked
      const second = await s.runOnce(); // должен сразу вернуть 0
      expect(second).toBe(0);
      expect(deleteOlderThan).toHaveBeenCalledTimes(1);

      // Закрываем первый — он завершается нормально
      resolve(7);
      expect(await first).toBe(7);
    } finally {
      s.stop();
    }
  });

  it('stop() прекращает interval-вызовы', async () => {
    const deleteOlderThan = vi.fn().mockResolvedValue(0);
    const s = startAuditLogSweeper({
      log,
      repo: { deleteOlderThan },
      intervalMs: 10,
      retentionDays: 30,
    });
    s.stop();
    // Чуть-чуть подождём — interval не должен ничего вызвать после stop.
    await new Promise((r) => setTimeout(r, 50));
    expect(deleteOlderThan).not.toHaveBeenCalled();
  });
});

describe('auditLogRepo.deleteOlderThan — input validation', () => {
  it('бросает на отрицательный daysAgo (защита от очистки всего)', async () => {
    await expect(auditLogRepo.deleteOlderThan(-1)).rejects.toThrow(/non-negative/);
  });

  // Положительные сценарии (что строго старее N дней удаляется, а новые
  // остаются) проверяются интеграционными тестами на живой БД — здесь
  // только unit'ы без сетевых вызовов.
});
