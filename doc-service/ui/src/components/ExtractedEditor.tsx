import { useState, useEffect, useCallback, useMemo } from 'react';
import { useUpdateExtracted } from '@/queries/jobs';
import { useDocumentTypeSchema } from '@/queries/documentTypes';
import {
  type FieldKind,
  type FieldSpec,
  parseSchemaFields,
  mergeSchemaWithValue,
  setByPath,
} from '@/lib/schema-fields';
import { confidenceBorderClass, HUMAN_VERIFIED } from '@/lib/confidence';

/**
 * F2 — schema-driven редактор `extracted`.
 *
 * Источник полей — эффективная схема типа (`GET /document-types/:slug/schema`,
 * admin-override ?? встроенный fallback), объединённая с фактически
 * распознанными ключами (`mergeSchemaWithValue`): сначала ожидаемые поля
 * схемы (видны даже пустые), затем «лишние» распознанные. Незнакомый тип
 * (схемы нет) → форма по фактическим полям. Сырой JSON остаётся как
 * отладочный переключатель.
 *
 * Правка поля → его `_field_confidence[path] = 1.0` (HUMAN_VERIFIED):
 * человек проверил значение глазами, дальше оно подсвечивается как «норма».
 *
 * Две кнопки сохранения (§8.1):
 *   «Сохранить» → PATCH `?keep_status=true` — правки пишутся, статус
 *     остаётся needs_review (правка ≠ одобрение);
 *   «Одобрить»  → PATCH без флага — правки пишутся, статус → done.
 *
 * F3 dirty-guard сохранён: закрытие при несохранённых правках спрашивает
 * подтверждение (крестик / Отмена / Esc / клик по фону / уход со страницы).
 */
interface Props {
  jobId: string;
  initial: Record<string, unknown> | null;
  /** slug типа документа — для подгрузки схемы полей. */
  documentType?: string | null;
  onClose: () => void;
  onSaved?: () => void;
}

/** Пустое значение по kind — для новой строки таблицы / нового поля. */
function emptyFor(kind: FieldKind): unknown {
  switch (kind) {
    case 'boolean':
      return false;
    case 'number':
    case 'integer':
      return null;
    case 'object':
      return {};
    case 'array-objects':
    case 'array-strings':
      return [];
    default:
      return '';
  }
}

