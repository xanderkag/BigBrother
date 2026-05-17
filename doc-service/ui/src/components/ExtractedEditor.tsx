import { useState, useEffect } from 'react';
import { useUpdateExtracted } from '@/queries/jobs';

/**
 * Inline JSON editor для extracted field'а.
 *
 * Render'ится как fullscreen modal над JobDetail. Pre-fill'ит текущим
 * extracted (pretty-printed), пользователь правит в textarea, клик
 * "Сохранить" → PATCH /jobs/:id/extracted.
 *
 * Зачем именно JSON-textarea, а не form-builder:
 *   - формы документов разные (УПД vs ТТН vs путевой), structured
 *     form builder = месяц работы
 *   - operator'ы которые правят extracted руками — это техсаппорт,
 *     они привычны к JSON
 *   - валидация happens на backend'е, при PATCH-запросе re-run
 *     document_type правил
 *
 * Когда дойдём до Phase 4: per-field inline edit в FormView
 * (двойной клик → input → blur = save) — но это другая модель UX.
 */
interface Props {
  jobId: string;
  initial: Record<string, unknown> | null;
  onClose: () => void;
  onSaved?: () => void;
}

export default function ExtractedEditor({ jobId, initial, onClose, onSaved }: Props) {
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const update = useUpdateExtracted();

  useEffect(() => {
    // Удаляем server-managed поля из initial — backend их перезаписывает
    // на save, не имеет смысла показывать оператору.
    const cleaned = initial ? { ...initial } : {};
    delete cleaned._issues;
    delete cleaned._field_confidence;
    delete cleaned._normalized_fields;
    delete cleaned._totals_recomputed;
    setText(JSON.stringify(cleaned, null, 2));
  }, [initial]);

  const handleSave = async () => {
    setParseError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'invalid JSON');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setParseError('extracted должен быть JSON-объектом');
      return;
    }
    try {
      await update.mutateAsync({ jobId, extracted: parsed as Record<string, unknown> });
      onSaved?.();
      onClose();
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="card flex max-h-[90vh] w-full max-w-3xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header">
          <h3 className="card-title">Редактировать extracted</h3>
          <button type="button" className="btn-ghost" onClick={onClose} aria-label="Закрыть">
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-hidden p-5">
          <p className="mb-3 text-xs text-slate-500">
            Перезаписывает поле <code className="rounded bg-slate-100 px-1">extracted</code>{' '}
            целиком. После сохранения статус job'а станет{' '}
            <span className="badge-emerald">done</span>. Backend пере-валидирует payload по
            правилам типа документа — если найдутся issues, они появятся в job снова.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="form-textarea h-[55vh] w-full resize-none font-mono text-xs leading-5"
            spellCheck={false}
          />
          {parseError && (
            <div className="error-banner mt-3">
              <span className="font-medium">Ошибка:</span> {parseError}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={update.isPending}
            onClick={handleSave}
          >
            {update.isPending ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}
