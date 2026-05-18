import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  useReferenceListEntries,
  useReferenceListTypes,
  type ReferenceListEntry,
  type ReferenceListType,
} from '@/queries/referenceLists';
import { useOrganizations } from '@/queries/tenants';

const PAGE_SIZE = 50;

/**
 * ReferenceLists — список типов справочников + просмотр записей.
 * org_id берётся пока через селект организаций (workspace switcher
 * подключим позже когда сделаем общий workspace state).
 *
 * Создание/синхронизация справочников — задача внешней системы
 * (WMS/ERP) через POST /reference-list-types, не из UI.
 */
export default function ReferenceListsPage() {
  const orgs = useOrganizations();
  const orgList = orgs.data?.items ?? [];

  // Выбор организации persist в localStorage чтобы при возврате на
  // страницу не выбирать заново.
  const [orgId, setOrgId] = useState<string>(() =>
    typeof window !== 'undefined' ? localStorage.getItem('rl-org') ?? '' : '',
  );

  const handleSetOrg = (id: string) => {
    setOrgId(id);
    if (id) localStorage.setItem('rl-org', id);
    else localStorage.removeItem('rl-org');
  };

  // Дефолт: если org ещё не выбрана, и список загрузился — берём
  // первую отличную от system. Это покрывает 90% юзкейсов «открыл
  // страницу и сразу видишь свои справочники».
  if (!orgId && orgList.length > 0) {
    const def = orgList.find((o) => o.type !== 'system') ?? orgList[0];
    if (def) {
      // setState side-effect в render — допустимо только если идемпотент,
      // здесь оно так. Альтернатива — useEffect с зависимостью.
      handleSetOrg(def.id);
    }
  }

  const types = useReferenceListTypes(orgId || null);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Справочники
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Справочники контрагентов и номенклатуры для привязки документов к
            бизнес-сущностям.
          </p>
        </div>
        <div className="min-w-[220px]">
          <label className="form-label">Организация</label>
          <select
            className="form-select"
            value={orgId}
            onChange={(e) => handleSetOrg(e.target.value)}
            disabled={orgs.isLoading}
          >
            <option value="">— выберите —</option>
            {orgList.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {!orgId && (
        <div className="card">
          <div className="card-body text-sm text-slate-500 dark:text-slate-400">
            Выберите организацию, чтобы увидеть её справочники.
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

      {orgId && types.data && types.data.length === 0 && (
        <div className="card">
          <div className="card-body space-y-2 text-center">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Справочников в этой организации ещё нет.
            </p>
            <p className="text-xs text-slate-400 dark:text-slate-500">
              Создаются при первой синхронизации из WMS/ERP через{' '}
              <code className="font-mono">POST /api/v1/reference-list-types</code>.
            </p>
          </div>
        </div>
      )}

      {orgId && types.data && types.data.length > 0 && (
        <TypesTable types={types.data} />
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
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
            <tr>
              <Th>Slug</Th>
              <Th>Название</Th>
              <Th>Подсказка поиска</Th>
              <Th>Создан</Th>
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
                <td className="px-4 py-2 text-xs text-slate-500 dark:text-slate-400">
                  {t.search_hint ?? '—'}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500 dark:text-slate-400">
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
    </div>
  );
}

// ============================================================================
// Detail page: записи одного справочника
// ============================================================================

export function ReferenceListEntriesPage() {
  const { slug } = useParams<{ slug: string }>();
  const orgId =
    typeof window !== 'undefined' ? localStorage.getItem('rl-org') ?? '' : '';

  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);

  const entries = useReferenceListEntries(slug ?? null, orgId || null, {
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
            Сначала выберите организацию на{' '}
            <Link to="/reference-lists" className="text-brand-600 hover:underline dark:text-brand-400">
              странице справочников
            </Link>
            .
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
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
                    <tr>
                      <Th>External ID</Th>
                      <Th>Название</Th>
                      <Th>Ключи поиска</Th>
                      <Th>Статус</Th>
                      <Th>Синхр.</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {items.map((e) => (
                      <EntryRow key={e.id} e={e} />
                    ))}
                  </tbody>
                </table>
              </div>
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

function EntryRow({ e }: { e: ReferenceListEntry }) {
  return (
    <tr className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
      <td className="px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
        {e.external_id ?? '—'}
      </td>
      <td className="px-4 py-2 text-slate-700 dark:text-slate-300">
        {e.display_name}
      </td>
      <td className="max-w-[16rem] truncate px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
        {e.search_keys.join(', ')}
      </td>
      <td className="px-4 py-2">
        {e.is_active ? (
          <span className="badge-emerald">Active</span>
        ) : (
          <span className="badge-slate">Inactive</span>
        )}
      </td>
      <td className="px-4 py-2 text-xs text-slate-500 dark:text-slate-400">
        {fmtDate(e.synced_at ?? e.updated_at)}
      </td>
    </tr>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-4 py-2 text-left">{children}</th>;
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
