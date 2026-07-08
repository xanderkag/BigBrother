import { useMemo, useState } from 'react';
import { useCurrentUser } from '@/queries/me';
import {
  useConnectors,
  usePatchConnector,
  useBudgets,
  usePatchBudget,
  useGatewayUsage,
  type GatewayConnector,
  type ConsumerBudget,
  type UsageGroup,
} from '@/queries/gateway';
import {
  useProviders,
  useSetDefaultProvider,
  type ProviderEntry,
} from '@/queries/providers';
import { SkeletonTable } from '@/components/Skeleton';
import { formatNumber } from '@/lib/format';

/**
 * Интеграции — управление хабом внешних провайдеров Vanga
 * (Яндекс.Карты, DaData и т.п.) + дашборд расхода.
 *
 * Доступ: только super_admin (бэкенд гейтит Bearer'ом, тут — мягкий
 * экран-заглушка, чтобы admin'у org-уровня не показывать пустой каркас).
 *
 * Три блока:
 *   1. Коннекторы — тумблер вкл/спит + лимиты ключа (сутки/месяц).
 *   2. Бюджеты потребителей — личный суточный лимит на пару
 *      потребитель × коннектор.
 *   3. Расход — кто сколько вызовов/единиц/ошибок сжёг за период.
 */

/** Человеческая подпись единицы расхода. */
function unitLabel(unitKind: string): string {
  const map: Record<string, string> = {
    call: 'вызовы',
    calls: 'вызовы',
    request: 'запросы',
    requests: 'запросы',
    char: 'символы',
    chars: 'символы',
    character: 'символы',
    token: 'токены',
    tokens: 'токены',
    page: 'страницы',
    pages: 'страницы',
    minute: 'минуты',
    minutes: 'минуты',
    geocode: 'геокоды',
    geocodes: 'геокоды',
    route: 'маршруты',
    routes: 'маршруты',
  };
  return map[unitKind] ?? unitKind;
}

/** consumer===null → трафик root-ключа. */
function consumerLabel(consumer: string | null): string {
  return consumer ?? '(root)';
}

/**
 * Виды провайдеров, которые реально живут в provider_settings и резолвятся в
 * рантайме через `findDefault(kind)` — то есть у которых ЕСТЬ что выбирать.
 * Держать в синхроне с `ProviderKind` (storage/provider-settings.ts).
 *
 * Коннектор с другим provider_kind (например `yandex_vision`) имеет ровно
 * одного исполнителя — ему рисуем прочерк, а не селектор.
 */
const SELECTABLE_PROVIDER_KINDS = new Set(['llm', 'ocr', 'dadata', 'yandex_maps']);

export default function IntegrationsPage() {
  const me = useCurrentUser();

  if (me.isLoading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        Загрузка…
      </div>
    );
  }

  if (!me.data?.is_super_admin) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="warning-banner">
          Раздел «Интеграции» доступен только супер-администратору. Здесь
          настраивается общий хаб внешних провайдеров (карты, проверка
          контрагентов) и контроль расхода по всем компаниям.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Интеграции
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Общий хаб внешних сервисов (Яндекс.Карты, проверка контрагентов и
          др.): что включено, какие лимиты, и кто сколько расходует.
        </p>
      </header>

      <ConnectorsSection />
      <BudgetsSection />
      <UsageSection />
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   1. Коннекторы
   ════════════════════════════════════════════════════════════════════ */

