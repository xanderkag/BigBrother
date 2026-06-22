import { useDocumentTypeSchema } from '@/queries/documentTypes';
import { parseSchemaFields, type FieldKind, type FieldSpec } from '@/lib/schema-fields';
import { SkeletonBlock } from '@/components/Skeleton';

/**
 * Read-only каталог «Что извлекаем» — из ЖИВОЙ эффективной схемы типа
 * (`GET /document-types/:slug/schema`, admin-override ?? builtin fallback).
 * Парсинг — общий `parseSchemaFields`; здесь только отображение.
 *
 * Для каждого поля: техническое имя (путь), русское название, «что значит»
 * (description из схемы — не выдумываем) и бейдж типа значения по-русски.
 * Вложенность: object → children с отступом, array-objects → колонки строки.
 */

const KIND_BADGE: Record<FieldKind, { label: string; cls: string }> = {
  string: { label: 'текст', cls: 'badge-slate' },
  number: { label: 'число', cls: 'badge-sky' },
  integer: { label: 'число', cls: 'badge-sky' },
  date: { label: 'дата', cls: 'badge-indigo' },
  boolean: { label: 'да/нет', cls: 'badge-emerald' },
  object: { label: 'блок', cls: 'badge-amber' },
  'array-objects': { label: 'таблица', cls: 'badge-amber' },
  'array-strings': { label: 'список', cls: 'badge-slate' },
  unknown: { label: '—', cls: 'badge-slate' },
};

function FieldRow({
  spec,
  path,
  depth,
}: {
  spec: FieldSpec;
  /** Полный путь к ключу: 'seller.inn', для колонок строки — 'items[].qty'. */
  path: string;
  depth: number;
}) {
  const badge = KIND_BADGE[spec.kind];
  return (
    <div
      className="border-t border-slate-100 px-4 py-2.5 first:border-t-0 dark:border-slate-800/60"
      style={depth > 0 ? { paddingLeft: `${1 + depth * 1.25}rem` } : undefined}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <code className="font-mono text-xs text-slate-500 dark:text-slate-400">{path}</code>
        <span className="font-medium text-slate-900 dark:text-slate-100">{spec.label}</span>
        <span className={`${badge.cls} ml-auto shrink-0`}>{badge.label}</span>
      </div>
      {spec.description && (
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{spec.description}</p>
      )}
    </div>
  );
}

function FieldTree({
  spec,
  parentPath,
  depth,
}: {
  spec: FieldSpec;
  parentPath: string;
  depth: number;
}) {
  const path = parentPath ? `${parentPath}.${spec.key}` : spec.key;
  return (
    <>
      <FieldRow spec={spec} path={path} depth={depth} />
      {spec.kind === 'object' &&
        spec.children?.map((child) => (
          <FieldTree key={child.key} spec={child} parentPath={path} depth={depth + 1} />
        ))}
      {spec.kind === 'array-objects' &&
        spec.itemFields?.map((col) => (
          <FieldTree key={col.key} spec={col} parentPath={`${path}[]`} depth={depth + 1} />
        ))}
    </>
  );
}

export default function ExtractionCatalog({ slug }: { slug: string }) {
  const { data, isLoading, error } = useDocumentTypeSchema(slug);

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[1, 2, 3, 4, 5].map((i) => (
          <SkeletonBlock key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="error-banner">
          <span className="font-medium">Не удалось загрузить схему:</span>{' '}
          {error instanceof Error ? error.message : String(error)}
        </div>
      </div>
    );
  }

  const fields = parseSchemaFields(data?.schema);

  if (fields.length === 0) {
    return (
      <div className="p-8 text-center">
        <p className="font-medium text-slate-700 dark:text-slate-300">
          Для этого типа схема не задана
        </p>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Поля распознаются автоматически из самого документа.
        </p>
      </div>
    );
  }

  return (
    <div>
      {fields.map((spec) => (
        <FieldTree key={spec.key} spec={spec} parentPath="" depth={0} />
      ))}
    </div>
  );
}
