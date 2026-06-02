import { useState, useMemo, useEffect } from 'react';
import { Link, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { useJobsList, useApproveJob, useReprocessJob } from '@/queries/jobs';
import { useDocumentTypes } from '@/queries/documentTypes';
import { usePermissions } from '@/lib/permissions';
import ConfidenceBar from '@/components/ConfidenceBar';
import TierBadge from '@/components/TierBadge';
import ConfirmDialog from '@/components/ConfirmDialog';
import BulkResultBanner from '@/components/BulkResultBanner';
import KeyboardHelp from '@/components/KeyboardHelp';
import { runBulk, type BulkResult } from '@/lib/bulk';
import { useHotkeys } from '@/lib/useHotkeys';
import { confidenceLevel, PREVIEW_ATTENTION_THRESHOLD } from '@/lib/confidence';
import type { JobNavState } from '@/lib/job-nav';
import { extractAmounts } from '@/lib/extracted-summary';
import {
  formatAge,
  formatDateTime,
  formatFileSize,
  formatMoneyCompact,
  shortIdSplit,
} from '@/lib/format';
import { isSynthetic, matchesOrigin, type DocOrigin } from '@/lib/synthetic';
import type { DocumentTypeTier } from '@/queries/documentTypes';
import type { Job } from '@/lib/types';

/**
 * Review queue v2 (2026-05-19 refactor):
 *
 *   - Stats-header сверху: total / by document_type / by origin / top issues
 *   - Filter strips:
 *       * Origin: все / реальные / синтетика
 *       * Document type: все / UPD / TORG-12 / ...
 *       * Issue category: все / INN / суммы / даты / другие
 *   - Group-by-doc_type сворачиваемые секции (collapsible details)
 *   - Каждая карточка:
 *       * filename + synth-бейдж + doc_type
 *       * confidence-bar + size + age
 *       * **Extracted preview** — топ-4 поля (seller, buyer, total, date)
 *         с подсветкой полей-проблем (упомянуты в _issues)
 *       * Issues list (как и было)
 *       * Actions: Открыть / Перепрогнать / Одобрить
 *   - Bulk approve через checkbox + sticky bar
 *
 * Backend bulk-approve endpoint'а нет — bulk = последовательные
 * POST /jobs/:id/approve. Параллелить не хотим: webhook delivery на
 * approve, не хотим заваливать клиентские системы пачкой webhooks.
 */

const PAGE_SIZE = 200;

/**
 * Категория issue по ключевым словам в тексте. Это эвристика для
 * UI-фильтра; backend не даёт структурированной классификации issue'ов
 * (они хранятся как массив строк в `_issues`).
 */
type IssueCategory = 'inn' | 'amounts' | 'dates' | 'other';

function classifyIssue(text: string): IssueCategory {
  const t = text.toLowerCase();
  if (t.includes('инн') || t.includes('inn') || t.includes('кпп')) return 'inn';
  if (t.includes('сумм') || t.includes('total') || t.includes('ндс') || t.includes('vat')) return 'amounts';
  if (t.includes('дата') || t.includes('date')) return 'dates';
  return 'other';
}

export default function ReviewQueuePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const documentType = searchParams.get('document_type') ?? '';
  const origin = (searchParams.get('origin') as DocOrigin) || 'all';
  const issueCat = (searchParams.get('issue') as IssueCategory | '') || '';

  const { data, isLoading, error, refetch, isFetching } = useJobsList({
    status: 'needs_review',
    document_type: documentType || undefined,
    limit: PAGE_SIZE,
  });
  const { data: docTypes } = useDocumentTypes();
  const tierBySlug = useMemo(() => {
    const m = new Map<string, DocumentTypeTier>();
    for (const t of docTypes?.items ?? []) {
      if (t.tier) m.set(t.slug, t.tier);
    }
    return m;
  }, [docTypes]);
  const approve = useApproveJob();
  const reprocess = useReprocessJob();
  // F9 — viewer работает в read-only: чекбоксы и кнопки одобрения/перепрогона
  // скрыты, остаётся «Открыть».
  const { isWriter } = usePermissions();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRunning, setBulkRunning] = useState(false);
  // F6 — подтверждение перед запуском + сводка результата.
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  // F5 — клавиатурный курсор по очереди + шпаргалка.
  const [cursor, setCursor] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Filter chain: origin (client) + issue category (client)
  const allItems = data?.items ?? [];
  const items = useMemo(() => {
    return allItems.filter((j) => {
      if (!matchesOrigin(j.file_name, origin)) return false;
      if (issueCat) {
        const issues = jobIssues(j);
        if (!issues.some((i) => classifyIssue(i) === issueCat)) return false;
      }
      return true;
    });
  }, [allItems, origin, issueCat]);

  // Stats — по unfiltered набору. Показывают «общую картину» что в
  // очереди, фильтры её сужают для работы.
  const stats = useMemo(() => computeStats(allItems), [allItems]);
  const total = data?.total ?? allItems.length;

  // Group by doc_type — для удобной навигации когда очередь >20 items
  const grouped = useMemo(() => groupByDocType(items), [items]);

  // F5/F8 — плоский порядок «как на экране» (для курсора j/k и для
  // прокидывания соседей в JobDetail).
  const orderedItems = useMemo(
    () => grouped.flatMap(([, jobs]) => jobs),
    [grouped],
  );
  const cursorId = orderedItems[cursor]?.id ?? null;

  // F8 — контекст выборки, который уносим в деталку (history-state).
  const navState = useMemo<JobNavState>(
    () => ({
      jobNav: {
        ids: orderedItems.map((j) => j.id),
        label: 'очередь проверки',
        backTo: location.pathname + location.search,
      },
    }),
    [orderedItems, location.pathname, location.search],
  );

  // Курсор не должен «уезжать» за пределы списка при смене фильтров.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, orderedItems.length - 1)));
  }, [orderedItems.length]);

  // Подкручиваем выделенную строку в зону видимости.
  useEffect(() => {
    if (!cursorId) return;
    document
      .getElementById(`review-row-${cursorId}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursorId]);

  // F5 — горячие клавиши очереди. Отключаем, пока открыт диалог/справка.
  useHotkeys(
    [
      {
        keys: ['j', 'ArrowDown'],
        handler: () => setCursor((c) => Math.min(orderedItems.length - 1, c + 1)),
      },
      { keys: ['k', 'ArrowUp'], handler: () => setCursor((c) => Math.max(0, c - 1)) },
      {
        keys: ['Enter'],
        handler: () => {
          if (cursorId) navigate(`/jobs/${cursorId}`, { state: navState });
        },
      },
      { keys: ['?'], handler: () => setHelpOpen(true) },
      ...(isWriter
        ? [
            {
              keys: ['a'],
              handler: () => {
                if (cursorId) approve.mutate(cursorId);
              },
            },
          ]
        : []),
    ],
    !confirmBulk && !helpOpen,
  );

  const updateFilter = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  };

  const toggleSelected = (jobId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

  const toggleAllVisible = () => {
    const visibleIds = items.map((j) => j.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  };

  // F6 — единый bulk-контракт. Последовательно (на approve летит webhook,
  // не параллелим, чтобы не завалить потребителя), до конца, не прерываясь
  // на первой ошибке. Сводка {succeeded, failed[]} → BulkResultBanner.
  // Успешные сразу убираем из выбора → «Повторить неуспешные» работает по
  // оставшимся.
  const doBulkApprove = async (ids: string[]) => {
    if (ids.length === 0) return;
    setBulkRunning(true);
    const result = await runBulk(ids, (id) => approve.mutateAsync(id), {
      onItemSettled: (id, ok) => {
        if (!ok) return;
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      },
    });
    setBulkRunning(false);
    setBulkResult(result);
    refetch();
  };

  const confirmBulkApprove = async () => {
    setConfirmBulk(false);
    await doBulkApprove(Array.from(selected));
  };

  const allVisibleSelected =
    items.length > 0 && items.every((i) => selected.has(i.id));

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-6">
      {/* Header + meta */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Очередь проверки
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Документы со статусом{' '}
            <span className="badge-amber">needs_review</span> — требуют ручной
            проверки перед отправкой webhook'а клиенту.
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

      {/* Stats grid */}
      <ReviewStats stats={stats} total={total} visibleCount={items.length} />

      {error && (
        <div className="error-banner">
          Ошибка: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {/* F6 — сводка массовой операции */}
      {bulkResult && (
        <BulkResultBanner
          result={bulkResult}
          busy={bulkRunning}
          onRetry={
            bulkResult.failed.length > 0
              ? () => doBulkApprove(bulkResult.failed.map((f) => f.id))
              : undefined
          }
          onDismiss={() => setBulkResult(null)}
        />
      )}

      {/* Filters */}
      <div className="space-y-2 border-y border-slate-200 py-3 dark:border-slate-800">
        <FilterStrip
          label="источник"
          options={[
            { value: '', label: 'все' },
            { value: 'real', label: 'реальные' },
            { value: 'synth', label: 'синтетика' },
          ]}
          active={origin === 'all' ? '' : origin}
          onChange={(v) => updateFilter('origin', v)}
        />
        {docTypes && docTypes.items.length > 0 && (
          <FilterStrip
            label="тип"
            options={[
              { value: '', label: 'все' },
              ...docTypes.items.map((t) => ({
                value: t.slug,
                label: t.slug,
                count: stats.byDocType[t.slug],
              })),
            ].filter((o) => o.value === '' || (stats.byDocType[o.value] ?? 0) > 0)}
            active={documentType}
            onChange={(v) => updateFilter('document_type', v)}
          />
        )}
        <FilterStrip
          label="проблема"
          options={[
            { value: '', label: 'все' },
            { value: 'inn', label: 'ИНН/КПП', count: stats.byIssueCategory.inn },
            { value: 'amounts', label: 'Суммы', count: stats.byIssueCategory.amounts },
            { value: 'dates', label: 'Даты', count: stats.byIssueCategory.dates },
            { value: 'other', label: 'Другое', count: stats.byIssueCategory.other },
          ].filter((o) => o.value === '' || (o.count ?? 0) > 0)}
          active={issueCat}
          onChange={(v) => updateFilter('issue', v)}
        />
      </div>

      {/* Bulk bar */}
      {items.length > 0 && (
        <div className="sticky top-0 z-10 flex items-center justify-between rounded-sm border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-3">
            {isWriter && (
              <input
                type="checkbox"
                checked={allVisibleSelected}
                ref={(el) => {
                  if (el) el.indeterminate = !allVisibleSelected && items.some((i) => selected.has(i.id));
                }}
                onChange={toggleAllVisible}
                className="h-3.5 w-3.5 cursor-pointer rounded-sm border-slate-300 text-indigo-600"
                aria-label="Выбрать все видимые"
              />
            )}
            <span className="font-mono text-xs uppercase tracking-wider text-slate-700 dark:text-slate-300">
              {selected.size > 0 ? (
                <>
                  <span className="rounded-sm bg-indigo-600 px-1.5 py-0.5 text-white">
                    {selected.size}
                  </span>{' '}
                  выбрано из {items.length}
                </>
              ) : (
                `в очереди ${items.length}${items.length !== total ? ` (отфильтровано из ${total})` : ''}`
              )}
            </span>
          </div>
          {isWriter && selected.size > 0 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setSelected(new Set())}
              >
                Снять
              </button>
              <button
                type="button"
                className="btn-success"
                disabled={bulkRunning}
                onClick={() => selected.size > 0 && setConfirmBulk(true)}
              >
                {bulkRunning ? 'Одобряю…' : `Одобрить ${selected.size}`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="card">
              <div className="card-body space-y-2">
                <div className="h-4 w-48 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!isLoading && items.length === 0 && (
        <div className="card">
          <div className="card-body py-12 text-center">
            <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/40">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="h-7 w-7 text-emerald-600 dark:text-emerald-400"
              >
                <path
                  fillRule="evenodd"
                  d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12Zm13.36-1.814a.75.75 0 1 0-1.22-.872l-3.236 4.53L9.53 12.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a.75.75 0 0 0 1.14-.094l3.75-5.25Z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <p className="text-lg font-medium text-slate-900 dark:text-slate-100">
              {allItems.length === 0 ? 'Очередь пуста ✓' : 'По фильтрам ничего не найдено'}
            </p>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {allItems.length === 0
                ? 'Документов на проверке нет — оператор может отдыхать.'
                : 'Попробуйте сбросить фильтры или изменить параметры.'}
            </p>
            {allItems.length > 0 && (
              <button
                type="button"
                className="btn-secondary mt-3"
                onClick={() => setSearchParams({})}
              >
                ✕ Сбросить фильтры
              </button>
            )}
          </div>
        </div>
      )}

      {/* Groups */}
      {grouped.map(([docType, jobs]) => (
        <details key={docType} open className="card">
          <summary className="card-header flex cursor-pointer items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs uppercase tracking-wider text-slate-700 dark:text-slate-300">
                {docType || '(без типа)'}
              </span>
              <span className="rounded-sm bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-400">
                {jobs.length}
              </span>
            </div>
          </summary>
          <div className="card-body space-y-2">
            {jobs.map((job) => (
              <ReviewRow
                key={job.id}
                job={job}
                tier={job.document_type ? tierBySlug.get(job.document_type) ?? null : null}
                canWrite={isWriter}
                checked={selected.has(job.id)}
                isCursor={job.id === cursorId}
                navState={navState}
                onToggle={() => toggleSelected(job.id)}
                onApprove={() => approve.mutate(job.id)}
                onReprocess={() => reprocess.mutate(job.id)}
                isApproving={approve.isPending && approve.variables === job.id}
                isReprocessing={reprocess.isPending && reprocess.variables === job.id}
              />
            ))}
          </div>
        </details>
      ))}

      {/* F6/F10 — подтверждение массового одобрения (webhook → внешняя система) */}
      <ConfirmDialog
        open={confirmBulk}
        title={`Одобрить ${selected.size} документ(ов)?`}
        description="Каждый документ будет помечен approved и пройдёт пост-обработку."
        warning="На одобрение отправляется webhook клиенту — данные уходят во внешнюю систему. Отменить доставку нельзя."
        confirmLabel={`Одобрить ${selected.size}`}
        busy={bulkRunning}
        onConfirm={confirmBulkApprove}
        onCancel={() => setConfirmBulk(false)}
      />

      <KeyboardHelp
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        items={[
          { keys: ['j', '↓'], label: 'Следующий документ' },
          { keys: ['k', '↑'], label: 'Предыдущий документ' },
          { keys: ['Enter'], label: 'Открыть выделенный' },
          ...(isWriter ? [{ keys: ['a'], label: 'Одобрить выделенный' }] : []),
          { keys: ['?'], label: 'Эта справка' },
        ]}
      />
    </div>
  );
}

/* ─── Sub-components ────────────────────────────────────────────────── */

interface ReviewStatsData {
  byDocType: Record<string, number>;
  bySynth: { synth: number; real: number };
  byIssueCategory: Record<IssueCategory, number>;
  topIssues: { text: string; count: number }[];
  avgConfidence: number | null;
}

function computeStats(items: Job[]): ReviewStatsData {
  const byDocType: Record<string, number> = {};
  const byIssueCategory: Record<IssueCategory, number> = {
    inn: 0,
    amounts: 0,
    dates: 0,
    other: 0,
  };
  const issueCounts: Record<string, number> = {};
  let synth = 0;
  let real = 0;
  let confSum = 0;
  let confN = 0;

  for (const j of items) {
    const dt = j.document_type ?? '(unknown)';
    byDocType[dt] = (byDocType[dt] ?? 0) + 1;
    if (isSynthetic(j.file_name)) synth++;
    else real++;
    if (j.confidence !== null) {
      confSum += Number(j.confidence);
      confN++;
    }
    for (const iss of jobIssues(j)) {
      byIssueCategory[classifyIssue(iss)]++;
      // Топ-issues по нормализованному тексту (без чисел/id)
      const key = iss.replace(/\d+/g, '#').slice(0, 80);
      issueCounts[key] = (issueCounts[key] ?? 0) + 1;
    }
  }

  const topIssues = Object.entries(issueCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([text, count]) => ({ text, count }));

  return {
    byDocType,
    bySynth: { synth, real },
    byIssueCategory,
    topIssues,
    avgConfidence: confN > 0 ? confSum / confN : null,
  };
}

function jobIssues(j: Job): string[] {
  return ((j.extracted as Record<string, unknown> | null)?._issues as string[] | undefined) ?? [];
}

/** F5: число сегментов в multi-doc PDF/xlsx (0 — single-doc). */
function multiDocCount(j: Job): number {
  const segs = (j.extracted as Record<string, unknown> | null)?._multidoc_documents;
  return Array.isArray(segs) ? segs.length : 0;
}

/** CP7: classify_only — extract-стадия пропущена профилем потребителя. */
function isClassifyOnly(j: Job): boolean {
  return (
    j.pipeline_steps?.some((s) => s.step === 'parse' && s.status === 'skipped') ??
    false
  );
}

function groupByDocType(items: Job[]): Array<[string, Job[]]> {
  const groups: Record<string, Job[]> = {};
  for (const j of items) {
    const k = j.document_type ?? '';
    groups[k] = groups[k] ?? [];
    groups[k].push(j);
  }
  // Сортируем группы по размеру убыванию (самые жирные сверху)
  return Object.entries(groups).sort((a, b) => b[1].length - a[1].length);
}

function ReviewStats({
  stats,
  total,
  visibleCount,
}: {
  stats: ReviewStatsData;
  total: number;
  visibleCount: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard
        label="всего"
        value={String(total)}
        sub={visibleCount !== total ? `показано ${visibleCount}` : 'все видны'}
      />
      <StatCard
        label="источник"
        value={`${stats.bySynth.real} / ${stats.bySynth.synth}`}
        sub="реал / синт"
      />
      <StatCard
        label="средняя conf"
        value={
          stats.avgConfidence !== null
            ? `${(stats.avgConfidence * 100).toFixed(0)}%`
            : '—'
        }
        sub={
          stats.avgConfidence === null
            ? 'нет данных'
            : confidenceLevel(stats.avgConfidence) === 'low'
            ? 'низкая'
            : confidenceLevel(stats.avgConfidence) === 'medium'
            ? 'средняя'
            : 'высокая'
        }
      />
      <StatCard
        label="топ-проблема"
        value={
          stats.topIssues[0]
            ? String(stats.topIssues[0].count)
            : '0'
        }
        sub={
          stats.topIssues[0]?.text.slice(0, 30) +
            (stats.topIssues[0]?.text.length > 30 ? '…' : '') || '—'
        }
        title={stats.topIssues[0]?.text}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  title,
}: {
  label: string;
  value: string;
  sub?: string;
  title?: string;
}) {
  return (
    <div
      className="rounded-sm border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900"
      title={title}
    >
      <div className="font-mono text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
        {value}
      </div>
      {sub && (
        <div className="font-mono text-[10px] text-slate-500 dark:text-slate-500">
          {sub}
        </div>
      )}
    </div>
  );
}

function FilterStrip({
  label,
  options,
  active,
  onChange,
}: {
  label: string;
  options: { value: string; label: string; count?: number }[];
  active: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <span className="w-20 shrink-0 px-2 py-1 font-mono uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}:
      </span>
      {options.map((o) => (
        <button
          key={o.value || 'all'}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex items-center gap-1 rounded-sm px-2 py-1 font-mono uppercase tracking-wider transition ${
            active === o.value
              ? 'bg-indigo-600 dark:bg-indigo-500 text-white'
              : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
        >
          {o.label}
          {o.count !== undefined && (
            <span
              className={`tabular-nums ${
                active === o.value ? 'text-indigo-100' : 'text-slate-400 dark:text-slate-600'
              }`}
            >
              {o.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ─── ReviewRow ──────────────────────────────────────────────────────── */

/**
 * Top-N полей из extracted для preview. Не показываем всё — это карточка
 * в списке, нужен скан глазами. Фокус: «кто, кому, сколько, когда».
 *
 * F1-fix (2026-06-01): схема `extracted` ВЛОЖЕННАЯ (`seller.name`, `number`,
 * `date`), а не плоская (`seller_name`, `document_number`). Раньше превью
 * читало плоские ключи → значения были `undefined` → блок «кто/кому/сколько/
 * когда» не отображался ни для одного обычного документа. Теперь резолвим
 * так же, как `ExtractedDataPanel` (вложенные party + алиасы number/doc_number),
 * с фолбэком на плоские ключи на случай уже-нормализованных payload'ов.
 *   - get      — достаёт значение (вложенное → плоский фолбэк)
 *   - confKeys — ключи в `_field_confidence` (алиасы number/doc_number)
 *   - flagKeys — ключи, по которым `flaggedFields` подсвечивает поле
 */
type ExtractedBag = Record<string, unknown>;

function nestedName(bag: ExtractedBag, ...objKeys: string[]): unknown {
  for (const ok of objKeys) {
    const obj = bag[ok];
    if (obj && typeof obj === 'object' && 'name' in (obj as ExtractedBag)) {
      const n = (obj as ExtractedBag).name;
      if (n !== null && n !== undefined && n !== '') return n;
    }
  }
  return undefined;
}

function firstDefined(bag: ExtractedBag, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = bag[k];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return undefined;
}

const PREVIEW_FIELDS: {
  label: string;
  get: (e: ExtractedBag) => unknown;
  confKeys: string[];
  flagKeys: string[];
}[] = [
  {
    label: 'Продавец',
    get: (e) => nestedName(e, 'seller', 'shipper', 'supplier') ?? firstDefined(e, 'seller_name'),
    confKeys: ['seller.name'],
    flagKeys: [],
  },
  {
    label: 'Покупатель',
    get: (e) => nestedName(e, 'buyer', 'consignee', 'customer') ?? firstDefined(e, 'buyer_name'),
    confKeys: ['buyer.name'],
    flagKeys: [],
  },
  {
    label: '№',
    get: (e) => firstDefined(e, 'number', 'doc_number', 'document_number'),
    confKeys: ['number', 'doc_number'],
    flagKeys: [],
  },
  {
    label: 'Дата',
    get: (e) => firstDefined(e, 'date', 'document_date'),
    confKeys: ['date'],
    flagKeys: ['document_date'],
  },
];

function ReviewRow({
  job,
  tier,
  canWrite,
  checked,
  isCursor,
  navState,
  onToggle,
  onApprove,
  onReprocess,
  isApproving,
  isReprocessing,
}: {
  job: Job;
  tier: DocumentTypeTier | null;
  canWrite: boolean;
  checked: boolean;
  isCursor: boolean;
  navState: JobNavState;
  onToggle: () => void;
  onApprove: () => void;
  onReprocess: () => void;
  isApproving: boolean;
  isReprocessing: boolean;
}) {
  const issues = jobIssues(job);
  const amounts = extractAmounts(job.extracted);
  const fc =
    (job.extracted as Record<string, unknown> | null)?._field_confidence as
      | Record<string, number>
      | undefined;
  const synth = isSynthetic(job.file_name);
  const multiDoc = multiDocCount(job);
  const classifyOnly = isClassifyOnly(job);

  // Поля, которые упомянуты в issues (для подсветки) — простая эвристика
  const flaggedFields = useMemo(() => {
    const set = new Set<string>();
    for (const iss of issues) {
      const lower = iss.toLowerCase();
      if (lower.includes('инн') || lower.includes('inn')) {
        set.add('seller_inn');
        set.add('buyer_inn');
      }
      if (lower.includes('сумм') || lower.includes('total')) {
        set.add('total_with_vat');
        set.add('vat_amount');
      }
      if (lower.includes('дата') || lower.includes('date')) {
        set.add('document_date');
      }
    }
    return set;
  }, [issues]);

  return (
    <div
      id={`review-row-${job.id}`}
      className={`scroll-mt-2 rounded-sm border ${
        isCursor ? 'ring-2 ring-indigo-500 dark:ring-indigo-400 ' : ''
      }${
        checked
          ? 'border-indigo-300 bg-indigo-50/40 dark:border-indigo-700 dark:bg-indigo-900/20'
          : 'border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'
      }`}
    >
      <div className="flex items-start gap-3 p-3">
        {canWrite && (
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            className="mt-1 h-3.5 w-3.5 shrink-0 cursor-pointer rounded-sm border-slate-300 text-indigo-600"
            aria-label={`Выбрать ${job.file_name}`}
          />
        )}

        <div className="min-w-0 flex-1 space-y-2">
          {/* Top line: filename + badges + meta */}
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={`/jobs/${job.id}`}
              state={navState}
              className="truncate font-medium text-slate-900 hover:text-indigo-600 dark:text-slate-100 dark:hover:text-indigo-400"
              title={job.file_name}
            >
              {job.file_name}
            </Link>
            {synth && (
              <span
                className="shrink-0 rounded-sm bg-violet-100 px-1 font-mono text-[10px] uppercase tracking-wider text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
                title="Синтетический документ"
              >
                synth
              </span>
            )}
            {job.document_type && (
              <span className="badge-indigo shrink-0 uppercase">{job.document_type}</span>
            )}
            {job.document_type && <TierBadge tier={tier} size="xs" />}
            {multiDoc > 0 && (
              <span
                className="shrink-0 rounded-sm bg-sky-100 px-1 font-mono text-[10px] uppercase tracking-wider text-sky-700 dark:bg-sky-900/40 dark:text-sky-300"
                title="Multi-doc PDF — несколько документов в одном файле"
              >
                {multiDoc} документов
              </span>
            )}
            {classifyOnly && (
              <span
                className="shrink-0 rounded-sm bg-slate-100 px-1 font-mono text-[10px] uppercase tracking-wider text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                title="Только классификация — извлечение полей отключено профилем"
              >
                classify-only
              </span>
            )}
            <span
              className="ml-auto font-mono text-[10px] text-slate-400 dark:text-slate-500"
              title={job.id}
            >
              {shortIdSplit(job.id)}
            </span>
          </div>

          {/* Meta line: confidence + size + age */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
            <ConfidenceBar
              value={job.confidence !== null ? Number(job.confidence) : null}
              width={80}
            />
            <span className="font-mono">{formatFileSize(job.file_size)}</span>
            <span className="font-mono" title={formatDateTime(job.created_at)}>
              {formatAge(job.created_at)} назад
            </span>
            {amounts.total !== null && (
              <span className="font-mono font-medium text-slate-700 dark:text-slate-300">
                итог: {formatMoneyCompact(amounts.total, amounts.currency)}
              </span>
            )}
          </div>

          {/* Extracted preview — top fields (не для classify-only: полей нет) */}
          {job.extracted && !classifyOnly && (
            <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
              {PREVIEW_FIELDS.map(({ label, get, confKeys, flagKeys }) => {
                const v = get(job.extracted as ExtractedBag);
                if (v === null || v === undefined || v === '') return null;
                const flagged = flagKeys.some((k) => flaggedFields.has(k));
                const confVal = fc
                  ? (confKeys.map((k) => fc[k]).find((x) => typeof x === 'number') as
                      | number
                      | undefined)
                  : undefined;
                const lowConf =
                  confVal !== undefined && confVal < PREVIEW_ATTENTION_THRESHOLD;
                return (
                  <div key={label} className="flex items-baseline gap-2 text-xs">
                    <span className="w-24 shrink-0 font-mono uppercase tracking-wider text-slate-500 dark:text-slate-400">
                      {label}
                    </span>
                    <span
                      className={`truncate font-mono ${
                        flagged || lowConf
                          ? 'text-amber-700 dark:text-amber-300'
                          : 'text-slate-700 dark:text-slate-300'
                      }`}
                      title={String(v)}
                    >
                      {String(v)}
                      {lowConf && (
                        <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-400">
                          ({(confVal! * 100).toFixed(0)}%)
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Issues */}
          {issues.length > 0 && (
            <div className="flex gap-2 rounded-sm border-l-2 border-amber-500 bg-amber-50 px-2 py-1.5 text-xs dark:bg-amber-900/20">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400"
              >
                <path fillRule="evenodd" d="M12 2.25a.75.75 0 0 1 .671.41l9.875 19.5a.75.75 0 0 1-.671 1.09H2.125a.75.75 0 0 1-.671-1.09l9.875-19.5A.75.75 0 0 1 12 2.25Zm0 6a.75.75 0 0 1 .75.75v5a.75.75 0 0 1-1.5 0v-5a.75.75 0 0 1 .75-.75Zm0 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clipRule="evenodd" />
              </svg>
              <div className="min-w-0 space-y-0.5 text-amber-900 dark:text-amber-200">
                {issues.slice(0, 3).map((iss, i) => (
                  <div key={i} className="truncate">
                    {iss}
                  </div>
                ))}
                {issues.length > 3 && (
                  <div className="font-mono text-[10px] text-amber-700 dark:text-amber-400">
                    + ещё {issues.length - 3} проблем
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex shrink-0 flex-col items-stretch gap-1.5">
          <Link
            to={`/jobs/${job.id}`}
            state={navState}
            className="btn-ghost text-center"
            title="Открыть деталку"
          >
            Открыть
          </Link>
          {canWrite && (
            <>
              <button
                type="button"
                className="btn-secondary text-xs"
                disabled={isReprocessing || isApproving}
                onClick={onReprocess}
                title="Перепрогнать через pipeline (новый OCR + LLM)"
              >
                {isReprocessing ? 'Перепрогон…' : '↻ Перепрогон'}
              </button>
              <button
                type="button"
                className="btn-success"
                disabled={isApproving || isReprocessing}
                onClick={onApprove}
                title="Одобрить (отправит webhook клиенту)"
              >
                {isApproving ? 'Одобряю…' : 'Одобрить ✓'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
