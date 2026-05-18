/**
 * Унифицированные skeleton-плейсхолдеры для states загрузки.
 *
 * Используем animate-pulse от Tailwind, base-цвет slate-200 в light /
 * slate-800 в dark. Меньше отвлекает чем «Загрузка…» текстом и даёт
 * пользователю представление о том «куда смотреть» когда контент
 * приедет.
 *
 * Принцип: skeleton должен внешне напоминать реальный контент по
 * size + расположению, а не быть универсальной серой полоской.
 * Поэтому делаем 3 узкоспециализированных компонента вместо одного
 * generic.
 */
import type { ReactNode } from 'react';

/** Стандартный «пульсирующий» прямоугольник. */
export function SkeletonBlock({
  className = '',
}: {
  className?: string;
}) {
  return (
    <div
      className={`animate-pulse rounded bg-slate-200 dark:bg-slate-800 ${className}`}
    />
  );
}

/**
 * Skeleton для таблицы: header + N строк по M колонок. Имитирует
 * реальную data-table структуру с правильной шириной и spacing.
 */
export function SkeletonTable({
  rows = 6,
  columns = 5,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/40">
            <tr>
              {Array.from({ length: columns }).map((_, i) => (
                <th key={i} className="px-4 py-2">
                  <SkeletonBlock className="h-3 w-16" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {Array.from({ length: rows }).map((_, i) => (
              <tr key={i}>
                {Array.from({ length: columns }).map((_, j) => (
                  <td key={j} className="px-4 py-3">
                    <SkeletonBlock
                      className={`h-3 ${
                        j === 0 ? 'w-16' : j === columns - 1 ? 'w-20' : 'w-32'
                      }`}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Skeleton для grid карточек метрик (Dashboard).
 */
export function SkeletonCardGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card">
          <div className="card-body space-y-3">
            <SkeletonBlock className="h-3 w-24" />
            <SkeletonBlock className="h-8 w-20" />
            <SkeletonBlock className="h-2 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Унифицированный empty state с иконкой, заголовком, описанием и опц. CTA.
 * Используется когда query вернул пустой список — даёт юзеру следующий
 * шаг вместо тупика «здесь ничего нет».
 */
export function EmptyState({
  title,
  description,
  icon,
  cta,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  cta?: ReactNode;
}) {
  return (
    <div className="card">
      <div className="card-body flex flex-col items-center gap-3 py-12 text-center">
        {icon && (
          <div className="text-slate-300 dark:text-slate-600">{icon}</div>
        )}
        <p className="text-base font-medium text-slate-700 dark:text-slate-300">
          {title}
        </p>
        {description && (
          <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
            {description}
          </p>
        )}
        {cta && <div className="mt-2">{cta}</div>}
      </div>
    </div>
  );
}
