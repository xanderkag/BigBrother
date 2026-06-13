import { useOrganizations, useSystems } from '@/queries/tenants';
import { UsersCard, SystemsCard, useUsers } from './tenants/cards';

/**
 * Доступ — пользователи (люди с логином) и системы (интеграции с
 * API-ключами). Доступно admin'у. Раньше системы были спрятаны внизу
 * страницы «Организации» — здесь они на равных с пользователями.
 */
export default function AccessPage() {
  const orgs = useOrganizations();
  const users = useUsers();
  const systems = useSystems();

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Доступ
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Пользователи и системы / интеграции. Выпуск и отзыв API-токенов.
        </p>
      </header>

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
