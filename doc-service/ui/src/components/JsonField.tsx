import { useState, useEffect } from 'react';

/**
 * JSON field input — textarea + live валидация на parse error.
 * Используется в DocumentType / Provider editor'ах для опциональных
 * объектных полей (llm_schema, metadata, resolution_config, extra).
 *
 * Контракт:
 *   value: Record<string,unknown> | null — текущее значение
 *   onChange: вызывается только когда JSON парсится валидно (объект)
 *   onError: вызывается с сообщением ошибки или null при clean state
 *
 * Если field optional → пустая textarea = null. JSON-литерал `null`
 * тоже трактуется как null.
 */
interface Props {
  label: string;
  value: Record<string, unknown> | null | undefined;
  onChange: (v: Record<string, unknown> | null) => void;
  hint?: string;
  rows?: number;
}

export default function JsonField({ label, value, onChange, hint, rows = 6 }: Props) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Sync external value into text (initial load / form reset). Не делаем
  // двустороннюю синхронизацию во время typing — иначе курсор прыгает.
  useEffect(() => {
    if (value === null || value === undefined) {
      setText('');
    } else {
      setText(JSON.stringify(value, null, 2));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (next: string) => {
    setText(next);
    if (next.trim() === '') {
      setError(null);
      onChange(null);
      return;
    }
    try {
      const parsed = JSON.parse(next);
      if (parsed === null) {
        setError(null);
        onChange(null);
        return;
      }
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('Должен быть JSON-объект {} или null');
        return;
      }
      setError(null);
      onChange(parsed as Record<string, unknown>);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'invalid JSON');
    }
  };

  return (
    <div>
      <label className="form-label">{label}</label>
      <textarea
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        className="form-textarea font-mono text-xs"
        rows={rows}
        spellCheck={false}
        placeholder="{} или оставьте пустым = null"
      />
      {hint && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">{hint}</p>}
      {error && <p className="mt-1 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
