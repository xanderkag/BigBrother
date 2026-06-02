/**
 * F9 — централизованные ролевые права для UI.
 *
 * Модель ролей (src/authz.ts на бэке):
 *   super_admin > admin (org_admin) > manager > viewer
 *
 * Ранги нужны для сравнения «не ниже чем». Неизвестная роль → 0 (как
 * viewer): fail-closed — скрываем write-кнопки и не пускаем в админку.
 *
 * Решение владельца (docs/UI_FRONTEND_TZ.md §5/§10):
 *   - Тест-лаборатория и Журнал действий — видны всем авторизованным;
 *   - разделы конфигурации (типы, провайдеры, справочники, организации,
 *     настройки) — только админам;
 *   - запись (одобрить / править / загрузить / reprocess) — manager+;
 *     viewer везде read-only.
 */
import { useCurrentUser } from '@/queries/me';

export const ROLE_RANK = {
  viewer: 0,
  manager: 1,
  admin: 2,
  org_admin: 2,
  super_admin: 3,
} as const;

/** Минимальный уровень доступа для гейтов маршрутов/кнопок. */
export type AccessLevel = 'writer' | 'admin';

const NEED: Record<AccessLevel, number> = {
  writer: ROLE_RANK.manager,
  admin: ROLE_RANK.admin,
};

export function rankOf(role: string | undefined, isSuperAdmin = false): number {
  if (isSuperAdmin) return ROLE_RANK.super_admin;
  return (ROLE_RANK as Record<string, number>)[role ?? ''] ?? 0;
}

export interface Permissions {
  /** /users/me загружен — решения по доступу можно принимать. */
  ready: boolean;
  role: string | undefined;
  rank: number;
  /** Только чтение (viewer или неизвестная роль). */
  isViewer: boolean;
  /** Может писать в назначенных проектах (manager+). */
  isWriter: boolean;
  /** Видит разделы конфигурации (admin+). */
  isAdmin: boolean;
  /** Достаточно ли прав для уровня доступа. */
  can: (level: AccessLevel) => boolean;
}

export function usePermissions(): Permissions {
  const me = useCurrentUser();
  const rank = rankOf(me.data?.role, me.data?.is_super_admin ?? false);
  return {
    ready: !me.isLoading && !!me.data,
    role: me.data?.role,
    rank,
    isViewer: rank < ROLE_RANK.manager,
    isWriter: rank >= ROLE_RANK.manager,
    isAdmin: rank >= ROLE_RANK.admin,
    can: (level) => rank >= NEED[level],
  };
}
