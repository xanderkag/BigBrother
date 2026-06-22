import { useEffect, useState } from 'react';
import {
  useDocumentTypes,
  useCreateDocumentType,
  useUpdateDocumentType,
  useDeleteDocumentType,
  type DocumentTypeEntry,
  type DocumentTypeTier,
  type ParserKind,
} from '@/queries/documentTypes';
import { useOrganizations } from '@/queries/tenants';
import { useCurrentUser } from '@/queries/me';
import {
  DOCUMENT_TYPE_TEMPLATES,
  type DocumentTypeTemplate,
} from '@/lib/document-type-templates';
import JsonField from '@/components/JsonField';
import StringListField from '@/components/StringListField';
import TierBadge from '@/components/TierBadge';
import ExtractionCatalog from '@/components/ExtractionCatalog';

/**
 * Document types CRUD-страница. Список + modal-форма для create/edit.
 *
 * Эквивалент `#document-types` в старом UI. Builtin-типы помечены
 * бэйджем и не могут быть удалены (DELETE возвращает 403) — только
 * deactivate через is_active=false.
 */

const PARSER_KINDS: ParserKind[] = [
  'builtin:invoice_regex',
  'builtin:upd_regex',
  'llm_extract',
  'llm_extract_multipass',
];

export default function DocumentTypesPage() {
  const { data, isLoading, error } = useDocumentTypes();
  const { data: orgsData } = useOrganizations();
  const { data: me } = useCurrentUser();
  const [editing, setEditing] = useState<DocumentTypeEntry | null>(null);
  const [catalog, setCatalog] = useState<DocumentTypeEntry | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [scope, setScope] = useState<string>('all'); // all | global | <org_id>

  const orgs = orgsData?.items ?? [];
  const orgName = (id: string | null | undefined) => {
    if (!id) return null;
    const found = orgs.find((o) => o.id === id);
    return found?.name ?? `${id.slice(0, 8)}…`;
  };

  const items = (data?.items ?? [])
    .filter((t) => showInactive || t.is_active)
    .filter((t) => {
      if (scope === 'all') return true;
      if (scope === 'global') return !t.organization_id;
      return t.organization_id === scope;
    });

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Типы документов</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 dark:text-slate-500">
            Справочник зарегистрированных типов. Влияет на классификацию, regex
            парсеры и LLM-промпты.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="form-select text-sm"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            title="Фильтр по владельцу"
          >
            <option value="all">Все</option>
            <option value="global">Глобальные</option>
            {me?.is_super_admin
              ? orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))
              : me?.organization_id && (
                  <option value={me.organization_id}>
                    {orgName(me.organization_id) ?? 'Моя организация'}
                  </option>
                )}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Показать inactive
          </label>
          <button
            type="button"
            className="btn-primary"
            onClick={() =>
              setEditing({
                slug: '',
                display_name: '',
                is_active: true,
                tier: 'experimental',
                organization_id: me?.is_super_admin ? null : me?.organization_id ?? null,
              } as DocumentTypeEntry)
            }
          >
            + Создать тип
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          Ошибка: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div className="card overflow-hidden">
        {/* Desktop / tablet (≥md): таблица. Slug/Название/Статус всегда
            видны; Владелец/Parser/Поля/Ключевые слова прячем на средней
            ширине через hidden lg/xl:table-cell. */}
        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-900/40 text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 dark:text-slate-500">
              <tr>
                <th className="px-4 py-2">Slug</th>
                <th className="px-4 py-2">Название</th>
                <th className="hidden px-4 py-2 lg:table-cell">Владелец</th>
                <th className="px-4 py-2">Зрелость</th>
                <th className="hidden px-4 py-2 xl:table-cell">Поля</th>
                <th className="hidden px-4 py-2 xl:table-cell">Ключевые слова</th>
                <th className="px-4 py-2">Статус</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {isLoading &&
                [1, 2, 3, 4, 5].map((i) => (
                  <tr key={`skel-${i}`}>
                    {Array.from({ length: 8 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3 w-20 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60" />
                      </td>
                    ))}
                  </tr>
                ))}
              {!isLoading && items.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center">
                    <p className="font-medium text-slate-700 dark:text-slate-300">
                      Типы документов не настроены
                    </p>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                      Добавьте первый тип через «+ Создать» — задайте слаг,
                      поля и инструкцию для LLM.
                    </p>
                  </td>
                </tr>
              )}
              {items.map((t) => (
                <tr key={t.slug} className="hover:bg-slate-50 dark:bg-slate-900/40">
                  <td className="px-4 py-2 font-mono text-xs text-slate-700 dark:text-slate-300">{t.slug}</td>
                  <td className="px-4 py-2 font-medium text-slate-900 dark:text-slate-100">
                    {t.display_name}
                    {t.is_builtin && (
                      <span className="badge-slate ml-2" title="Встроенный тип">
                        builtin
                      </span>
                    )}
                  </td>
                  <td className="hidden px-4 py-2 lg:table-cell">
                    {t.organization_id ? (
                      <span
                        className="badge-indigo"
                        title={`Принадлежит организации ${t.organization_id}`}
                      >
                        {orgName(t.organization_id)}
                      </span>
                    ) : (
                      <span className="badge-slate" title="Доступен всем организациям">
                        Глобальный
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <TierBadge tier={t.tier} />
                  </td>
                  <td className="hidden px-4 py-2 text-slate-600 xl:table-cell dark:text-slate-400 dark:text-slate-500">
                    <span className="text-xs">{(t.expected_fields ?? []).length}</span>
                  </td>
                  <td className="hidden px-4 py-2 text-slate-600 xl:table-cell dark:text-slate-400 dark:text-slate-500">
                    <span className="text-xs">{(t.classification_keywords ?? []).length}</span>
                  </td>
                  <td className="px-4 py-2">
                    {t.is_active ? (
                      <span className="badge-emerald">active</span>
                    ) : (
                      <span className="badge-slate">inactive</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => setCatalog(t)}
                        title="Поля, которые система извлекает из этого типа"
                      >
                        Что извлекаем
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => setEditing(t)}
                      >
                        Изменить
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile (<md): карточки. */}
        <div className="md:hidden">
          {isLoading && (
            <div className="space-y-2 p-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60" />
              ))}
            </div>
          )}
          {!isLoading && items.length === 0 && (
            <div className="px-4 py-10 text-center">
              <p className="font-medium text-slate-700 dark:text-slate-300">
                Типы документов не настроены
              </p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                Добавьте первый тип через «+ Создать» — задайте слаг,
                поля и инструкцию для LLM.
              </p>
            </div>
          )}
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {items.map((t) => (
              <li key={t.slug} className="space-y-2 px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-900 dark:text-slate-100">
                      {t.display_name}
                    </div>
                    <div className="font-mono text-xs text-slate-500 dark:text-slate-400">
                      {t.slug}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <button
                      type="button"
                      className="btn-ghost min-h-[40px] text-sm"
                      onClick={() => setCatalog(t)}
                    >
                      Что извлекаем
                    </button>
                    <button
                      type="button"
                      className="btn-ghost min-h-[40px] text-sm"
                      onClick={() => setEditing(t)}
                    >
                      Изменить
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  {t.is_active ? (
                    <span className="badge-emerald">active</span>
                  ) : (
                    <span className="badge-slate">inactive</span>
                  )}
                  <TierBadge tier={t.tier} />
                  {t.organization_id ? (
                    <span className="badge-indigo" title={`Принадлежит организации ${t.organization_id}`}>
                      {orgName(t.organization_id)}
                    </span>
                  ) : (
                    <span className="badge-slate" title="Доступен всем организациям">
                      Глобальный
                    </span>
                  )}
                  {t.is_builtin && (
                    <span className="badge-slate" title="Встроенный тип">
                      builtin
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-slate-500 dark:text-slate-400">
                  <span>{t.parser_kind ?? 'parser —'}</span>
                  <span>{(t.expected_fields ?? []).length} полей</span>
                  <span>{(t.classification_keywords ?? []).length} ключ.слов</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {editing && (
        <DocumentTypeEditor
          initial={editing}
          isNew={!editing.slug}
          orgs={orgs}
          isSuperAdmin={!!me?.is_super_admin}
          myOrgId={me?.organization_id ?? null}
          orgName={orgName}
          onClose={() => setEditing(null)}
        />
      )}

      {catalog && (
        <ExtractionCatalogModal type={catalog} onClose={() => setCatalog(null)} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* «Что извлекаем» — read-only modal                                  */
/* ------------------------------------------------------------------ */

function ExtractionCatalogModal({
  type,
  onClose,
}: {
  type: DocumentTypeEntry;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="card flex max-h-[90vh] w-full max-w-2xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header">
          <div className="min-w-0">
            <h3 className="card-title truncate">
              {type.display_name}{' '}
              <span className="font-mono text-xs font-normal text-slate-500 dark:text-slate-400">
                {type.slug}
              </span>
            </h3>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Поля, которые система извлекает из этого типа
            </p>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          <ExtractionCatalog slug={type.slug} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Editor modal                                                       */
/* ------------------------------------------------------------------ */

function DocumentTypeEditor({
  initial,
  isNew,
  orgs,
  isSuperAdmin,
  myOrgId,
  orgName,
  onClose,
}: {
  initial: DocumentTypeEntry;
  isNew: boolean;
  orgs: { id: string; name: string }[];
  isSuperAdmin: boolean;
  myOrgId: string | null;
  orgName: (id: string | null | undefined) => string | null;
  onClose: () => void;
}) {
  const create = useCreateDocumentType();
  const update = useUpdateDocumentType();
  const del = useDeleteDocumentType();

  const [draft, setDraft] = useState<DocumentTypeEntry>({ ...initial });
  const [error, setError] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);

  const setField = <K extends keyof DocumentTypeEntry>(
    key: K,
    value: DocumentTypeEntry[K],
  ) => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const applyTemplate = (tpl: DocumentTypeTemplate) => {
    setTemplateId(tpl.id);
    setDraft((d) => ({
      ...d,
      parser_kind: tpl.parser_kind,
      expected_fields: [...tpl.expected_fields],
      validators: [...tpl.validators],
    }));
  };

  const save = async () => {
    setError(null);
    try {
      if (isNew) {
        // Перед create — простая проверка slug
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(draft.slug)) {
          setError('slug: только латиница/цифры/дефис, без пробелов');
          return;
        }
        if (!draft.display_name) {
          setError('display_name обязательно');
          return;
        }
        await create.mutateAsync({
          slug: draft.slug,
          display_name: draft.display_name,
          description: draft.description ?? null,
          is_active: draft.is_active,
          organization_id: isSuperAdmin
            ? draft.organization_id ?? null
            : myOrgId,
          tier: draft.tier ?? 'experimental',
          parser_kind: draft.parser_kind ?? null,
          llm_prompt: draft.llm_prompt ?? null,
          llm_schema: draft.llm_schema ?? null,
          expected_fields: draft.expected_fields ?? [],
          validators: draft.validators ?? [],
          classification_keywords: draft.classification_keywords ?? [],
          confidence_threshold: draft.confidence_threshold ?? null,
          regex_fallback_threshold: draft.regex_fallback_threshold ?? null,
          metadata: draft.metadata ?? null,
          resolution_config: draft.resolution_config ?? null,
        });
      } else {
        await update.mutateAsync({
          slug: draft.slug,
          patch: {
            display_name: draft.display_name,
            description: draft.description ?? null,
            is_active: draft.is_active,
            tier: draft.tier ?? 'experimental',
            parser_kind: draft.parser_kind ?? null,
            llm_prompt: draft.llm_prompt ?? null,
            llm_schema: draft.llm_schema ?? null,
            expected_fields: draft.expected_fields ?? [],
            validators: draft.validators ?? [],
            classification_keywords: draft.classification_keywords ?? [],
            confidence_threshold: draft.confidence_threshold ?? null,
            regex_fallback_threshold: draft.regex_fallback_threshold ?? null,
            metadata: draft.metadata ?? null,
            resolution_config: draft.resolution_config ?? null,
          },
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async () => {
    if (initial.is_builtin) {
      alert('Builtin типы нельзя удалять — выключите через is_active вместо этого.');
      return;
    }
    if (!confirm(`Удалить тип "${initial.slug}"? Это необратимо.`)) return;
    try {
      await del.mutateAsync(initial.slug);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const busy = create.isPending || update.isPending || del.isPending;

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="card flex max-h-[92vh] w-full max-w-3xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header">
          <h3 className="card-title">
            {isNew ? 'Создать тип документа' : `Изменить «${initial.display_name}»`}
          </h3>
          <button type="button" className="btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {isNew && (
            <div className="border-b border-slate-200 px-5 py-4 dark:border-slate-800">
              <label className="form-label">Шаблон</label>
              <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
                Выберите категорию — поля, валидаторы и parser подставятся.
                Дальше отредактируйте slug, название и ключевые слова.
              </p>
              <div className="flex flex-wrap gap-2">
                {DOCUMENT_TYPE_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => applyTemplate(tpl)}
                    className={`rounded-lg border px-3 py-2 text-sm transition ${
                      templateId === tpl.id
                        ? 'border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-950 dark:text-indigo-200'
                        : 'border-slate-200 text-slate-700 hover:border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
                    }`}
                  >
                    <span className="mr-1">{tpl.emoji}</span>
                    {tpl.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="card-body grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="form-label">Slug</label>
              <input
                type="text"
                className="form-input font-mono text-sm"
                value={draft.slug}
                onChange={(e) => setField('slug', e.target.value)}
                disabled={!isNew}
                placeholder="например: invoice"
              />
            </div>
            <div>
              <label className="form-label">Название</label>
              <input
                type="text"
                className="form-input"
                value={draft.display_name}
                onChange={(e) => setField('display_name', e.target.value)}
                placeholder="например: Счёт-фактура"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="form-label">Описание</label>
              <textarea
                className="form-textarea text-sm"
                rows={2}
                value={draft.description ?? ''}
                onChange={(e) => setField('description', e.target.value || null)}
              />
            </div>

            {!initial.is_builtin && (
              <div className="sm:col-span-2">
                <label className="form-label">Владелец</label>
                {isSuperAdmin ? (
                  <select
                    className="form-select"
                    value={draft.organization_id ?? ''}
                    onChange={(e) =>
                      setField('organization_id', e.target.value || null)
                    }
                  >
                    <option value="">Глобальный (все)</option>
                    {orgs.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    {orgName(myOrgId) ?? 'Моя организация'}
                    <span className="ml-2 text-xs text-slate-400 dark:text-slate-500">
                      (тип будет доступен только вашей организации)
                    </span>
                  </p>
                )}
              </div>
            )}

            <div>
              <label className="form-label">Parser kind</label>
              <select
                className="form-select"
                value={draft.parser_kind ?? ''}
                onChange={(e) =>
                  setField('parser_kind', (e.target.value || null) as ParserKind | null)
                }
              >
                <option value="">— не задан —</option>
                {PARSER_KINDS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="form-label">Зрелость (tier)</label>
              <select
                className="form-select"
                value={draft.tier ?? 'experimental'}
                onChange={(e) => setField('tier', e.target.value as DocumentTypeTier)}
              >
                <option value="stable">stable</option>
                <option value="beta">beta</option>
                <option value="experimental">experimental</option>
              </select>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Default experimental; ставьте stable только когда есть Zod schema + golden-set покрытие
              </p>
            </div>

            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.is_active}
                  onChange={(e) => setField('is_active', e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                Активен (используется в классификации)
              </label>
            </div>

            <div>
              <label className="form-label">Confidence threshold</label>
              <input
                type="number"
                step="0.05"
                min="0"
                max="1"
                className="form-input"
                value={draft.confidence_threshold ?? ''}
                onChange={(e) =>
                  setField(
                    'confidence_threshold',
                    e.target.value === '' ? null : Number(e.target.value),
                  )
                }
                placeholder="env default"
              />
            </div>
            <div>
              <label className="form-label">Regex fallback threshold</label>
              <input
                type="number"
                step="0.05"
                min="0"
                max="1"
                className="form-input"
                value={draft.regex_fallback_threshold ?? ''}
                onChange={(e) =>
                  setField(
                    'regex_fallback_threshold',
                    e.target.value === '' ? null : Number(e.target.value),
                  )
                }
                placeholder="env default"
              />
            </div>

            <div className="sm:col-span-2">
              <StringListField
                label="Ключевые слова для классификации"
                value={draft.classification_keywords ?? []}
                onChange={(v) => setField('classification_keywords', v)}
                hint="Если в OCR-тексте найдено любое — документ классифицируется этим типом"
              />
            </div>

            <div className="sm:col-span-2">
              <StringListField
                label="Ожидаемые поля"
                value={draft.expected_fields ?? []}
                onChange={(v) => setField('expected_fields', v)}
                hint="Какие поля парсер должен извлечь. Влияет на missing/coverage метрики"
              />
            </div>

            <div className="sm:col-span-2">
              <StringListField
                label="Валидаторы"
                value={draft.validators ?? []}
                onChange={(v) => setField('validators', v)}
                hint="Имена кастомных валидаторов из validation/registry"
                rows={3}
              />
            </div>

            <div className="sm:col-span-2">
              <label className="form-label">LLM prompt (override)</label>
              <textarea
                className="form-textarea font-mono text-xs"
                rows={4}
                value={draft.llm_prompt ?? ''}
                onChange={(e) => setField('llm_prompt', e.target.value || null)}
                placeholder="Пусто = builtin промпт для этого типа"
              />
            </div>

            <div className="sm:col-span-2">
              <JsonField
                label="LLM schema (JSON Schema для extracted)"
                value={draft.llm_schema}
                onChange={(v) => setField('llm_schema', v)}
                hint="Передаётся в /extract как response_schema"
              />
            </div>

            <div className="sm:col-span-2">
              <JsonField
                label="Metadata"
                value={draft.metadata}
                onChange={(v) => setField('metadata', v)}
                hint="Произвольный admin-config, не влияет на pipeline напрямую"
              />
            </div>

            <div className="sm:col-span-2">
              <JsonField
                label="Resolution config"
                value={draft.resolution_config}
                onChange={(v) => setField('resolution_config', v)}
                hint="entity_links + item_matching для привязки к справочникам"
              />
            </div>

            {error && <div className="error-banner sm:col-span-2">{error}</div>}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40 px-5 py-3">
          <div>
            {!isNew && !initial.is_builtin && (
              <button
                type="button"
                className="btn-danger"
                disabled={busy}
                onClick={handleDelete}
              >
                Удалить
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Отмена
            </button>
            <button type="button" className="btn-primary" disabled={busy} onClick={save}>
              {busy ? 'Сохраняю…' : 'Сохранить'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
