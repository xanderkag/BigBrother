import { useMemo, useState, useCallback } from 'react';
import { Link, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useJobsList, useApproveJob, useReprocessJob, jobsKeys } from '@/queries/jobs';
import { useDocumentTypes } from '@/queries/documentTypes';
import { api } from '@/lib/api';
import ConfidenceBar from '@/components/ConfidenceBar';
import TierBadge from '@/components/TierBadge';
import ConfirmDialog from '@/components/ConfirmDialog';
import BulkResultBanner from '@/components/BulkResultBanner';
import { runBulk, type BulkResult } from '@/lib/bulk';
import { extractAmounts } from '@/lib/extracted-summary';
import {
  formatAge,
  formatDateTime,
  formatDuration,
  shortIdSplit,
} from '@/lib/format';
import { isSynthetic, matchesOrigin, type DocOrigin } from '@/lib/synthetic';
import type { JobNavState } from '@/lib/job-nav';
import type { DocumentTypeTier } from '@/queries/documentTypes';
import type { Job, JobStatus } from '@/lib/types';
import { EmptyState, SkeletonTable } from '@/components/Skeleton';

/**
 * JobsList — таблица всех загруженных документов.
 *
 * UX-design (raund 1, 2026-05-19):
 *   - Tab-стрипы со счётчиками вместо <select> для статуса
 *   - Подфильтр с document_type как отдельный strip
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
  const documentType = searchParams.get('document_type') ?? '';
  const q = searchParams.get('q') ?? '';
  const origin = (searchParams.get('origin') as DocOrigin) || 'all';
  const offset = Number(searchParams.get('offset') ?? 0);

  // Главный фильтрованный список — то что показывается в таблице.
  const filters = useMemo(
    () => ({
      status: status || undefined,
      document_type: documentType || undefined,
      q: q || undefined,
      limit: PAGE_SIZE,
      offset,
    }),
    [status, documentType, q, offset],
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

  // Счётчики по статусам — отдельные параллельные запросы limit=1
  // (нам нужен только response.total). На каждый refetchInterval 15s,
  // чтобы не давить на API при долгом сидении на странице. Backend
  // отдаёт total в ListJobsResponse — см. routes/jobs.ts.
  //
  // status='in_progress' — синтетический агрегат, складываем processing
  // и pending в один счётчик (UI-понятие «в работе»).
  // Counter queries учитывают активный quick-search q — иначе бы tabs
  // показывали global total «1284 jobs» даже когда табличка отфильтрована
  // по «invoice» и показывает 3 строки. Это сбивает.
  const baseFilters = { document_type: documentType || undefined, q: q || undefined } as const;
  const counterQueries = useQueries({
    queries: [
      { key: '', extra: {} },
      { key: 'needs_review', extra: { status: 'needs_review' } },
      { key: 'done', extra: { status: 'done' } },
      { key: 'failed', extra: { status: 'failed' } },
      { key: 'processing', extra: { status: 'processing' } },
      { key: 'pending', extra: { status: 'pending' } },
    ].map(({ key, extra }) => ({
      queryKey: ['jobs-count', key, documentType, q],
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

  const updateFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('offset');
    setSearchParams(next);
  };

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

      {/* Origin filter strip — real / synth / all */}
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <span className="px-2 py-1 uppercase tracking-wider text-slate-500 dark:text-slate-400">
          источник:
        </span>
        {(['all', 'real', 'synth'] as DocOrigin[]).map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => updateFilter('origin', o === 'all' ? '' : o)}
            className={`rounded-sm px-2 py-1 uppercase tracking-wider transition ${
              origin === o
                ? 'bg-indigo-600 dark:bg-indigo-500 text-white'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            {o === 'all' ? 'все' : o === 'real' ? 'реальные' : 'синтетика'}
          </button>
        ))}
        <span className="ml-2 font-mono text-[10px] text-slate-400 dark:text-slate-500">
          на странице: {realOnPage} real / {synthOnPage} synth
        </span>
      </div>

      {/* Document-type filter strip */}
      {docTypes && docTypes.items.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="px-2 py-1 uppercase tracking-wider text-slate-500 dark:text-slate-400">тип:</span>
          <button
            type="button"
            onClick={() => updateFilter('document_type', '')}
            className={`rounded-sm px-2 py-1 uppercase tracking-wider transition ${
              !documentType
                ? 'bg-indigo-600 dark:bg-indigo-500 text-white'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            все
          </button>
          {docTypes.items.map((t) => (
            <button
              key={t.slug}
              type="button"
              onClick={() => updateFilter('document_type', t.slug)}
              className={`rounded-sm px-2 py-1 uppercase tracking-wider transition ${
                documentType === t.slug
                  ? 'bg-indigo-600 dark:bg-indigo-500 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
              title={t.display_name}
            >
              {t.slug}
            </button>
          ))}
        </div>
      )}

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
                  <th className="hidden px-3 py-2 font-medium xl:table-cell">ID</th>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Confidence</th>
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
          </span>
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
      </td>

      {/* CONFIDENCE — горизонтальная полоска */}
      <td className="px-3 py-2">
        <ConfidenceBar value={job.confidence !== null ? Number(job.confidence) : null} />
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

          {/* Confidence */}
          <ConfidenceBar value={job.confidence !== null ? Number(job.confidence) : null} />

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
