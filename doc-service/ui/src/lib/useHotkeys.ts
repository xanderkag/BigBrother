import { useEffect, useRef } from 'react';

/**
 * F5 — единый механизм горячих клавиш. Один window-listener на хук,
 * актуальные обработчики читаются через ref (без переподписки на каждый
 * рендер и без устаревших замыканий).
 *
 * Правила (общие для всех точек):
 *   - НЕ срабатываем, когда фокус в поле ввода (input/textarea/select/
 *     contenteditable) — иначе `a`/`e`/`j` ломали бы набор текста.
 *   - НЕ перехватываем комбинации с Ctrl/Cmd/Alt — это ярлыки браузера и
 *     приложения (например, Cmd+B сворачивает сайдбар в Layout). Shift
 *     оставляем, т.к. `?` это Shift+/.
 *   - Первый подошедший обработчик «съедает» событие (preventDefault).
 */
export interface Hotkey {
  /** Клавиши `KeyboardEvent.key`, на которые реагируем (напр. ['j','ArrowDown']). */
  keys: string[];
  handler: (e: KeyboardEvent) => void;
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    t.isContentEditable
  );
}

export function useHotkeys(hotkeys: Hotkey[], enabled = true) {
  const ref = useRef(hotkeys);
  ref.current = hotkeys;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      for (const hk of ref.current) {
        if (hk.keys.includes(e.key)) {
          e.preventDefault();
          hk.handler(e);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
