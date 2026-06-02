import { useEffect, useCallback } from 'react';
import { useJobRawText } from '@/queries/jobs';

/**
 * F11/F21 — просмотр и скачивание сырого OCR-текста (то, что распознал
 * движок ДО LLM-структурирования). Полезно при разборе расхождений: видно,
 * что именно «прочитал» документ. Загружается по требованию (модал открыт).
 */
interface Props {
  jobId: string;
  fileName?: string | null;
  onClose: () => void;
}

export default function RawTextModal({ jobId, fileName, onClose }: Props) {
  const { data, isLoading, error } = useJobRawText(jobId, true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleDownload = useCallback(() => {
    if (!data) return;
    const blob = new Blob([data], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const base = fileName?.replace(/\.[^.]+$/, '') || jobId;
    a.download = `${base}.raw.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [data, fileName, jobId]);

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="card flex max-h-[90vh] w-full max-w-3xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header flex items-center justify-between">
          <h3 className="card-title">Сырой OCR-текст</h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={handleDownload}
              disabled={!data}
              title="Скачать .txt"
            >
              ↓ .txt
            </button>
            <button type="button" className="btn-ghost" onClick={onClose} aria-label="Закрыть">
              ✕
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-5">
          {isLoading ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Загрузка текста…</p>
          ) : error ? (
            <div className="error-banner">
              <span className="font-medium">Нет текста:</span>{' '}
              {error instanceof Error ? error.message : 'не удалось загрузить raw_text'}
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-5 text-slate-800 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-200">
              {data}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
