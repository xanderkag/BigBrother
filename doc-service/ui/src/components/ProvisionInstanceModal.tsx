import { useEffect, useRef, useState } from 'react';
import {
  useProvisionInstance,
  type ProvisionInstanceResult,
} from '@/queries/tenants';

interface Props {
  onClose: () => void;
}

type Step = 'identity' | 'integration' | 'done';

const ORG_TYPES = [
  {
    value: 'external_company',
    label: 'Боевой',
    hint: 'Внешний клиент / прод-инстанс',
  },
  {
    value: 'test',
    label: 'Песочница',
    hint: 'Тесты, демо, обкатка',
  },
] as const;

export default function ProvisionInstanceModal({ onClose }: Props) {
  const provision = useProvisionInstance();
  const [step, setStep] = useState<Step>('identity');
  const [result, setResult] = useState<ProvisionInstanceResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // form fields
  const [name, setName] = useState('');
  const [type, setType] = useState<string>('external_company');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('365');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [llmBudget, setLlmBudget] = useState('');
  const [dadataBudget, setDadataBudget] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canNext = name.trim().length > 0;

  const submit = async () => {
    setError(null);
    try {
      const res = await provision.mutateAsync({
        name: name.trim(),
        type,
        webhook_url: webhookUrl.trim() || null,
        expires_in_days: expiresInDays ? Number.parseInt(expiresInDays, 10) : null,
        llm_budget: llmBudget ? Number.parseInt(llmBudget, 10) : null,
        dadata_budget: dadataBudget ? Number.parseInt(dadataBudget, 10) : null,
      });
      setResult(res);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="card flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with step rail */}
        <div className="border-b border-slate-200 px-6 py-4 dark:border-slate-800">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Подключение инстанса
            </h3>
            <button
              type="button"
              className="btn-ghost -mr-2"
              onClick={onClose}
              aria-label="Закрыть"
            >
              ✕
            </button>
          </div>
          <StepRail step={step} />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {step === 'identity' && (
            <div className="space-y-5">
              <div>
                <label className="form-label" htmlFor="pi-name">
                  Название инстанса <span className="text-rose-500">*</span>
                </label>
                <input
                  id="pi-name"
                  type="text"
                  className="form-input"
                  placeholder="SLAI Клиент X"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
                <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                  Имя организации и сервисного бота. Должно быть уникальным.
                </p>
              </div>

              <div>
                <span className="form-label">Тип</span>
                <div className="grid grid-cols-2 gap-3">
                  {ORG_TYPES.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setType(t.value)}
                      className={`rounded-lg border p-3 text-left transition-colors ${
                        type === t.value
                          ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500 dark:border-brand-400 dark:bg-brand-900/30'
                          : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
                      }`}
                    >
                      <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        {t.label}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        {t.hint}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 'integration' && (
            <div className="space-y-5">
              <div>
                <label className="form-label" htmlFor="pi-webhook">
                  Webhook URL
                </label>
                <input
                  id="pi-webhook"
                  type="url"
                  className="form-input"
                  placeholder="https://api.client.ru/api/v1/parsdocs/webhook"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  autoFocus
                />
                <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                  Куда слать готовые результаты. Пусто — режим poll (клиент сам
                  читает GET /jobs/:id). Для webhook сгенерируем HMAC-секрет.
                </p>
              </div>

              <div>
                <label className="form-label" htmlFor="pi-expires">
                  Срок жизни токена
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="pi-expires"
                    type="number"
                    min={1}
                    max={3650}
                    className="form-input w-32"
                    placeholder="365"
                    value={expiresInDays}
                    onChange={(e) => setExpiresInDays(e.target.value)}
                  />
                  <span className="text-sm text-slate-500 dark:text-slate-400">
                    дней (пусто — бессрочно)
                  </span>
                </div>
              </div>

              <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  <span className={`transition-transform ${showAdvanced ? 'rotate-90' : ''}`}>
                    ▸
                  </span>
                  Лимиты шлюза (необязательно)
                </button>

                {showAdvanced && (
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <div>
                      <label className="form-label text-xs" htmlFor="pi-llm">
                        LLM, токенов/сутки
                      </label>
                      <input
                        id="pi-llm"
                        type="number"
                        min={0}
                        className="form-input"
                        placeholder="без лимита"
                        value={llmBudget}
                        onChange={(e) => setLlmBudget(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="form-label text-xs" htmlFor="pi-dadata">
                        DaData, вызовов/сутки
                      </label>
                      <input
                        id="pi-dadata"
                        type="number"
                        min={0}
                        className="form-input"
                        placeholder="без лимита"
                        value={dadataBudget}
                        onChange={(e) => setDadataBudget(e.target.value)}
                      />
                    </div>
                  </div>
                )}
              </div>

              {error && <div className="error-banner">{error}</div>}
            </div>
          )}

          {step === 'done' && result && <CredentialsPanel result={result} />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-200 px-6 py-4 dark:border-slate-800">
          {step === 'identity' && (
            <>
              <button type="button" className="btn-ghost" onClick={onClose}>
                Отмена
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!canNext}
                onClick={() => setStep('integration')}
              >
                Далее →
              </button>
            </>
          )}

          {step === 'integration' && (
            <>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setStep('identity')}
              >
                ← Назад
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={provision.isPending}
                onClick={submit}
              >
                {provision.isPending ? 'Создаём…' : 'Создать инстанс'}
              </button>
            </>
          )}

          {step === 'done' && (
            <button type="button" className="btn-primary ml-auto" onClick={onClose}>
              Готово
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Step rail ──────────────────────────────────────────────────────────

function StepRail({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: 'identity', label: 'Инстанс' },
    { id: 'integration', label: 'Интеграция' },
    { id: 'done', label: 'Ключи' },
  ];
  const activeIdx = steps.findIndex((s) => s.id === step);

  return (
    <div className="mt-4 flex items-center gap-2">
      {steps.map((s, i) => {
        const state = i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'todo';
        return (
          <div key={s.id} className="flex flex-1 items-center gap-2">
            <div
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                state === 'done'
                  ? 'bg-emerald-500 text-white'
                  : state === 'active'
                    ? 'bg-brand-600 text-white dark:bg-brand-500'
                    : 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400'
              }`}
            >
              {state === 'done' ? '✓' : i + 1}
            </div>
            <span
              className={`text-xs font-medium ${
                state === 'todo'
                  ? 'text-slate-400 dark:text-slate-500'
                  : 'text-slate-700 dark:text-slate-200'
              }`}
            >
              {s.label}
            </span>
            {i < steps.length - 1 && (
              <div
                className={`h-px flex-1 ${
                  i < activeIdx
                    ? 'bg-emerald-400'
                    : 'bg-slate-200 dark:bg-slate-700'
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Credentials panel ──────────────────────────────────────────────────

function CredentialsPanel({ result }: { result: ProvisionInstanceResult }) {
  const baseUrl = window.location.origin;
  const envBlock = [
    `PARSDOCS_BASE_URL=${baseUrl}`,
    `PARSDOCS_API_KEY=${result.plaintext_token}`,
    ...(result.webhook_secret
      ? [`PARSDOCS_WEBHOOK_SECRET=${result.webhook_secret}`]
      : []),
  ].join('\n');

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
        <span className="text-lg leading-none">✓</span>
        <div>
          Инстанс создан. Скопируйте блок ниже и передайте клиенту через
          защищённый канал — секреты показываются{' '}
          <span className="font-semibold">только один раз</span>.
        </div>
      </div>

      <CopyBlock label=".env блок для клиента" value={envBlock} multiline />

      <details className="text-sm">
        <summary className="cursor-pointer text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
          Идентификаторы (для справки)
        </summary>
        <div className="mt-2 space-y-1 rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-800/50">
          <IdRow label="organization_id" value={result.organization_id} />
          <IdRow label="user_id" value={result.user_id} />
          <IdRow label="project_id" value={result.project_id} />
        </div>
      </details>
    </div>
  );
}

function IdRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className="font-mono text-slate-700 dark:text-slate-300">{value}</span>
    </div>
  );
}

function CopyBlock({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (multiline) {
      ref.current?.focus();
      ref.current?.select();
    }
  }, [multiline]);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        ref.current?.select();
        // eslint-disable-next-line deprecation/deprecation
        document.execCommand('copy');
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      ref.current?.select();
    }
  };

  const rows = value.split('\n').length;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          {label}
        </span>
        <button type="button" className="btn-ghost text-xs" onClick={handleCopy}>
          {copied ? '✓ Скопировано' : '⧉ Копировать'}
        </button>
      </div>
      <textarea
        ref={ref}
        readOnly
        value={value}
        rows={rows}
        className="form-input resize-none font-mono text-xs leading-relaxed"
        onFocus={(e) => e.currentTarget.select()}
      />
    </div>
  );
}
