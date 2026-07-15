import { useEffect, useMemo, useState, useCallback } from 'react';
import { Link, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useJobsList, useApproveJob, useReprocessJob, jobsKeys } from '@/queries/jobs';
import { useDocumentTypes } from '@/queries/documentTypes';
import { api } from '@/lib/api';
import ConfidenceBar from '@/components/ConfidenceBar';
import FilterDropdown from '@/components/FilterDropdown';
import TierBadge from '@/components/TierBadge';
import ConfirmDialog from '@/components/ConfirmDialog';
import BulkResultBanner from '@/components/BulkResultBanner';
import { runBulk, type BulkResult } from '@/lib/bulk';
import { extractAmounts } from '@/lib/extracted-summary';
import {
  getDeepPass,
  DEEP_VERDICT_META,
  DEEP_VIA_LABELS,
  DEEP_REASON_LABELS,
  type DeepPassData,
} from '@/lib/deep-pass';
import {
  formatAge,
  formatDateTime,
  formatDuration,
  shortIdSplit,
} from '@/lib/format';
import { isSynthetic, matchesOrigin, type DocOrigin } from '@/lib/synthetic';
import { typeGroupOf, TYPE_GROUPS, type TypeGroup } from '@/lib/type-groups';
import type { JobNavState } from '@/lib/job-nav';
import type { DocumentTypeEntry, DocumentTypeTier } from '@/queries/documentTypes';
import type { Job, JobStatus, Classification } from '@/lib/types';
import { EmptyState, SkeletonTable } from '@/components/Skeleton';

/**
 * JobsList — таблица всех загруженных документов.
 *
 * UX-design (raund 1, 2026-05-19; raund 2 — шапка фильтров, 2026-07-06):
 *   - Tab-стрипы со счётчиками вместо <select> для статуса
 *   - Строка фильтров: поиск + дропдауны «Тип документа» (мультивыбор,
 *     группы, поиск), «Период» (from/to), «Формат», «Ещё» (источник);
 *     ниже — чипы выбранных фильтров и пресеты
 *   - Расширенный набор колонок: FILE / ID / TYPE / STATUS /
 *     CONFIDENCE-bar / TOTAL / VAT / ISSUES / ENGINE / AGE
 *   - ID — split-формат (`a8f3…91c2`) для скана глазами
 *   - AGE relative (`2 мин / 1 ч`), полная дата в title для tooltip'а
 *   - TOTAL/VAT/CURRENCY вытаскиваем из job.extracted через helper
 *
 * URL state: фильтры и offset хранятся в query params (?status=done).
 * Auto-refresh 10s — для live updates pending/processing job'ов.
 *
 * NOTE: счётчики по статусам — отдельные React Query запросы limit=1
 * (один на каждый статус), используем `useQueries`. Это N=5 параллельных
 * запросов с короткой response (только count, items=1 элемент max),
 * не создаёт давления на API. Альтернатива — добавить /stats endpoint,
 * пока не хочется трогать backend.
 */

const STATUS_TABS: { key: '' | JobStatus | 'in_progress'; label: string; cls: string }[] = [
  { key: '', label: 'Все', cls: '' },
  { key: 'needs_review', label: 'Нужна проверка', cls: 'text-amber-700 dark:text-amber-300' },
  { key: 'done', label: 'Готово', cls: 'text-emerald-700 dark:text-emerald-300' },
  { key: 'failed', label: 'Ошибки', cls: 'text-rose-700 dark:text-rose-300' },
  { key: 'in_progress', label: 'В работе', cls: 'text-sky-700 dark:text-sky-300' },
];

const PAGE_SIZE = 50;

