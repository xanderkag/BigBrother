import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  useJob,
  useJobFile,
  useApproveJob,
  useReprocessJob,
  useRedeliverWebhook,
} from '@/queries/jobs';
import { useDocumentTypes, type DocumentTypeTier } from '@/queries/documentTypes';
import { api } from '@/lib/api';
import PdfViewer from '@/components/PdfViewer';
import ExtractedDataPanel from '@/components/ExtractedDataPanel';
import ConfidenceBar from '@/components/ConfidenceBar';
import TierBadge from '@/components/TierBadge';
import ValidationBanner from '@/components/ValidationBanner';
import ExtractedEditor from '@/components/ExtractedEditor';
import ConfirmDialog from '@/components/ConfirmDialog';
import RawTextModal from '@/components/RawTextModal';
import { usePermissions } from '@/lib/permissions';
import {
  formatFileSize,
  formatPercent,
  shortId,
  formatDateTime,
} from '@/lib/format';
import type { Job } from '@/lib/types';

/**
 * F5 multi-doc сегмент — один документ внутри multi-doc PDF/xlsx.
 * Лежит в job.extracted._multidoc_documents (single-doc — ключа нет).
 */
interface MultiDocSegment {
  page_range: string;
  document_type: string | null;
  confidence: number;
  extracted: Record<string, unknown>;
  field_confidence?: Record<string, number>;
}

/**
 * DaData/ЕГРЮЛ-обогащение. Backend кладёт в job.extracted._enrichment, если
 * у потребителя включён enrich_enabled. Парти индексируются по ИНН.
 */
interface EnrichmentParty {
  inn?: string | null;
  kpp?: string | null;
  ogrn?: string | null;
  name_full?: string | null;
  name_short?: string | null;
  address?: string | null;
  management_name?: string | null;
  management_post?: string | null;
  status?: string | null;
}

interface Enrichment {
  parties?: Record<string, EnrichmentParty> | null;
  _meta?: {
    provider?: string | null;
    at?: string | null;
    mismatches?: string[] | null;
  } | null;
}

/**
 * Job Detail — главная страница UI v2. Заменяет старый view из app.js
 * с двух-колонным layout'ом (PDF слева, extracted data справа).
 *
 * Изменения по сравнению со старым:
 *   - PDF рендерится через react-pdf (canvas) — без браузерного PDF.js
 *     chrome (thumbnail strip), занимает 100% колонки.
 *   - layout растягивается на весь viewport (calc(100vh - header)).
 *   - validation issues — sticky banner один раз, не дублируется.
 *   - extracted data в правой колонке сгруппирована по секциям с
 *     2-колоночным grid'ом — лучше использует ширину.
 *   - actions (Одобрить / Перепрогнать) — в верхней панели страницы,
 *     не повторяются в карточке.
 */
