import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useJob, useJobFile, useApproveJob, useReprocessJob } from '@/queries/jobs';
import PdfViewer from '@/components/PdfViewer';
import ExtractedDataPanel from '@/components/ExtractedDataPanel';
import ValidationBanner from '@/components/ValidationBanner';
import ExtractedEditor from '@/components/ExtractedEditor';
import {
  formatFileSize,
  formatPercent,
  shortId,
  formatDateTime,
} from '@/lib/format';

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
  if (!jobId) return <div className="p-6">Job ID не указан</div>;

  const { data: job, isLoading, error } = useJob(jobId);
  const { data: fileUrl } = useJobFile(jobId);
  const approve = useApproveJob();
  const reprocess = useReprocessJob();
  const [editorOpen, setEditorOpen] = useState(false);

  // Cleanup blob URL — react-pdf держит ссылку, поэтому освобождаем
  // только при unmount страницы (не при ре-фетче).
  useEffect(() => {
    return () => {
      if (fileUrl) URL.revokeObjectURL(fileUrl);
    };
  }, [fileUrl]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
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

  return (
    <div className="flex h-full flex-col">
      {/* Top bar — title + meta + actions */}
      <div className="shrink-0 border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-lg font-semibold text-slate-900">
                {job.file_name}
              </h1>
              <StatusBadge status={job.status} />
              {job.document_type && (
                <span className="badge-indigo">{job.document_type}</span>
              )}
            </div>
            <div className="mt-1 flex items-center gap-4 text-xs text-slate-500">
              <span className="font-mono">{shortId(job.id)}</span>
              <span>{formatFileSize(job.file_size)}</span>
              <span>{job.mime_type}</span>
              {job.confidence !== null && (
                <span>
                  confidence{' '}
                  <span className="font-medium text-slate-700">
                    {formatPercent(Number(job.confidence))}
                  </span>{' '}
                  via {job.ocr_engine ?? '—'}
                </span>
              )}
              <span>создан {formatDateTime(job.created_at)}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {job.status === 'needs_review' && (
              <button
                type="button"
                className="btn-success"
                disabled={approve.isPending}
                onClick={() => approve.mutate(job.id)}
              >
                {approve.isPending ? 'Одобряю…' : 'Одобрить ✓'}
              </button>
            )}
            <button
              type="button"
              className="btn-secondary"
              disabled={reprocess.isPending}
              onClick={() => reprocess.mutate(job.id)}
            >
              {reprocess.isPending ? 'Перепрогон…' : 'Перепрогнать'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setEditorOpen(true)}
              title="Редактировать extracted JSON"
            >
              ✎ Edit
            </button>
            <a
              href={`/ui-legacy/#jobs/${job.id}`}
              className="btn-ghost"
              title="Открыть в legacy UI (страховка)"
            >
              Legacy →
            </a>
          </div>
        </div>
      </div>

      {/* Main grid: 2-колоночный layout */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-slate-200 lg:grid-cols-[1fr_minmax(420px,40%)]">
        {/* PDF слева */}
        <div className="min-h-0 bg-white">
          {fileUrl ? (
            <PdfViewer fileUrl={fileUrl} mimeType={job.mime_type} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              Загрузка файла…
            </div>
          )}
        </div>

        {/* Data справа */}
        <div className="flex min-h-0 flex-col gap-3 overflow-auto bg-slate-50 p-4">
          <ValidationBanner issues={issues} />

          <ExtractedDataPanel extracted={job.extracted} issues={issues} />

          {fieldConfidence && Object.keys(fieldConfidence).length > 0 && (
            <FieldConfidenceCard fc={fieldConfidence} />
          )}

          {job.pipeline_steps && job.pipeline_steps.length > 0 && (
            <PipelineStepsCard steps={job.pipeline_steps} />
          )}
        </div>
      </div>

      {editorOpen && (
        <ExtractedEditor
          jobId={job.id}
          initial={job.extracted}
          onClose={() => setEditorOpen(false)}
        />
      )}
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

function FieldConfidenceCard({ fc }: { fc: Record<string, number> }) {
  const entries = Object.entries(fc).sort((a, b) => a[1] - b[1]);
  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Per-field confidence</h3>
      </div>
      <div className="card-body space-y-2">
        {entries.map(([k, v]) => (
          <div key={k} className="flex items-center gap-3 text-sm">
            <span className="w-40 truncate text-slate-700">{k}</span>
            <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
              <div
                className={`absolute inset-y-0 left-0 ${
                  v >= 0.9
                    ? 'bg-emerald-500'
                    : v >= 0.7
                    ? 'bg-amber-500'
                    : 'bg-rose-500'
                }`}
                style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%` }}
              />
            </div>
            <span className="w-12 text-right font-mono text-xs text-slate-600">
              {formatPercent(v)}
            </span>
          </div>
        ))}
      </div>
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
                    ? 'text-emerald-700'
                    : s.status === 'failed'
                    ? 'text-rose-700'
                    : 'text-slate-500'
                }`}
              >
                {s.status}
              </span>
              <span className="flex-1 truncate text-slate-700">{s.step}</span>
              {s.duration_ms !== undefined && (
                <span className="font-mono text-xs text-slate-500">{s.duration_ms} ms</span>
              )}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
