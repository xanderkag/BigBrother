import { AsyncLocalStorage } from 'node:async_hooks';
import { providerSettingsRepo } from '../../storage/provider-settings.js';
import { config } from '../../config.js';
import { HttpLlmClient } from './http-client.js';
import { NullLlmClient } from './null-client.js';
import type {
  LlmClient,
  LlmClassifyResult,
  LlmCatalogClassifyInput,
  LlmCatalogClassifyResult,
  LlmExtractResult,
  LlmVerifyResult,
  LlmVisionResult,
} from './types.js';
import type { DocumentTypeSlug } from '../../types/documents.js';

/**
 * Per-job override контекста LLM-провайдера. Заполняется processJob если
 * пользователь явно указал `metadata._force_provider_id` при загрузке. Чтение —
 * в DynamicLlmClient.delegate() через AsyncLocalStorage: никакие сигнатуры
 * парсеров не меняются.
 */
const forceProviderContext = new AsyncLocalStorage<{ providerId: string }>();

/**
 * EXT-B (Q11): per-request BYO LLM credentials. Заполняется processJob когда
 * consumer передал `X-LLM-*` заголовки (и BYO_LLM_ENABLED). Несёт EPHEMERAL
 * конфиг провайдера — в БД/кэш он НЕ персистится. Читается в delegate(),
 * берёт приоритет НАД forceProviderContext и default-провайдером.
 *
 * SECURITY: apiKey живёт только в этом ALS-store на время обработки job'а.
 * Никуда не логируется и не сериализуется (см. inline-credentials.ts).
 */
const inlineCredentialsContext = new AsyncLocalStorage<{
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
}>();

/**
 * DynamicLlmClient — wraps a real LlmClient, but reads its endpoint+key from
 * `provider_settings` (DB) на каждый вызов (с короткой TTL-кэшировкой).
 *
 * Зачем не статика:
 *   - orchestrator создаёт LLM-клиент один раз при boot, держит const ссылку.
 *   - Админ меняет ключ через UI → таблица `provider_settings` обновляется.
 *   - Без shim'а это никак не поднимется в hot-path до рестарта сервиса.
 *
 * Стратегия резолва (для kind='llm'):
 *   1. Берём из БД row с is_default=true AND is_active=true.
 *   2. Если такой row нашёлся и у него есть base_url (или мы знаем дефолтный из env)
 *      — собираем HttpLlmClient с этими base_url + api_key.
 *   3. Если row.api_key пуст, берём env-fallback `config.llm.apiKey`.
 *   4. Если row нет вообще, но env есть — собираем чистый env HttpLlmClient (как раньше).
 *   5. Если ничего нет — NullLlmClient.
 *
 * TTL — 30s. Резолвер выдаёт «временный» делегат, и на каждой стене кэша
 * протух может смениться endpoint/key без перезапуска. Если хочется
 * мгновенно — придётся добавить .invalidate(), но сейчас 30s вполне ок.
 */

type Resolved = {
  client: LlmClient;
  resolvedAt: number;
};

/**
 * Причина, по которой запрошенный forced-provider id не резолвится и роутинг
 * молча откатывается на default. Возвращается probeForceProvider() —
 * observability-only, само поведение (fallthrough) не меняет.
 */
export type ForceProviderFallthroughReason =
  | 'not_found'
  | 'non_llm_kind'
  | 'missing_base_url'
  | 'lookup_error';

const TTL_MS = 30_000;

class DynamicLlmClient implements LlmClient {
  private cached: Resolved | null = null;
  /** Promise-in-flight reuse — не дёргаем БД параллельно из 10 разных вызовов. */
  private pending: Promise<LlmClient> | null = null;

  isAvailable(): boolean {
    // На горячем пути этот метод вызывается синхронно, ДО resolve. Простая
    // эвристика: считаем доступным если есть env-URL ИЛИ кэшированный DB-row.
    // Если ни того ни другого — точно недоступен (Null-делегат).
    if (config.llm.url) return true;
    if (this.cached?.client.isAvailable()) return true;
    return false;
  }

  supportsVision(): Promise<boolean> {
    return this.delegate().then((c) => c.supportsVision());
  }

  classify(text: string): Promise<LlmClassifyResult> {
    return this.delegate().then((c) => c.classify(text));
  }

  classifyWithCatalog(input: LlmCatalogClassifyInput): Promise<LlmCatalogClassifyResult> {
    return this.delegate().then((c) => c.classifyWithCatalog(input));
  }

  extract(input: {
    text: string;
    schema: Record<string, unknown>;
    hint?: DocumentTypeSlug;
    promptOverride?: string;
    includeDebug?: boolean;
    imagePath?: string;
  }): Promise<LlmExtractResult> {
    return this.delegate().then((c) => c.extract(input));
  }

