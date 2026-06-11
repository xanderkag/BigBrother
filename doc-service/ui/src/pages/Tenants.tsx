import { useEffect, useState } from 'react';
import {
  useCreateOrg,
  useCreateProject,
  useCreateSystem,
  useCreateUser,
  useGenerateToken,
  useOrganizations,
  useProjects,
  useRevokeToken,
  useSystems,
  useUsers,
  type Organization,
  type Project,
  type UserEntry,
  type UserRole,
  type OrgType,
} from '@/queries/tenants';
import { useCurrentUser } from '@/queries/me';
import {
  useOrganizationSettings,
  useUpdateOrganizationSettings,
  type OrganizationProfileUpdate,
  type ProcessingMode,
  type OutputMode,
} from '@/queries/organizationSettings';
import TokenRevealModal from '@/components/TokenRevealModal';

/**
 * Tenants — фундамент multi-tenant: организации, проекты, пользователи.
 * Доступно admin'у. Per-user role enforcement в API ещё не подключён —
 * super_admin'у видно всё.
 */
export default function TenantsPage() {
  const orgs = useOrganizations();
  const projects = useProjects();
  const users = useUsers();
  const systems = useSystems();

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Организации
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Организации, проекты и пользователи. Доступно super_admin&rsquo;у.
        </p>
      </header>

      <div className="warning-banner text-sm">
        <div>
          Эти таблицы — фундамент multi-tenant платформы. <strong>System</strong>{' '}
          / <strong>Default</strong> — встроенные дефолты (нельзя удалить). Все
          существующие job-ы привязаны к ним. Per-user enforcement в API ещё не
          подключён — super_admin&rsquo;у видно всё.
        </div>
      </div>

      <OrgsCard
        orgs={orgs.data?.items ?? []}
        loading={orgs.isLoading}
        error={orgs.error}
      />
      <ProjectsCard
        projects={projects.data?.items ?? []}
        orgs={orgs.data?.items ?? []}
        loading={projects.isLoading}
        error={projects.error}
      />
      <UsersCard
        users={users.data?.items ?? []}
        orgs={orgs.data?.items ?? []}
        loading={users.isLoading}
        error={users.error}
      />
      <SystemsCard
        systems={systems.data?.items ?? []}
        orgs={orgs.data?.items ?? []}
        loading={systems.isLoading}
        error={systems.error}
      />
    </div>
  );
}

// ============================================================================
// Organizations
// ============================================================================

