import { useEffect, useRef, useState } from 'react';

/**
 * Одноразовый показ personal access token. Заменяет alert() — это критично на
 * http-origin (прод открыт по `http://10.10.13.10:8085`, без домена/TLS): там
 * браузерный Clipboard API заблокирован, а текст внутри alert() не выделяется,
 * из-за чего токен невозможно скопировать вообще. Здесь токен лежит в
 * выделяемом readonly-поле + кнопка «Копировать» с fallback'ом на execCommand
 * для insecure-origin.
 */
interface Props {
  /** Plaintext-токен. Виден ровно один раз — сюда передаётся и больше нигде не хранится. */
  token: string;
  /** Чей это токен (имя пользователя) — для заголовка. */
  subject: string;
  onClose: () => void;
}

export default function TokenRevealModal({ token, subject, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  // Сразу выделяем поле — даже если копирование не сработает, токен готов к
  // ручному Ctrl+C.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        // https / localhost — современный путь.
        await navigator.clipboard.writeText(token);
      } else {
        // http-origin: Clipboard API недоступен → старый execCommand по
        // выделенному полю. Deprecated, но единственный рабочий путь без TLS.
        inputRef.current?.select();
        // eslint-disable-next-line deprecation/deprecation
        document.execCommand('copy');
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Совсем не вышло — поле уже выделено, пользователь копирует руками.
      inputRef.current?.select();
    }
  };

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div className="card flex w-full max-w-xl flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="card-header flex items-center justify-between">
          <h3 className="card-title">Токен для «{subject}»</h3>
          <button type="button" className="btn-ghost" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>

        <div className="space-y-3 p-5">
          <div className="warning-banner">
            Токен показывается <span className="font-semibold">один раз</span>. Скопируйте и
            сохраните его сейчас — после закрытия окна он не восстановится, только перевыпуск.
          </div>

          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              readOnly
              value={token}
              onFocus={(e) => e.currentTarget.select()}
              className="form-input flex-1 font-mono text-xs"
              aria-label="Personal access token"
            />
            <button type="button" className="btn-primary whitespace-nowrap" onClick={handleCopy}>
              {copied ? '✓ Скопировано' : 'Копировать'}
            </button>
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400">
            Использование: заголовок{' '}
            <code className="font-mono">Authorization: Bearer &lt;token&gt;</code>. Один и тот же
            токен подходит и для API документов, и для LLM-шлюза.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3 dark:border-slate-800">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}
