/**
 * «Подключения» — единый экран внешних сервисов (P0 пересборки настроек).
 *
 * Сводит бывшие «Провайдеры/модели» + «Интеграции» в один вид: каждый сервис —
 * одна карточка, сгруппированная по НАЗНАЧЕНИЮ (Разбор / Распознавание /
 * Обогащение·Геокод). Карточка = провайдер (provider_settings) ⨝ коннектор
 * (gateway_connectors) ⨝ расход (gateway/usage) — клиентский join, без новых
 * ручек. Развёрнутая панель: подключение → рубильник → расход → история.
 *
 * Честность контролов (см. docs/SETTINGS_IA.md):
 *   - редактирование креда/модели — переиспользуем ProviderEditor 1:1;
 *   - ★ активная — set-default для llm/dadata/yandex_maps (findDefault читает);
 *   - рубильник — ТОЛЬКО Vision: его egress-гейт (yandex-gate) безусловный и
 *     fail-closed. У llm/dadata/yandex_maps connector.enabled гейтит лишь при
 *     config.llmGateway.quotaEnabled (default false), а их request-time гейт —
 *     env-конфиг (dadataCfg.enabled и т.п.), не строка БД. Тумблер для них =
 *     ложное «отключение» → не показываем;
 *   - расход per-card — только для 1:1 провайдер↔коннектор (vision/dadata/
 *     yandex_maps). У llm много моделей на один коннектор → цифра была бы общим
 *     агрегатом шлюза, поэтому её не атрибутируем модели;
 *   - лимит — не обещаем «режет»: для Vision он мягкий, для gateway — за
 *     quotaEnabled; формулировка честная;
 *   - фейков (OCR-«исполнитель», secret_key) на этом экране нет by construction.
 */
import { useMemo, useState } from 'react';
import { useCurrentUser } from '@/queries/me';
import {
  useProviders,
  useSetDefaultProvider,
  type ProviderEntry,
  type ProviderKind,
} from '@/queries/providers';
import {
  useConnectors,
  useGatewayUsage,
  usePatchConnector,
  useGatewayChannelKeys,
  usePutGatewayChannelKey,
  type GatewayConnector,
  type GatewayChannelKeyState,
} from '@/queries/gateway';
import { useAuditLog } from '@/queries/auditLog';
import { ProviderEditor } from '@/pages/Providers';
import { formatNumber } from '@/lib/format';

/* ─────────────────────────── справочники ─────────────────────────── */

type Group = { key: string; title: string; kinds: ProviderKind[]; addKind?: ProviderKind };
const GROUPS: Group[] = [
  { key: 'parse', title: 'Модели разбора · LLM', kinds: ['llm'], addKind: 'llm' },
  { key: 'ocr', title: 'Распознавание · OCR', kinds: ['ocr'] },
  { key: 'enrich', title: 'Обогащение · Геокод', kinds: ['dadata', 'yandex_maps'] },
];

const KIND_ROLE: Record<string, string> = {
  llm: 'Извлечение полей из текста',
  ocr: 'Распознавание сканов',
  dadata: 'ИНН → ЕГРЮЛ-обогащение',
  yandex_maps: 'Адрес → геокод',
};

/** Строковое значение ключа extra (JSONB) без падения на не-строке. */
function extraStr(p: ProviderEntry, key: string): string {
  const v = p.extra?.[key];
  return typeof v === 'string' ? v : '';
}

/** Коннектор за провайдером (gateway_connectors.slug ↔ provider). */
function connectorFor(
  p: ProviderEntry,
  connectors: GatewayConnector[],
): GatewayConnector | undefined {
  const by = (s: string) => connectors.find((c) => c.slug === s);
  if (p.kind === 'llm') return by('llm');
  if (p.kind === 'dadata') return by('dadata');
  if (p.kind === 'yandex_maps') return by('yandex_maps');
  if (p.kind === 'ocr' && p.id === 'yandex-vision') return by('yandex_vision');
  return undefined;
}

