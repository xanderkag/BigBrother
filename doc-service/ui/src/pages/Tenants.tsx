import { useState } from 'react';
import {
  useCreateOrg,
  useCreateProject,
  useCreateUser,
  useGenerateToken,
  useOrganizations,
  useProjects,
  useRevokeToken,
  useUsers,
  type Organization,
  type Project,
  type UserEntry,
  type UserRole,
  type OrgType,
} from '@/queries/tenants';

/**
 * Tenants — фундамент multi-tenant: организации, проекты, пользователи.
 * Доступно admin'у. Per-user role enforcement в API ещё не подключён —
 * super_admin'у видно всё.
 */
export default function TenantsPage() {
  const orgs = useOrganizations();
  const projects = useProjects();
  const users = useUsers();

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
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
              <tr>
                <Th>ID</Th>
                <Th>Название</Th>
                <Th>Тип</Th>
                <Th>Создан</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {orgs.map((o) => (
                <tr key={o.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                  <Td mono>{o.id.slice(0, 8)}</Td>
                  <Td>{o.name}</Td>
                  <Td>
                    <TypeBadge type={o.type} />
                  </Td>
                  <Td className="text-xs text-slate-500 dark:text-slate-400">
                    {fmtDate(o.created_at)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
              <tr>
                <Th>ID</Th>
                <Th>Название</Th>
                <Th>Организация</Th>
                <Th>Описание</Th>
                <Th>Создан</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {projects.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                  <Td mono>{p.id.slice(0, 8)}</Td>
                  <Td>{p.name}</Td>
                  <Td className="text-xs text-slate-600 dark:text-slate-400">
                    {orgMap.get(p.organization_id) ?? p.organization_id.slice(0, 8)}
                  </Td>
                  <Td className="text-xs text-slate-500 dark:text-slate-400">
                    {p.description ?? '—'}
                  </Td>
                  <Td className="text-xs text-slate-500 dark:text-slate-400">
                    {fmtDate(p.created_at)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

  const handleGenerateToken = async (userId: string) => {
    if (!confirm('Сгенерировать новый токен? Старый перестанет работать.')) return;
    try {
      const res = await genToken.mutateAsync(userId);
      try {
        await navigator.clipboard.writeText(res.plaintext);
        alert(
          `Personal access token создан и скопирован в буфер:\n\n${res.plaintext}\n\n` +
            'Сохраните его сейчас — после закрытия этого окна вы его НЕ увидите. ' +
            'В заголовке: Authorization: Bearer <token>.',
        );
      } catch {
        alert(
          `Personal access token создан:\n\n${res.plaintext}\n\n` +
            'Скопировать не удалось — выделите вручную и сохраните.',
        );
      }
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
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
              <tr>
                <Th>Имя</Th>
                <Th>Email</Th>
                <Th>Роль</Th>
                <Th>Организация</Th>
                <Th>Токен</Th>
                <Th>Действия</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
                  <Td>{u.display_name}</Td>
                  <Td className="text-xs">{u.email ?? '—'}</Td>
                  <Td>
                    <RoleBadge role={u.role} />
                  </Td>
                  <Td className="text-xs text-slate-600 dark:text-slate-400">
                    {u.organization_id ? orgMap.get(u.organization_id) ?? u.organization_id.slice(0, 8) : '—'}
                  </Td>
                  <Td>
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
                        onClick={() => handleGenerateToken(u.id)}
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

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2 text-left">{children}</th>;
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
