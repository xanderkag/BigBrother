import { useState } from 'react';
import { useOrganizations } from '@/queries/tenants';
import { OrgsCard, ProjectsCard, useProjects } from './tenants/cards';
import ProvisionInstanceModal from '@/components/ProvisionInstanceModal';

/**
 * Организации — компании и проекты (фундамент multi-tenant). Доступно
 * admin'у. Пользователи и системы переехали в /access.
 */
export default function OrganizationsPage() {
  const orgs = useOrganizations();
  const projects = useProjects();
  const [showProvision, setShowProvision] = useState(false);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Организации
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Компании и проекты. Доступно super_admin&rsquo;у.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary shrink-0"
          onClick={() => setShowProvision(true)}
        >
          + Подключить инстанс
        </button>
      </header>

      {showProvision && (
        <ProvisionInstanceModal onClose={() => setShowProvision(false)} />
      )}

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
    </div>
  );
}
