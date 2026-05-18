import {
  useState,
  useCallback,
  useEffect,
  type DragEvent,
  type ChangeEvent,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useUploadJob } from '@/queries/jobs';
import { useDocumentTypes } from '@/queries/documentTypes';
import { formatFileSize, formatDateTime, shortId } from '@/lib/format';

/**
 * Upload page с drag-drop, bulk upload (до 3 параллельно по умолчанию)
 * и историей загрузок (localStorage, последние 20).
 *
 * Поведение:
 *   - drop zone принимает PDF/JPG/PNG/HEIC/BMP/TIFF/WebP
 *   - перед запуском показываем preview очереди с возможностью убрать файл
 *   - можно задать document_hint и webhook_url для ВСЕХ файлов в очереди
 *     (не per-file — упрощает UX, в 99% случаев батч однотипный)
 *   - после успешной загрузки добавляем в recent history с link'ом на детали
 */

const ACCEPT_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/bmp', 'image/tiff', 'image/webp'];
const ACCEPT_EXT = '.pdf,.jpg,.jpeg,.png,.heic,.heif,.bmp,.tif,.tiff,.webp';
const MAX_PARALLEL = 3;
const RECENT_KEY = 'parsdocs.v2.uploadRecent';
const RECENT_LIMIT = 20;

interface RecentEntry {
  jobId: string;
  fileName: string;
  size: number;
  documentHint?: string;
  uploadedAt: string;
}

interface QueueItem {
  id: string; // local UUID
  file: File;
  status: 'queued' | 'uploading' | 'done' | 'failed';
  jobId?: string;
  error?: string;
}

