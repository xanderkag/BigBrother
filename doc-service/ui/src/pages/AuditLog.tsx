import { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  useAuditLog,
  type AuditEntity,
  type AuditEntry,
} from '@/queries/auditLog';
import { formatDateTime } from '@/lib/format';

/**
 * Audit log viewer — журнал admin-изменений document_types и
 * provider_settings. Только чтение.
 *
 * URL state хранит фильтры (?entity=document_type&entity_id=invoice)
 * чтобы делиться ссылками с командой ("посмотри, кто менял x").
 *
 * Secrets маскируются на backend'е — здесь рендерим before/after как
 * есть, никакой логики на это не завязано.
 */

const PAGE_SIZE = 50;

export default function AuditLogPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const entity = (searchParams.get('entity') ?? '') as '' | AuditEntity;
  const entityId = searchParams.get('entity_id') ?? '';
  const offset = Number(searchParams.get('offset') ?? 0);

  const filters = useMemo(
    () => ({
      entity: entity || undefined,
      entity_id: entityId || undefined,
      limit: PAGE_SIZE,
      offset,
    }),
    [entity, entityId, offset],
  );

  const { data, isLoading, error, refetch, isFetching } = useAuditLog(filters);
  const items = data?.items ?? [];

  const updateFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('offset');
    setSearchParams(next);
  };

  const hasNext = items.length === PAGE_SIZE;
  const hasPrev = offset > 0;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Audit log</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 dark:text-slate-500">
            Журнал изменений типов документов и провайдеров. Только чтение.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary"
          disabled={isFetching}
          onClick={() => refetch()}
        >
          {isFetching ? 'Обновляю…' : '↻ Обновить'}
        </button>
      </div>

      <div className="card">
        <div className="card-body flex flex-wrap items-end gap-3">
          <div className="min-w-[200px]">
            <label className="form-label">Сущность</label>
            <select
              className="form-select"
              value={entity}
              onChange={(e) => updateFilter('entity', e.target.value)}
            >
              <option value="">Все</option>
              <option value="document_type">document_type</option>
              <option value="provider_setting">provider_setting</option>
            </select>
          </div>
          <div className="min-w-[200px]">
            <label className="form-label">ID</label>
            <input
              type="text"
              className="form-input font-mono text-sm"
              value={entityId}
              onChange={(e) => updateFilter('entity_id', e.target.value)}
              placeholder="slug или provider id"
            />
          </div>
          {(entity || entityId) && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setSearchParams({})}
            >
              ✕ Сбросить
            </button>
          )}
          <div className="ml-auto text-sm text-slate-500 dark:text-slate-400 dark:text-slate-500">
            {isLoading ? 'Загрузка…' : `${items.length} записей`}
            {hasNext && ' (есть ещё)'}
          </div>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          Ошибка: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div className="space-y-2">
        {!isLoading && items.length === 0 && (
          <div className="card">
            <div className="card-body text-center text-slate-400 dark:text-slate-500">
              Записей нет.
            </div>
          </div>
        )}
        {items.map((entry) => (
          <AuditCard key={String(entry.id)} entry={entry} />
        ))}
      </div>

      {(hasPrev || hasNext) && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-500 dark:text-slate-400 dark:text-slate-500">
            Страница {Math.floor(offset / PAGE_SIZE) + 1}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={!hasPrev}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                const nextOffset = Math.max(0, offset - PAGE_SIZE);
                if (nextOffset > 0) next.set('offset', String(nextOffset));
                else next.delete('offset');
                setSearchParams(next);
              }}
            >
              ← Назад
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!hasNext}
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.set('offset', String(offset + PAGE_SIZE));
                setSearchParams(next);
              }}
            >
              Вперёд →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Card                                                               */
/* ------------------------------------------------------------------ */

function AuditCard({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);

  const actionBadge =
    entry.action === 'create'
      ? 'badge-emerald'
      : entry.action === 'delete'
      ? 'badge-rose'
      : 'badge-sky';

  const diffEntries = entry.diff ? Object.entries(entry.diff) : [];

  return (
    <div className="card">
      <div className="card-body">
        <div className="flex items-center gap-3 text-sm">
          <span className={actionBadge}>{entry.action}</span>
          <span className="font-medium text-slate-900 dark:text-slate-100">{entry.entity}</span>
          <span className="font-mono text-xs text-slate-600 dark:text-slate-400 dark:text-slate-500">{entry.entity_id}</span>
          <span className="ml-auto text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">
            {formatDateTime(entry.at)} · {entry.actor}
          </span>
        </div>

        {/* Compact diff preview */}
        {entry.action === 'update' && diffEntries.length > 0 && (
          <div className="mt-3 space-y-1">
            {diffEntries.slice(0, expanded ? 999 : 5).map(([field, change]) => (
              <div key={field} className="flex items-start gap-3 text-xs">
                <span className="w-40 shrink-0 truncate font-mono text-slate-600 dark:text-slate-400 dark:text-slate-500">
                  {field}
                </span>
                <span className="rounded bg-rose-50 px-1.5 py-0.5 font-mono text-rose-700 dark:text-rose-300 line-through">
                  {renderShort(change.from)}
                </span>
                <span className="text-slate-400 dark:text-slate-500">→</span>
                <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-mono text-emerald-700 dark:text-emerald-300">
                  {renderShort(change.to)}
                </span>
              </div>
            ))}
            {!expanded && diffEntries.length > 5 && (
              <button
                type="button"
                className="text-xs text-brand-600 dark:text-brand-400 hover:underline"
                onClick={() => setExpanded(true)}
              >
                + ещё {diffEntries.length - 5} полей
              </button>
            )}
          </div>
        )}

        {/* Snapshots (collapsed by default for create/delete) */}
        {(entry.before || entry.after) && (
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:text-slate-300">
              Показать snapshot{entry.before && entry.after ? '\'ы' : ''}
            </summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {entry.before && (
                <div>
                  <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400 dark:text-slate-500">До</div>
                  <pre className="max-h-60 overflow-auto rounded-lg border border-rose-200 bg-rose-50 p-2 text-[11px] text-slate-800">
                    {JSON.stringify(entry.before, null, 2)}
                  </pre>
                </div>
              )}
              {entry.after && (
                <div>
                  <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400 dark:text-slate-500">После</div>
                  <pre className="max-h-60 overflow-auto rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-[11px] text-slate-800">
                    {JSON.stringify(entry.after, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function renderShort(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') {
    return v.length > 60 ? v.slice(0, 60) + '…' : v;
  }
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }
  return String(v);
}