  visionOcr(input: { imagePath: string; prompt?: string }): Promise<LlmVisionResult> {
    return this.delegate().then((c) => c.visionOcr(input));
  }

  verify(input: {
    extracted: Record<string, unknown>;
    rawText: string;
  }): Promise<LlmVerifyResult> {
    return this.delegate().then((c) => c.verify(input));
  }

  /** Принудительный сброс кэша — для тестов и для будущего hook'а из admin-CRUD. */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * Запустить функцию `fn` со «scoped» override LLM-провайдера. Все вызовы
   * `dynamicLlm.classify/extract/...` внутри callback'а пойдут через провайдер
   * с заданным id (без TTL-кэша default-провайдера). После возврата контекст
   * автоматически сбрасывается через AsyncLocalStorage.
   *
   * Если провайдер с таким id не найден или у него нет base_url — fallback
   * на default (не падаем шумно, оператор увидит в логах).
   */
  withForceProvider<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
    return forceProviderContext.run({ providerId }, fn);
  }

  /**
   * Observability-only: проверяет, зарезолвится ли forced-provider id, БЕЗ
   * побочных эффектов и БЕЗ создания клиента. Возвращает reason, если id
   * молча откатится на default (см. resolveById — те же ветки), либо null
   * если резолв пройдёт штатно. Роутинг НЕ меняет — caller (orchestrator)
   * лишь логирует/считает fallthrough перед обычным withForceProvider.
   */
  async probeForceProvider(id: string): Promise<ForceProviderFallthroughReason | null> {
    let row;
    try {
      row = await providerSettingsRepo.findById(id);
    } catch {
      return 'lookup_error';
    }
    if (!row) return 'not_found';
    if (row.kind !== 'llm') return 'non_llm_kind';
    // 'stub' резолвится в рабочий NullLlmClient — это не fallthrough.
    if (row.id === 'stub') return null;
    const baseUrl = row.base_url || config.llm.url || null;
    if (!baseUrl) return 'missing_base_url';
    return null;
  }

  /**
   * Запустить `fn` через активный vision-провайдер (vision=true, is_active).
   * Используется OCR-движком (VisionLlmEngine), чтобы vision-OCR сканов шёл
   * на vision-capable модель (qwen3-vl:32b / minicpm-v), а НЕ на default
   * text-провайдера extraction'а (qwen3.6:27b). Если активной vision-строки
   * нет — fail-soft, fn выполняется на default-провайдере (как раньше).
   *
   * Резолв id кэшируется на TTL_MS, чтобы не дёргать БД на каждую страницу
   * скана. withForceProvider сам fail-soft'ит, если строка пропала.
   */
  async withVisionProvider<T>(fn: () => Promise<T>): Promise<T> {
    const id = await this.resolveVisionProviderId();
    if (!id) return fn();
    return forceProviderContext.run({ providerId: id }, fn);
  }

  private visionIdCache: { id: string | null; at: number } | null = null;

  private async resolveVisionProviderId(): Promise<string | null> {
    const now = Date.now();
    if (this.visionIdCache && now - this.visionIdCache.at < TTL_MS) {
      return this.visionIdCache.id;
    }
    let id: string | null = null;
    try {
      // Явный OCR_VISION_PROVIDER_ID имеет приоритет — детерминированный
      // выбор vision-OCR модели независимо от display_name-ordering. Проверяем
      // что строка существует, активна и vision; иначе автоподбор.
      const explicit = config.hybridRouting.ocrVisionProviderId;
      if (explicit) {
        const row = await providerSettingsRepo.findById(explicit);
        if (row && row.kind === 'llm' && row.is_active && row.vision === true) {
          id = row.id;
        }
      }
      if (!id) {
        const row = await providerSettingsRepo.findActiveVision();
        id = row?.id ?? null;
      }
    } catch {
      id = null;
    }
    this.visionIdCache = { id, at: Date.now() };
    return id;
  }

  /**
   * EXT-B (Q11): запустить `fn` со scoped BYO-провайдером. Все вызовы
   * dynamicLlm внутри callback'а пойдут через ad-hoc HttpLlmClient,
   * собранный из переданных creds — БЕЗ записи в БД и БЕЗ кэширования ключа.
   * Приоритетнее withForceProvider и default-провайдера. После возврата
   * контекст автоматически сбрасывается через AsyncLocalStorage.
   */
  withInlineCredentials<T>(
    creds: { provider: string; apiKey: string; model?: string; baseUrl?: string },
    fn: () => Promise<T>,
  ): Promise<T> {
    return inlineCredentialsContext.run(creds, fn);
  }

  /**
   * Собрать ad-hoc HttpLlmClient из inline-creds. baseUrl: явный из заголовка,
   * иначе env-default (config.llm.url) — позволяет BYO передать только ключ
   * для нашего же shared inference-endpoint'а. Без какого-либо base_url
   * клиента не собрать — возвращаем null (caller fallback на default).
   */
  private buildInlineClient(ctx: {
    provider: string;
    apiKey: string;
    model?: string;
    baseUrl?: string;
  }): LlmClient | null {
    const baseUrl = ctx.baseUrl || config.llm.url || null;
    if (!baseUrl) return null;
    return new HttpLlmClient({
      baseUrl,
      apiKey: ctx.apiKey,
      timeoutMs: config.llm.timeoutMs,
      model: ctx.model || undefined,
    });
  }

  private async delegate(): Promise<LlmClient> {
    // EXT-B: BYO inline-creds имеют наивысший приоритет — пер-job ephemeral
    // провайдер, собранный из заголовков. Не кэшируем (ключ не должен жить
    // дольше обработки). Если base_url собрать неоткуда — fallthrough.
    const inline = inlineCredentialsContext.getStore();
    if (inline) {
      const adhoc = this.buildInlineClient(inline);
      if (adhoc) return adhoc;
    }
    // Если процессинговый код заявил force_provider — резолвим его без кэша
    // (per-job override должен быть детерминированным; кэш — только для
    // default-провайдера в стандартном hot-path).
    const ctx = forceProviderContext.getStore();
    if (ctx?.providerId) {
      const forced = await this.resolveById(ctx.providerId);
      if (forced) return forced;
      // fallthrough на default если provider не найден
    }
    const now = Date.now();
    if (this.cached && now - this.cached.resolvedAt < TTL_MS) {
      return this.cached.client;
    }
    if (this.pending) return this.pending;
    this.pending = this.resolve()
      .then((client) => {
        this.cached = { client, resolvedAt: Date.now() };
        return client;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  /**
   * Резолвит provider по id (без TTL-кэша). Возвращает null если провайдер
   * не найден / не llm-kind / без base_url — тогда caller должен fallback на
   * стандартный delegate().
   */
  private async resolveById(id: string): Promise<LlmClient | null> {
    let row;
    try {
      row = await providerSettingsRepo.findById(id);
    } catch {
      return null;
    }
    if (!row || row.kind !== 'llm') return null;
    if (row.id === 'stub') return new NullLlmClient();
    const baseUrl = row.base_url || config.llm.url || null;
    if (!baseUrl) return null;
    const apiKey = row.api_key || config.llm.apiKey;
    // row.model — конкретный ollama-tag (например "phi4", "gemma3:27b",
    // "mistral-small3.1"). Если задан — клиент пошлёт его в body запроса,
    // и inference-service.openai_compatible подменит свой default из env.
    // Это позволяет иметь несколько provider_settings rows с одним base_url
    // но разными model — каждая строка = «прогон через эту модель».
    return new HttpLlmClient({
      baseUrl,
      apiKey,
      timeoutMs: config.llm.timeoutMs,
      model: row.model || undefined,
      vision: row.vision === true,
      reasoningEffort: readReasoningEffort(row.extra),
    });
  }

  private async resolve(): Promise<LlmClient> {
    let dbRow = null;
    try {
      dbRow = await providerSettingsRepo.findDefault('llm');
    } catch {
      // БД может быть недоступна на старте — спокойно идём в env-fallback.
      dbRow = null;
    }

    // 'stub' — встроенный seed, означающий "никакого LLM" (используется в dev/test).
    if (dbRow && dbRow.id === 'stub') {
      return new NullLlmClient();
    }

    const baseUrl = dbRow?.base_url || config.llm.url || null;
    if (!baseUrl) {
      // Ни в БД, ни в env URL не задан — провайдера нет.
      return new NullLlmClient();
    }

    const apiKey = dbRow?.api_key || config.llm.apiKey;
    return new HttpLlmClient({
      baseUrl,
      apiKey,
      timeoutMs: config.llm.timeoutMs,
      // Если is_default-провайдер задал model — пробрасываем его в inference,
      // иначе inference использует свой OPENAI_MODEL из env.
      model: dbRow?.model || undefined,
      vision: dbRow?.vision === true,
      reasoningEffort: readReasoningEffort(dbRow?.extra),
    });
  }
}

/**
 * Читает `reasoning_effort` из provider_settings.extra (JSONB). Используется
 * для reasoning/thinking-моделей (qwen3.6) — значение "none" подавляет hidden
 * reasoning-токены на стороне Ollama. Возвращает undefined если ключа нет /
 * он не строка, чтобы не-reasoning провайдеры (phi4) не получали лишний param.
 */
function readReasoningEffort(extra: Record<string, unknown> | null | undefined): string | undefined {
  if (!extra || typeof extra !== 'object') return undefined;
  const v = (extra as Record<string, unknown>).reasoning_effort;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Singleton LLM-клиент, читающий конфиг из БД с TTL-кэшем. */
export const dynamicLlm = new DynamicLlmClient();