/** Бейдж «локально / облако» — ВЫЧИСЛЯЕМ из backend/upstream, не флаг. */
function placement(p: ProviderEntry): { label: string; cls: string } {
  if (p.kind === 'ocr')
    return p.id === 'yandex-vision'
      ? { label: 'облако', cls: 'badge-sky' }
      : { label: 'локально', cls: 'badge-emerald' };
  if (p.kind === 'dadata' || p.kind === 'yandex_maps')
    return { label: 'облако', cls: 'badge-sky' };
  // llm: локально, если upstream смотрит на внутренний хост или backend=qwen
  const backend = extraStr(p, 'backend');
  const upstream = extraStr(p, 'upstream_base_url');
  const local =
    backend === 'qwen' ||
    /\/\/(localhost|127\.|10\.|172\.|192\.168\.|ollama|vllm|inference)/i.test(upstream);
  return local ? { label: 'локально', cls: 'badge-emerald' } : { label: 'облако', cls: 'badge-sky' };
}

/** Рубильник у Vision — egress-предупреждение. */
const VISION_ID = 'yandex-vision';

function todayISO(): string {
  // UTC-дата: started_at — TIMESTAMPTZ, сессия БД в UTC → граница совпадает с
  // серверным now()::date (тем же «сегодня», что считает checkConsumerQuota).
  // Локальная дата браузера сдвинула бы окно на UTC-offset (первые часы суток
  // в UTC+3 давали бы «сегодня 0» при реальном расходе).
  return new Date().toISOString().slice(0, 10);
}

/* ─────────────────────────── страница ─────────────────────────── */

