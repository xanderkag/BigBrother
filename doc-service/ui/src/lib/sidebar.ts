/**
 * Sidebar collapse state — десктопный «свёрнут / развёрнут».
 *
 * Хранит выбор в localStorage('sidebar-collapsed'). Default — развёрнут.
 * На mobile sidebar и так оверлей-drawer, collapsed-режим там не имеет
 * визуального смысла, но JS-флаг един для простоты.
 */
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'sidebar-collapsed';

export function getSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setSidebarCollapsed(v: boolean) {
  try {
    if (v) {
      localStorage.setItem(STORAGE_KEY, '1');
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore (private mode, quota, etc.)
  }
}

/**
 * React-hook: возвращает [collapsed, setCollapsed]. Стейт прокидывается
 * в localStorage чтобы переживать reload.
 */
export function useSidebarCollapsed(): readonly [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsedState] = useState<boolean>(() => getSidebarCollapsed());

  // Реагируем на изменения в других вкладках/окнах (например, открыли копию UI).
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY) setCollapsedState(getSidebarCollapsed());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const apply = (v: boolean) => {
    setCollapsedState(v);
    setSidebarCollapsed(v);
  };
  return [collapsed, apply] as const;
}