export default function UploadPage() {
  const navigate = useNavigate();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [documentHint, setDocumentHint] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [running, setRunning] = useState(false);

  const upload = useUploadJob();
  const { data: docTypes } = useDocumentTypes();

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (raw) setRecent(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  const addRecent = (entry: RecentEntry) => {
    setRecent((prev) => {
      const next = [entry, ...prev].slice(0, RECENT_LIMIT);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const addFilesToQueue = useCallback((files: FileList | File[]) => {
    const incoming = Array.from(files);
    setQueue((prev) => [
      ...prev,
      ...incoming.map((f) => ({
        id: crypto.randomUUID(),
        file: f,
        status: 'queued' as const,
      })),
    ]);
  }, []);

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFilesToQueue(e.dataTransfer.files);
    }
  };

  const onFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFilesToQueue(e.target.files);
      e.target.value = ''; // позволяет выбрать те же файлы повторно
    }
  };

  const removeFromQueue = (id: string) => {
    setQueue((prev) => prev.filter((q) => q.id !== id));
  };

  const clearDone = () => {
    setQueue((prev) => prev.filter((q) => q.status === 'queued' || q.status === 'uploading'));
  };

  /**
   * Запуск bulk-upload'а с ограниченным параллелизмом. Простой Promise.all
   * пулинг — берём первые MAX_PARALLEL queued, ждём первой завершившейся,
   * берём следующую.
   */
  const startUpload = async () => {
    setRunning(true);
    const queued = queue.filter((q) => q.status === 'queued');

    // Простая семафор-логика: pool из MAX_PARALLEL воркеров.
    const remaining = [...queued];
    const workers: Array<Promise<void>> = [];

    const doOne = async (): Promise<void> => {
      while (remaining.length > 0) {
        const item = remaining.shift();
        if (!item) return;
        setQueue((prev) =>
          prev.map((q) => (q.id === item.id ? { ...q, status: 'uploading' } : q)),
        );
        try {
          const res = await upload.mutateAsync({
            file: item.file,
            documentHint: documentHint || undefined,
            webhookUrl: webhookUrl || undefined,
          });
          setQueue((prev) =>
            prev.map((q) =>
              q.id === item.id ? { ...q, status: 'done', jobId: res.job_id } : q,
            ),
          );
          addRecent({
            jobId: res.job_id,
            fileName: item.file.name,
            size: item.file.size,
            documentHint: documentHint || undefined,
            uploadedAt: new Date().toISOString(),
          });
        } catch (err) {
          setQueue((prev) =>
            prev.map((q) =>
              q.id === item.id
                ? {
                    ...q,
                    status: 'failed',
                    error: err instanceof Error ? err.message : String(err),
                  }
                : q,
            ),
          );
        }
      }
    };

    for (let i = 0; i < MAX_PARALLEL; i += 1) workers.push(doOne());
    await Promise.all(workers);
    setRunning(false);

    // Если все ОК и был ровно один файл — переходим на job-detail
    const justUploaded = queue.length === 1 && queued.length === 1;
    if (justUploaded) {
      // hack: queue ещё не обновился в state синхронно, используем последний recent
      // — он будет добавлен последним
      setTimeout(() => {
        const last = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') as RecentEntry[];
        if (last[0]) navigate(`/jobs/${last[0].jobId}`);
      }, 100);
    }
  };

  const queuedCount = queue.filter((q) => q.status === 'queued').length;
  const uploadingCount = queue.filter((q) => q.status === 'uploading').length;
  const doneCount = queue.filter((q) => q.status === 'done').length;
  const failedCount = queue.filter((q) => q.status === 'failed').length;

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Загрузить документы</h1>

      {/* Drop zone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`relative rounded-xl border-2 border-dashed bg-white dark:bg-slate-900 p-10 text-center transition-colors ${
          dragOver
            ? 'border-brand-500 bg-brand-50'
            : 'border-slate-300 hover:border-slate-400'
        }`}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="mx-auto mb-3 h-12 w-12 text-slate-400 dark:text-slate-500"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3"
          />
        </svg>
        <p className="text-sm text-slate-600 dark:text-slate-400 dark:text-slate-500">
          Перетащите файлы сюда или{' '}
          <label className="cursor-pointer font-medium text-brand-600 dark:text-brand-400 hover:underline">
            выберите вручную
            <input
              type="file"
              multiple
              accept={ACCEPT_EXT}
              onChange={onFileInput}
              className="sr-only"
            />
          </label>
        </p>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          PDF, JPG, PNG, HEIC, BMP, TIFF, WebP — до 50 MB каждый
        </p>
      </div>

      {/* Options */}
      <div className="card">
        <div className="card-body grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="u-hint" className="form-label">
              Подсказка типа документа (опционально)
            </label>
            <select
              id="u-hint"
              className="form-select"
              value={documentHint}
              onChange={(e) => setDocumentHint(e.target.value)}
            >
              <option value="">Авто (классификатор сам определит)</option>
              {(docTypes?.items ?? []).map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.display_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="u-webhook" className="form-label">
              Webhook URL (опционально)
            </label>
            <input
              id="u-webhook"
              type="url"
              className="form-input font-mono text-xs"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://example.com/webhook"
            />
          </div>
        </div>
      </div>

      {/* Queue */}
      {queue.length > 0 && (
        <div className="card">
          <div className="card-header">
            <div className="flex items-center gap-3">
              <h3 className="card-title">Очередь</h3>
              <div className="flex gap-2 text-xs">
                {queuedCount > 0 && <span className="badge-slate">{queuedCount} ждут</span>}
                {uploadingCount > 0 && (
                  <span className="badge-sky">{uploadingCount} грузятся</span>
                )}
                {doneCount > 0 && (
                  <span className="badge-emerald">{doneCount} готово</span>
                )}
                {failedCount > 0 && (
                  <span className="badge-rose">{failedCount} ошибок</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {(doneCount > 0 || failedCount > 0) && !running && (
                <button type="button" className="btn-ghost" onClick={clearDone}>
                  Очистить
                </button>
              )}
              <button
                type="button"
                className="btn-primary"
                disabled={running || queuedCount === 0}
                onClick={startUpload}
              >
                {running ? 'Загружаю…' : `Загрузить ${queuedCount}`}
              </button>
            </div>
          </div>
          <div className="card-body space-y-2">
            {queue.map((q) => (
              <QueueRow key={q.id} item={q} onRemove={removeFromQueue} />
            ))}
          </div>
        </div>
      )}

      {/* Recent uploads */}
      {recent.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Недавние загрузки</h3>
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => {
                localStorage.removeItem(RECENT_KEY);
                setRecent([]);
              }}
            >
              Очистить историю
            </button>
          </div>
          <div className="card-body p-0">
            <table className="min-w-full text-sm">
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {recent.map((r) => (
                  <tr key={r.jobId} className="hover:bg-slate-50 dark:bg-slate-900/40">
                    <td className="px-5 py-2">
                      <Link
                        to={`/jobs/${r.jobId}`}
                        className="font-medium text-slate-900 dark:text-slate-100 hover:underline"
                      >
                        {r.fileName}
                      </Link>
                    </td>
                    <td className="px-5 py-2 text-right text-slate-500 dark:text-slate-400 dark:text-slate-500">
                      {formatFileSize(r.size)}
                    </td>
                    <td className="px-5 py-2">
                      {r.documentHint && (
                        <span className="badge-indigo">{r.documentHint}</span>
                      )}
                    </td>
                    <td className="px-5 py-2 text-right font-mono text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">
                      {formatDateTime(r.uploadedAt)}
                    </td>
                    <td className="px-5 py-2 text-right">
                      <Link
                        to={`/jobs/${r.jobId}`}
                        className="font-mono text-xs text-brand-600 dark:text-brand-400 hover:underline"
                      >
                        {shortId(r.jobId)}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function QueueRow({
  item,
  onRemove,
}: {
  item: QueueItem;
  onRemove: (id: string) => void;
}) {
  const statusInfo =
    item.status === 'done'
      ? { label: '✓ загружен', cls: 'text-emerald-700 dark:text-emerald-300' }
      : item.status === 'failed'
      ? { label: '✕ ошибка', cls: 'text-rose-700 dark:text-rose-300' }
      : item.status === 'uploading'
      ? { label: '⟳ грузится…', cls: 'text-sky-700' }
      : { label: 'в очереди', cls: 'text-slate-500 dark:text-slate-400 dark:text-slate-500' };

  return (
    <div className="flex items-center gap-3 rounded-lg bg-slate-50 dark:bg-slate-900/40 px-3 py-2 text-sm">
      <span className="flex-1 truncate">
        <FileIcon mime={item.file.type} className="mr-2 inline h-4 w-4 text-slate-400 dark:text-slate-500" />
        {item.file.name}
      </span>
      <span className="font-mono text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">{formatFileSize(item.file.size)}</span>
      <span className={`text-xs ${statusInfo.cls}`}>{statusInfo.label}</span>
      {item.jobId && (
        <Link
          to={`/jobs/${item.jobId}`}
          className="font-mono text-xs text-brand-600 dark:text-brand-400 hover:underline"
        >
          {shortId(item.jobId)}
        </Link>
      )}
      {item.error && (
        <span className="max-w-[200px] truncate text-xs text-rose-600" title={item.error}>
          {item.error}
        </span>
      )}
      {item.status === 'queued' && (
        <button
          type="button"
          className="text-slate-400 dark:text-slate-500 hover:text-rose-600"
          onClick={() => onRemove(item.id)}
          aria-label="Убрать из очереди"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function FileIcon({ mime, className }: { mime: string; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      {mime.includes('pdf') ? (
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      ) : (
        <path
          fillRule="evenodd"
          d="M1.5 6a2.25 2.25 0 0 1 2.25-2.25h16.5A2.25 2.25 0 0 1 22.5 6v12a2.25 2.25 0 0 1-2.25 2.25H3.75A2.25 2.25 0 0 1 1.5 18V6ZM3 16.06l3.97-3.97a.75.75 0 0 1 1.06 0l4.03 4.03 1.97-1.97a.75.75 0 0 1 1.06 0l3.91 3.91v.94a.75.75 0 0 1-.75.75H3.75A.75.75 0 0 1 3 18.94v-2.88Z"
          clipRule="evenodd"
        />
      )}
    </svg>
  );
}

// silence ts: ACCEPT_MIME используется только концептуально (validation на backend'е)
export const _internal = { ACCEPT_MIME };
