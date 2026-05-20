import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  useCreateReferenceListType,
  useDeactivateEntry,
  useReactivateEntry,
  useReferenceListEntries,
  useReferenceListTypes,
  type ReferenceListEntry,
  type ReferenceListType,
} from '@/queries/referenceLists';
import { useWorkspaceOrgId } from '@/lib/workspace';

const PAGE_SIZE = 50;

/**
 * ReferenceLists — список типов справочников + просмотр записей.
 * Активная организация берётся из WorkspaceSwitcher в Layout.tsx.
 *
 * Создание/синхронизация справочников — задача внешней системы
 * (WMS/ERP) через POST /reference-list-types, не из UI.
 */
export default function ReferenceListsPage() {
  const [orgId] = useWorkspaceOrgId();

  const types = useReferenceListTypes(orgId);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Справочники
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Справочники контрагентов и номенклатуры для привязки документов к
          бизнес-сущностям. Активная организация — в шапке справа.
        </p>
      </header>

      {!orgId && (
        <div className="card">
          <div className="card-body text-sm text-slate-500 dark:text-slate-400">
            Выберите организацию в правом верхнем углу, чтобы увидеть её справочники.
          </div>
        </div>
      )}

      {orgId && types.isLoading && <SkeletonList />}

      {orgId && types.error && (
        <div className="error-banner text-sm">
          <div>
            {types.error instanceof Error ? types.error.message : String(types.error)}
          </div>
        </div>
      )}

      {orgId && types.data && (
        <>
          <CreateTypeForm orgId={orgId} />
          {types.data.length === 0 ? (
            <div className="card">
              <div className="card-body space-y-2 text-center">
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Справочников в этой организации ещё нет.
                </p>
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  Создайте первый через форму выше — затем загрузите записи
                  через WMS/ERP push в{' '}
                  <code className="font-mono">POST /api/v1/reference-list-types/:slug/sync</code>.
                </p>
              </div>
            </div>
          ) : (
            <TypesTable types={types.data} />
          )}
        </>
      )}
    </div>
  );
}

function CreateTypeForm({ orgId }: { orgId: string }) {
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState('');
  const [label, setLabel] = useState('');
  const [hint, setHint] = useState('');
  const create = useCreateReferenceListType();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slug.trim() || !label.trim()) return;
    try {
      await create.mutateAsync({
        organization_id: orgId,
        slug: slug.trim(),
        label: label.trim(),
        search_hint: hint.trim() || null,
      });
      setSlug('');
      setLabel('');
      setHint('');
      setOpen(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="card overflow-hidden">
      <div className="card-header">
        <h2 className="card-title">Новый справочник</h2>
        <button type="button" className="btn-secondary text-xs" onClick={() => setOpen((v) => !v)}>
          {open ? 'Скрыть' : '+ Создать'}
        </button>
      </div>
      {open && (
        <form onSubmit={submit} className="space-y-3 px-5 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="form-label">Слаг (machine-readable)</label>
              <input
                type="text"
                className="form-input font-mono"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="cargo_units"
                pattern="[a-z][a-z0-9_-]*"
                title="Только нижний регистр, цифры, дефис, подчёркивание; начинается с буквы"
                required
              />
            </div>
            <div>
              <label className="form-label">Название</label>
              <input
                type="text"
                className="form-input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Единицы измерения грузов"
                required
              />
            </div>
          </div>
          <div>
            <label className="form-label">Подсказка поиска (опц.)</label>
            <input
              type="text"
              className="form-input"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="Палет, контейнер, рулон…"
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Показывается LLM-агенту при resolution. Что-то вроде «как
              опознать запись этого справочника в тексте документа».
            </p>
          </div>
          <button type="submit" className="btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Создаём…' : 'Создать тип справочника'}
          </button>
        </form>
      )}
    </div>
  );
}

