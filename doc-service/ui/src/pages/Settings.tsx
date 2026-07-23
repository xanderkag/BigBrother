import { Link } from 'react-router-dom';
import { clearToken, getToken } from '@/lib/auth';
import {
  useProvidersStatus,
  useSettings,
  type ProvidersStatus,
  type SettingsSnapshot,
} from '@/queries/settings';

/**
 * Settings — read-only snapshot конфигурации сервиса. Все секреты
 * заменены на флаги "configured / not set" (backend никогда не отдаёт
 * plaintext-секреты). Эта страница нужна админу чтобы быстро понять
 * "как настроен прод" без доступа к .env на хосте.
 *
 * CRUD провайдеров — в /providers (отдельная страница).
 */
export default function SettingsPage() {
  const settings = useSettings();
  const providers = useProvidersStatus();

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Настройки
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Конфигурация сервиса и LLM-провайдеров. Read-only snapshot — изменения
          применяются через `.env` и рестарт контейнера.
        </p>
      </header>

      {settings.isLoading || providers.isLoading ? (
        <SkeletonGrid />
      ) : settings.error ? (
        <ErrorBanner err={settings.error} />
      ) : (
        <>
          {providers.data && <ProvidersCard data={providers.data} />}
          {settings.data && (
            <>
              <OcrCard data={settings.data} />
              <StorageCard data={settings.data} />
              <LimitsCard data={settings.data} />
              <EndpointsCard />
              <SessionCard />
            </>
          )}
        </>
      )}
    </div>
  );
}

