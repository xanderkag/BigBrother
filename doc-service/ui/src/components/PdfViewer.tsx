import {
  useEffect,
  useState,
  useCallback,
  useRef,
  forwardRef,
  useImperativeHandle,
} from 'react';
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

/**
 * F5 — императивный хэндл для управления вьюером с клавиатуры (JobDetail
 * вешает `[`/`]` на страницы и `+`/`-` на зум). Сами кнопки в тулбаре
 * остаются — это просто второй способ дёрнуть те же сеттеры.
 */
export interface PdfViewerHandle {
  prevPage: () => void;
  nextPage: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  rotateCw: () => void;
  rotateCcw: () => void;
}

const PdfViewer = forwardRef<PdfViewerHandle, PdfViewerProps>(function PdfViewer(
  { fileUrl, mimeType },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(800);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1);
  // §9 polish: поворот (для криво сканированных). Кратен 90°, общий для
  // всех страниц — скан обычно перекошен целиком, не по одной странице.
  const [rotation, setRotation] = useState<number>(0);

  useImperativeHandle(
    ref,
    () => ({
      prevPage: () => setPageNumber((n) => Math.max(1, n - 1)),
      nextPage: () => setPageNumber((n) => (numPages ? Math.min(numPages, n + 1) : n)),
      zoomIn: () => setScale((s) => Math.min(3, s + 0.1)),
      zoomOut: () => setScale((s) => Math.max(0.5, s - 0.1)),
      resetZoom: () => setScale(1),
      rotateCw: () => setRotation((r) => (r + 90) % 360),
      rotateCcw: () => setRotation((r) => (r + 270) % 360),
    }),
    [numPages],
  );

  // ResizeObserver — пересчитываем target width при ресайзе.
  // Важно: измеряем ТОЛЬКО внешний контейнер (overflow-hidden, w-full),
  // ширина которого не зависит от ширины отрисованной страницы. Плюс
  // guard на изменение ≥1px — иначе sub-pixel дрожание гоняет ре-рендеры
  // и роняет «ResizeObserver loop completed with undelivered notifications».
  const lastWidthRef = useRef<number>(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const next = el.clientWidth - 32; // padding margin
      if (next > 0 && Math.abs(next - lastWidthRef.current) >= 1) {
        lastWidthRef.current = next;
        setContainerWidth(next);
      }
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
        className="relative flex h-full w-full flex-col items-center justify-start overflow-auto bg-slate-100 dark:bg-slate-800 p-4"
      >
        <img
          src={fileUrl}
          alt="Document preview"
          className="max-w-full rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm transition-transform"
          style={{ transform: `rotate(${rotation}deg)` }}
        />
        {/* §9 polish: поворот для криво сканированных картинок. */}
        <div className="absolute right-3 top-3 flex items-center gap-1 rounded-lg border border-slate-200 bg-white/90 p-1 shadow-sm dark:border-slate-800 dark:bg-slate-900/90">
          <button
            type="button"
            className="btn-ghost h-8 px-2"
            onClick={() => setRotation((r) => (r + 270) % 360)}
            aria-label="Повернуть против часовой"
            title="Повернуть против часовой"
          >
            ↺
          </button>
          <button
            type="button"
            className="btn-ghost h-8 px-2"
            onClick={() => setRotation((r) => (r + 90) % 360)}
            aria-label="Повернуть по часовой"
            title="Повернуть по часовой (R)"
          >
            ↻
          </button>
        </div>
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
            rotate={rotation}
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
          {/* §9 polish: поворот для криво сканированных PDF. */}
          <span className="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700" />
          <button
            type="button"
            className="btn-ghost h-8 px-2"
            onClick={() => setRotation((r) => (r + 270) % 360)}
            aria-label="Повернуть против часовой"
            title="Повернуть против часовой"
          >
            ↺
          </button>
          <button
            type="button"
            className="btn-ghost h-8 px-2"
            onClick={() => setRotation((r) => (r + 90) % 360)}
            aria-label="Повернуть по часовой"
            title="Повернуть по часовой (R)"
          >
            ↻
          </button>
        </div>
      </div>
    </div>
  );
});

export default PdfViewer;
