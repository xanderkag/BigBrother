import { useState } from 'react';
import { useJobSheets } from '@/queries/jobs';
import { ApiError } from '@/lib/api';

/**
 * Превью Excel-книги на детальной странице job'а. Данные приходят гридом
 * с backend'а (GET /jobs/:id/sheets) — SheetJS в UI не тащим. Заменяет
 * битый <img>-fallback PdfViewer'а для xlsx/xls (там MIME не pdf и не
 * картинка, поэтому браузер рисовал сломанное изображение).
 *
 * Формы ответа:
 *   200 — { file_name, sheets[] } (см. useJobSheets)
 *   400 — не таблица (не должно случиться: тип проверен в JobDetail)
 *   410 — файл удалён по retention
 *   422 — битый файл
 */
interface Props {
  jobId: string;
}

export default function SheetViewer({ jobId }: Props) {
  const { data, isLoading, error } = useJobSheets(jobId, true);
  const [active, setActive] = useState(0);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        Загрузка таблицы…
      </div>
    );
  }

  if (error) {
    const status = error instanceof ApiError ? error.status : 0;
    // 400 не показываем как ошибку — тип проверен в JobDetail, сюда не
    // должны попасть. Но если попали — не рисуем сырой JSON, просто заглушка.
    const message =
      status === 410
        ? 'Файл удалён по истечении срока хранения'
        : status === 422
        ? 'Не удалось прочитать файл'
        : 'Не удалось загрузить таблицу';
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md text-center text-sm text-slate-600 dark:text-slate-300">
          {message}
        </div>
      </div>
    );
  }

  const sheets = data?.sheets ?? [];
  if (sheets.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        В книге нет листов
      </div>
    );
  }

  const idx = Math.min(active, sheets.length - 1);
  const sheet = sheets[idx];
  const rows = sheet.rows;
  const headerRow = rows.length > 0 ? rows[0] : [];
  const bodyRows = rows.length > 1 ? rows.slice(1) : [];

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-slate-100 dark:bg-slate-800">
      {sheets.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
          {sheets.map((s, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setActive(i)}
              className={`shrink-0 rounded px-2.5 py-1 text-xs ${
                i === idx
                  ? 'bg-brand-600 text-white'
                  : 'text-slate-700 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-700'
              }`}
              title={s.name}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {sheet.truncated && (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-500/10 dark:text-amber-200">
          Показаны первые {rows.length} строк из {sheet.totalRows}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-500 dark:text-slate-400">
            Лист пуст
          </div>
        ) : (
          <table className="border-collapse text-xs text-slate-800 dark:text-slate-200">
            <thead>
              <tr>
                {headerRow.map((cell, c) => (
                  <th
                    key={c}
                    className="whitespace-nowrap border border-slate-300 bg-slate-200 px-2 py-1 text-left font-medium dark:border-slate-700 dark:bg-slate-700/60"
                  >
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, r) => (
                <tr key={r} className="odd:bg-white even:bg-slate-50 dark:odd:bg-slate-900 dark:even:bg-slate-900/40">
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      className="whitespace-nowrap border border-slate-200 px-2 py-1 dark:border-slate-800"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