function ProvidersCard({ data }: { data: ProvidersStatus }) {
  return (
    <div className="card">
      <div className="card-body">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="card-title">
            LLM upstream{' '}
            <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
              (inference-service)
            </span>
          </h3>
          <div className="flex items-center gap-2">
            <StatusBadge status={data.upstream} />
            <Link to="/providers" className="btn-ghost text-xs">
              → Provider keys
            </Link>
          </div>
        </div>

        {data.upstream === 'not_configured' && (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            inference-service не подключён (
            <code className="font-mono text-xs">LLM_INFERENCE_URL</code> пустой).
            LLM-парсеры (УПД, ТТН, акты) деградируют до пустых результатов и
            needs_review.
          </p>
        )}

        {data.upstream === 'unreachable' && (
          <div className="error-banner text-sm">
            <div>
              <p className="font-medium">inference-service недоступен</p>
              {data.error && (
                <p className="mt-1 font-mono text-xs">{data.error}</p>
              )}
            </div>
          </div>
        )}

        {data.upstream === 'ok' && (
          <>
            <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
              Активный бэкенд переключается через{' '}
              <code className="font-mono">BACKEND=</code> в env
              inference-service. Требует рестарта контейнера.
            </p>
            <div className="space-y-2">
              {Object.entries(data.available).map(([name, info]) => {
                const isActive = name === data.active;
                return (
                  <div
                    key={name}
                    className={`flex items-start gap-4 rounded-lg p-3 ${
                      isActive
                        ? 'border border-indigo-200 bg-indigo-50/50 dark:border-indigo-900 dark:bg-indigo-950/30'
                        : 'bg-slate-50/50 dark:bg-slate-950/30'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-medium text-slate-900 dark:text-slate-100">
                          {name}
                        </span>
                        {isActive && <span className="badge-indigo">active</span>}
                        {info.configured ? (
                          <span className="badge-emerald">configured</span>
                        ) : (
                          <span className="badge-slate">not configured</span>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {info.description}
                      </div>
                      {info.model && (
                        <div className="mt-0.5 font-mono text-xs text-slate-400 dark:text-slate-500">
                          {info.model}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {Object.keys(data.available).length === 0 && (
                <p className="text-sm text-slate-400 dark:text-slate-500">провайдеров нет</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ProvidersStatus['upstream'] }) {
  if (status === 'ok') return <span className="badge-emerald">connected</span>;
  if (status === 'unreachable') return <span className="badge-rose">unreachable</span>;
  return <span className="badge-slate">not connected</span>;
}

function OcrCard({ data }: { data: SettingsSnapshot }) {
  const t = data.thresholds;
  const eng = data.ocr_engines;
  return (
    <div className="card">
      <div className="card-body">
        <h3 className="card-title mb-3">OCR pipeline</h3>
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          Confidence-пороги от 0.0 до 1.0. Если уверенность OCR-движка выше
          порога — результат принимается, цепочка останавливается; иначе
          пробуется следующий движок. <code className="font-mono">needs_review</code>{' '}
          — финальный порог, ниже которого job уходит на ручную проверку.
        </p>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Kv k="pdf-parse accept" v={t.pdf_text} />
          <Kv k="tesseract accept" v={t.tesseract} />
          <Kv k="vision-llm accept" v={t.vision_llm} />
          <Kv k="needs_review threshold" v={t.needs_review} />
          <Kv k="regex-fallback threshold" v={t.regex_fallback} />
          <Kv k="tesseract langs" v={eng.tesseract_langs} />
        </dl>
        <div className="mt-4 space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
              vision-llm engine
            </span>
            {eng.vision_llm.enabled ? (
              <span className="badge-emerald">enabled</span>
            ) : (
              <span className="badge-slate">disabled</span>
            )}
          </div>
          {eng.vision_llm.url && (
            <div className="font-mono text-xs text-slate-400 dark:text-slate-500">
              {eng.vision_llm.url}
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
              yandex-vision engine
            </span>
            {eng.yandex_vision.enabled ? (
              <span className="badge-amber">enabled</span>
            ) : (
              <span className="badge-slate">disabled</span>
            )}
          </div>
          {eng.yandex_vision.enabled && (
            <div className="warning-banner text-xs">
              <div>
                <strong>⚠</strong> {eng.yandex_vision.pii_warning}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StorageCard({ data }: { data: SettingsSnapshot }) {
  return (
    <div className="card">
      <div className="card-body">
        <h3 className="card-title mb-3">Storage &amp; sweepers</h3>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Kv k="backend" v={data.storage.backend} />
          <Kv k="dir" v={data.storage.dir} mono />
          <Kv k="file retention" v={`${data.storage.retention_days} days`} />
          <Kv k="worker concurrency" v={data.worker.concurrency} />
          <Kv
            k="pending sweep"
            v={`${data.sweepers.pending_interval_ms / 1000}s (grace ${data.sweepers.pending_grace_seconds}s)`}
          />
          <Kv
            k="cleanup sweep"
            v={`${Math.round(data.sweepers.file_cleanup_interval_ms / 60000)} мин`}
          />
          <Kv
            k="audit retention"
            v={`${data.sweepers.audit_log_retention_days} days (sweep ${Math.round(
              data.sweepers.audit_log_interval_ms / 3600000,
            )}h)`}
          />
        </dl>
      </div>
    </div>
  );
}

function LimitsCard({ data }: { data: SettingsSnapshot }) {
  return (
    <div className="card">
      <div className="card-body">
        <h3 className="card-title mb-3">Лимиты &amp; секреты</h3>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Kv k="max upload" v={`${data.limits.max_upload_mb} MB`} />
          <Kv
            k="max metadata"
            v={`${(data.limits.max_metadata_bytes / 1024).toFixed(0)} KB`}
          />
          <KvNode
            k="API_KEY"
            v={
              data.auth.api_key_configured ? (
                <span className="badge-emerald">configured</span>
              ) : (
                <span className="badge-rose">not set</span>
              )
            }
          />
          <KvNode
            k="webhook HMAC"
            v={
              data.webhook.hmac_secret_configured ? (
                <span className="badge-emerald">configured</span>
              ) : (
                <span className="badge-rose">default (change me)</span>
              )
            }
          />
          <Kv k="webhook attempts" v={data.webhook.max_attempts} />
          {/* FX-1: курс USD→RUB для стоимости валютных LLM-вызовов */}
          <KvNode
            k="курс USD→RUB"
            v={
              data.fx.usd_rub != null ? (
                <span>
                  <span className="font-mono">{data.fx.usd_rub.toFixed(2)} ₽</span>{' '}
                  <span className="text-xs text-slate-400 dark:text-slate-500">
                    {data.fx.source.startsWith('cbr:')
                      ? `ЦБ · ${data.fx.source.slice(4)}`
                      : data.fx.source.startsWith('config')
                        ? 'из конфига'
                        : ''}
                    {!data.fx.cbr_enabled ? ' · авто-ЦБ выкл' : ''}
                  </span>
                </span>
              ) : (
                <span className="badge-amber" title="курс не задан — валютный расход помечается estimate">
                  не задан
                </span>
              )
            }
          />
        </dl>
      </div>
    </div>
  );
}

function EndpointsCard() {
  const link = (path: string) => (
    <a
      href={path}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-sm text-brand-600 hover:underline dark:text-brand-400"
    >
      {path}
    </a>
  );
  return (
    <div className="card">
      <div className="card-body">
        <h3 className="card-title mb-3">Endpoints</h3>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Kv k="API base" v="/api/v1" mono />
          <KvNode k="Swagger UI" v={link('/docs')} />
          <KvNode k="OpenAPI JSON" v={link('/docs/json')} />
          <KvNode k="Health" v={link('/health')} />
          <KvNode k="Ready" v={link('/ready')} />
          <KvNode k="Metrics" v={link('/metrics')} />
        </dl>
      </div>
    </div>
  );
}

function SessionCard() {
  const token = getToken();
  const masked = token ? '••••••••' + token.slice(-6) : '—';
  return (
    <div className="card">
      <div className="card-body">
        <h3 className="card-title mb-3">Сессия</h3>
        <dl className="mb-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Kv k="Token" v={masked} mono />
        </dl>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            clearToken();
            window.location.href = '/ui/login';
          }}
        >
          Выйти
        </button>
      </div>
    </div>
  );
}

function Kv({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed border-slate-200 py-1 last:border-0 dark:border-slate-800">
      <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{k}</dt>
      <dd
        className={`text-right ${
          mono ? 'font-mono text-xs' : 'text-sm'
        } text-slate-900 dark:text-slate-100`}
      >
        {v}
      </dd>
    </div>
  );
}

function KvNode({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed border-slate-200 py-1 last:border-0 dark:border-slate-800">
      <dt className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="space-y-4">
      {[1, 2, 3].map((i) => (
        <div key={i} className="card">
          <div className="card-body">
            <div className="mb-3 h-5 w-40 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
            <div className="space-y-2">
              {[1, 2, 3, 4].map((j) => (
                <div
                  key={j}
                  className="h-3 w-full animate-pulse rounded bg-slate-100 dark:bg-slate-800/60"
                />
              ))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ErrorBanner({ err }: { err: unknown }) {
  return (
    <div className="error-banner">
      <div>
        <p className="font-medium">Ошибка загрузки настроек</p>
        <p className="mt-1 text-xs">
          {err instanceof Error ? err.message : String(err)}
        </p>
      </div>
    </div>
  );
}