export default function JobsListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const status = searchParams.get('status') ?? '';
  const q = searchParams.get('q') ?? '';
  const origin = (searchParams.get('origin') as DocOrigin) || 'all';
  const offset = Number(searchParams.get('offset') ?? 0);
  const typesParam = searchParams.get('document_types') ?? '';
  const formatParam = searchParams.get('format') ?? '';
  const period = searchParams.get('period') ?? '';
  const fromParam = searchParams.get('from') ?? '';
  const toParam = searchParams.get('to') ?? '';

  const selectedTypes = useMemo(
    () => typesParam.split(',').map((s) => s.trim()).filter(Boolean),
    [typesParam],
  );
  const selectedFormats = useMemo(
    () => formatParam.split(',').map((s) => s.trim()).filter(Boolean),
    [formatParam],
  );
  // Период → серверные from/to (ISO). Пресеты считаем от начала дня,
  // чтобы queryKey был стабилен в течение суток.
  const range = useMemo(
    () => periodToRange(period, fromParam, toParam),
    [period, fromParam, toParam],
  );

  // Главный фильтрованный список — то что показывается в таблице.
  const filters = useMemo(
    () => ({
      status: status || undefined,
      document_types: selectedTypes.length > 0 ? selectedTypes.join(',') : undefined,
      format: selectedFormats.length > 0 ? selectedFormats.join(',') : undefined,
      from: range.from,
      to: range.to,
      q: q || undefined,
      limit: PAGE_SIZE,
      offset,
    }),
    [status, selectedTypes, selectedFormats, range, q, offset],
  );

  const { data, isLoading, error, refetch, isFetching } = useJobsList(filters);
  const { data: docTypes } = useDocumentTypes();
  const tierBySlug = useMemo(() => {
    const m = new Map<string, DocumentTypeTier>();
    for (const t of docTypes?.items ?? []) {
      if (t.tier) m.set(t.slug, t.tier);
    }
    return m;
  }, [docTypes]);
  const nameBySlug = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of docTypes?.items ?? []) m.set(t.slug, t.display_name || t.slug);
    return m;
  }, [docTypes]);

  // Счётчики по статусам — отдельные параллельные запросы limit=1
  // (нам нужен только response.total). На каждый refetchInterval 15s,
  // чтобы не давить на API при долгом сидении на странице. Backend
  // отдаёт total в ListJobsResponse — см. routes/jobs.ts.
  //
  // status='in_progress' — синтетический агрегат, складываем processing
  // и pending в один счётчик (UI-понятие «в работе»).
  // Counter queries учитывают активные фильтры (типы, формат, период, q) —
  // иначе бы tabs показывали global total «1284 jobs» даже когда табличка
  // отфильтрована и показывает 3 строки. Это сбивает.
  const baseFilters = {
    document_types: filters.document_types,
    format: filters.format,
    from: filters.from,
    to: filters.to,
    q: q || undefined,
  } as const;
  const counterQueries = useQueries({
    queries: [
      { key: '', extra: {} },
      { key: 'needs_review', extra: { status: 'needs_review' } },
      { key: 'done', extra: { status: 'done' } },
      { key: 'failed', extra: { status: 'failed' } },
      { key: 'processing', extra: { status: 'processing' } },
      { key: 'pending', extra: { status: 'pending' } },
    ].map(({ key, extra }) => ({
      queryKey: [
        'jobs-count',
        key,
        typesParam,
        formatParam,
        range.from ?? '',
        range.to ?? '',
        q,
      ],
      queryFn: async () => {
        const params = new URLSearchParams();
        const merged = { ...baseFilters, ...extra, limit: 1 };
        for (const [k, v] of Object.entries(merged)) {
          if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
        }
        const res = await api.get<{ total?: number }>(`/api/v1/jobs?${params}`);
        return typeof res.total === 'number' ? res.total : undefined;
      },
      refetchInterval: 15_000,
      staleTime: 10_000,
    })),
  });
  const [cAll, cReview, cDone, cFailed, cProc, cPend] = counterQueries;
  const inProgressSum =
    cProc.data !== undefined || cPend.data !== undefined
      ? (cProc.data ?? 0) + (cPend.data ?? 0)
      : undefined;
  const counts: Record<string, number | undefined> = {
    '': cAll.data,
    needs_review: cReview.data,
    done: cDone.data,
    failed: cFailed.data,
    in_progress: inProgressSum,
  };

  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams);
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      next.delete('offset');
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );
  const updateFilter = (key: string, value: string) =>
    updateParams({ [key]: value || null });

  // ─── Строка фильтров: открытое меню + черновик мультивыбора типов ──
  const [openMenu, setOpenMenu] = useState<null | 'type' | 'period' | 'format' | 'more'>(null);
  const [typeDraft, setTypeDraft] = useState<string[]>([]);
  const closeMenu = useCallback(() => setOpenMenu(null), []);
  const toggleMenu = (menu: 'type' | 'period' | 'format' | 'more') => {
    if (openMenu === menu) {
      setOpenMenu(null);
      return;
    }
    if (menu === 'type') setTypeDraft(selectedTypes);
    setOpenMenu(menu);
  };
  const toggleFormat = (key: string) => {
    const next = selectedFormats.includes(key)
      ? selectedFormats.filter((f) => f !== key)
      : [...selectedFormats, key];
    updateParams({ format: next.join(',') || null });
  };
  const periodLabel = periodChipLabel(period, fromParam, toParam);
  const hasFilters = !!(
    status ||
    q ||
    selectedTypes.length > 0 ||
    selectedFormats.length > 0 ||
    period ||
    fromParam ||
    toParam ||
    origin !== 'all'
  );

  const updateOffset = (newOffset: number) => {
    const next = new URLSearchParams(searchParams);
    if (newOffset > 0) next.set('offset', String(newOffset));
    else next.delete('offset');
    setSearchParams(next);
  };

  // Origin filter работает чисто client-side по имени файла — серверные
  // фильтры не нужны, потому что синтетика отличается только конвенцией
  // имени (см. lib/synthetic.ts). Применяется ПОСЛЕ серверного fetch:
  // pagination footer и tab-счётчики продолжают показывать unfiltered
  // totals, чтобы пользователь видел масштаб корпуса.
  const allItems = data?.items ?? [];
  const items = useMemo(
    () => allItems.filter((j) => matchesOrigin(j.file_name, origin)),
    [allItems, origin],
  );
  const hasNext = allItems.length === PAGE_SIZE;
  const hasPrev = offset > 0;
  const now = useMemo(() => new Date(), [items]); // фиксируем «сейчас» на один рендер

  // Счётчики synth / real на текущей странице — для info-индикатора
  const synthOnPage = useMemo(
    () => allItems.filter((j) => isSynthetic(j.file_name)).length,
    [allItems],
  );
  const realOnPage = allItems.length - synthOnPage;

  // F8 — контекст выборки для навигации по соседям на JobDetail. Список id
  // в том порядке, как показан в таблице (после origin-фильтра); backTo —
  // текущий адрес с фильтрами, чтобы «← в список документов» вернул ровно
  // в это состояние. Кладём в history state ссылок (см. lib/job-nav.ts).
  const navState = useMemo<JobNavState>(
    () => ({
      jobNav: {
        ids: items.map((j) => j.id),
        label: 'список документов',
        backTo: location.pathname + location.search,
      },
    }),
    [items, location.pathname, location.search],
  );

  // ─── Bulk-select state ──────────────────────────────────────────
  // Set хранит id'ы выбранных job'ов. При смене страницы / фильтра
  // НЕ сбрасываем — пользователь может листать страницы и накапливать
  // выбор. Но при unmount страницы — естественно очищается.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const togglePage = useCallback(
    (pageItems: Job[]) => {
      const pageIds = pageItems.map((i) => i.id);
      const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
      setSelected((prev) => {
        const next = new Set(prev);
        if (allOnPageSelected) {
          pageIds.forEach((id) => next.delete(id));
        } else {
          pageIds.forEach((id) => next.add(id));
        }
        return next;
      });
    },
    [selected],
  );
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const removeSelected = useCallback((ids: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  }, []);
  const pageAllSelected =
    items.length > 0 && items.every((i) => selected.has(i.id));
  const pageSomeSelected = items.some((i) => selected.has(i.id));

  // ─── F6 — единый bulk-контракт ──────────────────────────────────
  // Логику и сводку держим на уровне страницы (а не в BulkBar): иначе
  // при полном успехе selected → 0, BulkBar анмаунтится и баннер с
  // результатом исчезает. Здесь баннер живёт независимо от выбора.
  const qc = useQueryClient();
  const approve = useApproveJob();
  const reprocess = useReprocessJob();
  const [confirmKind, setConfirmKind] = useState<null | 'approve' | 'reprocess'>(null);
  const [bulkRunning, setBulkRunning] = useState<null | 'approve' | 'reprocess'>(null);
  const [bulkOutcome, setBulkOutcome] = useState<
    { kind: 'approve' | 'reprocess'; result: BulkResult } | null
  >(null);

  const doBulk = useCallback(
    async (kind: 'approve' | 'reprocess', ids: string[]) => {
      if (ids.length === 0 || bulkRunning) return;
      setBulkRunning(kind);
      const mutateAsync = kind === 'approve' ? approve.mutateAsync : reprocess.mutateAsync;
      const result = await runBulk(ids, (id) => mutateAsync(id), {
        // reprocess дешёвый (ставит job в очередь) → можно параллельно;
        // approve шлёт webhook → последовательно, чтобы не завалить
        // систему-потребитель пачкой одновременных доставок.
        parallel: kind === 'reprocess',
        onItemSettled: (id, ok) => {
          if (ok) removeSelected([id]);
        },
      });
      setBulkRunning(null);
      setBulkOutcome({ kind, result });
      qc.invalidateQueries({ queryKey: jobsKeys.all });
    },
    [bulkRunning, approve, reprocess, qc, removeSelected],
  );

  return (
    <div className="mx-auto max-w-[1600px] space-y-3 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Документы</h1>
          {typeof counts[''] === 'number' && (
            <p className="mt-1 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <span className="font-mono">{counts['']}</span> jobs
            </p>
          )}
        </div>
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

      {/* Bulk action bar — заменяет status tabs пока есть выбор */}
      {selected.size > 0 && (
        <BulkBar
          count={selected.size}
          running={bulkRunning}
          onApprove={() => setConfirmKind('approve')}
          onReprocess={() => setConfirmKind('reprocess')}
          onClear={clearSelection}
        />
      )}

      {/* F6 — сводка массовой операции (живёт независимо от выбора) */}
      {bulkOutcome && (
        <BulkResultBanner
          result={bulkOutcome.result}
          busy={bulkRunning !== null}
          onRetry={
            bulkOutcome.result.failed.length > 0
              ? () =>
                  doBulk(
                    bulkOutcome.kind,
                    bulkOutcome.result.failed.map((f) => f.id),
                  )
              : undefined
          }
          onDismiss={() => setBulkOutcome(null)}
        />
      )}

      {/* Status tab strip — с счётчиками */}
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 dark:border-slate-800">
        {STATUS_TABS.map((t) => {
          const active = (status === t.key) || (t.key === '' && !status);
          const cnt = counts[t.key];
          return (
            <button
              key={t.key || 'all'}
              type="button"
              onClick={() => updateFilter('status', t.key)}
              className={`relative -mb-px border-b-2 px-3 py-2 text-sm uppercase tracking-wider transition ${
                active
                  ? `border-indigo-600 dark:border-indigo-400 font-medium ${t.cls || 'text-slate-900 dark:text-slate-100'}`
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
              }`}
            >
              {t.label}
              {cnt !== undefined && (
                <span
                  className={`ml-2 inline-flex h-5 min-w-[20px] items-center justify-center rounded-sm px-1.5 font-mono text-xs ${
                    active
                      ? 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {cnt}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Строка фильтров: поиск + дропдауны Тип/Период/Формат/Ещё */}
      <div className="flex flex-wrap items-center gap-2">
        <JobsSearchInput value={q} onChange={(v) => updateParams({ q: v || null })} />
        <FilterDropdown
          label="Тип документа"
          badge={selectedTypes.length}
          active={selectedTypes.length > 0}
          open={openMenu === 'type'}
          onToggle={() => toggleMenu('type')}
          onClose={closeMenu}
          widthClass="w-80"
        >
          <TypeFilterPanel
            items={docTypes?.items ?? []}
            draft={typeDraft}
            onDraftChange={setTypeDraft}
            onReset={() => setTypeDraft([])}
            onApply={() => {
              updateParams({ document_types: typeDraft.join(',') || null });
              closeMenu();
            }}
          />
        </FilterDropdown>
        <FilterDropdown
          label="Период"
          active={!!(period || fromParam || toParam)}
          open={openMenu === 'period'}
          onToggle={() => toggleMenu('period')}
          onClose={closeMenu}
          widthClass="w-64"
        >
          <PeriodFilterPanel
            period={period}
            from={fromParam}
            to={toParam}
            onPick={(key) => {
              updateParams({ period: key || null, from: null, to: null });
              closeMenu();
            }}
            onCustom={(from, to) => {
              updateParams({ period: null, from: from || null, to: to || null });
              closeMenu();
            }}
          />
        </FilterDropdown>
        <FilterDropdown
          label="Формат"
          badge={selectedFormats.length}
          active={selectedFormats.length > 0}
          open={openMenu === 'format'}
          onToggle={() => toggleMenu('format')}
          onClose={closeMenu}
          widthClass="w-48"
        >
          <FormatFilterPanel selected={selectedFormats} onToggle={toggleFormat} />
        </FilterDropdown>
        <FilterDropdown
          label="Ещё"
          active={origin !== 'all'}
          open={openMenu === 'more'}
          onToggle={() => toggleMenu('more')}
          onClose={closeMenu}
          align="right"
          widthClass="w-60"
        >
          <div className="px-1 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
            Источник
          </div>
          <div className="mt-1 space-y-0.5">
            {(['all', 'real', 'synth'] as DocOrigin[]).map((o) => {
              const activeOrigin = origin === o;
              return (
                <button
                  key={o}
                  type="button"
                  onClick={() => updateParams({ origin: o === 'all' ? null : o })}
                  className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm transition ${
                    activeOrigin
                      ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                      : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'
                  }`}
                >
                  {o === 'all' ? 'Все' : o === 'real' ? 'Реальные' : 'Синтетика'}
                  {activeOrigin && <span aria-hidden="true">✓</span>}
                </button>
              );
            })}
          </div>
          <p className="mt-2 border-t border-slate-200 px-1 pt-2 font-mono text-[10px] text-slate-400 dark:border-slate-700 dark:text-slate-500">
            на странице: {realOnPage} real / {synthOnPage} synth
          </p>
        </FilterDropdown>
      </div>

      {/* Чипы выбранных фильтров */}
      {(selectedTypes.length > 0 ||
        selectedFormats.length > 0 ||
        periodLabel ||
        origin !== 'all') && (
        <div className="flex flex-wrap items-center gap-1.5">
          {selectedTypes.map((slug) => (
            <FilterChip
              key={slug}
              label={nameBySlug.get(slug) ?? slug}
              onRemove={() =>
                updateParams({
                  document_types:
                    selectedTypes.filter((s) => s !== slug).join(',') || null,
                })
              }
            />
          ))}
          {selectedFormats.map((f) => (
            <FilterChip
              key={f}
              label={FORMAT_LABELS[f] ?? f}
              onRemove={() =>
                updateParams({
                  format: selectedFormats.filter((x) => x !== f).join(',') || null,
                })
              }
            />
          ))}
          {periodLabel && (
            <FilterChip
              label={periodLabel}
              onRemove={() => updateParams({ period: null, from: null, to: null })}
            />
          )}
          {origin !== 'all' && (
            <FilterChip
              label={origin === 'real' ? 'Реальные' : 'Синтетика'}
              onRemove={() => updateParams({ origin: null })}
            />
          )}
          <button
            type="button"
            onClick={() =>
              updateParams({
                document_types: null,
                format: null,
                period: null,
                from: null,
                to: null,
                origin: null,
              })
            }
            className="ml-1 text-xs text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline dark:text-slate-400 dark:hover:text-slate-200"
          >
            сбросить всё
          </button>
        </div>
      )}

      {/* Пресеты — готовые наборы фильтров одним кликом (замещают текущие) */}
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => setSearchParams(new URLSearchParams(p.params))}
            className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 dark:border-slate-700 dark:text-slate-400 dark:hover:border-indigo-700 dark:hover:bg-indigo-900/30 dark:hover:text-indigo-300"
          >
            <span aria-hidden="true">{p.icon}</span>
            {p.label}
          </button>
        ))}
      </div>

      {/* Error */}
      {error && (
        <div className="error-banner">
          Ошибка: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {/* Table */}
      {isLoading && items.length === 0 ? (
        <SkeletonTable rows={8} columns={10} />
      ) : !isLoading && items.length === 0 ? (
        <EmptyState
          title={
            hasFilters
              ? 'По текущим фильтрам ничего не найдено'
              : 'Документов ещё нет'
          }
          description={
            hasFilters
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
            hasFilters ? (
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
          {/* Desktop / tablet: классическая таблица (≥md). Часть колонок
              прячем на промежуточной ширине через hidden lg/xl:table-cell —
              первичные File/Type/Status/Confidence/Created остаются всегда. */}
          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 dark:bg-slate-900/40 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="w-8 px-3 py-2">
                    <input
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer rounded-sm border-slate-300 text-indigo-600 focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-700"
                      checked={pageAllSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = !pageAllSelected && pageSomeSelected;
                      }}
                      onChange={() => togglePage(items)}
                      aria-label="Выделить всю страницу"
                    />
                  </th>
                  <th className="px-3 py-2 font-medium">File</th>
                  <th className="hidden px-3 py-2 text-right font-medium lg:table-cell" title="Размер исходного файла">
                    Размер
                  </th>
                  <th className="hidden px-3 py-2 font-medium xl:table-cell">ID</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Confidence</th>
                  <th
                    className="px-3 py-2 text-center font-medium"
                    title="Кол-во заполненных бизнес-полей верхнего уровня. Помогает отличить «высокая уверенность но 0 полей» (extract-фейл) от реального разбора."
                  >
                    Полей
                  </th>
                  <th
                    className="hidden px-3 py-2 text-right font-medium lg:table-cell"
                    title="Оценка стоимости разбора в ₽ (Yandex Vision ₽/стр + AI Studio ₽/1k токенов). «≥» — сумма неполна (часть расхода не измерена). 0/— для локальных движков."
                  >
                    Стоимость
                  </th>
                  <th className="px-3 py-2 text-center font-medium">Issues</th>
                  <th
                    className="hidden px-3 py-2 text-right font-medium lg:table-cell"
                    title="Длительность разбора: реальное время вызова модели (last_llm_call.duration_ms), для regex-типов — сумма шагов пайплайна. In-flight — таймер от старта с «…»."
                  >
                    Время разбора
                  </th>
                  <th className="hidden px-3 py-2 font-medium xl:table-cell">Model / OCR</th>
                  <th
                    className="px-3 py-2 font-medium"
                    title="Сколько прошло с момента создания job'а (relative). Полная дата — в tooltip ячейки."
                  >
                    Создан
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {items.map((j) => (
                  <JobRow
                    key={j.id}
                    job={j}
                    now={now}
                    selected={selected.has(j.id)}
                    onToggle={() => toggleOne(j.id)}
                    tier={j.document_type ? tierBySlug.get(j.document_type) ?? null : null}
                    navState={navState}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile (<md): каждая строка — карточка с парами label/value.
              Несёт все ключевые ячейки desktop-таблицы: статус, тип, tier,
              confidence, issues, время разбора, движок, возраст. */}
          <ul className="divide-y divide-slate-200 md:hidden dark:divide-slate-800">
            {items.map((j) => (
              <JobCard
                key={j.id}
                job={j}
                now={now}
                selected={selected.has(j.id)}
                onToggle={() => toggleOne(j.id)}
                tier={j.document_type ? tierBySlug.get(j.document_type) ?? null : null}
                navState={navState}
              />
            ))}
          </ul>

          {/* Pagination */}
          {(hasPrev || hasNext) && (
            <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-2 text-sm dark:border-slate-800 dark:bg-slate-900/40">
              <div className="font-mono text-xs uppercase tracking-wider text-slate-600 dark:text-slate-400">
                page {Math.floor(offset / PAGE_SIZE) + 1}
                {' · '}
                {items.length} of {counts['']  ?? '…'} rows
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

      {/* F6/F10 — подтверждение перед массовым действием */}
      <ConfirmDialog
        open={confirmKind !== null}
        title={
          confirmKind === 'approve'
            ? `Одобрить ${selected.size} документ(ов)?`
            : `Перепрогнать ${selected.size} документ(ов)?`
        }
        description={
          confirmKind === 'approve'
            ? 'Каждый документ будет помечен approved и пройдёт пост-обработку.'
            : 'Для каждого документа заново запустится OCR и LLM-разбор; текущие результаты будут перезаписаны.'
        }
        warning={
          confirmKind === 'approve'
            ? 'На одобрение отправляется webhook клиенту — данные уходят во внешнюю систему. Отменить доставку нельзя.'
            : undefined
        }
        confirmLabel={confirmKind === 'approve' ? 'Одобрить' : 'Перепрогнать'}
        busy={bulkRunning !== null}
        onConfirm={() => {
          const kind = confirmKind;
          setConfirmKind(null);
          if (kind) doBulk(kind, Array.from(selected));
        }}
        onCancel={() => setConfirmKind(null)}
      />
    </div>
  );
}

// ─── Строка фильтров: константы и помощники ────────────────────────

const PERIOD_OPTIONS = [
  { key: '', label: 'Всё время' },
  { key: 'today', label: 'Сегодня' },
  { key: '7d', label: '7 дней' },
  { key: '30d', label: '30 дней' },
] as const;

const FORMAT_OPTIONS = [
  { key: 'pdf', label: 'PDF' },
  { key: 'excel', label: 'Excel' },
  { key: 'word', label: 'Word' },
  { key: 'image', label: 'Фото' },
  { key: 'xml', label: 'XML' },
  { key: 'other', label: 'Прочее' },
] as const;

const FORMAT_LABELS: Record<string, string> = Object.fromEntries(
  FORMAT_OPTIONS.map((o) => [o.key, o.label]),
);

/** Пресеты — готовый набор query-параметров, замещает текущие фильтры. */
const PRESETS: { icon: string; label: string; params: Record<string, string> }[] = [
  { icon: '⚑', label: 'На проверку сегодня', params: { status: 'needs_review', period: 'today' } },
  {
    icon: '₽',
    label: 'Счета за неделю',
    params: {
      document_types: 'invoice,factInvoice,UPD,commercial_invoice,proforma_invoice',
      period: '7d',
    },
  },
  { icon: '⚠', label: 'Ошибки разбора', params: { status: 'failed' } },
  { icon: '▤', label: 'Excel и Word', params: { format: 'excel,word' } },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function startOfDayIso(daysBack: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.toISOString();
}

/**
 * URL-состояние периода → серверные from/to (ISO 8601 UTC, как требует
 * ListJobsQuery). Пресеты (`period=today|7d|30d`) считаются от начала
 * локального дня; свой диапазон (`from`/`to` = YYYY-MM-DD) — включительно
 * с обеих сторон (to → конец дня).
 */
function periodToRange(
  period: string,
  from: string,
  to: string,
): { from?: string; to?: string } {
  if (period === 'today') return { from: startOfDayIso(0) };
  if (period === '7d') return { from: startOfDayIso(7) };
  if (period === '30d') return { from: startOfDayIso(30) };
  const r: { from?: string; to?: string } = {};
  if (DATE_RE.test(from)) r.from = new Date(`${from}T00:00:00`).toISOString();
  if (DATE_RE.test(to)) r.to = new Date(`${to}T23:59:59.999`).toISOString();
  return r;
}

function periodChipLabel(period: string, from: string, to: string): string | null {
  const opt = PERIOD_OPTIONS.find((p) => p.key !== '' && p.key === period);
  if (opt) return opt.label;
  if (from || to) {
    const fmt = (d: string) => (DATE_RE.test(d) ? d.split('-').reverse().join('.') : '…');
    return `${from ? fmt(from) : '…'} — ${to ? fmt(to) : '…'}`;
  }
  return null;
}

/**
 * Поиск в строке фильтров. Дублирует глобальный SearchBox из TopBar:
 * оба синкаются через URL `?q=`, локальный стейт + debounce 300ms.
 */
function JobsSearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  useEffect(() => {
    const trimmed = local.trim();
    if (trimmed === value) return;
    const t = setTimeout(() => onChange(trimmed), 300);
    return () => clearTimeout(t);
  }, [local, value, onChange]);

  return (
    <div className="relative flex min-w-[220px] flex-1 items-center">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="pointer-events-none absolute left-2.5 h-4 w-4 text-slate-400 dark:text-slate-500"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z"
          clipRule="evenodd"
        />
      </svg>
      <input
        type="search"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setLocal('');
        }}
        placeholder="Поиск: имя файла, ID, ИНН…"
        aria-label="Поиск по документам"
        className="w-full rounded-sm border border-slate-200 bg-white py-1.5 pl-8 pr-2 text-sm text-slate-800 placeholder:text-slate-400 hover:border-slate-300 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:placeholder:text-slate-500 dark:hover:border-slate-600 dark:focus:border-indigo-400 dark:focus:ring-indigo-400"
      />
    </div>
  );
}

/**
 * Панель «Тип документа»: поиск по русскому названию и слагу, группы
 * из lib/type-groups (типы вне мапы — «Прочее»), чекбоксы-мультивыбор.
 * Черновик живёт на странице; URL меняется только по «Применить».
 */
function TypeFilterPanel({
  items,
  draft,
  onDraftChange,
  onApply,
  onReset,
}: {
  items: DocumentTypeEntry[];
  draft: string[];
  onDraftChange: (next: string[]) => void;
  onApply: () => void;
  onReset: () => void;
}) {
  const [search, setSearch] = useState('');
  const grouped = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = needle
      ? items.filter(
          (t) =>
            (t.display_name ?? '').toLowerCase().includes(needle) ||
            t.slug.toLowerCase().includes(needle),
        )
      : items;
    const buckets = new Map<TypeGroup, DocumentTypeEntry[]>();
    for (const t of filtered) {
      const g = typeGroupOf(t.slug);
      const arr = buckets.get(g);
      if (arr) arr.push(t);
      else buckets.set(g, [t]);
    }
    return TYPE_GROUPS.filter((g) => buckets.has(g)).map((g) => ({
      group: g,
      types: buckets.get(g)!,
    }));
  }, [items, search]);

  const toggle = (slug: string) => {
    onDraftChange(
      draft.includes(slug) ? draft.filter((s) => s !== slug) : [...draft, slug],
    );
  };

  return (
    <div className="flex flex-col">
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Найти тип…"
        aria-label="Поиск по типам документов"
        autoFocus
        className="mb-2 w-full rounded-sm border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:placeholder:text-slate-500"
      />
      <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
        {grouped.length === 0 && (
          <p className="px-1 py-2 text-sm text-slate-500 dark:text-slate-400">
            Ничего не найдено
          </p>
        )}
        {grouped.map(({ group, types }) => (
          <div key={group}>
            <div className="mb-1 flex items-center justify-between px-1 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              <span>{group}</span>
              <span className="font-mono">{types.length}</span>
            </div>
            {types.map((t) => (
              <label
                key={t.slug}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded-sm border-slate-300 text-indigo-600 focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-700"
                  checked={draft.includes(t.slug)}
                  onChange={() => toggle(t.slug)}
                />
                <span className="truncate" title={t.slug}>
                  {t.display_name || t.slug}
                </span>
              </label>
            ))}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-slate-200 pt-2 dark:border-slate-700">
        <button
          type="button"
          className="rounded-sm px-2 py-1 text-xs uppercase tracking-wider text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-slate-800"
          disabled={draft.length === 0}
          onClick={onReset}
        >
          Сбросить
        </button>
        <button
          type="button"
          className="btn-primary px-3 py-1.5 text-xs"
          onClick={onApply}
        >
          Применить
        </button>
      </div>
    </div>
  );
}

/**
 * Панель «Период»: быстрые пресеты применяются сразу, свой диапазон —
 * два date-инпута + «Применить». В URL: `period=` либо `from`/`to`
 * (YYYY-MM-DD, взаимоисключимо с period).
 */
function PeriodFilterPanel({
  period,
  from,
  to,
  onPick,
  onCustom,
}: {
  period: string;
  from: string;
  to: string;
  onPick: (key: string) => void;
  onCustom: (from: string, to: string) => void;
}) {
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);
  const customActive = !period && !!(from || to);
  const dateCls =
    'w-full rounded-sm border border-slate-200 bg-white px-2 py-1 text-sm text-slate-800 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 [color-scheme:light] dark:[color-scheme:dark]';

  return (
    <div className="space-y-1 text-sm">
      {PERIOD_OPTIONS.map((p) => {
        const active =
          p.key === '' ? !period && !from && !to : period === p.key;
        return (
          <button
            key={p.key || 'all'}
            type="button"
            onClick={() => onPick(p.key)}
            className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left transition ${
              active
                ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
                : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'
            }`}
          >
            {p.label}
            {active && <span aria-hidden="true">✓</span>}
          </button>
        );
      })}
      <div className="border-t border-slate-200 pt-2 dark:border-slate-700">
        <div
          className={`mb-1 px-2 text-xs uppercase tracking-wider ${
            customActive
              ? 'text-indigo-600 dark:text-indigo-400'
              : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          Свой диапазон
        </div>
        <div className="flex items-center gap-2 px-2">
          <input
            type="date"
            value={draftFrom}
            onChange={(e) => setDraftFrom(e.target.value)}
            aria-label="С даты"
            className={dateCls}
          />
          <span className="text-slate-400 dark:text-slate-500">—</span>
          <input
            type="date"
            value={draftTo}
            onChange={(e) => setDraftTo(e.target.value)}
            aria-label="По дату"
            className={dateCls}
          />
        </div>
        <div className="mt-2 px-2 pb-1">
          <button
            type="button"
            className="btn-primary w-full px-3 py-1.5 text-xs"
            disabled={!draftFrom && !draftTo}
            onClick={() => onCustom(draftFrom, draftTo)}
          >
            Применить
          </button>
        </div>
      </div>
    </div>
  );
}

/** Панель «Формат»: чекбоксы, применяются сразу (URL `format=excel,word`). */
function FormatFilterPanel({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <div className="space-y-0.5">
      {FORMAT_OPTIONS.map((f) => (
        <label
          key={f.key}
          className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <input
            type="checkbox"
            className="h-4 w-4 rounded-sm border-slate-300 text-indigo-600 focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-700"
            checked={selected.includes(f.key)}
            onChange={() => onToggle(f.key)}
          />
          {f.label}
        </label>
      ))}
    </div>
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-indigo-100 py-0.5 pl-2 pr-1 text-xs text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="rounded-sm px-0.5 hover:bg-indigo-200 dark:hover:bg-indigo-800/60"
        aria-label={`Убрать фильтр ${label}`}
      >
        ✕
      </button>
    </span>
  );
}

function JobRow({
  job,
  now,
  selected,
  onToggle,
  tier,
  navState,
}: {
  job: Job;
  now: Date;
  selected: boolean;
  onToggle: () => void;
  tier: DocumentTypeTier | null;
  navState: JobNavState;
}) {
  const amounts = extractAmounts(job.extracted);
  const deep = getDeepPass(job.extracted);
  // Разворот глубокого разбора (deep-pass): клик по бейджу категории открывает
  // панель с резюме под строкой. Состояние локальное — не переживает
  // перерисовку списка, и это ок (панель — быстрый взгляд, не рабочий режим).
  const [deepOpen, setDeepOpen] = useState(false);
  const fullDate = formatDateTime(job.created_at);
  const age = formatAge(job.created_at, now);
  const duration = computeDuration(job, now);
  const navigate = useNavigate();

  // F7 — кликабельна вся строка (большая мишень для целодневной работы).
  // Не перехватываем клики по интерактивным элементам (чекбокс, ссылка на
  // имя файла) и активное выделение текста. Ссылка на имени остаётся для
  // клавиатуры и открытия в новой вкладке (ctrl/⌘+клик).
  // F8 — прокидываем контекст выборки в history state, чтобы деталка
  // показала стрелки соседей и кнопку возврата.
  const handleRowClick = (e: React.MouseEvent<HTMLTableRowElement>) => {
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (target.closest('a, button, input, label, [role="button"]')) return;
    if (window.getSelection()?.toString()) return;
    navigate(`/jobs/${job.id}`, { state: navState });
  };

  return (
    <>
    <tr
      onClick={handleRowClick}
      className={`group cursor-pointer ${
        selected
          ? 'bg-indigo-50/60 dark:bg-indigo-900/20'
          : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
      }`}
    >
      {/* Bulk checkbox */}
      <td className="px-3 py-2">
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer rounded-sm border-slate-300 text-indigo-600 focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-700"
          checked={selected}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Выделить ${job.file_name}`}
        />
      </td>

      {/* FILE — иконка + имя + synth-бейдж */}
      <td className="px-3 py-2">
        <Link
          to={`/jobs/${job.id}`}
          state={navState}
          className="flex items-center gap-2 text-slate-900 dark:text-slate-100 hover:text-indigo-600 dark:hover:text-indigo-400"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500"
            aria-hidden="true"
          >
            <path d="M4 4a2 2 0 0 1 2-2h6l4 4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4Z" />
          </svg>
          <span className="max-w-[260px] truncate" title={job.file_name}>
            {job.file_name}
          </span>
          {isSynthetic(job.file_name) && (
            <span
              className="shrink-0 rounded-sm bg-violet-100 px-1 font-mono text-[10px] uppercase tracking-wider text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
              title="Синтетический документ из gen-synthetic-pdfs"
            >
              synth
            </span>
          )}
        </Link>
      </td>

      {/* РАЗМЕР ФАЙЛА */}
      <td className="hidden px-3 py-2 text-right font-mono text-xs tabular-nums text-slate-500 lg:table-cell dark:text-slate-400">
        {formatBytes(job.file_size)}
      </td>

      {/* ID — split */}
      <td className="hidden px-3 py-2 font-mono text-xs text-slate-500 xl:table-cell dark:text-slate-400" title={job.id}>
        {shortIdSplit(job.id)}
      </td>

      {/* TYPE — бейдж */}
      <td className="px-3 py-2 text-xs">
        {job.document_type ? (
          <span className="inline-flex items-center gap-1">
            <span className="badge-indigo uppercase">{job.document_type}</span>
            <TierBadge tier={tier} size="xs" />
            <ClassifyMethodChip classification={job.classification} />
          </span>
        ) : deep ? (
          <DeepPassBadge deep={deep} expanded={deepOpen} onToggle={() => setDeepOpen((v) => !v)} />
        ) : job.document_hint ? (
          <span className="badge-slate uppercase" title="hint от клиента">
            {job.document_hint}
          </span>
        ) : (
          <span className="text-slate-400 dark:text-slate-500">—</span>
        )}
      </td>

      {/* STATUS — бейдж + чип доставки вебхука */}
      <td className="px-3 py-2">
        <span className="inline-flex items-center gap-1.5">
          <StatusBadge status={job.status} />
          <WebhookChip job={job} />
        </span>
        {job.status === 'failed' && job.error && (
          <span
            className="mt-0.5 block max-w-[220px] truncate text-[11px] text-rose-500 dark:text-rose-400"
            title={job.error}
          >
            {job.error}
          </span>
        )}
      </td>

      {/* CONFIDENCE — горизонтальная полоска */}
      <td className="px-3 py-2">
        <ConfidenceBar value={job.confidence !== null ? Number(job.confidence) : null} />
      </td>

      {/* FIELDS EXTRACTED — визуальный сигнал глубины разбора. 0 полей на
          done-документе = extract-фейл (модель уверенно вернула пустоту). */}
      <td className="px-3 py-2 text-center">
        <FieldsCountChip count={job.extracted_fields_count ?? null} status={job.status} />
      </td>

      {/* СТОИМОСТЬ ₽ — оценка расхода Yandex (Vision + AI Studio) */}
      <td
        className="hidden px-3 py-2 text-right font-mono text-xs tabular-nums text-slate-600 lg:table-cell dark:text-slate-400"
        title={
          job.cost_estimate
            ? 'Нижняя граница — часть расхода не измерена'
            : 'Оценка по фактическому расходу'
        }
      >
        {typeof job.cost_rub === 'number' && job.cost_rub > 0 ? (
          `${job.cost_estimate ? '≥' : ''}${job.cost_rub.toFixed(2)} ₽`
        ) : (
          <span className="text-slate-300 dark:text-slate-700">—</span>
        )}
      </td>

      {/* ISSUES */}
      <td className="px-3 py-2 text-center">
        {amounts.issuesCount > 0 ? (
          <span
            className="inline-flex h-5 min-w-[24px] items-center justify-center rounded-sm bg-amber-100 px-1.5 font-mono text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
            title={`${amounts.issuesCount} валидационных проблем`}
          >
            {amounts.issuesCount}
          </span>
        ) : (
          <span className="text-slate-300 dark:text-slate-700">—</span>
        )}
      </td>

      {/* ВРЕМЯ РАЗБОРА — длительность процессинга */}
      <td
        className="hidden px-3 py-2 text-right font-mono text-xs tabular-nums text-slate-600 lg:table-cell dark:text-slate-400"
        title={duration.tooltip}
      >
        {duration.label}
      </td>

      {/* MODEL / OCR ENGINE — стэк: LLM-модель сверху (важнее для
          оператора, который хочет понять «чем прогнали»), OCR-движок ниже
          мелким и тусклым. Если LLM не использовался — модель «—». */}
      <td className="hidden px-3 py-2 leading-tight xl:table-cell">
        <div
          className="font-mono text-xs text-slate-700 dark:text-slate-300"
          title={
            job.last_llm_call?.backend
              ? `${job.last_llm_call.model} via ${job.last_llm_call.backend}`
              : 'LLM не использовался'
          }
        >
          {job.last_llm_call?.model ?? (
            <span className="text-slate-300 dark:text-slate-700">no llm</span>
          )}
        </div>
        <div className="font-mono text-[10px] text-slate-400 dark:text-slate-500">
          {job.ocr_engine ?? '—'}
        </div>
      </td>

      {/* AGE — relative */}
      <td className="px-3 py-2 font-mono text-xs text-slate-500 dark:text-slate-400" title={fullDate}>
        {age}
      </td>
    </tr>
    {/* DEEP-PASS разворот: полная информация второго яруса под строкой */}
    {deep && deepOpen && (
      <tr className="bg-white dark:bg-slate-900">
        <td />
        <td colSpan={12} className="px-3 pb-3">
          <DeepPassPanel deep={deep} />
        </td>
      </tr>
    )}
    </>
  );
}

/**
 * JobCard — мобильная (<md) форма строки журнала. Тот же набор данных,
 * что и JobRow, но в виде стека label/value. Чекбокс и имя файла —
 * крупная зона (≥44px touch target), остальные поля — компактная сетка.
 */
function JobCard({
  job,
  now,
  selected,
  onToggle,
  tier,
  navState,
}: {
  job: Job;
  now: Date;
  selected: boolean;
  onToggle: () => void;
  tier: DocumentTypeTier | null;
  navState: JobNavState;
}) {
  const amounts = extractAmounts(job.extracted);
  const deep = getDeepPass(job.extracted);
  const fullDate = formatDateTime(job.created_at);
  const age = formatAge(job.created_at, now);
  const duration = computeDuration(job, now);

  return (
    <li
      className={
        selected
          ? 'bg-indigo-50/60 dark:bg-indigo-900/20'
          : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
      }
    >
      <div className="flex items-start gap-3 px-3 py-3">
        {/* Чекбокс — увеличенная зона нажатия */}
        <label className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            className="h-5 w-5 cursor-pointer rounded-sm border-slate-300 text-indigo-600 focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-700"
            checked={selected}
            onChange={onToggle}
            aria-label={`Выделить ${job.file_name}`}
          />
        </label>

        <div className="min-w-0 flex-1 space-y-2">
          {/* Имя файла → деталка */}
          <Link
            to={`/jobs/${job.id}`}
            state={navState}
            className="flex items-center gap-2 text-slate-900 hover:text-indigo-600 dark:text-slate-100 dark:hover:text-indigo-400"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500"
              aria-hidden="true"
            >
              <path d="M4 4a2 2 0 0 1 2-2h6l4 4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4Z" />
            </svg>
            <span className="truncate font-medium" title={job.file_name}>
              {job.file_name}
            </span>
            {isSynthetic(job.file_name) && (
              <span className="shrink-0 rounded-sm bg-violet-100 px-1 font-mono text-[10px] uppercase tracking-wider text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                synth
              </span>
            )}
          </Link>

          {/* Бейджи: статус + тип + tier */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <StatusBadge status={job.status} />
            <WebhookChip job={job} />
            {job.document_type ? (
              <span className="inline-flex items-center gap-1">
                <span className="badge-indigo uppercase">{job.document_type}</span>
                <TierBadge tier={tier} size="xs" />
                <ClassifyMethodChip classification={job.classification} />
              </span>
            ) : deep ? (
              <span className="inline-flex items-center gap-1">
                <DeepPassBadge deep={deep} />
                <DeepVerdictChip verdict={deep.verdict} />
              </span>
            ) : job.document_hint ? (
              <span className="badge-slate uppercase" title="hint от клиента">
                {job.document_hint}
              </span>
            ) : null}
            {amounts.issuesCount > 0 && (
              <span
                className="inline-flex h-5 items-center justify-center rounded-sm bg-amber-100 px-1.5 font-mono font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                title={`${amounts.issuesCount} валидационных проблем`}
              >
                {amounts.issuesCount} issues
              </span>
            )}
          </div>

          {/* DEEP-PASS: резюме второго яруса — на карточке всегда видно */}
          {deep?.summary && (
            <p className="line-clamp-2 text-xs text-slate-500 dark:text-slate-400" title={deep.summary}>
              {deep.summary}
            </p>
          )}

          {/* Confidence + кол-во полей — читаются вместе */}
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <ConfidenceBar value={job.confidence !== null ? Number(job.confidence) : null} />
            </div>
            <FieldsCountChip count={job.extracted_fields_count ?? null} status={job.status} />
          </div>

          {/* Метаданные: время разбора · движок · возраст */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-slate-500 dark:text-slate-400">
            <span title={duration.tooltip}>⏱ {duration.label}</span>
            <span
              title={
                job.last_llm_call?.backend
                  ? `${job.last_llm_call.model} via ${job.last_llm_call.backend}`
                  : 'LLM не использовался'
              }
            >
              {job.last_llm_call?.model ?? 'no llm'}
              {job.ocr_engine ? ` · ${job.ocr_engine}` : ''}
            </span>
            <span title={fullDate}>{age}</span>
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * Длительность РАЗБОРА для колонки «Время разбора».
 *
 * ВАЖНО: время разбора ≠ (finished_at − created_at). У документа, который
 * загрузили давно и затем пере-разобрали (reprocess), `created_at` и
 * `started_at` стоят на моменте ЗАГРУЗКИ, а `finished_at`/`updated_at` — на
 * моменте последнего разбора. Их разница даёт «возраст документа» (дни/часы),
 * а не время разбора — отсюда абсурдные «98 ч» на пере-разобранных доках.
 *
 * Реальную длительность берём из факта разбора:
 *  1. `last_llm_call.duration_ms` — время вызова модели; обновляется при
 *     каждом reprocess, единственный надёжный источник для LLM-типов.
 *  2. Для regex-типов без LLM — сумма `duration_ms` шагов пайплайна.
 *  3. Иначе «—» (лучше пусто, чем неверные часы).
 *
 * In-flight (pending / processing) — таймер `now − started_at` с «…».
 */
function computeDuration(
  job: Job,
  now: Date,
): { label: string; tooltip: string } {
  const terminal =
    job.status === 'done' ||
    job.status === 'failed' ||
    job.status === 'needs_review' ||
    job.status === 'approved';

  if (terminal) {
    // 1. Реальное время вызова модели (свежее на каждый reprocess).
    const llmMs = job.last_llm_call?.duration_ms;
    if (typeof llmMs === 'number' && llmMs > 0) {
      return {
        label: formatDuration(llmMs),
        tooltip: `${llmMs} мс · время вызова модели`,
      };
    }
    // 2. regex-типы без LLM — сумма длительностей шагов пайплайна.
    const stepMs = (job.pipeline_steps ?? []).reduce(
      (acc, s) => acc + (typeof s.duration_ms === 'number' ? s.duration_ms : 0),
      0,
    );
    if (stepMs > 0) {
      return {
        label: formatDuration(stepMs),
        tooltip: `${stepMs} мс · сумма шагов пайплайна`,
      };
    }
    return { label: '—', tooltip: 'нет данных о длительности разбора' };
  }

  // In-flight: pending / processing → таймер ещё крутится.
  const start = Date.parse(job.started_at ?? job.created_at);
  if (!Number.isFinite(start)) return { label: '—', tooltip: '' };
  const ms = Math.max(0, now.getTime() - start);
  return {
    label: `${formatDuration(ms)} …`,
    tooltip: `${ms} мс · ещё в работе`,
  };
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
  return <span className={`${cls} uppercase`}>{status}</span>;
}

/**
 * UI-5: компактный чип статуса доставки вебхука. Нет webhook_url →
 * ничего не рисуем (pull-режим). Иначе ✓ доставлен / ✗ ошибка /
 * • ожидает. Складываем рядом со status-бейджем, без отдельной колонки.
 */
function WebhookChip({ job }: { job: Job }) {
  if (!job.webhook_url) return null;

  const delivered = job.webhook_delivered_at != null;
  const failed = !delivered && job.webhook_last_error != null;

  const base =
    'inline-flex h-5 w-5 items-center justify-center rounded-sm font-mono text-xs';
  if (delivered) {
    return (
      <span
        className={`${base} bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300`}
        title={`Вебхук доставлен · ${formatDateTime(job.webhook_delivered_at)} · попыток: ${job.webhook_attempts}`}
      >
        ✓
      </span>
    );
  }
  if (failed) {
    return (
      <span
        className={`${base} bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300`}
        title={`Вебхук не доставлен · попыток: ${job.webhook_attempts} · ${job.webhook_last_error ?? ''}`}
      >
        ✗
      </span>
    );
  }
  return (
    <span
      className={`${base} bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400`}
      title={`Вебхук ожидает отправки · попыток: ${job.webhook_attempts}`}
    >
      •
    </span>
  );
}

/**
 * Компактный индикатор метода классификации рядом с типом. Одна буква
 * (L / К / И / О / П) в тусклом чипе — оператор видит «как определился тип»
 * без клика в деталку; полная расшифровка — в title. classification == null
 * (legacy jobs) или unknown → ничего не рисуем, чтобы не шуметь.
 */
const CLASSIFY_METHOD_META: Record<
  Classification['method'],
  { short: string; label: string }
> = {
  llm: { short: 'L', label: 'LLM' },
  keyword: { short: 'К', label: 'ключевые слова' },
  filename: { short: 'И', label: 'имя файла' },
  fallback: { short: 'О', label: 'откат' },
  hint: { short: 'П', label: 'подсказка' },
  vlm: { short: 'V', label: 'по изображению (VLM)' },
  deep_pass: { short: 'Г', label: 'глубокий разбор' },
};

/**
 * DEEP-PASS (docs/DEEP-PASS-SPEC.md): бейдж широкой категории для документов
 * без рабочего типа. Кликабелен, когда есть onToggle — разворачивает под
 * строкой панель с полной информацией второго яруса (см. DeepPassPanel).
 */
function DeepPassBadge({
  deep,
  expanded,
  onToggle,
}: {
  deep: DeepPassData;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const notDoc = deep.verdict === 'not_a_document';
  const cls = notDoc
    ? 'inline-flex items-center gap-1 rounded-sm bg-slate-200 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-700 dark:text-slate-300'
    : 'inline-flex items-center gap-1 rounded-sm bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
  const label = notDoc ? 'Не документ' : deep.broad_label;
  if (!onToggle) {
    return (
      <span className={cls} title={deep.summary || 'Глубокий разбор: широкая категория'}>
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`${cls} cursor-pointer select-none`}
      title={expanded ? 'Свернуть глубокий разбор' : deep.summary || 'Показать глубокий разбор'}
      aria-expanded={expanded}
    >
      {label}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z"
          clipRule="evenodd"
        />
      </svg>
    </button>
  );
}

/** Чип вердикта deep-pass — общий для панели-разворота и мобильной карточки. */
function DeepVerdictChip({ verdict }: { verdict: DeepPassData['verdict'] }) {
  const meta = DEEP_VERDICT_META[verdict];
  const tone =
    meta.tone === 'emerald'
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
      : meta.tone === 'amber'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
        : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300';
  return (
    <span className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>
      {meta.label}
    </span>
  );
}

/**
 * Панель-разворот глубокого разбора под строкой таблицы: категория + вердикт,
 * язык, как читали, причина запуска, полное резюме, рабочий тип при mapped.
 */
function DeepPassPanel({ deep }: { deep: DeepPassData }) {
  return (
    <div className="flex flex-col gap-2 rounded-md bg-slate-50 p-3 text-xs dark:bg-slate-800/60">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-700 dark:text-slate-200">Глубокий разбор:</span>
        <span className="font-medium text-slate-900 dark:text-slate-100">{deep.broad_label}</span>
        <span className="font-mono text-[10px] text-slate-400 dark:text-slate-500">{deep.broad_type}</span>
        <DeepVerdictChip verdict={deep.verdict} />
        {deep.catalog_slug && (
          <span className="badge-indigo uppercase" title="Опознан рабочий тип — извлечение выполнено по его схеме">
            {deep.catalog_slug}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-500 dark:text-slate-400">
        <span>
          Язык: <span className="font-mono">{deep.language ?? '—'}</span>
        </span>
        <span>Чтение: {DEEP_VIA_LABELS[deep.via]}</span>
        <span>Причина: {DEEP_REASON_LABELS[deep.reason]}</span>
      </div>
      {deep.summary && (
        <p className="max-w-3xl whitespace-pre-wrap text-slate-700 dark:text-slate-300">{deep.summary}</p>
      )}
    </div>
  );
}

function ClassifyMethodChip({
  classification,
}: {
  classification?: Classification | null;
}) {
  if (!classification || classification.unknown) return null;
  const meta = CLASSIFY_METHOD_META[classification.method];
  if (!meta) return null;
  return (
    <span
      className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-sm bg-slate-100 px-1 font-mono text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400"
      title={`Тип определён: ${meta.label}`}
    >
      {meta.short}
    </span>
  );
}

/**
 * Bulk action bar — appears когда selected.size > 0. Заменяет статусные
 * табы на vertical пространстве (важно — не двигает контент таблицы вниз,
 * ощущается как «контекстный switch»).
 *
 * F6: чисто презентационный — вся логика (подтверждение, runBulk, сводка)
 * живёт на уровне страницы, чтобы баннер результата не исчезал, когда
 * успешный bulk обнуляет выбор и бар анмаунтится. Кнопки лишь дёргают
 * колбэки; `running` подсвечивает активную операцию.
 */
function BulkBar({
  count,
  running,
  onApprove,
  onReprocess,
  onClear,
}: {
  count: number;
  running: null | 'approve' | 'reprocess';
  onApprove: () => void;
  onReprocess: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-sm border border-indigo-200 bg-indigo-50 px-3 py-2 dark:border-indigo-800 dark:bg-indigo-900/30">
      <span className="font-mono text-xs uppercase tracking-wider text-indigo-800 dark:text-indigo-200">
        <span className="rounded-sm bg-indigo-600 px-1.5 py-0.5 font-semibold text-white">
          {count}
        </span>{' '}
        выбрано
      </span>
      <div className="h-4 w-px bg-indigo-300 dark:bg-indigo-700" />
      <button
        type="button"
        className="btn-success disabled:opacity-50"
        disabled={!!running}
        onClick={onApprove}
      >
        {running === 'approve' ? 'Одобряю…' : `Одобрить ✓`}
      </button>
      <button
        type="button"
        className="btn-secondary disabled:opacity-50"
        disabled={!!running}
        onClick={onReprocess}
      >
        {running === 'reprocess' ? 'Перепрогон…' : 'Перепрогнать'}
      </button>
      <button
        type="button"
        className="ml-auto rounded-sm px-2 py-1 font-mono text-xs uppercase tracking-wider text-indigo-700 hover:bg-indigo-100 dark:text-indigo-300 dark:hover:bg-indigo-800/50"
        onClick={onClear}
      >
        ✕ Снять выбор
      </button>
    </div>
  );
}

/** Размер файла в человекочитаемом виде (B/KB/MB). '—' для пустого/неизвестного. */
function formatBytes(size: string | number | undefined): string {
  const n = typeof size === 'string' ? Number(size) : size;
  if (n == null || !Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Кол-во заполненных бизнес-полей в extracted. Красный при 0 на терминальном
 * done-документе (extract-фейл), янтарный при 1-5 (частичный), зелёный при 6+,
 * тире для in-flight/pending. Дополняет ConfidenceBar: помогает поймать
 * «уверенно 0» — модель ответила пустотой, а confidence всё равно 0.7+.
 */
function FieldsCountChip({
  count,
  status,
}: {
  count: number | null;
  status: string;
}): React.ReactElement {
  if (count === null || status === 'pending' || status === 'processing') {
    return <span className="text-slate-300 dark:text-slate-700">—</span>;
  }
  const terminal = status === 'done' || status === 'approved' || status === 'needs_review';
  const cls =
    !terminal
      ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
      : count === 0
      ? 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300'
      : count <= 5
      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
      : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300';
  const title = count === 0
    ? 'Модель отдала пустой JSON — extract-фейл. Проверьте raw_text или запустите reprocess.'
    : `${count} полей извлечено`;
  return (
    <span
      className={`inline-flex h-5 min-w-[24px] items-center justify-center rounded-sm px-1.5 font-mono text-xs font-medium ${cls}`}
      title={title}
    >
      {count}
    </span>
  );
}