export default function ExtractedEditor({
  jobId,
  initial,
  documentType,
  onClose,
  onSaved,
}: Props) {
  // value — рабочая копия extracted (включая _field_confidence и прочие
  // служебные ключи, чтобы они round-trip'нулись в PATCH; _issues бэкенд
  // перестроит сам, поэтому его выбрасываем).
  const [value, setValue] = useState<Record<string, unknown>>({});
  const [pristine, setPristine] = useState('{}');
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const update = useUpdateExtracted();
  const { data: schemaResp } = useDocumentTypeSchema(documentType ?? undefined);

  useEffect(() => {
    const base = initial ? { ...initial } : {};
    delete base._issues; // бэкенд пере-валидирует и перестроит
    setValue(base);
    setPristine(JSON.stringify(base));
  }, [initial]);

  const dirty = JSON.stringify(value) !== pristine;

  const schemaFields = useMemo(
    () => parseSchemaFields(schemaResp?.schema),
    [schemaResp],
  );
  const fields = useMemo(
    () => mergeSchemaWithValue(schemaFields, value),
    [schemaFields, value],
  );
  const fieldConfidence = value._field_confidence as
    | Record<string, number>
    | undefined;

  /** Правка значения поля → setByPath + пометка _field_confidence[path]=1.0. */
  const handleFieldChange = useCallback((path: string, next: unknown) => {
    setValue((prev) => {
      const updated = setByPath(prev, path, next);
      const fcPrev =
        (updated._field_confidence as Record<string, number> | undefined) ?? {};
      return { ...updated, _field_confidence: { ...fcPrev, [path]: HUMAN_VERIFIED } };
    });
  }, []);

  /** Структурная правка массива (add/remove строки) — без отметки confidence. */
  const handleArrayChange = useCallback((path: string, next: unknown[]) => {
    setValue((prev) => setByPath(prev, path, next));
  }, []);

  /* ----------------------------- JSON-режим ---------------------------- */
  const switchToJson = () => {
    setJsonText(JSON.stringify(value, null, 2));
    setJsonError(null);
    setMode('json');
  };
  const onJsonChange = (t: string) => {
    setJsonText(t);
    try {
      const parsed = JSON.parse(t);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setJsonError('extracted должен быть JSON-объектом');
        return;
      }
      setJsonError(null);
      setValue(parsed as Record<string, unknown>);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : 'некорректный JSON');
    }
  };

  /* ------------------------------ закрытие ----------------------------- */
  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('Есть несохранённые изменения. Закрыть без сохранения?')) {
      return;
    }
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  /* ----------------------------- сохранение ---------------------------- */
  const doSave = async (keepStatus: boolean) => {
    setSaveError(null);
    if (mode === 'json' && jsonError) {
      setSaveError(`Исправьте JSON: ${jsonError}`);
      return;
    }
    const { _issues, ...payload } = value; // _issues перестроит бэкенд
    void _issues;
    try {
      await update.mutateAsync({ jobId, extracted: payload, keepStatus });
      onSaved?.();
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const busy = update.isPending;

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={requestClose}
    >
      <div
        className="card flex max-h-[92vh] w-full max-w-3xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header flex items-center justify-between">
          <h3 className="card-title">
            Редактировать данные
            {documentType && (
              <span className="ml-2 align-middle badge-indigo">{documentType}</span>
            )}
            {dirty && (
              <span
                className="ml-2 align-middle text-xs font-normal text-amber-600 dark:text-amber-400"
                title="Есть несохранённые изменения"
              >
                • не сохранено
              </span>
            )}
          </h3>
          <div className="flex items-center gap-2">
            {/* Форма / JSON переключатель — JSON для отладки */}
            <div className="flex overflow-hidden rounded-lg border border-slate-200 text-xs dark:border-slate-700">
              <button
                type="button"
                className={`px-2.5 py-1 ${
                  mode === 'form'
                    ? 'bg-brand-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
                onClick={() => setMode('form')}
              >
                Форма
              </button>
              <button
                type="button"
                className={`px-2.5 py-1 ${
                  mode === 'json'
                    ? 'bg-brand-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}
                onClick={switchToJson}
              >
                JSON
              </button>
            </div>
            <button
              type="button"
              className="btn-ghost"
              onClick={requestClose}
              aria-label="Закрыть"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {mode === 'form' ? (
            fields.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Нет распознанных полей. Переключитесь в режим JSON, чтобы
                заполнить данные вручную.
              </p>
            ) : (
              <div className="space-y-3">
                {fields.map((spec) => (
                  <FieldNode
                    key={spec.key}
                    spec={spec}
                    path={spec.key}
                    value={value[spec.key]}
                    fc={fieldConfidence}
                    onChange={handleFieldChange}
                    onArrayChange={handleArrayChange}
                  />
                ))}
              </div>
            )
          ) : (
            <>
              <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
                Режим отладки — правка <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">extracted</code> как
                есть. Для обычной работы используйте «Форму».
              </p>
              <textarea
                value={jsonText}
                onChange={(e) => onJsonChange(e.target.value)}
                className="form-textarea h-[55vh] w-full resize-none font-mono text-xs leading-5"
                spellCheck={false}
              />
              {jsonError && (
                <div className="error-banner mt-2">
                  <span className="font-medium">JSON:</span> {jsonError}
                </div>
              )}
            </>
          )}
          {saveError && (
            <div className="error-banner mt-3">
              <span className="font-medium">Ошибка сохранения:</span> {saveError}
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-800 dark:bg-slate-900/40">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            «Сохранить» оставит статус <span className="badge-amber">needs_review</span>,
            «Одобрить» переведёт в <span className="badge-emerald">done</span>.
          </p>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-ghost" onClick={requestClose}>
              Отмена
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => doSave(true)}
            >
              {busy ? 'Сохраняю…' : 'Сохранить'}
            </button>
            <button
              type="button"
              className="btn-success"
              disabled={busy}
              onClick={() => doSave(false)}
            >
              {busy ? '…' : 'Одобрить ✓'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Field renderers                                                    */
/* ------------------------------------------------------------------ */

/** Виджет ввода примитива (string / number / date / boolean) + цвет границы. */
function ValueInput({
  kind,
  value,
  conf,
  onChange,
  ariaLabel,
  compact,
}: {
  kind: FieldKind;
  value: unknown;
  conf?: number;
  onChange: (v: unknown) => void;
  ariaLabel: string;
  compact?: boolean;
}) {
  const border = confidenceBorderClass(conf);
  const cls = `form-input ${compact ? 'px-2 py-1 text-xs' : ''} ${border}`;

  if (kind === 'boolean') {
    return (
      <input
        type="checkbox"
        aria-label={ariaLabel}
        checked={value === true}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-900"
      />
    );
  }

  if (kind === 'number' || kind === 'integer') {
    return (
      <input
        type="number"
        aria-label={ariaLabel}
        className={cls}
        value={value == null ? '' : String(value)}
        onChange={(e) => {
          const t = e.target.value;
          onChange(t === '' ? null : Number(t));
        }}
      />
    );
  }

  if (kind === 'date') {
    const s = typeof value === 'string' ? value : value == null ? '' : String(value);
    // Нативный date-picker только для ISO (YYYY-MM-DD); иные форматы
    // (01.02.2026 и т.п.) правим текстом, чтобы не потерять значение.
    const iso = s === '' || /^\d{4}-\d{2}-\d{2}$/.test(s);
    return (
      <input
        type={iso ? 'date' : 'text'}
        aria-label={ariaLabel}
        className={cls}
        value={s}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  // object / array / unknown в ячейке таблицы — read-only сводка
  // (вложенное правится через режим JSON).
  if (kind === 'object' || kind === 'array-objects' || kind === 'array-strings') {
    let text = '—';
    try {
      text = value == null ? '—' : JSON.stringify(value);
    } catch {
      text = '—';
    }
    return (
      <span
        className="block truncate rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-500 dark:border-slate-700 dark:text-slate-400"
        title="Вложенные данные — правьте через режим JSON"
      >
        {text}
      </span>
    );
  }

  // string / unknown
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  return (
    <input
      type="text"
      aria-label={ariaLabel}
      className={cls}
      value={s}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function FieldNode({
  spec,
  path,
  value,
  fc,
  onChange,
  onArrayChange,
}: {
  spec: FieldSpec;
  path: string;
  value: unknown;
  fc?: Record<string, number>;
  onChange: (path: string, v: unknown) => void;
  onArrayChange: (path: string, arr: unknown[]) => void;
}) {
  const conf = fc?.[path];

  // object — вложенная группа.
  if (spec.kind === 'object') {
    const obj =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const children = spec.children ?? [];
    return (
      <fieldset className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
        <legend className="px-1 text-xs font-medium text-slate-600 dark:text-slate-300">
          {spec.label}
        </legend>
        {children.length === 0 ? (
          <p className="text-xs text-slate-400">Нет полей</p>
        ) : (
          <div className="space-y-2">
            {children.map((c) => (
              <FieldNode
                key={c.key}
                spec={c}
                path={`${path}.${c.key}`}
                value={obj[c.key]}
                fc={fc}
                onChange={onChange}
                onArrayChange={onArrayChange}
              />
            ))}
          </div>
        )}
      </fieldset>
    );
  }

  // array-objects — редактируемая таблица позиций.
  if (spec.kind === 'array-objects') {
    const arr = Array.isArray(value) ? value : [];
    const cols = spec.itemFields ?? [];
    const addRow = () => {
      const row: Record<string, unknown> = {};
      for (const c of cols) row[c.key] = emptyFor(c.kind);
      onArrayChange(path, [...arr, row]);
    };
    return (
      <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
            {spec.label}{' '}
            <span className="text-slate-400">({arr.length})</span>
          </span>
          <button type="button" className="btn-ghost px-2 py-0.5 text-xs" onClick={addRow}>
            + строка
          </button>
        </div>
        {arr.length === 0 ? (
          <p className="text-xs text-slate-400">Нет позиций</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-left text-slate-500 dark:text-slate-400">
                  {cols.map((c) => (
                    <th key={c.key} className="px-1 pb-1 font-medium" title={c.description}>
                      {c.label}
                    </th>
                  ))}
                  <th className="w-6" />
                </tr>
              </thead>
              <tbody>
                {arr.map((row, i) => {
                  const rowObj =
                    row && typeof row === 'object' && !Array.isArray(row)
                      ? (row as Record<string, unknown>)
                      : {};
                  return (
                    <tr key={i} className="align-top">
                      {cols.map((c) => {
                        const cellPath = `${path}.${i}.${c.key}`;
                        return (
                          <td key={c.key} className="p-0.5">
                            <ValueInput
                              kind={c.kind}
                              value={rowObj[c.key]}
                              conf={fc?.[cellPath]}
                              onChange={(v) => onChange(cellPath, v)}
                              ariaLabel={`${spec.label} ${i + 1} ${c.label}`}
                              compact
                            />
                          </td>
                        );
                      })}
                      <td className="p-0.5 text-right">
                        <button
                          type="button"
                          className="text-rose-500 hover:text-rose-700"
                          title="Удалить строку"
                          onClick={() => onArrayChange(path, arr.filter((_, j) => j !== i))}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // array-strings — textarea, по строке на элемент.
  if (spec.kind === 'array-strings') {
    const arr = Array.isArray(value) ? value : [];
    const text = arr.map((x) => (x == null ? '' : String(x))).join('\n');
    const border = confidenceBorderClass(conf);
    return (
      <div className="grid grid-cols-[minmax(120px,32%)_1fr] items-start gap-2">
        <label className="pt-1.5 text-xs text-slate-600 dark:text-slate-300" title={spec.description ?? spec.label}>
          {spec.label}
        </label>
        <div>
          <textarea
            className={`form-textarea h-20 resize-y text-xs ${border}`}
            value={text}
            onChange={(e) =>
              onChange(path, e.target.value === '' ? [] : e.target.value.split('\n'))
            }
            spellCheck={false}
          />
          <p className="mt-0.5 text-[10px] text-slate-400">по строке на элемент</p>
        </div>
      </div>
    );
  }

  // примитив — подпись + ввод.
  return (
    <div className="grid grid-cols-[minmax(120px,32%)_1fr] items-center gap-2">
      <label
        className="truncate text-xs text-slate-600 dark:text-slate-300"
        title={spec.description ?? spec.label}
      >
        {spec.label}
      </label>
      <ValueInput
        kind={spec.kind}
        value={value}
        conf={conf}
        onChange={(v) => onChange(path, v)}
        ariaLabel={spec.label}
      />
    </div>
  );
}
