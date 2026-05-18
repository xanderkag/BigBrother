import { useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { useUploadJob, useJob } from '@/queries/jobs';
import { useDocumentTypes } from '@/queries/documentTypes';
import { useProviders } from '@/queries/providers';
import { useProvidersStatus } from '@/queries/settings';
import { formatFileSize } from '@/lib/format';

/**
 * Test Lab — упрощённый прогон одного документа через выбранный
 * LLM-провайдер для калибровки и сравнения моделей.
 *
 * Отличия от обычного Upload:
 *   - один файл за раз (не bulk)
 *   - явный picker LLM-провайдера — отправляется через
 *     metadata._force_provider_id, перекрывая дефолт
 *   - live-poll job'а после создания (auto-refresh каждые 2с пока
 *     not in terminal status), результат рендерится прямо на странице
 *   - badges цепочки OCR-движков (что будет пробоваться)
 *
 * Доступ — admin. Полная Upload-страница (/upload) для бизнес-пользователя.
 */
const ACCEPT_EXT = '.pdf,.jpg,.jpeg,.png,.heic,.heif,.bmp,.tif,.tiff,.webp';

export default function TestLabPage() {
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [documentHint, setDocumentHint] = useState('');
  const [providerId, setProviderId] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);

  const upload = useUploadJob();
  const { data: docTypes } = useDocumentTypes();
  const { data: providersStatus } = useProvidersStatus();
  const { data: allProviders } = useProviders();
  const llmProviders = (allProviders?.items ?? []).filter((p) => p.kind === 'llm');

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
  };

  const run = async () => {
    if (!file) return;
    setJobId(null);
    try {
      const res = await upload.mutateAsync({
        file,
        documentHint: documentHint || undefined,
        metadata: providerId ? { _force_provider_id: providerId } : undefined,
      });
      setJobId(res.job_id);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const reset = () => {
    setFile(null);
    setJobId(null);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Тестовая лаборатория
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Прогон одного документа через конкретный LLM-провайдер для
          калибровки и сравнения моделей. Для массовой загрузки используйте{' '}
          <Link to="/upload" className="text-brand-600 hover:underline dark:text-brand-400">
            страницу загрузки
          </Link>
          .
        </p>
      </header>

      <EngineChainBadges providersStatus={providersStatus} />

      <div className="card">
        <div className="card-body space-y-4">
          {/* Drop zone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => document.getElementById('testlab-file')?.click()}
            className={`cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition ${
              dragOver
                ? 'border-brand-500 bg-brand-50 dark:bg-brand-900/20'
                : 'border-slate-300 hover:border-brand-400 dark:border-slate-700 dark:hover:border-brand-600'
            }`}
          >
            <input
              id="testlab-file"
              type="file"
              className="hidden"
              accept={ACCEPT_EXT}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            {file ? (
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-100">{file.name}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {formatFileSize(file.size)} • {file.type || 'unknown'}
                </p>
                <button
                  type="button"
                  className="btn-ghost mt-2 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFile(null);
                  }}
                >
                  ✕ выбрать другой
                </button>
              </div>
            ) : (
              <>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="mx-auto mb-3 h-12 w-12 text-slate-400 dark:text-slate-500"
                >
                  <path d="M11.47 1.72a.75.75 0 0 1 1.06 0l3 3a.75.75 0 0 1-1.06 1.06l-1.72-1.72V7.5h-1.5V4.06L9.53 5.78a.75.75 0 0 1-1.06-1.06l3-3ZM11.25 7.5V15a.75.75 0 0 0 1.5 0V7.5h3.75a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-9a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3h3.75Z" />
                </svg>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Перетащи файл или{' '}
                  <span className="font-medium text-brand-600 dark:text-brand-400">
                    нажми чтобы выбрать
                  </span>
                </p>
                <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                  PDF, JPG, PNG, BMP, TIFF, HEIC — до 50 МБ
                </p>
              </>
            )}
          </div>

          {/* Form */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="form-label">Тип документа</label>
              <select
                className="form-select"
                value={documentHint}
                onChange={(e) => setDocumentHint(e.target.value)}
              >
                <option value="">Авто-определение (по содержимому)</option>
                {(docTypes?.items ?? []).map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.display_name} ({t.slug})
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Опционально — помогает классификатору.
              </p>
            </div>
            <div>
              <label className="form-label">LLM-провайдер</label>
              <select
                className="form-select"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              >
                <option value="">По умолчанию (как настроено)</option>
                {llmProviders
                  .filter((p) => p.is_active)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.display_name} {p.model ? `· ${p.model}` : ''}
                      {p.is_default ? ' (default)' : ''}
                    </option>
                  ))}
              </select>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Перекрывает дефолт через{' '}
                <code className="font-mono">metadata._force_provider_id</code>.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn-primary"
              disabled={!file || upload.isPending}
              onClick={run}
            >
              {upload.isPending ? 'Отправляю…' : '▶ Прогнать'}
            </button>
            {file && !upload.isPending && (
              <button type="button" className="btn-ghost" onClick={reset}>
                Сбросить
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Result */}
      {jobId && <JobResult jobId={jobId} />}
    </div>
  );
}