export default function ConnectionsPage() {
  const me = useCurrentUser();
  const isSuperAdmin = me.data?.is_super_admin ?? false;

  const providersQ = useProviders();
  const connectorsQ = useConnectors();
  const usageQ = useGatewayUsage({ from: todayISO() });

  const [editing, setEditing] = useState<{ provider: ProviderEntry | null; isNew: boolean } | null>(
    null,
  );

  const providers = providersQ.data?.items ?? [];
  const connectors = connectorsQ.data ?? [];

  // Расход за сегодня по коннектору (сумма success-units).
  const todayByConnector = useMemo(() => {
    const m = new Map<string, { calls: number; units: number }>();
    for (const g of usageQ.data?.groups ?? []) {
      if (g.status !== 'success') continue;
      const cur = m.get(g.connector) ?? { calls: 0, units: 0 };
      cur.calls += g.calls;
      cur.units += g.units;
      m.set(g.connector, cur);
    }
    return m;
  }, [usageQ.data]);

  // Баннер инстанса — из активных провайдеров, без нового бэка.
  const banner = useMemo(() => {
    const llm = providers.find((p) => p.kind === 'llm' && p.is_default && p.is_active);
    const vision = providers.find((p) => p.id === VISION_ID);
    const visionOn =
      vision?.is_active && connectors.find((c) => c.slug === 'yandex_vision')?.enabled;
    const dadata = providers.find((p) => p.kind === 'dadata' && p.is_default && p.is_active);
    const maps = providers.find((p) => p.kind === 'yandex_maps' && p.is_default && p.is_active);
    return { llm, visionOn, dadata, maps };
  }, [providers, connectors]);

  const loading = providersQ.isLoading || connectorsQ.isLoading;
  // connectors/usage требуют super_admin → для обычного admin они 403'ят. Это
  // обогащение, а не базовые данные: провайдеры рендерятся и без них. Поэтому
  // их ошибку НЕ поднимаем в фатальный баннер (иначе спурьёзный «Ошибка»).
  const err = providersQ.error || (isSuperAdmin ? connectorsQ.error : null);

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Подключения</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Внешние сервисы и модели этого инстанса. Каждый сервис — одна карточка:
          подключение, статус, расход и история в одном месте.
        </p>
      </div>

      {/* Баннер инстанса */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg border border-slate-200 bg-indigo-50/60 px-4 py-2.5 text-sm dark:border-slate-800 dark:bg-indigo-950/30">
        <span className="inline-flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
          <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,.2)]" />
          Активно на этом инстансе
        </span>
        <BannerItem label="Разбор" value={banner.llm?.display_name} />
        <BannerItem label="Распознавание" value={banner.visionOn ? 'Yandex Vision' : 'встроенный OCR'} />
        <BannerItem label="Обогащение" value={banner.dadata?.display_name} />
        <BannerItem label="Геокод" value={banner.maps?.display_name} />
      </div>

      {err && (
        <div className="error-banner">
          Ошибка загрузки: {err instanceof Error ? err.message : String(err)}
        </div>
      )}

      {loading && <div className="text-sm text-slate-500 dark:text-slate-400">Загрузка…</div>}

      {!loading &&
        GROUPS.map((g) => {
          const rows = providers.filter((p) => g.kinds.includes(p.kind));
          if (rows.length === 0 && !g.addKind) return null;
          return (
            <section key={g.key} className="space-y-3">
              <div className="flex items-baseline justify-between gap-3 px-0.5">
                <h2 className="font-mono text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {g.title}
                </h2>
                {g.addKind && (
                  <button
                    type="button"
                    className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                    onClick={() => setEditing({ provider: null, isNew: true })}
                  >
                    + добавить модель
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {rows.map((p) => {
                  const conn = connectorFor(p, connectors);
                  return (
                    <ConnectionCard
                      key={p.id}
                      provider={p}
                      connector={conn}
                      today={conn ? todayByConnector.get(conn.slug) : undefined}
                      isSuperAdmin={isSuperAdmin}
                      onEdit={() => setEditing({ provider: p, isNew: false })}
                    />
                  );
                })}
                {rows.length === 0 && (
                  <p className="text-sm text-slate-400 dark:text-slate-500">Пока не настроено.</p>
                )}
              </div>
            </section>
          );
        })}

      {/* Ключи каналов шлюза — только super_admin (ручки 403 для остальных). */}
      {!loading && isSuperAdmin && <GatewayKeysSection />}

      {editing && (
        <ProviderEditor
          initial={editing.isNew ? null : editing.provider}
          isNew={editing.isNew}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/* ─────────────────── ключи каналов шлюза (SLAI) ─────────────────── */

/**
 * «Пользователь вносит ключ сам»: Anthropic (chat) / OpenAI (embeddings) /
 * DaData — ключи внешних каналов LLM-шлюза вводятся здесь, хранятся
 * шифрованно в БД и НЕ передаются через чат/почту. env-ключ хоста, если
 * задан, побеждает — секция это честно показывает.
 */
function GatewayKeysSection() {
  const keysQ = useGatewayChannelKeys();
  const [editing, setEditing] = useState<GatewayChannelKeyState | null>(null);

  return (
    <section className="space-y-3">
      <div className="px-0.5">
        <h2 className="font-mono text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Ключи каналов шлюза · SLAI
        </h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Внешние ключи каналов /v1/* (chat · embeddings · DaData). Вносите ключ прямо здесь —
          он шифруется при хранении (AES-256-GCM) и никогда не отображается целиком.
          Шлюз подхватывает новый ключ в течение ~минуты.
        </p>
      </div>

      {keysQ.isLoading && (
        <div className="text-sm text-slate-500 dark:text-slate-400">Загрузка…</div>
      )}
      {keysQ.error && (
        <div className="error-banner">
          Ошибка загрузки ключей: {keysQ.error instanceof Error ? keysQ.error.message : String(keysQ.error)}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {(keysQ.data ?? []).map((k) => (
          <ChannelKeyCard key={k.channel} state={k} onEdit={() => setEditing(k)} />
        ))}
      </div>

      {editing && <ChannelKeyModal state={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function ChannelKeyCard({ state: k, onEdit }: { state: GatewayChannelKeyState; onEdit: () => void }) {
  // chat в режиме openai_compat (kb-docker, локальный Ollama) ключа не требует —
  // честно говорим об этом вместо «ключ не задан».
  const keylessBackend = k.channel === 'chat' && k.backend === 'openai_compat';

  return (
    <div className="card space-y-2.5 p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold text-slate-900 dark:text-slate-100">{k.vendor}</span>
        <span className={`badge ${k.channel_enabled ? 'badge-emerald' : 'badge-slate'}`}>
          {k.channel_enabled ? 'канал вкл' : 'канал выкл'}
        </span>
      </div>

      <div className="text-[13px] text-slate-600 dark:text-slate-400">{k.title}</div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11.5px]">
        {keylessBackend ? (
          <span className="text-slate-400 dark:text-slate-500">
            backend openai_compat — ключ не используется
          </span>
        ) : k.active_source === 'env' ? (
          <span className="text-sky-600 dark:text-sky-400">ключ из env хоста</span>
        ) : k.active_source === 'ui' ? (
          <span className="text-emerald-600 dark:text-emerald-400">
            внесён через UI {k.api_key_masked}
          </span>
        ) : (
          <span className="text-amber-600 dark:text-amber-400">ключ не задан</span>
        )}
      </div>

      {k.env_configured && k.ui_configured && (
        <p className="text-[11.5px] leading-snug text-slate-500 dark:text-slate-400">
          В env хоста тоже задан ключ — он имеет приоритет над внесённым здесь.
        </p>
      )}

      {!keylessBackend && (
        <div className="flex justify-end pt-0.5">
          <button type="button" className="btn-ghost text-xs" onClick={onEdit}>
            {k.ui_configured ? 'Заменить ключ' : 'Внести ключ'}
          </button>
        </div>
      )}
    </div>
  );
}

function ChannelKeyModal({ state: k, onClose }: { state: GatewayChannelKeyState; onClose: () => void }) {
  const put = usePutGatewayChannelKey();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const save = async (apiKey: string | null) => {
    setError(null);
    try {
      await put.mutateAsync({ channel: k.channel, api_key: apiKey });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div className="card w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="card-header">
          <h3 className="card-title">
            {k.vendor} — ключ канала {k.channel}
          </h3>
          <button type="button" className="btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="card-body space-y-3">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Вставьте ключ {k.vendor}. Он будет зашифрован при сохранении
            (провайдер <code className="font-mono">{k.provider_id}</code>) и больше
            никогда не отобразится целиком — только маска.
          </p>
          {k.env_configured && (
            <p className="rounded-md bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:bg-sky-950/40 dark:text-sky-200">
              На этом хосте ключ задан в env — он останется приоритетным, пока его
              не уберут из env. Внесённый здесь ключ станет активным после этого.
            </p>
          )}
          <div>
            <label className="form-label">API-ключ</label>
            <input
              type="password"
              className="form-input font-mono text-sm"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={k.vendor === 'Anthropic' ? 'sk-ant-…' : k.vendor === 'OpenAI' ? 'sk-…' : 'токен DaData'}
              autoFocus
              autoComplete="off"
            />
          </div>
          {error && <div className="error-banner">{error}</div>}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-800 dark:bg-slate-900/40">
          {k.ui_configured ? (
            <button
              type="button"
              className="btn-ghost text-xs text-rose-600 dark:text-rose-400"
              disabled={put.isPending}
              onClick={() => save(null)}
            >
              Очистить ключ
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>
              Отмена
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={put.isPending || value.trim().length < 8}
              onClick={() => save(value.trim())}
            >
              {put.isPending ? 'Сохраняю…' : 'Сохранить'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BannerItem({ label, value }: { label: string; value?: string | null }) {
  return (
    <span className="text-slate-600 dark:text-slate-400">
      {label} —{' '}
      {value ? (
        <b className="font-medium text-slate-900 dark:text-slate-100">{value}</b>
      ) : (
        <span className="text-slate-400 dark:text-slate-500">не настроено</span>
      )}
    </span>
  );
}

/* ─────────────────────────── карточка ─────────────────────────── */

function ConnectionCard({
  provider: p,
  connector,
  today,
  isSuperAdmin,
  onEdit,
}: {
  provider: ProviderEntry;
  connector?: GatewayConnector;
  today?: { calls: number; units: number };
  isSuperAdmin: boolean;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const setDefault = useSetDefaultProvider();
  const patchConnector = usePatchConnector();

  const place = placement(p);
  const isVision = p.id === VISION_ID;
  // Дефолт (★) существует только для типов, которые реально резолвит
  // findDefault(kind). Для ocr его нет — если в БД остался фейковый ocr-дефолт
  // (старый баг), НЕ рисуем ★/кольцо, иначе экран врёт про «активный OCR».
  const kindHasDefault = p.kind === 'llm' || p.kind === 'dadata' || p.kind === 'yandex_maps';
  const isDefault = p.is_default && kindHasDefault;
  const canSetDefault = kindHasDefault && !p.is_default;
  // Рубильник — ТОЛЬКО Vision: его egress-гейт (yandex-gate) fail-closed и
  // безусловный. У llm/dadata/yandex_maps connector.enabled срабатывает лишь при
  // config.llmGateway.quotaEnabled (default false), а request-time гейт у них —
  // env-конфиг (dadataCfg.enabled и т.п.), не эта строка БД. Показать их тумблер
  // = обещать отключение, которого по умолчанию не происходит. Не делаем.
  const showKill = !!connector && isVision;
  // Расход атрибутируем per-card только для 1:1 провайдер↔коннектор
  // (vision/dadata/yandex_maps). У llm много моделей на один коннектор 'llm' —
  // цифра была бы общим агрегатом шлюза на каждой карточке (ложная атрибуция).
  const oneToOne = !!connector && p.kind !== 'llm';

  const keyState = p.has_api_key ? (
    <span className="text-emerald-600 dark:text-emerald-400">ключ ✓</span>
  ) : p.kind === 'ocr' && !isVision ? null : (
    <span className="text-amber-600 dark:text-amber-400">ключ —</span>
  );

  const toggleKill = () => {
    if (!connector) return;
    patchConnector.mutate({ slug: connector.slug, patch: { enabled: !connector.enabled } });
  };

  return (
    <div
      className={`card space-y-2.5 p-4 ${
        isDefault ? 'ring-1 ring-indigo-300 dark:ring-indigo-500/40' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          {isDefault && <span className="text-indigo-600 dark:text-indigo-400">★</span>}
          <span className="font-semibold text-slate-900 dark:text-slate-100">{p.display_name}</span>
        </div>
        <span className={`badge ${place.cls}`}>{place.label}</span>
      </div>

      <div className="text-[13px] text-slate-600 dark:text-slate-400">
        {isDefault && p.kind === 'llm' ? 'Активная модель разбора' : KIND_ROLE[p.kind] ?? ''}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11.5px] text-slate-500 dark:text-slate-400">
        {p.model && <span className="break-all">{p.model}</span>}
        {isVision && extraStr(p, 'folder_id') && <span>folder ✓</span>}
        {keyState}
      </div>

      {/* Рубильник — только реальный (Vision egress / dadata / maps шлюз) */}
      {showKill && (
        <div className={`rounded-md px-3 py-2 ${isVision ? 'bg-amber-50 dark:bg-amber-950/30' : 'bg-slate-50 dark:bg-slate-800/40'}`}>
          <button
            type="button"
            disabled={!isSuperAdmin || patchConnector.isPending}
            onClick={toggleKill}
            className="flex w-full items-center gap-2.5 text-left disabled:opacity-60"
            title={isSuperAdmin ? undefined : 'Требуется super_admin'}
          >
            <Switch on={!!connector?.enabled} />
            <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
              {isVision ? 'Облачное распознавание' : connector?.display_name}
              {' — '}
              {connector?.enabled ? 'вкл' : 'выкл'}
            </span>
          </button>
          {isVision && (
            <p className="mt-1 text-[11.5px] leading-snug text-amber-700 dark:text-amber-300">
              При включении сканы (в т.ч. с ПДн) уходят в облако Яндекса. Выключение
              блокирует отправку сразу — egress-рубильник.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-0.5">
        <div className="flex items-center gap-3 text-xs">
          {oneToOne && connector ? (
            <span className="text-slate-500 dark:text-slate-400">
              сегодня <b className="tabular-nums text-slate-800 dark:text-slate-200">{formatNumber(today?.units ?? 0)}</b>{' '}
              {connector.unit_kind}
            </span>
          ) : p.kind === 'ocr' && !isVision ? (
            <span className="italic text-slate-400 dark:text-slate-500">read-only · всегда доступен</span>
          ) : p.kind === 'llm' ? (
            <span className="text-slate-400 dark:text-slate-500">расход — общий по шлюзу LLM</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          {canSetDefault && (
            <button
              type="button"
              className="btn-ghost text-xs"
              disabled={setDefault.isPending}
              onClick={() => setDefault.mutate(p.id)}
              title="Сделать активным исполнителем для этого типа"
            >
              ★ активной
            </button>
          )}
          {p.id !== 'tesseract' && (
            <button type="button" className="btn-ghost text-xs" onClick={onEdit}>
              Изменить
            </button>
          )}
          {p.id !== 'tesseract' && (
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? 'Свернуть' : 'Детали'}
            </button>
          )}
        </div>
      </div>

      {/* Расход отдаём в детали только для 1:1-коннектора (не llm). */}
      {open && <CardDetails provider={p} connector={oneToOne ? connector : undefined} />}
    </div>
  );
}

/* ─────────────────── детали: расход-спарклайн + история ─────────────────── */

function CardDetails({ provider: p, connector }: { provider: ProviderEntry; connector?: GatewayConnector }) {
  return (
    <div
      className={`grid grid-cols-1 gap-4 border-t border-slate-200 pt-3 dark:border-slate-800 ${
        connector ? 'sm:grid-cols-2' : ''
      }`}
    >
      {connector && <UsageBlock connector={connector} />}
      <HistoryBlock provider={p} connector={connector} />
    </div>
  );
}

/** Расход-спарклайн + честная формулировка лимита. Только для 1:1-коннектора. */
function UsageBlock({ connector }: { connector: GatewayConnector }) {
  const usage = useGatewayUsage({ connector: connector.slug, byDay: true });
  const isVision = connector.slug === 'yandex_vision';
  const series = useMemo(() => {
    const byDate = new Map<string, number>();
    for (const r of usage.data?.daily ?? []) {
      if (r.status && r.status !== 'success') continue;
      byDate.set(r.day, (byDate.get(r.day) ?? 0) + (r.units ?? 0));
    }
    return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map((e) => e[1]);
  }, [usage.data]);

  return (
    <div>
      <p className="mb-2 font-mono text-[10.5px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
        Расход · 30 дней ({connector.unit_kind})
      </p>
      <Sparkline values={series} />
      {connector.daily_cap != null && (
        <p className="mt-1.5 text-[11.5px] text-slate-500 dark:text-slate-400">
          {isVision ? (
            <>
              Лимит <b className="tabular-nums text-slate-700 dark:text-slate-300">{formatNumber(connector.daily_cap)}</b>/сут ·
              мягкий (возможен небольшой перерасход)
            </>
          ) : (
            <>
              Целевой лимит <b className="tabular-nums text-slate-700 dark:text-slate-300">{formatNumber(connector.daily_cap)}</b>/сут ·
              режет при включённом enforcement
            </>
          )}
        </p>
      )}
    </div>
  );
}

function HistoryBlock({ provider: p, connector }: { provider: ProviderEntry; connector?: GatewayConnector }) {
  // Склеиваем два источника: правки провайдера (ключ/модель) и правки коннектора
  // (рубильник/лимит — теперь логируются, P1). Мержим по времени.
  const provHist = useAuditLog({ entity: 'provider_setting', entity_id: p.id, limit: 5 });
  const connHist = useAuditLog(
    { entity: 'gateway_connector', entity_id: connector?.slug ?? '', limit: 5 },
    { enabled: !!connector },
  );
  const items = useMemo(() => {
    const merged = [
      ...(provHist.data?.items ?? []),
      ...(connector ? connHist.data?.items ?? [] : []),
    ];
    return merged.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 6);
  }, [provHist.data, connHist.data, connector]);
  const loading = provHist.isLoading || (!!connector && connHist.isLoading);

  const what = (e: (typeof items)[number]): string => {
    const verb = e.action === 'create' ? 'создан' : e.action === 'delete' ? 'удалён' : 'изменён';
    const scope = e.entity === 'gateway_connector' ? 'рубильник/лимит' : 'провайдер';
    return `${scope} ${verb}`;
  };

  return (
    <div>
      <p className="mb-2 font-mono text-[10.5px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
        История изменений
      </p>
      {loading ? (
        <p className="text-xs text-slate-400 dark:text-slate-500">…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-slate-400 dark:text-slate-500">Изменений не записано.</p>
      ) : (
        <ul className="space-y-1 text-[12.5px] text-slate-600 dark:text-slate-300">
          {items.map((e) => (
            <li key={`${e.entity}-${String(e.id)}`}>
              <span className="font-mono text-[11px] text-slate-400 dark:text-slate-500">
                {new Date(e.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>{' '}
              · {e.actor} · {what(e)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─────────────────────────── мелкие UI ─────────────────────────── */

function Switch({ on }: { on: boolean }) {
  return (
    <span
      className={`relative inline-block h-5 w-9 flex-none rounded-full transition-colors ${
        on ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
          on ? 'left-4' : 'left-0.5'
        }`}
      />
    </span>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <div className="text-xs text-slate-400 dark:text-slate-500">нет данных за период</div>;
  }
  const max = Math.max(...values, 1);
  const w = 220;
  const h = 34;
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * (h - 4) - 2}`)
    .join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block h-8 w-full">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" className="text-indigo-500 dark:text-indigo-400" />
    </svg>
  );
}