export default function JobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  // Защита от stale-ссылок типа /jobs/undefined: они появлялись когда UI
  // читал job.id (которого нет — backend отдаёт job_id), компонент
  // строил `to=/jobs/${undefined}` и Router'у прилетала literal-строка
  // "undefined". Не дергаем API за 400'й.
  const isValidUuid = !!jobId && /^[0-9a-f-]{8,}$/i.test(jobId);
  if (!jobId || !isValidUuid) {
    return (
      <div className="p-6">
        <div className="error-banner">
          Невалидный Job ID в URL: <code className="font-mono">{jobId ?? '(пусто)'}</code>.
          <br />
          Вернитесь в <a href="/ui/jobs" className="underline">список документов</a> и
          откройте через клик по строке.
        </div>
      </div>
    );
  }

  const { data: job, isLoading, error } = useJob(jobId);
  const { data: fileUrl } = useJobFile(jobId);
  const { data: docTypes } = useDocumentTypes();
  const approve = useApproveJob();
  const reprocess = useReprocessJob();
  // F9 — viewer работает в read-only: одобрение/перепрогон/правка скрыты,
  // выгрузка JSON и просмотр остаются.
  const { isWriter } = usePermissions();
  const [editorOpen, setEditorOpen] = useState(false);
  const [activeDoc, setActiveDoc] = useState(0);
  // F10/F11 — подтверждение reprocess + просмотр сырого текста.
  const [confirmReprocess, setConfirmReprocess] = useState(false);
  const [rawTextOpen, setRawTextOpen] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const tierBySlug = useMemo(() => {
    const m = new Map<string, DocumentTypeTier>();
    for (const t of docTypes?.items ?? []) {
      if (t.tier) m.set(t.slug, t.tier);
    }
    return m;
  }, [docTypes]);

  // Cleanup blob URL — react-pdf держит ссылку, поэтому освобождаем
  // только при unmount страницы (не при ре-фетче).
  useEffect(() => {
    return () => {
      if (fileUrl) URL.revokeObjectURL(fileUrl);
    };
  }, [fileUrl]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-slate-400 dark:text-slate-500">
        Загрузка job'а…
      </div>
    );
  }

  if (error || !job) {
    return (
      <div className="p-6">
        <div className="error-banner">
          Ошибка загрузки: {error instanceof Error ? error.message : 'job не найден'}
        </div>
      </div>
    );
  }

  const issues = (job.extracted?._issues as string[] | undefined) ?? [];
  const fieldConfidence = job.extracted?._field_confidence as
    | Record<string, number>
    | undefined;
  const enrichment = (job.extracted?._enrichment as Enrichment | undefined) ?? null;

  // CP7: classify_only — extract-стадия пропущена профилем потребителя.
  // Сигнал — pipeline-шаг parse со статусом skipped (см. orchestrator.ts).
  const classifyOnly =
    job.pipeline_steps?.some(
      (s) => s.step === 'parse' && s.status === 'skipped',
    ) ?? false;

  // F5: multi-doc сегменты. Primary `extracted` = доминирующий документ,
  // сегменты — дополнительные. Single-doc — ключа нет.
  const segmentsRaw = job.extracted?._multidoc_documents;
  const segments: MultiDocSegment[] =
    Array.isArray(segmentsRaw) && segmentsRaw.length > 0
      ? (segmentsRaw as MultiDocSegment[])
      : [];
  const isMultiDoc = segments.length > 0;

  // F11 — выгрузка извлечённых данных в JSON. Отдаём `extracted` целиком
  // (включая _issues/_field_confidence/_enrichment), чтобы файл был
  // самодостаточным для разбора вне UI. Имя — по исходному файлу.
  const handleDownloadJson = () => {
    if (!job.extracted) return;
    const blob = new Blob([JSON.stringify(job.extracted, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const base = job.file_name?.replace(/\.[^.]+$/, '') || job.id;
    a.download = `${base}.extracted.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // F11 — скачать оригинал документа (GET /jobs/:id/file). Проверяем статус
  // (после retention-чистки бэк отдаёт 410), чтобы не сохранить error-JSON
  // под видом файла. Имя берём из job.file_name.
  const handleDownloadOriginal = async () => {
    setDownloadError(null);
    try {
      const res = await api.getResponse(`/api/v1/jobs/${job.id}/file`);
      if (!res.ok) {
        setDownloadError(
          res.status === 410
            ? 'Оригинал уже удалён (истёк срок хранения).'
            : `Не удалось скачать файл (HTTP ${res.status}).`,
        );
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = job.file_name || job.id;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Top bar — title + meta + actions */}
      <div className="shrink-0 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-6 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-semibold text-slate-900 dark:text-slate-100">
                {job.file_name}
              </h1>
              <StatusBadge status={job.status} />
              {job.document_type && (
                <span className="badge-indigo">{job.document_type}</span>
              )}
            </div>
            <div className="mt-1 flex items-center gap-4 text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">
              <span className="font-mono">{shortId(job.id)}</span>
              <span>{formatFileSize(job.file_size)}</span>
              <span>{job.mime_type}</span>
              {job.confidence !== null && (
                <span>
                  confidence{' '}
                  <span className="font-medium text-slate-700 dark:text-slate-300">
                    {formatPercent(Number(job.confidence))}
                  </span>{' '}
                  via {job.ocr_engine ?? '—'}
                </span>
              )}
              <span>создан {formatDateTime(job.created_at)}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isWriter && job.status === 'needs_review' && (
              <button
                type="button"
                className="btn-success"
                disabled={approve.isPending}
                onClick={() => approve.mutate(job.id)}
              >
                {approve.isPending ? 'Одобряю…' : 'Одобрить ✓'}
              </button>
            )}
            {isWriter && (
              <button
                type="button"
                className="btn-secondary"
                disabled={reprocess.isPending}
                onClick={() => setConfirmReprocess(true)}
              >
                {reprocess.isPending ? 'Перепрогон…' : 'Перепрогнать'}
              </button>
            )}
            <button
              type="button"
              className="btn-secondary"
              onClick={handleDownloadJson}
              disabled={!job.extracted}
              title="Скачать извлечённые данные в JSON"
            >
              ↓ JSON
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleDownloadOriginal}
              title="Скачать исходный файл"
            >
              ↓ Оригинал
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setRawTextOpen(true)}
              title="Показать сырой OCR-текст"
            >
              Сырой текст
            </button>
            {isWriter && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setEditorOpen(true)}
                disabled={classifyOnly}
                title={
                  classifyOnly
                    ? 'Извлечение отключено профилем (classify_only)'
                    : 'Редактировать extracted JSON'
                }
              >
                ✎ Edit
              </button>
            )}
          </div>
        </div>
      </div>

      {downloadError && (
        <div className="shrink-0 px-6 pt-3">
          <div className="error-banner">
            <span className="font-medium">Скачивание:</span> {downloadError}
          </div>
        </div>
      )}

      {/* Main grid: 2-колоночный layout */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-slate-200 lg:grid-cols-[1fr_minmax(420px,40%)]">
        {/* PDF слева */}
        <div className="min-h-0 bg-white dark:bg-slate-900">
          {fileUrl ? (
            <PdfViewer fileUrl={fileUrl} mimeType={job.mime_type} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-slate-400 dark:text-slate-500">
              Загрузка файла…
            </div>
          )}
        </div>

        {/* Data справа */}
        <div className="flex min-h-0 flex-col gap-3 overflow-auto bg-slate-50 dark:bg-slate-900/40 p-4">
          <ValidationBanner issues={issues} />

          <EnrichmentCard enrichment={enrichment} />

          {classifyOnly ? (
            <ClassifyOnlyResult
              documentType={job.document_type}
              confidence={job.confidence}
              tier={
                job.document_type ? tierBySlug.get(job.document_type) ?? null : null
              }
            />
          ) : isMultiDoc ? (
            <MultiDocView
              activeDoc={activeDoc}
              onSelect={setActiveDoc}
              primary={{
                extracted: job.extracted,
                issues,
                document_type: job.document_type,
                confidence: job.confidence,
                fieldConfidence,
              }}
              segments={segments}
              tierBySlug={tierBySlug}
            />
          ) : (
            <>
              <ExtractedDataPanel
                extracted={job.extracted}
                issues={issues}
                fieldConfidence={fieldConfidence}
              />

              {fieldConfidence && Object.keys(fieldConfidence).length > 0 && (
                <FieldConfidenceCard fc={fieldConfidence} />
              )}
            </>
          )}

          <WebhookDeliveryCard job={job} canWrite={isWriter} />

          {job.pipeline_steps && job.pipeline_steps.length > 0 && (
            <PipelineStepsCard steps={job.pipeline_steps} />
          )}
        </div>
      </div>

      {editorOpen && (
        <ExtractedEditor
          jobId={job.id}
          initial={job.extracted}
          documentType={job.document_type}
          onClose={() => setEditorOpen(false)}
        />
      )}

      {rawTextOpen && (
        <RawTextModal
          jobId={job.id}
          fileName={job.file_name}
          onClose={() => setRawTextOpen(false)}
        />
      )}

      <ConfirmDialog
        open={confirmReprocess}
        title="Перепрогнать документ?"
        description={
          <>
            Документ будет заново разобран по текущей конфигурации типа
            (промпт / схема / валидаторы). OCR не повторяется — используется
            сохранённый текст. Текущие извлечённые данные будут перезаписаны.
          </>
        }
        objectName={job.file_name ?? job.id}
        confirmLabel="Перепрогнать"
        busy={reprocess.isPending}
        error={reprocess.isError ? (reprocess.error as Error)?.message : null}
        onCancel={() => setConfirmReprocess(false)}
        onConfirm={() =>
          reprocess.mutate(job.id, { onSuccess: () => setConfirmReprocess(false) })
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Helper components                                                  */
/* ------------------------------------------------------------------ */

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

/**
 * DaData/ЕГРЮЛ-обогащение. Карточка показывается, только если backend
 * приложил _enrichment с непустым parties. Иначе — ничего (return null).
 */
function EnrichmentCard({ enrichment }: { enrichment: Enrichment | null }) {
  if (!enrichment) return null;
  const parties = Object.entries(enrichment.parties ?? {});
  const mismatches = (enrichment._meta?.mismatches ?? []).filter(Boolean);
  if (parties.length === 0 && mismatches.length === 0) return null;

  return (
    <div className="card">
      <div className="card-header flex items-center justify-between">
        <h3 className="card-title">Обогащение (DaData/ЕГРЮЛ)</h3>
        {enrichment._meta?.provider && (
          <span className="badge-slate">{enrichment._meta.provider}</span>
        )}
      </div>
      <div className="card-body space-y-3">
        {mismatches.length > 0 && (
          <div className="space-y-1">
            {mismatches.map((m, i) => (
              <div
                key={i}
                className="rounded-md border-l-4 border-amber-500 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
              >
                ⚠ {m}
              </div>
            ))}
          </div>
        )}

        {parties.map(([inn, p]) => (
          <div
            key={inn}
            className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                ИНН {p.inn ?? inn}
              </span>
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                {p.name_short ?? p.name_full ?? '—'}
              </span>
              <EnrichmentStatusBadge status={p.status ?? null} />
            </div>
            {(p.kpp || p.ogrn) && (
              <div className="mt-1 flex flex-wrap gap-x-4 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                {p.kpp && <span>КПП {p.kpp}</span>}
                {p.ogrn && <span>ОГРН {p.ogrn}</span>}
              </div>
            )}
            {p.address && (
              <div className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                {p.address}
              </div>
            )}
            {(p.management_name || p.management_post) && (
              <div className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                {[p.management_post, p.management_name].filter(Boolean).join(': ')}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function EnrichmentStatusBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const up = status.toUpperCase();
  if (up === 'ACTIVE') return <span className="badge-emerald">действует</span>;
  if (up === 'LIQUIDATED' || up === 'LIQUIDATING')
    return <span className="badge-rose">ликвидирован</span>;
  return <span className="badge-slate">{status}</span>;
}

/**
 * CP7: classify_only-результат. Извлечение полей отключено профилем
 * потребителя — показываем только тип + confidence (это весь результат).
 */
function ClassifyOnlyResult({
  documentType,
  confidence,
  tier,
}: {
  documentType: string | null;
  confidence: number | null;
  tier: DocumentTypeTier | null;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border-l-4 border-sky-500 bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:bg-sky-900/20 dark:text-sky-200">
        Только классификация — извлечение полей отключено профилем
        потребителя (classify_only).
      </div>
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Результат классификации</h3>
        </div>
        <div className="card-body space-y-4">
          <div className="flex items-center gap-2">
            {documentType ? (
              <span className="badge-indigo uppercase">{documentType}</span>
            ) : (
              <span className="text-sm text-slate-500 dark:text-slate-400">
                тип не определён
              </span>
            )}
            <TierBadge tier={tier} />
          </div>
          <div>
            <div className="mb-1 text-xs text-slate-500 dark:text-slate-400">
              Confidence
            </div>
            <ConfidenceBar
              value={confidence !== null ? Number(confidence) : null}
              width={160}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * F5: multi-doc view. Tab strip + панель активного документа. Первая
 * вкладка — primary `extracted` (доминирующий документ, редактируемый
 * через общий Edit-flow). Остальные сегменты — read-only в этом cut.
 */
function MultiDocView({
  activeDoc,
  onSelect,
  primary,
  segments,
  tierBySlug,
}: {
  activeDoc: number;
  onSelect: (i: number) => void;
  primary: {
    extracted: Record<string, unknown> | null;
    issues: string[];
    document_type: string | null;
    confidence: number | null;
    fieldConfidence?: Record<string, number>;
  };
  segments: MultiDocSegment[];
  tierBySlug: Map<string, DocumentTypeTier>;
}) {
  // Вкладка 0 — primary, далее по одному на сегмент.
  const tabs = [
    {
      label: primary.document_type ?? 'основной',
      page_range: null as string | null,
      confidence: primary.confidence,
      document_type: primary.document_type,
    },
    ...segments.map((s) => ({
      label: s.document_type ?? 'без типа',
      page_range: s.page_range,
      confidence: s.confidence,
      document_type: s.document_type,
    })),
  ];
  const idx = Math.min(activeDoc, tabs.length - 1);
  const isPrimary = idx === 0;
  const seg = isPrimary ? null : segments[idx - 1];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1 overflow-x-auto rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
        {tabs.map((t, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onSelect(i)}
            className={`flex shrink-0 items-center gap-1.5 rounded px-2.5 py-1 text-xs ${
              i === idx
                ? 'bg-brand-600 text-white'
                : 'text-slate-700 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700'
            }`}
            title={t.page_range ? `Страницы ${t.page_range}` : 'Основной документ'}
          >
            <span className="uppercase">{t.label}</span>
            {t.page_range && (
              <span className="font-mono opacity-70">[{t.page_range}]</span>
            )}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
        {(tabs[idx].document_type ?? null) && (
          <span className="badge-indigo uppercase">{tabs[idx].document_type}</span>
        )}
        <TierBadge
          tier={
            tabs[idx].document_type
              ? tierBySlug.get(tabs[idx].document_type as string) ?? null
              : null
          }
        />
        {tabs[idx].page_range && (
          <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
            стр. {tabs[idx].page_range}
          </span>
        )}
        <ConfidenceBar
          value={
            tabs[idx].confidence !== null ? Number(tabs[idx].confidence) : null
          }
          width={120}
        />
        {!isPrimary && (
          <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
            read-only
          </span>
        )}
      </div>

      {isPrimary ? (
        <>
          <ExtractedDataPanel
            extracted={primary.extracted}
            issues={primary.issues}
            fieldConfidence={primary.fieldConfidence}
          />
          {primary.fieldConfidence &&
            Object.keys(primary.fieldConfidence).length > 0 && (
              <FieldConfidenceCard fc={primary.fieldConfidence} />
            )}
        </>
      ) : (
        seg && (
          <>
            <ExtractedDataPanel
              extracted={seg.extracted}
              fieldConfidence={seg.field_confidence}
            />
            {seg.field_confidence &&
              Object.keys(seg.field_confidence).length > 0 && (
                <FieldConfidenceCard fc={seg.field_confidence} />
              )}
          </>
        )
      )}
    </div>
  );
}

function FieldConfidenceCard({ fc }: { fc: Record<string, number> }) {
  const entries = Object.entries(fc).sort((a, b) => a[1] - b[1]);
  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Per-field confidence</h3>
      </div>
      <div className="card-body space-y-2">
        {entries.map(([k, v]) => {
          const pct = Math.max(0, Math.min(1, v));
          const barCls =
            pct >= 0.85
              ? 'bg-emerald-500 dark:bg-emerald-400'
              : pct >= 0.6
              ? 'bg-amber-500 dark:bg-amber-400'
              : 'bg-rose-500 dark:bg-rose-400';
          const labelCls =
            pct >= 0.85
              ? 'text-emerald-700 dark:text-emerald-300'
              : pct >= 0.6
              ? 'text-amber-700 dark:text-amber-300'
              : 'text-rose-700 dark:text-rose-300';
          return (
            <div key={k} className="flex items-center gap-3 text-sm">
              <span className="w-40 truncate text-slate-700 dark:text-slate-300">{k}</span>
              <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                <div
                  className={`absolute inset-y-0 left-0 ${barCls}`}
                  style={{ width: `${pct * 100}%` }}
                />
              </div>
              <span className={`w-12 text-right font-mono text-xs tabular-nums ${labelCls}`}>
                {formatPercent(v)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * UI-5: панель доставки вебхука. webhook_url == null → потребитель в
 * pull-режиме, ничего не рисуем. Иначе показываем состояние доставки:
 * доставлен / ошибка(retry) / ожидает.
 */
function WebhookDeliveryCard({ job, canWrite }: { job: Job; canWrite: boolean }) {
  const redeliver = useRedeliverWebhook();
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!job.webhook_url) return null;

  const delivered = job.webhook_delivered_at != null;
  const failed = !delivered && job.webhook_last_error != null;
  const pending = !delivered && !failed;
  // Повтор возможен только в терминальном статусе (бэк отбивает pending/processing).
  const terminal =
    job.status !== 'pending' && job.status !== 'processing';

  return (
    <div className="card">
      <div className="card-header flex items-center justify-between">
        <h3 className="card-title">Доставка вебхука</h3>
        {delivered ? (
          <span className="badge-emerald">Доставлен</span>
        ) : failed ? (
          <span className="badge-rose">Ошибка</span>
        ) : (
          <span className="badge-slate">Ожидает отправки</span>
        )}
      </div>
      <div className="card-body space-y-3 text-sm">
        <div className="flex items-start gap-2">
          <span className="w-24 shrink-0 text-xs text-slate-500 dark:text-slate-400">
            Адрес
          </span>
          <code
            className="min-w-0 break-all font-mono text-xs text-slate-700 dark:text-slate-300"
            title={job.webhook_url}
          >
            {job.webhook_url}
          </code>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-xs text-slate-500 dark:text-slate-400">
            Попыток
          </span>
          <span className="font-mono text-xs text-slate-700 dark:text-slate-300">
            {job.webhook_attempts}
          </span>
        </div>

        {delivered && (
          <div className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-xs text-slate-500 dark:text-slate-400">
              Доставлен
            </span>
            <span className="text-xs text-emerald-700 dark:text-emerald-300">
              {formatDateTime(job.webhook_delivered_at)}
            </span>
          </div>
        )}

        {failed && job.webhook_last_error && (
          <div className="space-y-1">
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Последняя ошибка
            </span>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 font-mono text-[11px] text-rose-800 dark:border-rose-900/50 dark:bg-rose-900/20 dark:text-rose-300">
              {job.webhook_last_error}
            </pre>
          </div>
        )}

        {pending && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Документ ещё не отправлен потребителю.
          </p>
        )}

        {canWrite && (
          <div className="pt-1">
            <button
              type="button"
              className="btn-secondary"
              disabled={!terminal || redeliver.isPending}
              onClick={() => setConfirmOpen(true)}
              title={
                terminal
                  ? 'Повторно отправить вебхук потребителю'
                  : 'Доступно после завершения обработки'
              }
            >
              {redeliver.isPending ? 'Отправляю…' : '↻ Повторить доставку'}
            </button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="Повторить доставку вебхука?"
        description="Данные документа будут заново отправлены потребителю по указанному адресу."
        objectName={job.webhook_url}
        warning={
          <>
            Это <strong>внешний эффект</strong>: запрос уйдёт во внешнюю систему
            (например, SLAI). Если вебхук уже был доставлен, потребитель получит
            данные повторно.
          </>
        }
        confirmLabel="Отправить повторно"
        busy={redeliver.isPending}
        error={redeliver.isError ? (redeliver.error as Error)?.message : null}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() =>
          redeliver.mutate(job.id, { onSuccess: () => setConfirmOpen(false) })
        }
      />
    </div>
  );
}

function PipelineStepsCard({
  steps,
}: {
  steps: Array<{ step: string; status: string; duration_ms?: number; at: string }>;
}) {
  return (
    <details className="card">
      <summary className="card-header cursor-pointer">
        <h3 className="card-title">Pipeline steps ({steps.length})</h3>
      </summary>
      <div className="card-body">
        <ol className="space-y-1 text-sm">
          {steps.map((s, i) => (
            <li key={i} className="flex items-center gap-3">
              <span
                className={`w-24 font-mono text-xs ${
                  s.status === 'done'
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : s.status === 'failed'
                    ? 'text-rose-700 dark:text-rose-300'
                    : 'text-slate-500 dark:text-slate-400 dark:text-slate-500'
                }`}
              >
                {s.status}
              </span>
              <span className="flex-1 truncate text-slate-700 dark:text-slate-300">{s.step}</span>
              {s.duration_ms !== undefined && (
                <span className="font-mono text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">{s.duration_ms} ms</span>
              )}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
