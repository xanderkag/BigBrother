import { useEffect, useState } from 'react';

/**
 * String-list input: одна строка = одно значение. Используется для
 * classification_keywords, expected_fields, validators — простой UX
 * без тэгов с x-кнопками, легко копировать и редактировать.
 *
 * Пустые строки фильтруются автоматически на выходе.
 */
interface Props {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  hint?: string;
  rows?: number;
}

export default function StringListField({
  label,
  value,
  onChange,
  hint,
  rows = 4,
}: Props) {
  const [text, setText] = useState('');

  useEffect(() => {
    setText((value ?? []).join('\n'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (next: string) => {
    setText(next);
    const arr = next.split('\n').map((s) => s.trim()).filter(Boolean);
    onChange(arr);
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
        placeholder="по одному значению на строку"
      />
      {hint && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 dark:text-slate-500">{hint}</p>}
    </div>
  );
}
