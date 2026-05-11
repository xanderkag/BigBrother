import { providerSettingsRepo } from '../../storage/provider-settings.js';
import { config } from '../../config.js';
import { HttpLlmClient } from './http-client.js';
import { NullLlmClient } from './null-client.js';
import type {
  LlmClient,
  LlmClassifyResult,
  LlmExtractResult,
  LlmVerifyResult,
  LlmVisionResult,
} from './types.js';
import type { DocumentTypeSlug } from '../../types/documents.js';

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

  classify(text: string): Promise<LlmClassifyResult> {
    return this.delegate().then((c) => c.classify(text));
  }

  extract(input: {
    text: string;
    schema: Record<string, unknown>;
    hint?: DocumentTypeSlug;
    promptOverride?: string;
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

  private async delegate(): Promise<LlmClient> {
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
    });
  }
}

/** Singleton LLM-клиент, читающий конфиг из БД с TTL-кэшем. */
export const dynamicLlm = new DynamicLlmClient();
