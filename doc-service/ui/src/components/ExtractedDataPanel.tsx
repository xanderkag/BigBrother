import { useState, useMemo } from 'react';
import {
  formatMoney,
  formatNumber,
  formatDate,
  formatPercent,
} from '@/lib/format';

/**
 * Панель Extracted data с двумя вьюхами: Форма и JSON.
 *
 * "Форма" — структурированный показ полей по группам (Реквизиты,
 * Продавец, Покупатель, Items, Flags). Знание о схеме hardcoded —
 * соответствует JSON Schema УПД/счета/ТТН из backend.
 *
 * "JSON" — pretty-printed JSON в monospace, для разработчиков/админов.
 *
 * Группировка работает best-effort: если поля нет — секция не
 * показывается. Это естественно обрабатывает разные типы документов
 * (УПД vs путевой лист) без хардкода document_type.
 */

interface Props {
  extracted: Record<string, unknown> | null;
  /** Validation issues для подсветки конкретных полей. */
  issues?: string[];
}

type ViewMode = 'form' | 'json';
const VIEW_MODE_KEY = 'parsdocs.v2.extractedView';

export default function ExtractedDataPanel({ extracted, issues }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    return (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) || 'form';
  });

  const updateView = (mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem(VIEW_MODE_KEY, mode);
  };

  const handleCopy = async () => {
    if (!extracted) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(extracted, null, 2));
    } catch {
      /* ignore */
    }
  };

  if (!extracted) {
    return (
      <div className="card">
        <div className="card-body text-sm text-slate-500">Данные ещё не извлечены.</div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header">
        <div className="flex items-center gap-3">
          <h3 className="card-title">Extracted data</h3>
          <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs">
            <button
              type="button"
              className={`rounded px-2 py-1 ${
                viewMode === 'form' ? 'bg-brand-600 text-white' : 'text-slate-700'
              }`}
              onClick={() => updateView('form')}
            >
              Форма
            </button>
            <button
              type="button"
              className={`rounded px-2 py-1 ${
                viewMode === 'json' ? 'bg-brand-600 text-white' : 'text-slate-700'
              }`}
              onClick={() => updateView('json')}
            >
              JSON
            </button>
          </div>
        </div>
        <button type="button" className="btn-ghost h-8 px-2 text-xs" onClick={handleCopy}>
          Copy
        </button>
      </div>
      {viewMode === 'form' ? (
        <FormView extracted={extracted} issues={issues} />
      ) : (
        <JsonView extracted={extracted} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* JSON view                                                          */
/* ------------------------------------------------------------------ */

function JsonView({ extracted }: { extracted: Record<string, unknown> }) {
  return (
    <pre className="card-body max-h-[70vh] overflow-auto whitespace-pre-wrap font-mono text-xs text-slate-800">
      {JSON.stringify(extracted, null, 2)}
    </pre>
  );
}

/* ------------------------------------------------------------------ */
/* Form view                                                          */
/* ------------------------------------------------------------------ */

function FormView({
  extracted,
  issues,
}: {
  extracted: Record<string, unknown>;
  issues?: string[];
}) {
  // Извлекаем party (продавец/покупатель) — могут быть разные структуры
  const seller = (extracted.seller ?? extracted.shipper ?? extracted.supplier) as
    | Record<string, unknown>
    | undefined;
  const buyer = (extracted.buyer ?? extracted.consignee ?? extracted.customer) as
    | Record<string, unknown>
    | undefined;

  // Items — для УПД, счетов, ТТН
  const items = (extracted.items ?? extracted.positions) as
    | Array<Record<string, unknown>>
    | undefined;

  // Flags — все boolean поля на верхнем уровне
  const flags = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(extracted)) {
      if (typeof v === 'boolean') out[k] = v;
    }
    return out;
  }, [extracted]);

  // Помечаем поля, упомянутые в issues — для подсветки
  const issueKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!issues) return keys;
    for (const issue of issues) {
      // Эвристика: если в issue упомянуто слово "НДС" → подсвечиваем поле vat
      if (/НДС|vat/i.test(issue)) keys.add('vat');
      if (/totals?|итог/i.test(issue)) keys.add('total_with_vat');
      if (/ИНН|inn/i.test(issue)) {
        keys.add('seller.inn');
        keys.add('buyer.inn');
      }
    }
    return keys;
  }, [issues]);

  return (
    <div className="card-body space-y-5">
      {/* Реквизиты — основные поля документа */}
      <Section title="Реквизиты">
        <Field
          label="Номер"
          value={extracted.number ?? extracted.doc_number}
          highlight={issueKeys.has('number')}
        />
        <Field
          label="Дата"
          value={formatDate((extracted.date as string) ?? null)}
          highlight={issueKeys.has('date')}
        />
        <Field
          label="Итого"
          value={formatMoney(extracted.total_with_vat as number, '')}
          highlight={issueKeys.has('total_with_vat')}
        />
        <Field
          label="Total без НДС"
          value={formatMoney(extracted.total_without_vat as number, '')}
        />
        <Field
          label="НДС"
          value={formatMoney(extracted.vat as number, '')}
          highlight={issueKeys.has('vat')}
        />
        <Field
          label="Ставка НДС"
          value={extracted.vat_rate !== undefined ? `${extracted.vat_rate}%` : '—'}
        />
        <Field
          label="Валюта"
          value={
            extracted.currency ? (
              <span className="badge-sky">{String(extracted.currency)}</span>
            ) : (
              '—'
            )
          }
        />
      </Section>

      {/* Парт продавец */}
      {seller && (
        <Section title="Продавец">
          <Field label="ИНН" value={seller.inn} highlight={issueKeys.has('seller.inn')} />
          <Field label="КПП" value={seller.kpp} />
          <Field label="Наименование" value={seller.name} wide />
          <Field label="Адрес" value={seller.address} wide />
          {Boolean(seller.bank) && <Field label="Банк" value={seller.bank} wide />}
          {Boolean(seller.bik) && <Field label="БИК" value={seller.bik} />}
          {Boolean(seller.account) && <Field label="Счёт" value={seller.account} wide />}
        </Section>
      )}

      {/* Парт покупатель */}
      {buyer && (
        <Section title="Покупатель">
          <Field label="ИНН" value={buyer.inn} highlight={issueKeys.has('buyer.inn')} />
          <Field label="КПП" value={buyer.kpp} />
          <Field label="Наименование" value={buyer.name} wide />
          <Field label="Адрес" value={buyer.address} wide />
        </Section>
      )}

      {/* Items */}
      {items && items.length > 0 && (
        <ItemsTable items={items} />
      )}

      {/* Flags */}
      {Object.keys(flags).length > 0 && (
        <Section title="Flags">
          {Object.entries(flags).map(([k, v]) => (
            <Field key={k} label={k} value={v ? <span className="badge-emerald">да</span> : '—'} />
          ))}
        </Section>
      )}

      {/* Misc — все остальные top-level поля, которые мы ещё не показали */}
      <MiscFields
        extracted={extracted}
        excludeKeys={[
          'number',
          'doc_number',
          'date',
          'total_with_vat',
          'total_without_vat',
          'vat',
          'vat_rate',
          'currency',
          'seller',
          'shipper',
          'supplier',
          'buyer',
          'consignee',
          'customer',
          'items',
          'positions',
          '_issues',
          '_field_confidence',
          '_normalized_fields',
          '_totals_recomputed',
          ...Object.keys(flags),
        ]}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Primitives                                                         */
/* ------------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </h4>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">{children}</dl>
    </div>
  );
}

function Field({
  label,
  value,
  highlight,
  wide,
}: {
  label: string;
  value: unknown;
  highlight?: boolean;
  wide?: boolean;
}) {
  const display = renderValue(value);
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd
        className={`mt-0.5 text-sm ${
          highlight
            ? 'rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-900'
            : 'text-slate-900'
        }`}
      >
        {display}
      </dd>
    </div>
  );
}

function renderValue(v: unknown): React.ReactNode {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') {
    // если это React-element (badge-sky из <Field value={<span>...}>) — рендерим как есть
    if ((v as { $$typeof?: symbol }).$$typeof) return v as React.ReactNode;
    return <code className="font-mono text-xs">{JSON.stringify(v)}</code>;
  }
  return String(v);
}

/**
 * Таблица позиций. Колонки: №, Наименование, Кол-во, Цена, НДС%, Сумма.
 * Если есть category_hint / _slai_category_id (F6/F13 enrichment) —
 * показываем как доп. колонку.
 */
function ItemsTable({ items }: { items: Array<Record<string, unknown>> }) {
  const hasCategories = items.some(
    (i) => i.category_hint !== undefined || i._slai_category_id !== undefined,
  );
  return (
    <div>
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Позиции <span className="font-normal text-slate-400">({items.length})</span>
      </h4>
      <div className="overflow-auto rounded-lg border border-slate-200">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">№</th>
              <th className="px-3 py-2 text-left">Наименование</th>
              <th className="px-3 py-2 text-right">Кол-во</th>
              <th className="px-3 py-2 text-right">Цена</th>
              <th className="px-3 py-2 text-right">НДС%</th>
              <th className="px-3 py-2 text-right">Сумма</th>
              {hasCategories && <th className="px-3 py-2 text-left">Категория</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {items.map((it, i) => (
              <tr key={i} className="hover:bg-slate-50">
                <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                <td className="px-3 py-2 font-medium text-slate-900">{String(it.name ?? '—')}</td>
                <td className="px-3 py-2 text-right">{formatNumber(it.qty as number)}</td>
                <td className="px-3 py-2 text-right">{formatMoney(it.price as number, '')}</td>
                <td className="px-3 py-2 text-right">
                  {it.vat_rate !== undefined ? `${it.vat_rate}%` : '—'}
                </td>
                <td className="px-3 py-2 text-right font-medium">
                  {formatMoney(it.total as number, '')}
                </td>
                {hasCategories && (
                  <td className="px-3 py-2">
                    {Boolean(it.category_hint) && (
                      <span className="badge-indigo">{String(it.category_hint)}</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Показывает любые поля верхнего уровня, которые мы не отрендерили
 * явно (для нестандартных типов документов или для отладки).
 */
function MiscFields({
  extracted,
  excludeKeys,
}: {
  extracted: Record<string, unknown>;
  excludeKeys: string[];
}) {
  const excluded = new Set(excludeKeys);
  const entries = Object.entries(extracted).filter(
    ([k, v]) => !excluded.has(k) && !k.startsWith('_') && v !== null && v !== undefined,
  );
  if (entries.length === 0) return null;

  return (
    <Section title="Прочее">
      {entries.map(([k, v]) => (
        <Field key={k} label={k} value={v} />
      ))}
    </Section>
  );
}

// Используется только для типизации — silence ts noUnused
export const _types = { formatPercent };
