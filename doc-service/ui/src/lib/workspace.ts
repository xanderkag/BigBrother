/**
 * Workspace state — текущая выбранная организация для multi-tenant UI.
 *
 * Хранится в localStorage('workspace.orgId'). Для обычного юзера === его
 * organization_id (нет выбора, единственная орг). Для super_admin'а —
 * выбираемая через dropdown в header.
 *
 * Страницы которые зависят от org (RefLists, sync ERP, owner-filter Jobs)
 * вызывают `getWorkspaceOrgId()` или подписываются через `useWorkspaceOrgId()`.
 *
 * Используем lightweight pub/sub чтобы не тащить Zustand для одной строки.
 * `window` event позволяет компонентам обновляться когда другой компонент
 * меняет workspace.
 */
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'workspace.orgId';
const EVENT_NAME = 'workspace-change';

export function getWorkspaceOrgId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(STORAGE_KEY);
}

export function setWorkspaceOrgId(id: string | null) {
  if (typeof localStorage === 'undefined') return;
  if (id) localStorage.setItem(STORAGE_KEY, id);
  else localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: id }));
}

/**
 * React-хук: возвращает текущий orgId и подписывается на изменения через
 * custom event. Если другой компонент позвал `setWorkspaceOrgId` — все
 * подписчики перерисуются.
 */
export function useWorkspaceOrgId(): [string | null, (id: string | null) => void] {
  const [orgId, setOrgIdState] = useState<string | null>(() => getWorkspaceOrgId());

  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<string | null>).detail ?? getWorkspaceOrgId();
      setOrgIdState(id);
    };
    window.addEventListener(EVENT_NAME, handler);
    return () => window.removeEventListener(EVENT_NAME, handler);
  }, []);

  return [orgId, setWorkspaceOrgId];
}