// ============================================================================
// Engine chain — какие OCR будут пробоваться сверху вниз
// ============================================================================

function EngineChainBadges({
  providersStatus,
}: {
  providersStatus: ReturnType<typeof useProvidersStatus>['data'];
}) {
  const llmOk = providersStatus?.upstream === 'ok';
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-slate-500 dark:text-slate-400">Цепочка OCR:</span>
      <Pill>pdf-parse</Pill>
      <Arrow />
      <Pill>tesseract</Pill>
      <Arrow />
      <Pill active={llmOk}>vision-LLM {llmOk ? '' : '(off)'}</Pill>
      <Arrow />
      <Pill>yandex-vision</Pill>
      <span className="ml-2 text-slate-400 dark:text-slate-500">
        пробуется сверху вниз; первый проходящий порог уверенности — побеждает
      </span>
    </div>
  );
}

function Pill({ children, active }: { children: React.ReactNode; active?: boolean }) {
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 font-mono ${
        active
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
          : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
      }`}
    >
      {children}
    </span>
  );
}

function Arrow() {
  return <span className="text-slate-400 dark:text-slate-600">→</span>;
}

// ============================================================================
// Job result — live polling пока not terminal
// ============================================================================

function JobResult({ jobId }: { jobId: string }) {
  const { data: job, error } = useJob(jobId);

  // refetchInterval подключим через useJob, но без него — простой setInterval
  // не нужен, useJob уже определяет refetchInterval для not-terminal статусов.
  const isTerminal =
    job && ['done', 'needs_review', 'failed', 'approved'].includes(job.status);

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Результат</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Job <code className="font-mono">{jobId.slice(0, 12)}…</code>
          </p>
        </div>
        <Link to={`/jobs/${jobId}`} className="btn-secondary text-xs">
          → Открыть детально
        </Link>
      </div>
      <div className="card-body space-y-3">
        {error && (
          <div className="error-banner text-sm">
            <div>{error instanceof Error ? error.message : String(error)}</div>
          </div>
        )}

        {!job && !error && (
          <p className="text-sm text-slate-500 dark:text-slate-400">Ждём ответ от сервера…</p>
        )}

        {job && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge status={job.status} />
              {job.document_type && (
                <span className="badge-indigo">{job.document_type}</span>
              )}
              {job.ocr_engine && (
                <span className="badge-slate">engine: {job.ocr_engine}</span>
              )}
              {job.confidence !== null && (
                <span className="text-xs text-slate-600 dark:text-slate-400">
                  confidence:{' '}
                  <span className="font-mono">
                    {(Number(job.confidence) * 100).toFixed(1)}%
                  </span>
                </span>
              )}
              {!isTerminal && (
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  • обновляется автоматически
                </span>
              )}
            </div>

            {job.error && (
              <div className="error-banner text-sm">
                <div>
                  <p className="font-medium">Ошибка обработки</p>
                  <p className="mt-1 font-mono text-xs">{job.error}</p>
                </div>
              </div>
            )}

            {job.extracted && (
              <details open className="rounded-lg border border-slate-200 dark:border-slate-800">
                <summary className="cursor-pointer bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700 dark:bg-slate-900/40 dark:text-slate-300">
                  Извлечённые данные
                </summary>
                <pre className="max-h-96 overflow-auto bg-slate-50 p-3 font-mono text-xs text-slate-800 dark:bg-slate-950 dark:text-slate-200">
                  {JSON.stringify(job.extracted, null, 2)}
                </pre>
              </details>
            )}

            {job.last_llm_call && (
              <details className="rounded-lg border border-slate-200 dark:border-slate-800">
                <summary className="cursor-pointer bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700 dark:bg-slate-900/40 dark:text-slate-300">
                  LLM-call ({job.last_llm_call.backend} / {job.last_llm_call.model})
                </summary>
                <div className="space-y-2 p-3 text-xs">
                  <p className="text-slate-600 dark:text-slate-400">
                    duration: {job.last_llm_call.duration_ms ?? '?'} ms · prompt:{' '}
                    {job.last_llm_call.prompt_tokens ?? '?'} tokens · output:{' '}
                    {job.last_llm_call.output_tokens ?? '?'} tokens
                  </p>
                  {job.last_llm_call.raw_response && (
                    <pre className="max-h-48 overflow-auto rounded bg-slate-50 p-2 font-mono dark:bg-slate-950">
                      {job.last_llm_call.raw_response.slice(0, 4000)}
                    </pre>
                  )}
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </div>
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
      : 'badge-sky';
  return <span className={cls}>{status}</span>;
}