function OrgsCard({
  orgs,
  loading,
  error,
}: {
  orgs: Organization[];
  loading: boolean;
  error: unknown;
}) {
  const [showForm, setShowForm] = useState(false);
  const create = useCreateOrg();
  const [name, setName] = useState('');
  const [type, setType] = useState<OrgType>('external_company');
  const [profileOrg, setProfileOrg] = useState<Organization | null>(null);

  const me = useCurrentUser();
  // org_admin своей организации редактирует профиль; super_admin — любой.
  const canEditProfile = (orgId: string): boolean => {
    const u = me.data;
    if (!u) return false;
    if (u.is_super_admin) return true;
    return (u.role === 'admin' || u.role === 'org_admin') && u.organization_id === orgId;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await create.mutateAsync({ name: name.trim(), type });
      setName('');
      setShowForm(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="card overflow-hidden">
      <div className="card-header">
        <h2 className="card-title">Организации ({orgs.length})</h2>
        <button type="button" className="btn-secondary text-xs" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Отмена' : '+ Создать'}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={submit}
          className="space-y-3 border-b border-slate-200 bg-slate-50/50 px-5 py-4 dark:border-slate-800 dark:bg-slate-950/30"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="form-label">Название</label>
              <input
                type="text"
                className="form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ООО «Иванов и партнёры»"
                required
              />
            </div>
            <div>
              <label className="form-label">Тип</label>
              <select
                className="form-select"
                value={type}
                onChange={(e) => setType(e.target.value as OrgType)}
              >
                <option value="taipit">taipit (внутренняя)</option>
                <option value="external_company">external_company</option>
              </select>
            </div>
          </div>
          <button type="submit" className="btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Создаём…' : 'Создать организацию'}
          </button>
        </form>
      )}

      {!!error && <ErrorRow err={error} />}
      {loading && <LoadingRow />}
      {!loading && !error && orgs.length === 0 && (
        <EmptyRow text="Организаций ещё нет — создайте первую." />
      )}
      {orgs.length > 0 && (
        <>
          {/* Desktop / tablet (≥md): таблица. ID/Создан прячем на средней ширине. */}
          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
                <tr>
                  <Th className="hidden lg:table-cell">ID</Th>
                  <Th>Название</Th>
                  <Th>Тип</Th>
                  <Th className="hidden lg:table-cell">Создан</Th>
                  <Th>Профиль</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {orgs.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                    <Td mono className="hidden lg:table-cell">{o.id.slice(0, 8)}</Td>
                    <Td>{o.name}</Td>
                    <Td>
                      <TypeBadge type={o.type} />
                    </Td>
                    <Td className="hidden text-xs text-slate-500 lg:table-cell dark:text-slate-400">
                      {fmtDate(o.created_at)}
                    </Td>
                    <Td>
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        onClick={() => setProfileOrg(o)}
                        title="Профиль потребителя (режим, webhook, порог)"
                      >
                        ⚙ Профиль
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile (<md): карточки. */}
          <ul className="divide-y divide-slate-200 md:hidden dark:divide-slate-800">
            {orgs.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-2 px-5 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-900 dark:text-slate-100">{o.name}</span>
                    <TypeBadge type={o.type} />
                  </div>
                  <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                    {o.id.slice(0, 8)} · {fmtDate(o.created_at)}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-ghost min-h-[40px] shrink-0 text-xs"
                  onClick={() => setProfileOrg(o)}
                >
                  ⚙ Профиль
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Модалка вместо отдельного роута: страница Tenants уже работает на
          inline-формах/модалках (см. DocumentTypes/Providers), отдельный
          /organizations/:id/profile добавил бы лишнюю навигацию и роутинг
          ради одной формы. */}
      {profileOrg && (
        <ProfileModal
          org={profileOrg}
          canEdit={canEditProfile(profileOrg.id)}
          onClose={() => setProfileOrg(null)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Consumer profile (per-organization settings)
// ============================================================================

function ProfileModal({
  org,
  canEdit,
  onClose,
}: {
  org: Organization;
  canEdit: boolean;
  onClose: () => void;
}) {
  const settings = useOrganizationSettings(org.id);
  const update = useUpdateOrganizationSettings(org.id);

  const [mode, setMode] = useState<ProcessingMode>('extract');
  const [output, setOutput] = useState<OutputMode>('pull');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [threshold, setThreshold] = useState<string>('');
  const [enrichEnabled, setEnrichEnabled] = useState(false);
  // Секрет write-only: показываем только статус. По умолчанию — не трогаем
  // (omit). 'set' раскрывает поле ввода нового; 'clear' отправит null.
  const [secretAction, setSecretAction] = useState<'keep' | 'set' | 'clear'>('keep');
  const [secret, setSecret] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Гидратируем форму из ответа GET один раз на загрузку.
  useEffect(() => {
    const d = settings.data;
    if (!d) return;
    setMode(d.mode);
    setOutput(d.output);
    setWebhookUrl(d.webhook_url ?? '');
    setThreshold(d.auto_approve_threshold == null ? '' : String(d.auto_approve_threshold));
    setEnrichEnabled(d.enrich_enabled ?? false);
    setSecretAction('keep');
    setSecret('');
  }, [settings.data]);

  const hasStoredSecret = settings.data?.has_webhook_secret ?? false;
  const urlValid = (v: string) => /^https?:\/\/\S+$/i.test(v.trim());

  const save = async () => {
    setError(null);
    setSaved(false);

    if (output === 'webhook' && !webhookUrl.trim()) {
      setError('Для режима webhook укажите Webhook URL.');
      return;
    }
    if (output === 'webhook' && !urlValid(webhookUrl)) {
      setError('Webhook URL должен начинаться с http:// или https://');
      return;
    }
    const thrNum = threshold.trim() === '' ? null : Number(threshold);
    if (thrNum != null && (Number.isNaN(thrNum) || thrNum < 0 || thrNum > 1)) {
      setError('Порог авто-одобрения должен быть числом от 0 до 1.');
      return;
    }

    const payload: OrganizationProfileUpdate = {
      mode,
      output,
      webhook_url: webhookUrl.trim() ? webhookUrl.trim() : null,
      auto_approve_threshold: thrNum,
      enrich_enabled: enrichEnabled,
    };
    if (secretAction === 'set') {
      if (!secret.trim()) {
        setError('Введите новый HMAC-секрет или отмените смену.');
        return;
      }
      payload.webhook_hmac_secret = secret;
    } else if (secretAction === 'clear') {
      payload.webhook_hmac_secret = null;
    }

    try {
      await update.mutateAsync(payload);
      setSaved(true);
      // секрет в кэше/стейте не держим — сбрасываем после успеха
      setSecret('');
      setSecretAction('keep');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

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
          <h3 className="card-title">Профиль потребителя — «{org.name}»</h3>
          <button type="button" className="btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {settings.isLoading && <LoadingRow />}
          {!!settings.error && <ErrorRow err={settings.error} />}

          {settings.data && (
            <div className="card-body space-y-5">
              {!canEdit && (
                <div className="warning-banner text-sm">
                  <div>
                    Только для чтения — редактировать профиль может admin этой
                    организации или super_admin.
                  </div>
                </div>
              )}

              <fieldset disabled={!canEdit} className="space-y-5">
                {/* Режим обработки */}
                <div>
                  <label className="form-label">Режим обработки</label>
                  <select
                    className="form-select"
                    value={mode}
                    onChange={(e) => setMode(e.target.value as ProcessingMode)}
                  >
                    <option value="extract">Полный разбор (extract)</option>
                    <option value="classify_only">Только классификация (classify_only)</option>
                  </select>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    classify_only — только определяем тип документа, без извлечения
                    полей. Дешевле; для потребителей, которым нужен только тип.
                  </p>
                </div>

                {/* Куда отдаём результат */}
                <div>
                  <label className="form-label">Куда отдаём результат</label>
                  <select
                    className="form-select"
                    value={output}
                    onChange={(e) => setOutput(e.target.value as OutputMode)}
                  >
                    <option value="webhook">Webhook (push)</option>
                    <option value="pull">Опрос через API (pull)</option>
                  </select>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    webhook — мы сами шлём результат на ваш URL; pull — вы опрашиваете
                    GET /jobs/:id.
                  </p>
                </div>

                {/* Webhook URL — только для output=webhook */}
                {output === 'webhook' && (
                  <div>
                    <label className="form-label">Webhook URL</label>
                    <input
                      type="url"
                      className="form-input"
                      value={webhookUrl}
                      onChange={(e) => setWebhookUrl(e.target.value)}
                      placeholder="https://example.com/parsdocs/callback"
                    />
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Обязателен при режиме webhook — без URL сохранение вернёт 400.
                    </p>
                  </div>
                )}

                {/* HMAC-секрет вебхука — write-only */}
                {output === 'webhook' && (
                  <div>
                    <label className="form-label">HMAC-секрет вебхука</label>
                    <div className="mb-2 flex items-center gap-2 text-sm">
                      {hasStoredSecret ? (
                        <span className="badge-emerald">секрет задан</span>
                      ) : (
                        <span className="badge-slate">не задан</span>
                      )}
                      {secretAction === 'keep' && (
                        <>
                          <button
                            type="button"
                            className="btn-ghost text-xs"
                            onClick={() => setSecretAction('set')}
                          >
                            {hasStoredSecret ? 'сменить' : 'задать'}
                          </button>
                          {hasStoredSecret && (
                            <button
                              type="button"
                              className="btn-ghost text-xs text-rose-600 dark:text-rose-400"
                              onClick={() => setSecretAction('clear')}
                            >
                              очистить
                            </button>
                          )}
                        </>
                      )}
                      {secretAction === 'set' && (
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          onClick={() => {
                            setSecretAction('keep');
                            setSecret('');
                          }}
                        >
                          отмена
                        </button>
                      )}
                      {secretAction === 'clear' && (
                        <>
                          <span className="text-xs text-rose-600 dark:text-rose-400">
                            будет очищен при сохранении
                          </span>
                          <button
                            type="button"
                            className="btn-ghost text-xs"
                            onClick={() => setSecretAction('keep')}
                          >
                            отмена
                          </button>
                        </>
                      )}
                    </div>
                    {secretAction === 'set' && (
                      <input
                        type="password"
                        className="form-input"
                        value={secret}
                        onChange={(e) => setSecret(e.target.value)}
                        placeholder="новый секрет"
                        autoComplete="new-password"
                      />
                    )}
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Секрет хранится у нас и наружу не возвращается — показываем лишь
                      статус. Используется для подписи вебхуков (HMAC).
                    </p>
                  </div>
                )}

                {/* Порог авто-одобрения */}
                <div>
                  <label className="form-label">Порог авто-одобрения</label>
                  <input
                    type="number"
                    className="form-input"
                    min={0}
                    max={1}
                    step={0.05}
                    value={threshold}
                    onChange={(e) => setThreshold(e.target.value)}
                    placeholder="не задан — использовать глобальный"
                  />
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    документы с confidence ниже порога уходят в Очередь ревью.
                  </p>
                </div>

                {/* Обогащение по ИНН (DaData) */}
                <div>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800"
                      checked={enrichEnabled}
                      onChange={(e) => setEnrichEnabled(e.target.checked)}
                    />
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                      Обогащение по ИНН (DaData)
                    </span>
                  </label>
                  <p className="ml-6 mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Подтягивать офиц. данные ЕГРЮЛ по ИНН и слать потребителю.
                  </p>
                </div>

                {error && <div className="error-banner text-sm">{error}</div>}
                {saved && (
                  <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                    Профиль сохранён.
                  </div>
                )}
              </fieldset>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-800 dark:bg-slate-900/40">
          <button type="button" className="btn-secondary" onClick={onClose}>
            {canEdit ? 'Отмена' : 'Закрыть'}
          </button>
          {canEdit && (
            <button
              type="button"
              className="btn-primary"
              disabled={update.isPending || settings.isLoading}
              onClick={save}
            >
              {update.isPending ? 'Сохраняю…' : 'Сохранить'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function TypeBadge({ type }: { type: OrgType }) {
  const cls =
    type === 'taipit'
      ? 'badge-indigo'
      : type === 'system'
      ? 'badge-slate'
      : 'badge-emerald';
  return <span className={cls}>{type}</span>;
}

// ============================================================================
// Projects
// ============================================================================

function ProjectsCard({
  projects,
  orgs,
  loading,
  error,
}: {
  projects: Project[];
  orgs: Organization[];
  loading: boolean;
  error: unknown;
}) {
  const [showForm, setShowForm] = useState(false);
  const create = useCreateProject();
  const [name, setName] = useState('');
  const [orgId, setOrgId] = useState('');
  const [description, setDescription] = useState('');

  const orgMap = new Map(orgs.map((o) => [o.id, o.name]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !orgId) return;
    try {
      await create.mutateAsync({
        organization_id: orgId,
        name: name.trim(),
        description: description.trim() || null,
      });
      setName('');
      setDescription('');
      setShowForm(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="card overflow-hidden">
      <div className="card-header">
        <h2 className="card-title">Проекты ({projects.length})</h2>
        <button type="button" className="btn-secondary text-xs" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Отмена' : '+ Создать'}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={submit}
          className="space-y-3 border-b border-slate-200 bg-slate-50/50 px-5 py-4 dark:border-slate-800 dark:bg-slate-950/30"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="form-label">Организация</label>
              <select
                className="form-select"
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
                required
              >
                <option value="">Выберите…</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="form-label">Название</label>
              <input
                type="text"
                className="form-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Бухгалтерия Q3 2026"
                required
              />
            </div>
          </div>
          <div>
            <label className="form-label">Описание (опционально)</label>
            <input
              type="text"
              className="form-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Прогон счетов и УПД от поставщиков"
            />
          </div>
          <button type="submit" className="btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Создаём…' : 'Создать проект'}
          </button>
        </form>
      )}

      {!!error && <ErrorRow err={error} />}
      {loading && <LoadingRow />}
      {!loading && !error && projects.length === 0 && (
        <EmptyRow text="Проектов ещё нет." />
      )}
      {projects.length > 0 && (
        <>
          {/* Desktop / tablet (≥md): таблица. */}
          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
                <tr>
                  <Th className="hidden xl:table-cell">ID</Th>
                  <Th>Название</Th>
                  <Th>Организация</Th>
                  <Th className="hidden lg:table-cell">Описание</Th>
                  <Th className="hidden lg:table-cell">Создан</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {projects.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                    <Td mono className="hidden xl:table-cell">{p.id.slice(0, 8)}</Td>
                    <Td>{p.name}</Td>
                    <Td className="text-xs text-slate-600 dark:text-slate-400">
                      {orgMap.get(p.organization_id) ?? p.organization_id.slice(0, 8)}
                    </Td>
                    <Td className="hidden text-xs text-slate-500 lg:table-cell dark:text-slate-400">
                      {p.description ?? '—'}
                    </Td>
                    <Td className="hidden text-xs text-slate-500 lg:table-cell dark:text-slate-400">
                      {fmtDate(p.created_at)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile (<md): карточки. */}
          <ul className="divide-y divide-slate-200 md:hidden dark:divide-slate-800">
            {projects.map((p) => (
              <li key={p.id} className="space-y-1 px-5 py-3">
                <div className="font-medium text-slate-900 dark:text-slate-100">{p.name}</div>
                <div className="text-xs text-slate-600 dark:text-slate-400">
                  {orgMap.get(p.organization_id) ?? p.organization_id.slice(0, 8)}
                </div>
                {p.description && (
                  <div className="text-xs text-slate-500 dark:text-slate-400">{p.description}</div>
                )}
                <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                  {p.id.slice(0, 8)} · {fmtDate(p.created_at)}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ============================================================================
// Users
// ============================================================================

function UsersCard({
  users,
  orgs,
  loading,
  error,
}: {
  users: UserEntry[];
  orgs: Organization[];
  loading: boolean;
  error: unknown;
}) {
  const [showForm, setShowForm] = useState(false);
  const create = useCreateUser();
  const genToken = useGenerateToken();
  const revoke = useRevokeToken();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>('manager');
  const [orgId, setOrgId] = useState('');
  // Одноразовый показ только что выпущенного токена (в модале, не alert —
  // alert не копируется на http-origin). null = модал закрыт.
  const [revealed, setRevealed] = useState<{ token: string; subject: string } | null>(null);

  const orgMap = new Map(orgs.map((o) => [o.id, o.name]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    try {
      await create.mutateAsync({
        display_name: displayName.trim(),
        email: email.trim() || undefined,
        role,
        organization_id: orgId || null,
      });
      setDisplayName('');
      setEmail('');
      setShowForm(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleGenerateToken = async (userId: string, subject: string) => {
    if (!confirm('Сгенерировать новый токен? Старый перестанет работать.')) return;
    try {
      const res = await genToken.mutateAsync(userId);
      // Показываем токен в модале с выделяемым полем + копированием. alert()
      // на http-origin копировать не даёт и текст не выделяется.
      setRevealed({ token: res.plaintext, subject });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRevoke = async (userId: string) => {
    if (!confirm('Отозвать токен пользователя? Его API-запросы будут отклоняться.'))
      return;
    try {
      await revoke.mutateAsync(userId);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="card overflow-hidden">
      <div className="card-header">
        <h2 className="card-title">Пользователи ({users.length})</h2>
        <button type="button" className="btn-secondary text-xs" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Отмена' : '+ Создать'}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={submit}
          className="space-y-3 border-b border-slate-200 bg-slate-50/50 px-5 py-4 dark:border-slate-800 dark:bg-slate-950/30"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="form-label">Имя</label>
              <input
                type="text"
                className="form-input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Иван Петров"
                required
              />
            </div>
            <div>
              <label className="form-label">Email</label>
              <input
                type="email"
                className="form-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ivan@taipit.ru"
              />
            </div>
            <div>
              <label className="form-label">Роль</label>
              <select
                className="form-select"
                value={role}
                onChange={(e) => setRole(e.target.value as UserRole)}
              >
                <option value="super_admin">super_admin</option>
                <option value="admin">admin</option>
                <option value="manager">manager</option>
                <option value="viewer">viewer</option>
              </select>
            </div>
            <div>
              <label className="form-label">Организация</label>
              <select
                className="form-select"
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
              >
                <option value="">— (super_admin без привязки)</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button type="submit" className="btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Создаём…' : 'Создать пользователя'}
          </button>
        </form>
      )}

      {!!error && <ErrorRow err={error} />}
      {loading && <LoadingRow />}
      {!loading && !error && users.length === 0 && (
        <EmptyRow text="Пользователей ещё нет." />
      )}
      {users.length > 0 && (
        <>
          {/* Desktop / tablet (≥md): таблица. Email/Организация/Токен прячем
              на средней ширине; Имя/Роль/Действия остаются. */}
          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
                <tr>
                  <Th>Имя</Th>
                  <Th className="hidden lg:table-cell">Email</Th>
                  <Th>Роль</Th>
                  <Th className="hidden xl:table-cell">Организация</Th>
                  <Th className="hidden lg:table-cell">Токен</Th>
                  <Th>Действия</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                    <Td>{u.display_name}</Td>
                    <Td className="hidden text-xs lg:table-cell">{u.email ?? '—'}</Td>
                    <Td>
                      <RoleBadge role={u.role} />
                    </Td>
                    <Td className="hidden text-xs text-slate-600 xl:table-cell dark:text-slate-400">
                      {u.organization_id ? orgMap.get(u.organization_id) ?? u.organization_id.slice(0, 8) : '—'}
                    </Td>
                    <Td className="hidden lg:table-cell">
                      {u.has_token ? (
                        <span className="badge-emerald">есть</span>
                      ) : (
                        <span className="badge-slate">нет</span>
                      )}
                      {u.token_last_used_at && (
                        <div className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                          исп. {fmtDate(u.token_last_used_at)}
                        </div>
                      )}
                    </Td>
                    <Td>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          onClick={() => handleGenerateToken(u.id, u.display_name)}
                          disabled={genToken.isPending}
                          title={u.has_token ? 'Перевыпустить токен' : 'Сгенерировать токен'}
                        >
                          {u.has_token ? '↻ rotate' : '+ token'}
                        </button>
                        {u.has_token && (
                          <button
                            type="button"
                            className="btn-ghost text-xs text-rose-600 dark:text-rose-400"
                            onClick={() => handleRevoke(u.id)}
                            disabled={revoke.isPending}
                            title="Отозвать токен"
                          >
                            ✕ revoke
                          </button>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile (<md): карточки. */}
          <ul className="divide-y divide-slate-200 md:hidden dark:divide-slate-800">
            {users.map((u) => (
              <li key={u.id} className="space-y-2 px-5 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 dark:text-slate-100">{u.display_name}</div>
                    {u.email && (
                      <div className="text-xs text-slate-500 dark:text-slate-400">{u.email}</div>
                    )}
                  </div>
                  <RoleBadge role={u.role} />
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  {u.has_token ? (
                    <span className="badge-emerald">токен есть</span>
                  ) : (
                    <span className="badge-slate">нет токена</span>
                  )}
                  <span className="text-slate-500 dark:text-slate-400">
                    {u.organization_id ? orgMap.get(u.organization_id) ?? u.organization_id.slice(0, 8) : 'без орг.'}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn-ghost min-h-[40px] text-xs"
                    onClick={() => handleGenerateToken(u.id, u.display_name)}
                    disabled={genToken.isPending}
                  >
                    {u.has_token ? '↻ rotate' : '+ token'}
                  </button>
                  {u.has_token && (
                    <button
                      type="button"
                      className="btn-ghost min-h-[40px] text-xs text-rose-600 dark:text-rose-400"
                      onClick={() => handleRevoke(u.id)}
                      disabled={revoke.isPending}
                    >
                      ✕ revoke
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {revealed && (
        <TokenRevealModal
          token={revealed.token}
          subject={revealed.subject}
          onClose={() => setRevealed(null)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Systems / integrations (service accounts)
// ============================================================================

function SystemsCard({
  systems,
  orgs,
  loading,
  error,
}: {
  systems: UserEntry[];
  orgs: Organization[];
  loading: boolean;
  error: unknown;
}) {
  const [showForm, setShowForm] = useState(false);
  const create = useCreateSystem();
  const genToken = useGenerateToken();
  const revoke = useRevokeToken();

  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<UserRole>('manager');
  const [orgId, setOrgId] = useState('');
  // Одноразовый показ только что выпущенного токена (в модале, не alert).
  const [revealed, setRevealed] = useState<{ token: string; subject: string } | null>(null);

  const orgMap = new Map(orgs.map((o) => [o.id, o.name]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim()) return;
    try {
      await create.mutateAsync({
        display_name: displayName.trim(),
        role,
        organization_id: orgId || null,
      });
      setDisplayName('');
      setShowForm(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleGenerateToken = async (userId: string, subject: string) => {
    if (!confirm('Сгенерировать новый токен? Старый перестанет работать.')) return;
    try {
      const res = await genToken.mutateAsync(userId);
      setRevealed({ token: res.plaintext, subject });
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRevoke = async (userId: string) => {
    if (!confirm('Отозвать токен системы? Её API-запросы будут отклоняться.')) return;
    try {
      await revoke.mutateAsync(userId);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="card overflow-hidden">
      <div className="card-header">
        <h2 className="card-title">Системы / интеграции ({systems.length})</h2>
        <button type="button" className="btn-secondary text-xs" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Отмена' : '+ Создать'}
        </button>
      </div>

      <p className="border-b border-slate-200 bg-slate-50/50 px-5 py-3 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-950/30 dark:text-slate-400">
        Система = внешняя интеграция (SLAI, 1С, Bitrix). Без логина, только
        API-ключи. Ключ работает и для API документов, и для LLM-шлюза.
      </p>

      {showForm && (
        <form
          onSubmit={submit}
          className="space-y-3 border-b border-slate-200 bg-slate-50/50 px-5 py-4 dark:border-slate-800 dark:bg-slate-950/30"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="form-label">Имя</label>
              <input
                type="text"
                className="form-input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="SLAI"
                required
              />
            </div>
            <div>
              <label className="form-label">Роль</label>
              <select
                className="form-select"
                value={role}
                onChange={(e) => setRole(e.target.value as UserRole)}
              >
                <option value="super_admin">super_admin</option>
                <option value="admin">admin</option>
                <option value="manager">manager</option>
                <option value="viewer">viewer</option>
              </select>
            </div>
            <div>
              <label className="form-label">Организация (опционально)</label>
              <select
                className="form-select"
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
              >
                <option value="">— (без привязки)</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button type="submit" className="btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Создаём…' : 'Создать систему'}
          </button>
        </form>
      )}

      {!!error && <ErrorRow err={error} />}
      {loading && <LoadingRow />}
      {!loading && !error && systems.length === 0 && (
        <EmptyRow text="Систем ещё нет — добавьте первую интеграцию." />
      )}
      {systems.length > 0 && (
        <>
          {/* Desktop / tablet (≥md): таблица. */}
          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
                <tr>
                  <Th>Имя</Th>
                  <Th>Роль</Th>
                  <Th className="hidden xl:table-cell">Организация</Th>
                  <Th className="hidden lg:table-cell">Токен</Th>
                  <Th>Действия</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {systems.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                    <Td>{s.display_name}</Td>
                    <Td>
                      <RoleBadge role={s.role} />
                    </Td>
                    <Td className="hidden text-xs text-slate-600 xl:table-cell dark:text-slate-400">
                      {s.organization_id ? orgMap.get(s.organization_id) ?? s.organization_id.slice(0, 8) : '—'}
                    </Td>
                    <Td className="hidden lg:table-cell">
                      {s.has_token ? (
                        <span className="badge-emerald">есть</span>
                      ) : (
                        <span className="badge-slate">нет</span>
                      )}
                      {s.token_last_used_at && (
                        <div className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                          исп. {fmtDate(s.token_last_used_at)}
                        </div>
                      )}
                    </Td>
                    <Td>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          onClick={() => handleGenerateToken(s.id, s.display_name)}
                          disabled={genToken.isPending}
                          title={s.has_token ? 'Перевыпустить токен' : 'Сгенерировать токен'}
                        >
                          {s.has_token ? '↻ rotate' : '+ token'}
                        </button>
                        {s.has_token && (
                          <button
                            type="button"
                            className="btn-ghost text-xs text-rose-600 dark:text-rose-400"
                            onClick={() => handleRevoke(s.id)}
                            disabled={revoke.isPending}
                            title="Отозвать токен"
                          >
                            ✕ revoke
                          </button>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile (<md): карточки. */}
          <ul className="divide-y divide-slate-200 md:hidden dark:divide-slate-800">
            {systems.map((s) => (
              <li key={s.id} className="space-y-2 px-5 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 dark:text-slate-100">{s.display_name}</div>
                  </div>
                  <RoleBadge role={s.role} />
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  {s.has_token ? (
                    <span className="badge-emerald">токен есть</span>
                  ) : (
                    <span className="badge-slate">нет токена</span>
                  )}
                  <span className="text-slate-500 dark:text-slate-400">
                    {s.organization_id ? orgMap.get(s.organization_id) ?? s.organization_id.slice(0, 8) : 'без орг.'}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn-ghost min-h-[40px] text-xs"
                    onClick={() => handleGenerateToken(s.id, s.display_name)}
                    disabled={genToken.isPending}
                  >
                    {s.has_token ? '↻ rotate' : '+ token'}
                  </button>
                  {s.has_token && (
                    <button
                      type="button"
                      className="btn-ghost min-h-[40px] text-xs text-rose-600 dark:text-rose-400"
                      onClick={() => handleRevoke(s.id)}
                      disabled={revoke.isPending}
                    >
                      ✕ revoke
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {revealed && (
        <TokenRevealModal
          token={revealed.token}
          subject={revealed.subject}
          onClose={() => setRevealed(null)}
        />
      )}
    </div>
  );
}

function RoleBadge({ role }: { role: UserRole }) {
  const cls =
    role === 'super_admin'
      ? 'badge-rose'
      : role === 'admin'
      ? 'badge-indigo'
      : role === 'manager'
      ? 'badge-sky'
      : 'badge-slate';
  return <span className={cls}>{role}</span>;
}

// ============================================================================
// Helpers
// ============================================================================

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2 text-left ${className ?? ''}`}>{children}</th>;
}

function Td({
  children,
  mono,
  className,
}: {
  children: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <td
      className={`px-4 py-2 align-top text-slate-700 dark:text-slate-300 ${
        mono ? 'font-mono text-xs' : ''
      } ${className ?? ''}`}
    >
      {children}
    </td>
  );
}

function LoadingRow() {
  return (
    <div className="space-y-2 px-5 py-4">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-8 animate-pulse rounded bg-slate-100 dark:bg-slate-800/60"
        />
      ))}
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="px-5 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
      {text}
    </div>
  );
}

function ErrorRow({ err }: { err: unknown }) {
  return (
    <div className="error-banner mx-5 my-4 text-sm">
      <div>{err instanceof Error ? err.message : String(err)}</div>
    </div>
  );
}

function fmtDate(s: string): string {
  try {
    const d = new Date(s);
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return s;
  }
}
