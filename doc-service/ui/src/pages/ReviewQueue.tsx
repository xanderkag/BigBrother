import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useJobsList, useApproveJob } from '@/queries/jobs';
import {
  formatDateTime,
  formatPercent,
  shortId,
  formatFileSize,
} from '@/lib/format';
import type { Job } from '@/lib/types';

/**
 * Review queue — список job'ов в статусе needs_review с инструментами
 * для быстрого одобрения. Эквивалент `#review` в старом UI.
 *
 * UX-фокус — операторская проверка батчами:
 *   - Каждая карточка показывает превью что вызвало review (validation
 *     issues + low confidence), чтобы оператор быстро решал
 *   - Approve кнопка на каждой строке (без перехода в детальный view)
 *   - Bulk approve checkbox'ами для очевидно-OK кейсов
 *   - Клик на имя файла → детальный JobDetail для углублённого осмотра
 *
 * Backend bulk-approve endpoint'а пока нет — bulk = последовательные
 * POST /jobs/:id/approve. Это достаточно для review-queue размером
 * < 100 (типичный кейс). Если очередь вырастет — добавим bulk-endpoint
 * на backend'е.
 */

const PAGE_SIZE = 100;

export default function ReviewQueuePage() {
  const { data, isLoading, error, refetch, isFetching } = useJobsList({
    status: 'needs_review',
    limit: PAGE_SIZE,
  });
  const approve = useApproveJob();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);

  const items = data?.items ?? [];

  const toggleSelected = (jobId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map((j) => j.id)));
    }
  };

  /**
   * Одобряет все выбранные job'ы последовательно. Останавливается на
   * первой ошибке (показывает её и сохраняет в selected неодобренные).
   *
   * Не делаем параллельно — backend approve дёргает finalize +
   * webhook delivery, не хотим заваливать клиентские системы пачкой
   * webhooks разом.
   */
  const bulkApprove = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Одобрить ${selected.size} job'ов? Это вызовет webhook delivery.`)) {
      return;
    }
    setBulkRunning(true);
    const toApprove = Array.from(selected);
    for (const jobId of toApprove) {
      try {
        await approve.mutateAsync(jobId);
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(jobId);
          return next;
        });
      } catch (err) {
        alert(
          `Ошибка при одобрении ${jobId}: ${
            err instanceof Error ? err.message : String(err)
          }\n\nОстальные не одобрены.`,
        );
        break;
      }
    }
    setBulkRunning(false);
    refetch();
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Очередь проверки</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 dark:text-slate-500">
            Документы со статусом{' '}
            <span className="badge-amber">needs_review</span> — требуют ручной проверки
            оператором перед отправкой webhook'а клиенту.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-ghost"
            disabled={isFetching}
            onClick={() => refetch()}
          >
            {isFetching ? 'Обновляю…' : '↻ Обновить'}
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          Ошибка: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {/* Bulk actions bar — sticky */}
      {items.length > 0 && (
        <div className="card sticky top-0 z-10">
          <div className="card-body flex items-center justify-between">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={selected.size === items.length && items.length > 0}
                onChange={toggleAll}
                className="h-4 w-4 rounded border-slate-300"
                aria-label="Выбрать все"
              />
              <span className="text-sm">
                {selected.size > 0
                  ? `Выбрано: ${selected.size} из ${items.length}`
                  : `В очереди: ${items.length}`}
                {data?.items.length === PAGE_SIZE && (
                  <span className="ml-2 text-amber-700 dark:text-amber-300">(показаны первые {PAGE_SIZE})</span>
                )}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {selected.size > 0 && (
                <>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => setSelected(new Set())}
                  >
                    Снять выделение
                  </button>
                  <button
                    type="button"
                    className="btn-success"
                    disabled={bulkRunning}
                    onClick={bulkApprove}
                  >
                    {bulkRunning ? `Одобряю…` : `Одобрить ${selected.size}`}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* List */}
      {isLoading && (
        <div className="card">
          <div className="card-body text-sm text-slate-500 dark:text-slate-400 dark:text-slate-500">Загрузка…</div>
        </div>
      )}

      {!isLoading && items.length === 0 && (
        <div className="card">
          <div className="card-body py-12 text-center">
            <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="h-7 w-7 text-emerald-600"
              >
                <path
                  fillRule="evenodd"
                  d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <p className="text-lg font-medium text-slate-900 dark:text-slate-100">Все проверены ✓</p>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 dark:text-slate-500">
              В очереди нет документов на проверке.
            </p>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {items.map((job) => (
          <ReviewRow
            key={job.id}
            job={job}
            checked={selected.has(job.id)}
            onToggle={() => toggleSelected(job.id)}
            onApprove={() => approve.mutate(job.id)}
            isApproving={approve.isPending && approve.variables === job.id}
          />
        ))}
      </div>
    </div>
  );
}

function ReviewRow({
  job,
  checked,
  onToggle,
  onApprove,
  isApproving,
}: {
  job: Job;
  checked: boolean;
  onToggle: () => void;
  onApprove: () => void;
  isApproving: boolean;
}) {
  const issues =
    ((job.extracted as Record<string, unknown> | null)?._issues as
      | string[]
      | undefined) ?? [];

  return (
    <div className="card">
      <div className="card-body flex items-center gap-4">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="h-4 w-4 shrink-0 rounded border-slate-300"
          aria-label={`Выбрать ${job.file_name}`}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link
              to={`/jobs/${job.id}`}
              className="truncate font-medium text-slate-900 dark:text-slate-100 hover:underline"
            >
              {job.file_name}
            </Link>
            {job.document_type && (
              <span className="badge-indigo shrink-0">{job.document_type}</span>
            )}
            <span className="font-mono text-xs text-slate-400 dark:text-slate-500">{shortId(job.id, 8)}</span>
          </div>

          <div className="mt-1 flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">
            <span>{formatFileSize(job.file_size)}</span>
            {job.confidence !== null && (
              <span
                className={
                  Number(job.confidence) >= 0.6 ? 'text-amber-700 dark:text-amber-300' : 'text-rose-700 dark:text-rose-300'
                }
              >
                confidence {formatPercent(Number(job.confidence))}
              </span>
            )}
            <span>создан {formatDateTime(job.created_at)}</span>
          </div>

          {/* Issues preview */}
          {issues.length > 0 && (
            <div className="mt-2 flex gap-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="h-4 w-4 shrink-0 text-amber-600"
              >
                <path
                  fillRule="evenodd"
                  d="M12 2.25a.75.75 0 0 1 .671.41l9.875 19.5a.75.75 0 0 1-.671 1.09H2.125a.75.75 0 0 1-.671-1.09l9.875-19.5A.75.75 0 0 1 12 2.25Zm0 6a.75.75 0 0 1 .75.75v5a.75.75 0 0 1-1.5 0v-5a.75.75 0 0 1 .75-.75Zm0 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
                  clipRule="evenodd"
                />
              </svg>
              <div className="min-w-0">
                {issues.slice(0, 2).map((iss, i) => (
                  <div key={i} className="truncate">
                    {iss}
                  </div>
                ))}
                {issues.length > 2 && (
                  <div className="text-amber-700 dark:text-amber-300">+ ещё {issues.length - 2}</div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Link to={`/jobs/${job.id}`} className="btn-ghost" title="Открыть деталку">
            Открыть →
          </Link>
          <button
            type="button"
            className="btn-success"
            disabled={isApproving}
            onClick={onApprove}
            title="Одобрить (без открытия)"
          >
            {isApproving ? 'Одобряю…' : '✓'}
          </button>
        </div>
      </div>
    </div>
  );
}
