import { useEffect, useRef, useState } from 'react';
import {
  useProvisionInstance,
  type ProvisionInstanceResult,
} from '@/queries/tenants';

interface Props {
  onClose: () => void;
}

type Step = 'form' | 'credentials';

export default function ProvisionInstanceModal({ onClose }: Props) {
  const provision = useProvisionInstance();
  const [step, setStep] = useState<Step>('form');
  const [result, setResult] = useState<ProvisionInstanceResult | null>(null);

  // form fields
  const [name, setName] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('365');

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await provision.mutateAsync({
        name: name.trim(),
        webhook_url: webhookUrl.trim() || null,
        expires_in_days: expiresInDays ? Number.parseInt(expiresInDays, 10) : null,
      });
      setResult(res);
      setStep('credentials');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="card flex w-full max-w-lg flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-header flex items-center justify-between">
          <h3 className="card-title">
            {step === 'form' ? 'Подключить инстанс' : 'Учётные данные'}
          </h3>
          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            aria-label="Закрыть"
          >
            ✕
          </button>
        </div>

        {step === 'form' ? (
          <form onSubmit={handleSubmit} className="space-y-4 p-5">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Создаст организацию, сервисного бота и API-ключ за один шаг.
            </p>

            <div>
              <label className="form-label" htmlFor="pi-name">
                Название *
              </label>
              <input
                id="pi-name"
                type="text"
                className="form-input w-full"
                placeholder="SLAI Клиент X"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div>
              <label className="form-label" htmlFor="pi-webhook">
                Webhook URL
              </label>
              <input
                id="pi-webhook"
                type="url"
                className="form-input w-full"
                placeholder="https://api.client.ru/api/v1/parsdocs/webhook"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-400">
                Оставьте пустым — будет режим poll (GET /jobs/:id)
              </p>
            </div>

            <div>
              <label className="form-label" htmlFor="pi-expires">
                Срок токена (дней)
              </label>
              <input
                id="pi-expires"
                type="number"
                min={1}
                max={3650}
                className="form-input w-full"
                placeholder="365"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
              />
              <p className="mt-1 text-xs text-slate-400">Оставьте пустым — без срока</p>
            </div>

            {error && (
              <div className="warning-banner text-sm">{error}</div>
            )}

            <div className="flex justify-end gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
              <button type="button" className="btn-secondary" onClick={onClose}>
                Отмена
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={provision.isPending || !name.trim()}
              >
                {provision.isPending ? 'Создаём…' : 'Создать'}
              </button>
            </div>
          </form>
        ) : (
          <CredentialsPanel result={result!} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

function CredentialsPanel({
  result,
  onClose,
}: {
  result: ProvisionInstanceResult;
  onClose: () => void;
}) {
  const baseUrl = window.location.origin;
  const envBlock = [
    `PARSDOCS_BASE_URL=${baseUrl}`,
    `PARSDOCS_API_KEY=${result.plaintext_token}`,
    ...(result.webhook_secret
      ? [`PARSDOCS_WEBHOOK_SECRET=${result.webhook_secret}`]
      : []),
  ].join('\n');

  const [copied, setCopied] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textRef.current?.focus();
    textRef.current?.select();
  }, []);

  const handleCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(envBlock);
      } else {
        textRef.current?.select();
        // eslint-disable-next-line deprecation/deprecation
        document.execCommand('copy');
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      textRef.current?.select();
    }
  };

  return (
    <div className="space-y-4 p-5">
      <div className="warning-banner">
        Учётные данные показываются <span className="font-semibold">один раз</span>.
        Скопируйте блок и передайте клиенту через защищённый канал.
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            .env блок для клиента
          </span>
          <button type="button" className="btn-ghost text-xs" onClick={handleCopy}>
            {copied ? '✓ Скопировано' : 'Копировать'}
          </button>
        </div>
        <textarea
          ref={textRef}
          readOnly
          value={envBlock}
          rows={result.webhook_secret ? 3 : 2}
          className="form-input w-full resize-none font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
      </div>

      <div className="space-y-1 rounded-lg bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
        <div>
          <span className="font-medium">org id:</span>{' '}
          <span className="font-mono">{result.organization_id}</span>
        </div>
        <div>
          <span className="font-medium">user id:</span>{' '}
          <span className="font-mono">{result.user_id}</span>
        </div>
        <div>
          <span className="font-medium">project id:</span>{' '}
          <span className="font-mono">{result.project_id}</span>
        </div>
      </div>

      <div className="flex justify-end border-t border-slate-200 pt-4 dark:border-slate-800">
        <button type="button" className="btn-primary" onClick={onClose}>
          Готово
        </button>
      </div>
    </div>
  );
}