function ConnectorsSection() {
  const { data, isLoading, error } = useConnectors();
  const connectors = data ?? [];
  // Провайдеры нужны, чтобы показать И дать переключить исполнителя коннектора.
  // Состояние загрузки прокидываем в строку: пока список не приехал, пустой
  // массив выглядел бы как «провайдеров нет» и селектор врал бы «настраивается
  // через окружение» во всех строках сразу.
  const providersQuery = useProviders();
  const providers = providersQuery.data?.items ?? [];
  const providersLoading = providersQuery.isPending;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Коннекторы
        </h2>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          Внешние сервисы за ключом платформы. «Исполнитель» — кто фактически
          выполняет работу (переключается без перезапуска). Тумблер
          включает/усыпляет сервис целиком; лимиты ограничивают расход всего ключа.
        </p>
      </div>

      {error && (
        <div className="error-banner">
          Ошибка: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {isLoading ? (
        <SkeletonTable rows={3} columns={7} />
      ) : connectors.length === 0 ? (
        <div className="card">
          <div className="card-body py-10 text-center">
            <p className="font-medium text-slate-700 dark:text-slate-300">
              Коннекторы не настроены
            </p>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Сервисы добавляются на стороне платформы. Когда появятся —
              они отобразятся здесь.
            </p>
          </div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2">Сервис</th>
                  <th className="px-4 py-2">Исполнитель</th>
                  <th className="px-4 py-2">Считаем в</th>
                  <th className="px-4 py-2">Статус</th>
                  <th className="px-4 py-2">Лимит ключа в сутки</th>
                  <th className="px-4 py-2">Лимит ключа в месяц</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {connectors.map((c) => (
                  <ConnectorRow
                    key={c.slug}
                    connector={c}
                    providers={providers}
                    providersLoading={providersLoading}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Переключатель исполнителя коннектора. Показывает активные provider_settings
 * того же `kind` и назначает дефолтного (`set-default`) — смена применяется
 * без перезапуска: `llm` читается через `findDefault('llm')` (VANGA-LLM-2),
 * `dadata` и `yandex_maps` — через свои `findDefault`.
 *
 * ⚠ Не добавляй сюда коннектор, чей `provider_kind` НИКТО не читает через
 * `findDefault(kind)` в рантайме. Иначе селектор запишет `is_default` в БД,
 * вернёт 200 — и не изменит ничего. Так было с попыткой завести `ocr`:
 * OCR-каскад собирается из env (`orchestrator.ts` + `router.ts`), а не из
 * provider_settings, поэтому «переключение» было бы ложью — и, что хуже,
 * читалось бы как отключение облачного OCR для ПДн-документов.
 *
 * Нет активных провайдеров этого kind → пишем это прямо, а не рисуем пустой
 * селектор. Пока список провайдеров грузится — показываем «…», иначе пустой
 * массив выглядел бы как «провайдеров нет».
 */
function ExecutorPicker({
  connector,
  providers,
  providersLoading,
}: {
  connector: GatewayConnector;
  providers: ProviderEntry[];
  providersLoading: boolean;
}) {
  const setDefault = useSetDefaultProvider();
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(
    () => providers.filter((p) => p.kind === connector.provider_kind && p.is_active),
    [providers, connector.provider_kind],
  );
  const current = candidates.find((p) => p.is_default) ?? null;

  if (providersLoading) {
    return <span className="text-xs text-slate-400 dark:text-slate-500">…</span>;
  }

  // Прочерк ставим ТОЛЬКО когда исполнитель у коннектора действительно
  // фиксирован — то есть его provider_kind вообще не из тех, что живут в
  // provider_settings (например `yandex_vision`: это и есть Яндекс, выбирать
  // не из чего).
  //
  // Раньше прочерк ставился по «нет кандидатов», и на свежей установке строки
  // llm/dadata/yandex_maps врали «исполнитель один»: провайдеры dadata и
  // yandex_maps ничем не засеяны, а засеянные llm приходят is_active=false.
  // Это маскировало ровно ту misconfiguration, ради которой админ сюда и зашёл.
  if (!SELECTABLE_PROVIDER_KINDS.has(connector.provider_kind)) {
    return (
      <span
        className="text-slate-400 dark:text-slate-500"
        title="У этой интеграции один исполнитель — выбирать не из чего"
      >
        —
      </span>
    );
  }

  // Вид провайдера настраиваемый, но активных нет → это реальная проблема
  // конфигурации, о которой надо сказать прямо, а не прятать за прочерком.
  if (candidates.length === 0) {
    return (
      <span className="text-xs text-amber-600 dark:text-amber-400">
        нет активных провайдеров
      </span>
    );
  }

  return (
    <div className="space-y-1">
      <select
        className="form-select w-48 text-sm"
        value={current?.id ?? ''}
        disabled={setDefault.isPending}
        aria-label={`Исполнитель для «${connector.display_name}»`}
        onChange={(e) => {
          const id = e.target.value;
          if (!id || id === current?.id) return;
          setError(null);
          setDefault.mutate(id, {
            onError: (err) => setError(err instanceof Error ? err.message : String(err)),
          });
        }}
      >
        {!current && <option value="">— не выбран —</option>}
        {candidates.map((p) => (
          <option key={p.id} value={p.id}>
            {p.display_name}
            {p.model ? ` · ${p.model}` : ''}
          </option>
        ))}
      </select>
      {error && (
        <div className="text-xs text-rose-600 dark:text-rose-400">{error}</div>
      )}
    </div>
  );
}

function ConnectorRow({
  connector,
  providers,
  providersLoading,
}: {
  connector: GatewayConnector;
  providers: ProviderEntry[];
  providersLoading: boolean;
}) {
  const patch = usePatchConnector();
  const [editing, setEditing] = useState(false);
  const [daily, setDaily] = useState<string>(
    connector.daily_cap === null ? '' : String(connector.daily_cap),
  );
  const [monthly, setMonthly] = useState<string>(
    connector.monthly_cap === null ? '' : String(connector.monthly_cap),
  );
  const [error, setError] = useState<string | null>(null);

  const toggleEnabled = () => {
    setError(null);
    patch.mutate(
      { slug: connector.slug, patch: { enabled: !connector.enabled } },
      { onError: (e) => setError(e instanceof Error ? e.message : String(e)) },
    );
  };

  const saveCaps = () => {
    setError(null);
    const parse = (s: string): number | null | undefined => {
      const t = s.trim();
      if (t === '') return null; // пусто = снять лимит
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0) return undefined; // невалидно
      return Math.floor(n);
    };
    const d = parse(daily);
    const m = parse(monthly);
    if (d === undefined || m === undefined) {
      setError('Лимит — целое число ≥ 0 или пусто (без лимита)');
      return;
    }
    patch.mutate(
      { slug: connector.slug, patch: { daily_cap: d, monthly_cap: m } },
      {
        onSuccess: () => setEditing(false),
        onError: (e) => setError(e instanceof Error ? e.message : String(e)),
      },
    );
  };

  const cancel = () => {
    setDaily(connector.daily_cap === null ? '' : String(connector.daily_cap));
    setMonthly(connector.monthly_cap === null ? '' : String(connector.monthly_cap));
    setError(null);
    setEditing(false);
  };

  const capCell = (v: number | null) =>
    v === null ? (
      <span className="text-slate-400 dark:text-slate-500">без лимита</span>
    ) : (
      <span className="tabular-nums">{formatNumber(v)}</span>
    );

  return (
    <>
      <tr className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
        <td className="px-4 py-2.5">
          <div className="font-medium text-slate-900 dark:text-slate-100">
            {connector.display_name}
          </div>
          <div className="font-mono text-xs text-slate-500 dark:text-slate-400">
            {connector.slug}
          </div>
        </td>
        <td className="px-4 py-2.5">
          <ExecutorPicker
            connector={connector}
            providers={providers}
            providersLoading={providersLoading}
          />
        </td>
        <td className="px-4 py-2.5 text-slate-600 dark:text-slate-400">
          {unitLabel(connector.unit_kind)}
        </td>
        <td className="px-4 py-2.5">
          <button
            type="button"
            onClick={toggleEnabled}
            disabled={patch.isPending}
            className="inline-flex items-center gap-2"
            title={connector.enabled ? 'Включён — нажмите, чтобы усыпить' : 'Спит — нажмите, чтобы включить'}
          >
            <Toggle on={connector.enabled} />
            <span
              className={connector.enabled ? 'badge-emerald' : 'badge-slate'}
            >
              {connector.enabled ? 'включён' : 'спит'}
            </span>
          </button>
        </td>
        {editing ? (
          <>
            <td className="px-4 py-2.5">
              <input
                type="number"
                min={0}
                className="form-input w-32 text-sm tabular-nums"
                value={daily}
                onChange={(e) => setDaily(e.target.value)}
                placeholder="без лимита"
              />
            </td>
            <td className="px-4 py-2.5">
              <input
                type="number"
                min={0}
                className="form-input w-32 text-sm tabular-nums"
                value={monthly}
                onChange={(e) => setMonthly(e.target.value)}
                placeholder="без лимита"
              />
            </td>
            <td className="px-4 py-2.5 text-right">
              <div className="flex items-center justify-end gap-1">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={patch.isPending}
                  onClick={saveCaps}
                >
                  {patch.isPending ? 'Сохраняю…' : 'Сохранить'}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={patch.isPending}
                  onClick={cancel}
                >
                  Отмена
                </button>
              </div>
            </td>
          </>
        ) : (
          <>
            <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300">
              {capCell(connector.daily_cap)}
            </td>
            <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300">
              {capCell(connector.monthly_cap)}
            </td>
            <td className="px-4 py-2.5 text-right">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setEditing(true)}
              >
                Лимиты
              </button>
            </td>
          </>
        )}
      </tr>
      {error && (
        <tr>
          <td colSpan={7} className="px-4 pb-2">
            <div className="error-banner text-xs">{error}</div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ════════════════════════════════════════════════════════════════════
   2. Бюджеты потребителей
   ════════════════════════════════════════════════════════════════════ */

function BudgetsSection() {
  const { data, isLoading, error } = useBudgets();
  const connectors = useConnectors();
  const [adding, setAdding] = useState(false);
  const budgets = data ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Бюджеты потребителей
          </h2>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            Личный суточный лимит конкретного потребителя на конкретный
            сервис. Без личного лимита потребитель ограничен только общим
            лимитом ключа.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary shrink-0"
          onClick={() => setAdding(true)}
        >
          + Добавить бюджет
        </button>
      </div>

      {error && (
        <div className="error-banner">
          Ошибка: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {isLoading ? (
        <SkeletonTable rows={3} columns={4} />
      ) : budgets.length === 0 && !adding ? (
        <div className="card">
          <div className="card-body py-10 text-center">
            <p className="font-medium text-slate-700 dark:text-slate-300">
              Персональных лимитов пока нет
            </p>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Добавьте лимит, чтобы ограничить отдельного потребителя по
              конкретному сервису.
            </p>
          </div>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2">Потребитель</th>
                  <th className="px-4 py-2">Сервис</th>
                  <th className="px-4 py-2">Лимит в сутки</th>
                  <th className="px-4 py-2">Статус</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {budgets.map((b) => (
                  <BudgetRow key={`${b.consumer ?? '∅'}::${b.connector}`} budget={b} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {adding && (
        <BudgetEditor
          connectors={connectors.data ?? []}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}

function BudgetRow({ budget }: { budget: ConsumerBudget }) {
  const patch = usePatchBudget();
  const [editing, setEditing] = useState(false);
  const [limit, setLimit] = useState<string>(
    budget.daily_budget === null ? '' : String(budget.daily_budget),
  );
  const [error, setError] = useState<string | null>(null);

  // root-трафик (consumer===null) нельзя адресно патчить — у него нет имени.
  const isRoot = budget.consumer === null;

  const toggleEnabled = () => {
    if (isRoot) return;
    setError(null);
    patch.mutate(
      { consumer: budget.consumer as string, connector: budget.connector, enabled: !budget.enabled },
      { onError: (e) => setError(e instanceof Error ? e.message : String(e)) },
    );
  };

  const saveLimit = () => {
    if (isRoot) return;
    setError(null);
    const t = limit.trim();
    let val: number | null;
    if (t === '') {
      val = null;
    } else {
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0) {
        setError('Лимит — целое число ≥ 0 или пусто (без лимита)');
        return;
      }
      val = Math.floor(n);
    }
    patch.mutate(
      { consumer: budget.consumer as string, connector: budget.connector, daily_budget: val },
      {
        onSuccess: () => setEditing(false),
        onError: (e) => setError(e instanceof Error ? e.message : String(e)),
      },
    );
  };

  const cancel = () => {
    setLimit(budget.daily_budget === null ? '' : String(budget.daily_budget));
    setError(null);
    setEditing(false);
  };

  return (
    <>
      <tr className="hover:bg-slate-50 dark:hover:bg-slate-900/40">
        <td className="px-4 py-2.5">
          {budget.consumer === null ? (
            <span className="font-mono text-xs text-slate-500 dark:text-slate-400" title="Трафик корневого ключа платформы">
              (root)
            </span>
          ) : (
            <span className="font-medium text-slate-900 dark:text-slate-100">
              {budget.consumer}
            </span>
          )}
        </td>
        <td className="px-4 py-2.5 font-mono text-xs text-slate-600 dark:text-slate-400">
          {budget.connector}
        </td>
        {editing ? (
          <td className="px-4 py-2.5">
            <input
              type="number"
              min={0}
              className="form-input w-32 text-sm tabular-nums"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="без лимита"
            />
          </td>
        ) : (
          <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300">
            {budget.daily_budget === null ? (
              <span className="text-slate-400 dark:text-slate-500">без лимита</span>
            ) : (
              <span className="tabular-nums">{formatNumber(budget.daily_budget)}</span>
            )}
          </td>
        )}
        <td className="px-4 py-2.5">
          <button
            type="button"
            onClick={toggleEnabled}
            disabled={patch.isPending || isRoot}
            className="inline-flex items-center gap-2 disabled:cursor-not-allowed"
            title={
              isRoot
                ? 'Трафик root-ключа не редактируется адресно'
                : budget.enabled
                ? 'Включён — нажмите, чтобы отключить'
                : 'Отключён — нажмите, чтобы включить'
            }
          >
            <Toggle on={budget.enabled} />
            <span className={budget.enabled ? 'badge-emerald' : 'badge-slate'}>
              {budget.enabled ? 'включён' : 'отключён'}
            </span>
          </button>
        </td>
        <td className="px-4 py-2.5 text-right">
          {isRoot ? (
            <span className="text-xs text-slate-400 dark:text-slate-500">—</span>
          ) : editing ? (
            <div className="flex items-center justify-end gap-1">
              <button
                type="button"
                className="btn-primary"
                disabled={patch.isPending}
                onClick={saveLimit}
              >
                {patch.isPending ? 'Сохраняю…' : 'Сохранить'}
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={patch.isPending}
                onClick={cancel}
              >
                Отмена
              </button>
            </div>
          ) : (
            <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>
              Лимит
            </button>
          )}
        </td>
      </tr>
      {error && (
        <tr>
          <td colSpan={5} className="px-4 pb-2">
            <div className="error-banner text-xs">{error}</div>
          </td>
        </tr>
      )}
    </>
  );
}

function BudgetEditor({
  connectors,
  onClose,
}: {
  connectors: GatewayConnector[];
  onClose: () => void;
}) {
  const patch = usePatchBudget();
  const [consumer, setConsumer] = useState('');
  const [connector, setConnector] = useState(connectors[0]?.slug ?? '');
  const [limit, setLimit] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    if (!consumer.trim()) {
      setError('Укажите потребителя');
      return;
    }
    if (!connector) {
      setError('Выберите сервис');
      return;
    }
    let daily_budget: number | null = null;
    const t = limit.trim();
    if (t !== '') {
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0) {
        setError('Лимит — целое число ≥ 0 или пусто (без лимита)');
        return;
      }
      daily_budget = Math.floor(n);
    }
    try {
      await patch.mutateAsync({
        consumer: consumer.trim(),
        connector,
        daily_budget,
        enabled,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
        <div className="card-header">
          <h3 className="card-title">Добавить бюджет</h3>
          <button type="button" className="btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="card-body space-y-4">
          <div>
            <label className="form-label">Потребитель</label>
            <input
              type="text"
              className="form-input"
              value={consumer}
              onChange={(e) => setConsumer(e.target.value)}
              placeholder="имя системы / пользователя"
            />
          </div>
          <div>
            <label className="form-label">Сервис</label>
            <select
              className="form-select"
              value={connector}
              onChange={(e) => setConnector(e.target.value)}
            >
              {connectors.length === 0 && <option value="">— нет коннекторов —</option>}
              {connectors.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.display_name} ({c.slug})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label">Лимит в сутки</label>
            <input
              type="number"
              min={0}
              className="form-input tabular-nums"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder="пусто = без личного лимита"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Включён
          </label>
          {error && <div className="error-banner">{error}</div>}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-800 dark:bg-slate-900/40">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={patch.isPending}
            onClick={save}
          >
            {patch.isPending ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   3. Расход (usage)
   ════════════════════════════════════════════════════════════════════ */

/** YYYY-MM-DD для <input type=date>. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return isoDate(d);
}

interface AggRow {
  consumer: string | null;
  connector: string;
  calls: number;
  units: number;
  errors: number;
}

/** Свернуть groups (consumer×connector×status) в consumer×connector. */
function aggregate(groups: UsageGroup[]): AggRow[] {
  const map = new Map<string, AggRow>();
  for (const g of groups) {
    const key = `${g.consumer ?? '∅'}::${g.connector}`;
    let row = map.get(key);
    if (!row) {
      row = { consumer: g.consumer, connector: g.connector, calls: 0, units: 0, errors: 0 };
      map.set(key, row);
    }
    row.calls += g.calls;
    row.units += g.units;
    if (g.status && g.status !== 'ok' && g.status !== 'success') {
      row.errors += g.calls;
    }
  }
  return [...map.values()].sort((a, b) => b.units - a.units || b.calls - a.calls);
}

function UsageSection() {
  const [from, setFrom] = useState(defaultFrom());
  const [to, setTo] = useState(isoDate(new Date()));
  const [consumer, setConsumer] = useState('');
  const [connector, setConnector] = useState('');

  const connectors = useConnectors();
  const { data, isLoading, error } = useGatewayUsage({
    from,
    to,
    consumer: consumer || undefined,
    connector: connector || undefined,
    byDay: true,
  });

  const rows = useMemo(() => aggregate(data?.groups ?? []), [data?.groups]);
  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          calls: acc.calls + r.calls,
          units: acc.units + r.units,
          errors: acc.errors + r.errors,
        }),
        { calls: 0, units: 0, errors: 0 },
      ),
    [rows],
  );

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Расход
        </h2>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          Кто сколько вызовов и единиц израсходовал за период, и сколько было
          ошибок.
        </p>
      </div>

      <div className="card">
        <div className="card-body grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="form-label">С даты</label>
            <input
              type="date"
              className="form-input"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="form-label">По дату</label>
            <input
              type="date"
              className="form-input"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div>
            <label className="form-label">Потребитель</label>
            <input
              type="text"
              className="form-input"
              value={consumer}
              onChange={(e) => setConsumer(e.target.value)}
              placeholder="все"
            />
          </div>
          <div>
            <label className="form-label">Сервис</label>
            <select
              className="form-select"
              value={connector}
              onChange={(e) => setConnector(e.target.value)}
            >
              <option value="">Все сервисы</option>
              {(connectors.data ?? []).map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.display_name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          Ошибка: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {isLoading ? (
        <SkeletonTable rows={5} columns={5} />
      ) : rows.length === 0 ? (
        <div className="card">
          <div className="card-body py-10 text-center">
            <p className="font-medium text-slate-700 dark:text-slate-300">
              За выбранный период расхода нет
            </p>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              Измените период или снимите фильтры.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Итоговые карточки */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <TotalCard label="Вызовы" value={totals.calls} />
            <TotalCard label="Единицы" value={totals.units} />
            <TotalCard label="Ошибки" value={totals.errors} tone={totals.errors > 0 ? 'bad' : undefined} />
          </div>

          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-2">Потребитель</th>
                    <th className="px-4 py-2">Сервис</th>
                    <th className="px-4 py-2 text-right">Вызовы</th>
                    <th className="px-4 py-2 text-right">Единицы</th>
                    <th className="px-4 py-2 text-right">Ошибки</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {rows.map((r) => (
                    <tr
                      key={`${r.consumer ?? '∅'}::${r.connector}`}
                      className="hover:bg-slate-50 dark:hover:bg-slate-900/40"
                    >
                      <td className="px-4 py-2.5">
                        {r.consumer === null ? (
                          <span className="font-mono text-xs text-slate-500 dark:text-slate-400" title="Трафик корневого ключа">
                            (root)
                          </span>
                        ) : (
                          <span className="font-medium text-slate-900 dark:text-slate-100">
                            {consumerLabel(r.consumer)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-slate-600 dark:text-slate-400">
                        {r.connector}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-300">
                        {formatNumber(r.calls)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-300">
                        {formatNumber(r.units)}
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right tabular-nums ${
                          r.errors > 0
                            ? 'font-medium text-rose-700 dark:text-rose-300'
                            : 'text-slate-400 dark:text-slate-500'
                        }`}
                      >
                        {r.errors > 0 ? formatNumber(r.errors) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {data?.daily && data.daily.length > 0 && (
            <DailySparkline daily={data.daily} />
          )}
        </>
      )}
    </section>
  );
}

function TotalCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'bad';
}) {
  return (
    <div className="card">
      <div className="card-body">
        <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {label}
        </div>
        <div
          className={`mt-1 text-2xl font-semibold tabular-nums ${
            tone === 'bad'
              ? 'text-rose-700 dark:text-rose-300'
              : 'text-slate-900 dark:text-slate-100'
          }`}
        >
          {formatNumber(value)}
        </div>
      </div>
    </div>
  );
}

/** Маленький столбчатый «спарклайн» по дням (units суммарно). */
function DailySparkline({ daily }: { daily: { date: string; units?: number; calls?: number }[] }) {
  const byDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of daily) {
      map.set(d.date, (map.get(d.date) ?? 0) + (d.units ?? d.calls ?? 0));
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [daily]);

  const max = byDate.reduce((m, [, v]) => Math.max(m, v), 0) || 1;

  return (
    <div className="card">
      <div className="card-body">
        <div className="mb-3 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
          По дням (единицы)
        </div>
        <div className="flex h-24 items-end gap-1">
          {byDate.map(([date, v]) => (
            <div
              key={date}
              className="group relative flex-1"
              title={`${date}: ${formatNumber(v)}`}
            >
              <div
                className="w-full rounded-sm bg-indigo-400 transition-colors group-hover:bg-indigo-600 dark:bg-indigo-500 dark:group-hover:bg-indigo-300"
                style={{ height: `${Math.max(2, (v / max) * 96)}px` }}
              />
            </div>
          ))}
        </div>
        <div className="mt-1.5 flex justify-between font-mono text-[10px] text-slate-400 dark:text-slate-500">
          <span>{byDate[0]?.[0]}</span>
          <span>{byDate[byDate.length - 1]?.[0]}</span>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   Общие виджеты
   ════════════════════════════════════════════════════════════════════ */

function Toggle({ on }: { on: boolean }) {
  return (
    <span
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        on ? 'bg-emerald-500 dark:bg-emerald-600' : 'bg-slate-300 dark:bg-slate-700'
      }`}
      aria-hidden="true"
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          on ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </span>
  );
}
