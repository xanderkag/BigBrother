import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useJobsList } from '@/queries/jobs';
import { useDocumentTypes } from '@/queries/documentTypes';
import {
  formatDateTime,
  formatFileSize,
  formatPercent,
  shortId,
} from '@/lib/format';
import type { Job, JobStatus } from '@/lib/types';
import { EmptyState, SkeletonTable } from '@/components/Skeleton';

/**
 * JobsList — таблица всех загруженных документов с фильтрами по
 * статусу и типу. Поведение совместимо со старым UI:
 *   - status filter: pending / processing / done / needs_review / failed / approved
 *   - document_type filter — слаги из document-types endpoint'а
 *   - пагинация через offset + limit (50 по умолчанию)
 *   - клик на строку → /v2/jobs/:id
 *   - auto-refresh каждые 10s (TanStack Query refetchInterval)
 *
 * URL state: фильтры и offset хранятся в query params (?status=done)
 * чтобы можно было копировать ссылку и возвращаться к фильтрованному
 * списку через browser history.
 */

const STATUSES: JobStatus[] = [
  'pending',
  'processing',
  'done',
  'needs_review',
  'approved',
  'failed',
];

const PAGE_SIZE = 50;

export default function JobsListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get('status') ?? '';
  const documentType = searchParams.get('document_type') ?? '';
  const offset = Number(searchParams.get('offset') ?? 0);

  const filters = useMemo(
    () => ({
      status: status || undefined,
      document_type: documentType || undefined,
      limit: PAGE_SIZE,
      offset,
    }),
    [status, documentType, offset],
  );

  const { data, isLoading, error, refetch, isFetching } = useJobsList(filters);
  const { data: docTypes } = useDocumentTypes();

  const updateFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('offset'); // сброс пагинации при смене фильтра
    setSearchParams(next);
  };

  const updateOffset = (newOffset: number) => {
    const next = new URLSearchParams(searchParams);
    if (newOffset > 0) next.set('offset', String(newOffset));
    else next.delete('offset');
    setSearchParams(next);
  };

  const items = data?.items ?? [];
  const hasNext = items.length === PAGE_SIZE;
  const hasPrev = offset > 0;

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Документы</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={isFetching}
            onClick={() => refetch()}
            title="Обновить список"
          >
            {isFetching ? 'Обновляю…' : '↻ Обновить'}
          </button>
          <Link to="/upload" className="btn-primary">
            + Загрузить
          </Link>
        </div>
      </div>

      {/* Filters */}
      <div className="card">
        <div className="card-body flex flex-wrap items-end gap-3">
          <div className="min-w-[180px]">
            <label htmlFor="f-status" className="form-label">
              Статус
            </label>
            <select
              id="f-status"
              className="form-select"
              value={status}
              onChange={(e) => updateFilter('status', e.target.value)}
            >
              <option value="">Все статусы</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[220px]">
            <label htmlFor="f-type" className="form-label">
              Тип документа
            </label>
            <select
              id="f-type"
              className="form-select"
              value={documentType}
              onChange={(e) => updateFilter('document_type', e.target.value)}
            >
              <option value="">Все типы</option>
              {(docTypes?.items ?? []).map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.display_name} ({t.slug})
                </option>
              ))}
            </select>
          </div>
          {(status || documentType) && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setSearchParams({})}
            >
              ✕ Сбросить
            </button>
          )}
          <div className="ml-auto text-sm text-slate-500 dark:text-slate-400 dark:text-slate-500">
            {isLoading ? 'Загрузка…' : `${items.length} строк`}
            {hasNext && ' (есть ещё)'}
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="error-banner">
          Ошибка: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {/* Table */}
      {isLoading && items.length === 0 ? (
        <SkeletonTable rows={8} columns={7} />
      ) : !isLoading && items.length === 0 ? (
        <EmptyState
          title={
            status || documentType
              ? 'По текущим фильтрам ничего не найдено'
              : 'Документов ещё нет'
          }
          description={
            status || documentType
              ? 'Попробуйте сбросить фильтры или изменить параметры поиска.'
              : 'Загрузите первый документ — система определит тип, извлечёт поля и покажет результат.'
          }
          icon={
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-12 w-12"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
          }
          cta={
            status || documentType ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setSearchParams({})}
              >
                ✕ Сбросить фильтры
              </button>
            ) : (
              <Link to="/upload" className="btn-primary">
                + Загрузить документ
              </Link>
            )
          }
        />
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/40 text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2">ID</th>
                  <th className="px-4 py-2">Файл</th>
                  <th className="px-4 py-2">Статус</th>
                  <th className="px-4 py-2">Тип</th>
                  <th className="px-4 py-2 text-right">Размер</th>
                  <th className="px-4 py-2 text-right">Confidence</th>
                  <th className="px-4 py-2">Создан</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {items.map((j) => (
                  <JobRow key={j.id} job={j} />
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {(hasPrev || hasNext) && (
            <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-2 text-sm dark:border-slate-800 dark:bg-slate-900/40">
              <div className="text-slate-600 dark:text-slate-400">
                Страница {Math.floor(offset / PAGE_SIZE) + 1}
                {offset > 0 && ` (от ${offset + 1})`}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!hasPrev}
                  onClick={() => updateOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  ← Назад
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={!hasNext}
                  onClick={() => updateOffset(offset + PAGE_SIZE)}
                >
                  Вперёд →
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function JobRow({ job }: { job: Job }) {
  return (
    <tr className="hover:bg-slate-50 dark:bg-slate-900/40">
      <td className="px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">
        <Link to={`/jobs/${job.id}`} className="hover:underline">
          {shortId(job.id, 8)}
        </Link>
      </td>
      <td className="px-4 py-2">
        <Link
          to={`/jobs/${job.id}`}
          className="block max-w-[300px] truncate font-medium text-slate-900 dark:text-slate-100 hover:underline"
        >
          {job.file_name}
        </Link>
      </td>
      <td className="px-4 py-2">
        <StatusBadge status={job.status} />
      </td>
      <td className="px-4 py-2 text-slate-700 dark:text-slate-300">
        {job.document_type ? (
          <span className="badge-indigo">{job.document_type}</span>
        ) : job.document_hint ? (
          <span className="badge-slate" title="hint от клиента">
            {job.document_hint}
          </span>
        ) : (
          <span className="text-slate-400 dark:text-slate-500">—</span>
        )}
      </td>
      <td className="px-4 py-2 text-right font-mono text-slate-700 dark:text-slate-300">
        {formatFileSize(job.file_size)}
      </td>
      <td className="px-4 py-2 text-right">
        {job.confidence !== null ? (
          <span
            className={`font-mono ${
              Number(job.confidence) >= 0.85
                ? 'text-emerald-700 dark:text-emerald-300'
                : Number(job.confidence) >= 0.6
                ? 'text-amber-700 dark:text-amber-300'
                : 'text-rose-700 dark:text-rose-300'
            }`}
          >
            {formatPercent(Number(job.confidence))}
          </span>
        ) : (
          <span className="text-slate-400 dark:text-slate-500">—</span>
        )}
      </td>
      <td className="px-4 py-2 text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">
        {formatDateTime(job.created_at)}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'done' || status === 'approved'
      ? 'badge-emerald'
      : status === 'needs_review'
      ? 'badge-amber'
      : status === 'failed'
      ? 'badge-rose'
      : status === 'processing' || status === 'pending'
      ? 'badge-sky'
      : 'badge-slate';
  return <span className={cls}>{status}</span>;
}
