import { useState } from 'react';
import {
  useProviders,
  useCreateProvider,
  useUpdateProvider,
  useDeleteProvider,
  useSetDefaultProvider,
  useTestProvider,
  type ProviderEntry,
  type ProviderKind,
  type TestResult,
} from '@/queries/providers';
import JsonField from '@/components/JsonField';

/**
 * Provider settings CRUD-страница. Список LLM / OCR провайдеров с
 * возможностью set-default и test-connection.
 *
 * SECURITY:
 *   - api_key показывается ТОЛЬКО как маскированный (••••1234)
 *   - Поле ввода api_key всегда пустое при открытии edit (не
 *     pre-fill'им — мы и не знаем plaintext, backend нам его не
 *     отдаёт). Пустое поле при save = не менять секрет, явный null
 *     или строка "null" = очистить секрет.
 *
 * Эквивалент `#providers` в старом UI.
 */

export default function ProvidersPage() {
  const { data, isLoading, error } = useProviders();
  const [editing, setEditing] = useState<{ provider: ProviderEntry | null; isNew: boolean } | null>(
    null,
  );
  const [filter, setFilter] = useState<'' | ProviderKind>('');

  const items = (data?.items ?? []).filter((p) => !filter || p.kind === filter);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Провайдеры</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 dark:text-slate-500">
            LLM (Anthropic / OpenAI / Ollama) и OCR (Yandex Vision) — креды и
            URL'ы для динамической резолюции в pipeline'е.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="form-select"
            value={filter}
            onChange={(e) => setFilter(e.target.value as '' | ProviderKind)}
          >
            <option value="">Все типы</option>
            <option value="llm">LLM</option>
            <option value="ocr">OCR</option>
            <option value="dadata">DaData</option>
            <option value="yandex_maps">Яндекс.Карты</option>
          </select>
          <button
            type="button"
            className="btn-primary"
            onClick={() => setEditing({ provider: null, isNew: true })}
          >
            + Добавить провайдера
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          Ошибка: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      <div className="card overflow-hidden">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-900/40 text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 dark:text-slate-500">
            <tr>
              <th className="px-4 py-2">ID</th>
              <th className="px-4 py-2">Тип</th>
              <th className="px-4 py-2">Название</th>
              <th className="px-4 py-2">Base URL</th>
              <th className="px-4 py-2">Модель</th>
              <th className="px-4 py-2">API key</th>
              <th className="px-4 py-2">Статус</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {isLoading &&
              [1, 2, 3, 4].map((i) => (
                <tr key={`skel-${i}`}>
                  {Array.from({ length: 8 }).map((_, j) => (
                    <td key={j} className="px-4 py-3">
                      <div className="h-3 w-16 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60" />
                    </td>
                  ))}
                </tr>
              ))}
            {!isLoading && items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center">
                  <p className="font-medium text-slate-700 dark:text-slate-300">
                    Провайдеры не настроены
                  </p>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                    Добавьте API-ключи Anthropic / OpenAI / Yandex и адреса
                    локальных моделей через «+ Добавить провайдера».
                  </p>
                </td>
              </tr>
            )}
            {items.map((p) => (
              <ProviderRow
                key={p.id}
                provider={p}
                onEdit={() => setEditing({ provider: p, isNew: false })}
              />
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <ProviderEditor
          initial={editing.provider}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Row                                                                */
/* ------------------------------------------------------------------ */

function ProviderRow({
  provider,
  onEdit,
}: {
  provider: ProviderEntry;
  onEdit: () => void;
}) {
  const setDefault = useSetDefaultProvider();
  const test = useTestProvider();
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const handleTest = async () => {
    setTestResult(null);
    try {
      const r = await test.mutateAsync(provider.id);
      setTestResult(r);
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <tr className="hover:bg-slate-50 dark:bg-slate-900/40">
      <td className="px-4 py-2 font-mono text-xs text-slate-700 dark:text-slate-300">{provider.id}</td>
      <td className="px-4 py-2">
        <span className={provider.kind === 'llm' ? 'badge-indigo' : 'badge-sky'}>
          {provider.kind}
        </span>
      </td>
      <td className="px-4 py-2 font-medium text-slate-900 dark:text-slate-100">
        {provider.display_name}
        {provider.is_default && (
          <span className="badge-emerald ml-2" title="Default для этого типа">
            default
          </span>
        )}
      </td>
      <td className="px-4 py-2 font-mono text-xs text-slate-600 dark:text-slate-400 dark:text-slate-500">
        {provider.base_url ?? <span className="text-slate-400 dark:text-slate-500">—</span>}
      </td>
      <td className="px-4 py-2 text-slate-600 dark:text-slate-400 dark:text-slate-500">
        {provider.model ?? <span className="text-slate-400 dark:text-slate-500">—</span>}
      </td>
      <td className="px-4 py-2 font-mono text-xs text-slate-600 dark:text-slate-400 dark:text-slate-500">
        {provider.has_api_key ? (
          provider.api_key_masked ?? <span className="text-emerald-700 dark:text-emerald-300">set</span>
        ) : (
          <span className="text-slate-400 dark:text-slate-500">—</span>
        )}
      </td>
      <td className="px-4 py-2">
        {provider.is_active ? (
          <span className="badge-emerald">active</span>
        ) : (
          <span className="badge-slate">inactive</span>
        )}
      </td>
      <td className="px-4 py-2 text-right">
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            className="btn-ghost"
            disabled={test.isPending}
            onClick={handleTest}
            title="Проверить подключение"
          >
            {test.isPending && test.variables === provider.id ? 'Тест…' : 'Тест'}
          </button>
          {!provider.is_default && (
            <button
              type="button"
              className="btn-ghost"
              disabled={setDefault.isPending}
              onClick={() => {
                if (
                  confirm(
                    `Сделать ${provider.id} default'ом для ${provider.kind}? Снимет default с остальных.`,
                  )
                ) {
                  setDefault.mutate(provider.id);
                }
              }}
              title="Использовать по умолчанию"
            >
              ★
            </button>
          )}
          <button type="button" className="btn-ghost" onClick={onEdit}>
            Изменить
          </button>
        </div>
        {testResult && (
          <div
            className={`mt-1 text-xs ${
              testResult.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'
            }`}
          >
            {testResult.ok
              ? `✓ ${testResult.latency_ms} ms`
              : `✕ ${testResult.message ?? `HTTP ${testResult.status}`}`}
          </div>
        )}
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------------ */
/* Editor modal                                                       */
/* ------------------------------------------------------------------ */

/** Убирает secret_key из extra (его plaintext бэк не отдаёт — нельзя гонять обратно). */
function stripSecretKey(
  src: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!src) return src;
  const rest = { ...src };
  delete rest.secret_key;
  return Object.keys(rest).length > 0 ? rest : null;
}

interface DraftForm {
  id: string;
  kind: ProviderKind;
  display_name: string;
  description: string;
  base_url: string;
  api_key: string;
  secret_key: string; // только для kind='dadata' → extra.secret_key (write-only)
  model: string;
  is_active: boolean;
  extra: Record<string, unknown> | null;
}

function ProviderEditor({
  initial,
  isNew,
  onClose,
}: {
  initial: ProviderEntry | null;
  isNew: boolean;
  onClose: () => void;
}) {
  const create = useCreateProvider();
  const update = useUpdateProvider();
  const del = useDeleteProvider();

  const [draft, setDraft] = useState<DraftForm>(() => ({
    id: initial?.id ?? '',
    kind: initial?.kind ?? 'llm',
    display_name: initial?.display_name ?? '',
    description: initial?.description ?? '',
    base_url: initial?.base_url ?? '',
    api_key: '', // никогда не pre-fill'им
    secret_key: '', // никогда не pre-fill'им (backend не отдаёт plaintext)
    model: initial?.model ?? '',
    is_active: initial?.is_active ?? true,
    // extra без secret_key: маскированное значение из toApi() в JSON-редакторе
    // показывать/гонять обратно нельзя. secret_key редактируется отдельным полем.
    extra: stripSecretKey(initial?.extra ?? null),
  }));
  const [error, setError] = useState<string | null>(null);
  const [clearApiKey, setClearApiKey] = useState(false);
  const [clearSecretKey, setClearSecretKey] = useState(false);

  // Собрать extra для отправки: базовый extra (без secret_key) +
  // secret_key только если введён новый или явно очищается.
  const buildExtra = (): Record<string, unknown> | null => {
    const base = stripSecretKey(draft.extra);
    if (draft.kind !== 'dadata') return base;
    if (draft.secret_key) {
      return { ...(base ?? {}), secret_key: draft.secret_key };
    }
    if (clearSecretKey) {
      return { ...(base ?? {}), secret_key: null };
    }
    // Не трогаем secret_key: на create — нет ключа; на patch — он останется
    // в БД только если extra не передаётся целиком. См. save() ниже.
    return base;
  };

  const save = async () => {
    setError(null);
    try {
      if (isNew) {
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(draft.id)) {
          setError('id: только lowercase a-z, цифры, _-');
          return;
        }
        if (!draft.display_name) {
          setError('display_name обязательно');
          return;
        }
        await create.mutateAsync({
          id: draft.id,
          kind: draft.kind,
          display_name: draft.display_name,
          description: draft.description || null,
          base_url: draft.base_url || null,
          api_key: draft.api_key || null,
          model: draft.model || null,
          is_active: draft.is_active,
          extra: buildExtra(),
        });
      } else {
        // PATCH: api_key — особая логика. Пустое поле = не менять,
        // clearApiKey=true = явный null (стираем). Если что-то введено
        // — обновляем. Это позволяет редактировать другие поля без
        // повторного ввода ключа.
        //
        // Тип патча — Partial<CreateProviderInput> чтобы null'ы для
        // description/base_url/model работали (DraftForm хранит их как
        // string для удобства binding'а в input'ах).
        const patch: Partial<import('@/queries/providers').CreateProviderInput> = {
          display_name: draft.display_name,
          description: draft.description || null,
          base_url: draft.base_url || null,
          model: draft.model || null,
          is_active: draft.is_active,
        };
        if (clearApiKey) {
          patch.api_key = null;
        } else if (draft.api_key) {
          patch.api_key = draft.api_key;
        }
        // extra — full-replace на бэке. Включаем его в patch ТОЛЬКО когда
        // реально что-то меняется в extra (новый/очищенный secret_key или
        // изменённый non-secret extra), иначе stored secret_key затрётся.
        const secretChanged =
          draft.kind === 'dadata' && (!!draft.secret_key || clearSecretKey);
        const baseChanged =
          JSON.stringify(stripSecretKey(draft.extra)) !==
          JSON.stringify(stripSecretKey(initial?.extra ?? null));
        if (secretChanged || baseChanged) {
          patch.extra = buildExtra();
        }
        await update.mutateAsync({ id: draft.id, patch });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async () => {
    if (!initial) return;
    if (!confirm(`Удалить провайдера "${initial.id}"? Это необратимо.`)) return;
    try {
      await del.mutateAsync(initial.id);
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
        className="card flex max-h-[92vh] w-full max-w-2xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header">
          <h3 className="card-title">
            {isNew ? 'Добавить провайдера' : `Изменить «${initial?.display_name}»`}
          </h3>
          <button type="button" className="btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="card-body grid flex-1 grid-cols-1 gap-4 overflow-auto sm:grid-cols-2">
          <div>
            <label className="form-label">ID</label>
            <input
              type="text"
              className="form-input font-mono text-sm"
              value={draft.id}
              onChange={(e) => setDraft((d) => ({ ...d, id: e.target.value }))}
              disabled={!isNew}
              placeholder="например: claude-prod"
            />
          </div>
          <div>
            <label className="form-label">Тип</label>
            <select
              className="form-select"
              value={draft.kind}
              onChange={(e) =>
                setDraft((d) => ({ ...d, kind: e.target.value as ProviderKind }))
              }
              disabled={!isNew}
            >
              <option value="llm">LLM</option>
              <option value="ocr">OCR</option>
              <option value="dadata">DaData (ЕГРЮЛ-обогащение)</option>
              <option value="yandex_maps">Яндекс.Карты (геокодер)</option>
            </select>
          </div>

          <div className="sm:col-span-2">
            <label className="form-label">Название</label>
            <input
              type="text"
              className="form-input"
              value={draft.display_name}
              onChange={(e) =>
                setDraft((d) => ({ ...d, display_name: e.target.value }))
              }
              placeholder="например: Anthropic Claude Sonnet 4.6"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="form-label">Описание</label>
            <textarea
              className="form-textarea text-sm"
              rows={2}
              value={draft.description}
              onChange={(e) =>
                setDraft((d) => ({ ...d, description: e.target.value }))
              }
            />
          </div>

          <div className="sm:col-span-2">
            <label className="form-label">Base URL</label>
            <input
              type="url"
              className="form-input font-mono text-sm"
              value={draft.base_url}
              onChange={(e) => setDraft((d) => ({ ...d, base_url: e.target.value }))}
              placeholder="https://api.anthropic.com"
            />
          </div>

          <div className="sm:col-span-2">
            <label className="form-label">
              API key{' '}
              {!isNew && initial?.has_api_key && (
                <span className="text-xs font-normal text-slate-500 dark:text-slate-400 dark:text-slate-500">
                  (текущий: {initial.api_key_masked ?? 'установлен'} — пусто = не менять)
                </span>
              )}
            </label>
            <input
              type="password"
              className="form-input font-mono text-sm"
              value={draft.api_key}
              onChange={(e) => {
                setDraft((d) => ({ ...d, api_key: e.target.value }));
                setClearApiKey(false);
              }}
              placeholder={
                !isNew && initial?.has_api_key ? '••••••••' : 'sk-... или пусто'
              }
              autoComplete="off"
            />
            {!isNew && initial?.has_api_key && (
              <label className="mt-1 flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={clearApiKey}
                  onChange={(e) => {
                    setClearApiKey(e.target.checked);
                    if (e.target.checked) setDraft((d) => ({ ...d, api_key: '' }));
                  }}
                />
                Очистить ключ (явно установить null)
              </label>
            )}
          </div>

          {draft.kind === 'dadata' && (
            <div className="sm:col-span-2">
              <label className="form-label">
                Secret key (DaData, для cleaning API){' '}
                {!isNew && initial?.has_secret_key && (
                  <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                    (установлен — пусто = не менять)
                  </span>
                )}
              </label>
              <input
                type="password"
                className="form-input font-mono text-sm"
                value={draft.secret_key}
                onChange={(e) => {
                  setDraft((d) => ({ ...d, secret_key: e.target.value }));
                  setClearSecretKey(false);
                }}
                placeholder={
                  !isNew && initial?.has_secret_key ? '••••••••' : 'необязательно'
                }
                autoComplete="off"
              />
              {!isNew && initial?.has_secret_key && (
                <label className="mt-1 flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={clearSecretKey}
                    onChange={(e) => {
                      setClearSecretKey(e.target.checked);
                      if (e.target.checked) setDraft((d) => ({ ...d, secret_key: '' }));
                    }}
                  />
                  Очистить secret key
                </label>
              )}
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                API key (Token) — поле выше. Secret key нужен только для будущей
                стандартизации адресов; для ЕГРЮЛ-обогащения по ИНН достаточно Token.
              </p>
            </div>
          )}

          <div>
            <label className="form-label">Модель (для LLM)</label>
            <input
              type="text"
              className="form-input font-mono text-sm"
              value={draft.model}
              onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              placeholder="claude-sonnet-4-6"
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.is_active}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, is_active: e.target.checked }))
                }
                className="h-4 w-4 rounded border-slate-300"
              />
              Активен
            </label>
          </div>

          <div className="sm:col-span-2">
            <JsonField
              label="Extra"
              value={draft.extra}
              onChange={(v) => setDraft((d) => ({ ...d, extra: v }))}
              hint="Произвольный provider-specific config (timeout, headers и т.п.)"
            />
          </div>

          {error && <div className="error-banner sm:col-span-2">{error}</div>}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40 px-5 py-3">
          <div>
            {!isNew && (
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