function TypesTable({ types }: { types: ReferenceListType[] }) {
  return (
    <div className="card overflow-hidden">
      <div className="card-header">
        <h2 className="card-title">Типы справочников ({types.length})</h2>
      </div>
      {/* Desktop / tablet (≥md): таблица. Подсказку и дату прячем на
          средней ширине. */}
      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
            <tr>
              <Th>Slug</Th>
              <Th>Название</Th>
              <Th className="hidden lg:table-cell">Подсказка поиска</Th>
              <Th className="hidden lg:table-cell">Создан</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {types.map((t) => (
              <tr
                key={t.slug}
                className="hover:bg-slate-50 dark:hover:bg-slate-900/40"
              >
                <td className="px-4 py-2 font-mono text-xs text-slate-900 dark:text-slate-100">
                  <Link
                    to={`/reference-lists/${encodeURIComponent(t.slug)}`}
                    className="hover:underline"
                  >
                    {t.slug}
                  </Link>
                </td>
                <td className="px-4 py-2 text-slate-700 dark:text-slate-300">
                  {t.label}
                </td>
                <td className="hidden px-4 py-2 text-xs text-slate-500 lg:table-cell dark:text-slate-400">
                  {t.search_hint ?? '—'}
                </td>
                <td className="hidden px-4 py-2 text-xs text-slate-500 lg:table-cell dark:text-slate-400">
                  {fmtDate(t.created_at)}
                </td>
                <td className="px-4 py-2">
                  <Link
                    to={`/reference-lists/${encodeURIComponent(t.slug)}`}
                    className="btn-secondary text-xs"
                  >
                    Записи →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile (<md): карточки. */}
      <ul className="divide-y divide-slate-200 md:hidden dark:divide-slate-800">
        {types.map((t) => (
          <li key={t.slug} className="px-4 py-3">
            <Link
              to={`/reference-lists/${encodeURIComponent(t.slug)}`}
              className="flex items-center justify-between gap-2"
            >
              <div className="min-w-0">
                <div className="truncate text-slate-700 dark:text-slate-300">{t.label}</div>
                <div className="font-mono text-xs text-slate-500 dark:text-slate-400">{t.slug}</div>
              </div>
              <span className="btn-secondary min-h-[40px] shrink-0 text-xs">Записи →</span>
            </Link>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
              {t.search_hint && <span>{t.search_hint}</span>}
              <span>{fmtDate(t.created_at)}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ============================================================================
// Detail page: записи одного справочника
// ============================================================================

export function ReferenceListEntriesPage() {
  const { slug } = useParams<{ slug: string }>();
  const [orgId] = useWorkspaceOrgId();

  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);

  const entries = useReferenceListEntries(slug ?? null, orgId, {
    q: q.trim() || undefined,
    limit: PAGE_SIZE,
    offset,
    activeOnly: false,
  });

  const items = entries.data?.items ?? [];
  const hasNext = items.length === PAGE_SIZE;
  const hasPrev = offset > 0;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <Link
        to="/reference-lists"
        className="inline-flex items-center text-sm text-brand-600 hover:underline dark:text-brand-400"
      >
        ← Все справочники
      </Link>
      <header>
        <h1 className="font-mono text-xl text-slate-900 dark:text-slate-100">
          {slug}
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Записи справочника. Синхронизация из внешней системы — через POST{' '}
          <code className="font-mono">/sync</code>.
        </p>
      </header>

      {!orgId && (
        <div className="card">
          <div className="card-body text-sm text-slate-500 dark:text-slate-400">
            Выберите организацию в правом верхнем углу шапки.
          </div>
        </div>
      )}

      {orgId && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              className="form-input max-w-xs"
              placeholder="Поиск по названию и ключам…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setOffset(0);
              }}
            />
            {entries.isFetching && (
              <span className="text-xs text-slate-400 dark:text-slate-500">Загружаю…</span>
            )}
          </div>

          {entries.error && (
            <div className="error-banner text-sm">
              <div>
                {entries.error instanceof Error
                  ? entries.error.message
                  : String(entries.error)}
              </div>
            </div>
          )}

          {!entries.error && items.length === 0 && !entries.isLoading && (
            <div className="card">
              <div className="card-body text-center text-sm text-slate-400 dark:text-slate-500">
                {q ? `По запросу "${q}" ничего не найдено.` : 'Нет записей.'}
              </div>
            </div>
          )}

          {items.length > 0 && (
            <div className="card overflow-hidden">
              {/* Desktop / tablet (≥md): таблица. */}
              <div className="hidden overflow-x-auto md:block">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
                    <tr>
                      <Th className="hidden lg:table-cell">External ID</Th>
                      <Th>Название</Th>
                      <Th className="hidden lg:table-cell">Ключи поиска</Th>
                      <Th>Статус</Th>
                      <Th className="hidden lg:table-cell">Синхр.</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {items.map((e) => (
                      <EntryRow key={e.id} e={e} slug={slug ?? ''} orgId={orgId ?? ''} />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile (<md): карточки. */}
              <ul className="divide-y divide-slate-200 md:hidden dark:divide-slate-800">
                {items.map((e) => (
                  <EntryCard key={e.id} e={e} slug={slug ?? ''} orgId={orgId ?? ''} />
                ))}
              </ul>
              <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50/50 px-4 py-2 text-sm dark:border-slate-800 dark:bg-slate-950/30">
                <span className="text-slate-600 dark:text-slate-400">
                  Показано {offset + 1}–{offset + items.length}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    disabled={!hasPrev}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  >
                    ← Назад
                  </button>
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    disabled={!hasNext}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    Вперёд →
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EntryRow({
  e,
  slug,
  orgId,
}: {
  e: ReferenceListEntry;
  slug: string;
  orgId: string;
}) {
  const deactivate = useDeactivateEntry();
  const reactivate = useReactivateEntry();

  const handleDeactivate = async () => {
    if (!confirm(`Деактивировать "${e.display_name}"? Запись скроется из resolution, но останется в БД.`))
      return;
    try {
      await deactivate.mutateAsync({ entryId: e.id, organization_id: orgId, slug });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReactivate = async () => {
    try {
      await reactivate.mutateAsync({ entryId: e.id, organization_id: orgId, slug });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <tr className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
      <td className="hidden px-4 py-2 font-mono text-xs text-slate-500 lg:table-cell dark:text-slate-400">
        {e.external_id ?? '—'}
      </td>
      <td className="px-4 py-2 text-slate-700 dark:text-slate-300">
        {e.display_name}
      </td>
      <td className="hidden max-w-[16rem] truncate px-4 py-2 font-mono text-xs text-slate-500 lg:table-cell dark:text-slate-400">
        {e.search_keys.join(', ')}
      </td>
      <td className="px-4 py-2">
        {e.is_active ? (
          <span className="badge-emerald">Active</span>
        ) : (
          <span className="badge-slate">Inactive</span>
        )}
      </td>
      <td className="hidden px-4 py-2 text-xs text-slate-500 lg:table-cell dark:text-slate-400">
        {fmtDate(e.synced_at ?? e.updated_at)}
      </td>
      <td className="px-4 py-2 text-right">
        {e.is_active ? (
          <button
            type="button"
            className="btn-ghost text-xs text-rose-600 dark:text-rose-400"
            disabled={deactivate.isPending}
            onClick={handleDeactivate}
            title="Soft-delete: запись скрывается из resolution"
          >
            ✕ Деактивировать
          </button>
        ) : (
          <button
            type="button"
            className="btn-ghost text-xs"
            disabled={reactivate.isPending}
            onClick={handleReactivate}
            title="Вернуть запись в активные"
          >
            ↻ Восстановить
          </button>
        )}
      </td>
    </tr>
  );
}

/** EntryCard — мобильная (<md) форма записи справочника. */
function EntryCard({
  e,
  slug,
  orgId,
}: {
  e: ReferenceListEntry;
  slug: string;
  orgId: string;
}) {
  const deactivate = useDeactivateEntry();
  const reactivate = useReactivateEntry();

  const handleDeactivate = async () => {
    if (!confirm(`Деактивировать "${e.display_name}"? Запись скроется из resolution, но останется в БД.`))
      return;
    try {
      await deactivate.mutateAsync({ entryId: e.id, organization_id: orgId, slug });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReactivate = async () => {
    try {
      await reactivate.mutateAsync({ entryId: e.id, organization_id: orgId, slug });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-slate-700 dark:text-slate-300">{e.display_name}</div>
          {e.external_id && (
            <div className="font-mono text-xs text-slate-500 dark:text-slate-400">
              id: {e.external_id}
            </div>
          )}
        </div>
        {e.is_active ? (
          <span className="badge-emerald shrink-0">Active</span>
        ) : (
          <span className="badge-slate shrink-0">Inactive</span>
        )}
      </div>
      {e.search_keys.length > 0 && (
        <div className="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400">
          {e.search_keys.join(', ')}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-slate-500 dark:text-slate-400">
          синхр. {fmtDate(e.synced_at ?? e.updated_at)}
        </span>
        {e.is_active ? (
          <button
            type="button"
            className="btn-ghost min-h-[40px] text-xs text-rose-600 dark:text-rose-400"
            disabled={deactivate.isPending}
            onClick={handleDeactivate}
          >
            ✕ Деактивировать
          </button>
        ) : (
          <button
            type="button"
            className="btn-ghost min-h-[40px] text-xs"
            disabled={reactivate.isPending}
            onClick={handleReactivate}
          >
            ↻ Восстановить
          </button>
        )}
      </div>
    </li>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2 text-left ${className ?? ''}`}>{children}</th>;
}

function SkeletonList() {
  return (
    <div className="card">
      <div className="card-body space-y-2">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-8 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60"
          />
        ))}
      </div>
    </div>
  );
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  try {
    const d = new Date(s);
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return s;
  }
}
