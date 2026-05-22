/**
 * DaData party-by-INN client.
 *
 * Зеркалит стиль pipeline/ocr/yandex.ts: env-gated isAvailable(), секрет через
 * config, undici request, fail-soft (throw на HTTP-ошибке — caller оборачивает
 * в try/catch и НИКОГДА не роняет job).
 *
 * Endpoint: POST findById/party. Шлём только ИНН юрлица (опц. КПП) — это
 * публичные данные ЕГРЮЛ, не ПДн (152-ФЗ ок). DaData — российский сервис.
 *
 * Парсим только те поля suggestions[0].data, которые реально читаем (минимальный
 * shape). Возвращаем null если подсказок нет.
 */
import { request } from 'undici';
import { providerSettingsRepo } from '../../storage/provider-settings.js';

const FIND_BY_ID_PARTY =
  'https://suggestions.dadata.ru/suggestions/api/4_1/rs/findById/party';

export type DadataConfig = {
  apiKey?: string;
  timeoutMs: number;
  cacheTtlMs: number;
};

/** Минимальный нормализованный shape — только поля, которые отдаём наружу. */
export type DadataParty = {
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  name_full: string | null;
  name_short: string | null;
  address: string | null;
  management_name: string | null;
  management_post: string | null;
  /** state.status: ACTIVE / LIQUIDATING / LIQUIDATED / REORGANIZING / BANKRUPT. */
  status: string | null;
};

// --- DaData findById/party response (minimal — только то, что читаем) ---
type DadataNameBlock = { full_with_opf?: string; short_with_opf?: string };
type DadataAddressBlock = { unrestricted_value?: string; value?: string };
type DadataManagementBlock = { name?: string; post?: string };
type DadataStateBlock = { status?: string };
type DadataPartyData = {
  inn?: string;
  kpp?: string;
  ogrn?: string;
  name?: DadataNameBlock;
  address?: DadataAddressBlock;
  management?: DadataManagementBlock;
  state?: DadataStateBlock;
};
type DadataResponse = {
  suggestions?: Array<{ value?: string; data?: DadataPartyData }>;
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export class DadataClient {
  constructor(private readonly cfg: DadataConfig) {}

  /**
   * Резолвит API-key (Token) на call-time: сначала default-провайдер
   * kind='dadata' из provider_settings (расшифрованный api_key), потом
   * env-fallback (config.dadata.apiKey). Зеркалит DynamicLlmClient.resolve().
   *
   * Никогда не бросает — БД недоступна → спокойно идём в env.
   */
  private async resolveApiKey(): Promise<string | undefined> {
    try {
      const row = await providerSettingsRepo.findDefault('dadata');
      if (row?.api_key) return row.api_key;
    } catch {
      // БД может быть недоступна — fallback на env.
    }
    return this.cfg.apiKey;
  }

  /**
   * Доступен если ключ резолвится из БД (default kind='dadata') ИЛИ env.
   * Async — внутри DB-lookup. Mirror yandex.isAvailable() по смыслу.
   */
  async isAvailable(): Promise<boolean> {
    return !!(await this.resolveApiKey());
  }

  /**
   * Поиск организации по ИНН (опц. КПП для филиалов). Возвращает первую
   * подсказку в нормализованном виде или null если подсказок нет.
   *
   * Бросает Error на HTTP >= 400 — caller (enrich-стадия) ловит и fail-soft'ит.
   */
  async findByInn(inn: string, kpp?: string): Promise<DadataParty | null> {
    const apiKey = await this.resolveApiKey();
    const body: { query: string; kpp?: string } = { query: inn };
    if (kpp) body.kpp = kpp;

    const res = await request(FIND_BY_ID_PARTY, {
      method: 'POST',
      headers: {
        authorization: `Token ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      headersTimeout: this.cfg.timeoutMs,
      bodyTimeout: this.cfg.timeoutMs,
    });

    if (res.statusCode >= 400) {
      const errText = await res.body.text();
      throw new Error(`DaData ${res.statusCode}: ${errText.slice(0, 500)}`);
    }

    const data = (await res.body.json()) as DadataResponse;
    const suggestion = data.suggestions?.[0];
    if (!suggestion || !suggestion.data) return null;

    const d = suggestion.data;
    return {
      inn: str(d.inn),
      kpp: str(d.kpp),
      ogrn: str(d.ogrn),
      name_full: str(d.name?.full_with_opf),
      name_short: str(d.name?.short_with_opf),
      address: str(d.address?.unrestricted_value ?? d.address?.value),
      management_name: str(d.management?.name),
      management_post: str(d.management?.post),
      status: str(d.state?.status),
    };
  }
}
