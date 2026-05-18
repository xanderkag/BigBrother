import { useEffect, useState, useCallback, useRef } from 'react';
import { Document, Page } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

/**
 * PDF viewer на react-pdf (pdfjs-dist под капотом). В отличие от
 * native <iframe>, мы рисуем страницы в <canvas> и полностью
 * контролируем хром — никаких лишних thumbnail-стрипов и тулбаров,
 * как у браузерного PDF viewer'а. Это устраняет основную жалобу UX.
 *
 * Particulars:
 *   - file: Object URL (blob URL) — освобождение URL'а на стороне
 *     парента через useJobFile cleanup'е.
 *   - width: подгоняется под container width через ResizeObserver +
 *     useRef, чтобы PDF масштабировался под колонку.
 *   - Page nav: если многостраничный — компактный counter + arrows
 *     внизу. Если одностраничный — никаких лишних элементов.
 *   - Image fallback: если MIME не application/pdf, показываем как <img>.
 */
interface PdfViewerProps {
  fileUrl: string;
  mimeType: string;
}

export default function PdfViewer({ fileUrl, mimeType }: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(800);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1);

  // ResizeObserver — пересчитываем target width при ресайзе.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w > 0) setContainerWidth(w - 32); // padding margin
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onLoadSuccess = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
    setPageNumber(1);
  }, []);

  // image fallback
  if (mimeType && !mimeType.includes('pdf')) {
    return (
      <div
        ref={containerRef}
        className="flex h-full w-full flex-col items-center justify-start overflow-auto bg-slate-100 dark:bg-slate-800 p-4"
      >
        <img
          src={fileUrl}
          alt="Document preview"
          className="max-w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm"
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full flex-col overflow-hidden bg-slate-100 dark:bg-slate-800"
    >
      <div className="flex-1 overflow-auto p-4">
        <Document
          file={fileUrl}
          onLoadSuccess={onLoadSuccess}
          loading={<div className="p-6 text-sm text-slate-500 dark:text-slate-400 dark:text-slate-500">Загрузка PDF…</div>}
          error={
            <div className="error-banner m-4">
              Не удалось загрузить PDF. Попробуйте обновить страницу.
            </div>
          }
        >
          <Page
            pageNumber={pageNumber}
            width={containerWidth * scale}
            renderTextLayer={true}
            renderAnnotationLayer={true}
            loading={
              <div className="flex h-96 items-center justify-center text-sm text-slate-500 dark:text-slate-400 dark:text-slate-500">
                Рендеринг страницы…
              </div>
            }
          />
        </Document>
      </div>

      {/* Bottom toolbar — sticky над content'ом. */}
      <div className="flex shrink-0 items-center justify-between border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-2 text-sm">
        <div className="flex items-center gap-2">
          {numPages && numPages > 1 && (
            <>
              <button
                type="button"
                className="btn-ghost h-8 px-2"
                onClick={() => setPageNumber((n) => Math.max(1, n - 1))}
                disabled={pageNumber <= 1}
                aria-label="Предыдущая страница"
              >
                ←
              </button>
              <span className="font-mono text-slate-700 dark:text-slate-300">
                {pageNumber} / {numPages}
              </span>
              <button
                type="button"
                className="btn-ghost h-8 px-2"
                onClick={() => setPageNumber((n) => Math.min(numPages, n + 1))}
                disabled={pageNumber >= numPages}
                aria-label="Следующая страница"
              >
                →
              </button>
            </>
          )}
          {numPages === 1 && <span className="text-slate-500 dark:text-slate-400 dark:text-slate-500">1 страница</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-ghost h-8 px-2"
            onClick={() => setScale((s) => Math.max(0.5, s - 0.1))}
            disabled={scale <= 0.5}
            aria-label="Уменьшить"
          >
            −
          </button>
          <span className="font-mono w-12 text-center text-slate-700 dark:text-slate-300">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className="btn-ghost h-8 px-2"
            onClick={() => setScale((s) => Math.min(3, s + 0.1))}
            disabled={scale >= 3}
            aria-label="Увеличить"
          >
            +
          </button>
          <button
            type="button"
            className="btn-ghost h-8 px-2"
            onClick={() => setScale(1)}
            aria-label="Сбросить масштаб"
          >
            100%
          </button>
        </div>
      </div>
    </div>
  );
}
