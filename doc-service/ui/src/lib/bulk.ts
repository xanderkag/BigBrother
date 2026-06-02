/**
 * F6 — единый контракт массовых операций.
 *
 * Проблема: bulk-approve рвался на первой ошибке (один сбойный job ломал
 * всю пачку), а поведение разнилось между Review и Jobs. Решение —
 * `Promise.allSettled`-семантика: выполнять до конца, собирать сводку
 * `{ succeeded, failed:[{id,reason}] }`, **не** откатывать успешные,
 * давать «повторить только неуспешные».
 *
 * Concurrency:
 *   - sequential (по умолчанию) — для approve: на approve летит webhook,
 *     не хотим заваливать систему-потребитель пачкой одновременных доставок;
 *   - parallel — для дешёвых операций (reprocess ставит job в очередь).
 */
export interface BulkFailure {
  id: string;
  reason: string;
}

export interface BulkResult {
  total: number;
  succeeded: string[];
  failed: BulkFailure[];
}

interface RunBulkOptions {
  /** true → Promise.allSettled (параллельно); false → последовательно. */
  parallel?: boolean;
  /** Колбэк на каждый завершённый элемент (для live-обновления выбора). */
  onItemSettled?: (id: string, ok: boolean) => void;
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runBulk(
  ids: string[],
  op: (id: string) => Promise<unknown>,
  opts: RunBulkOptions = {},
): Promise<BulkResult> {
  const succeeded: string[] = [];
  const failed: BulkFailure[] = [];

  const settle = (id: string, ok: boolean, reason?: string) => {
    if (ok) succeeded.push(id);
    else failed.push({ id, reason: reason ?? 'неизвестная ошибка' });
    opts.onItemSettled?.(id, ok);
  };

  if (opts.parallel) {
    const results = await Promise.allSettled(ids.map((id) => op(id)));
    results.forEach((r, i) => {
      const id = ids[i];
      if (r.status === 'fulfilled') settle(id, true);
      else settle(id, false, reasonOf(r.reason));
    });
  } else {
    for (const id of ids) {
      try {
        await op(id);
        settle(id, true);
      } catch (err) {
        settle(id, false, reasonOf(err));
      }
    }
  }

  return { total: ids.length, succeeded, failed };
}
