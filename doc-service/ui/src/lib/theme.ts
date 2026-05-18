/**
 * Theme management — light / dark / system.
 *
 * Хранит выбор в localStorage('theme'). Если значение === 'system' или
 * отсутствует — слушает `prefers-color-scheme` и подменяет класс на <html>
 * автоматически (включая мгновенные переключения когда пользователь
 * меняет тему ОС).
 */

const STORAGE_KEY = 'theme';
const DARK_CLASS = 'dark';

export type ThemeChoice = 'light' | 'dark' | 'system';

const mediaQuery = typeof window !== 'undefined'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

function effectiveDark(choice: ThemeChoice): boolean {
  if (choice === 'dark') return true;
  if (choice === 'light') return false;
  return mediaQuery?.matches ?? false;
}

function applyChoice(choice: ThemeChoice) {
  const dark = effectiveDark(choice);
  document.documentElement.classList.toggle(DARK_CLASS, dark);
}

export function getTheme(): ThemeChoice {
  const v = (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY)) as ThemeChoice | null;
  if (v === 'light' || v === 'dark' || v === 'system') return v;
  return 'system';
}

export function setTheme(choice: ThemeChoice) {
  if (choice === 'system') {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, choice);
  }
  applyChoice(choice);
}

/**
 * Инициализация — вызывается один раз в main.tsx до первого render'а
 * чтобы избежать вспышки белого фона при загрузке в dark-режиме.
 * Также подписывается на системное переключение темы.
 */
export function initTheme() {
  applyChoice(getTheme());
  if (!mediaQuery) return;
  mediaQuery.addEventListener('change', () => {
    if (getTheme() === 'system') applyChoice('system');
  });
}

/**
 * Циклический toggle для одной кнопки: light → dark → system → light.
 * Возвращает следующее значение для UI-индикации.
 */
export function cycleTheme(): ThemeChoice {
  const next: ThemeChoice = ({ light: 'dark', dark: 'system', system: 'light' } as const)[getTheme()];
  setTheme(next);
  return next;
}
