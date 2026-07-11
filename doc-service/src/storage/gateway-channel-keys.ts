import { config } from '../config.js';
import { providerSettingsRepo, type ProviderSettingRow } from './provider-settings.js';

/**
 * Ключи каналов LLM-шлюза (SLAI cutover) — «пользователь вносит ключ сам
 * в UI», без передачи plaintext через чат/секрет-каналы и без ручной правки
 * .env на хосте.
 *
 * Каждый внешний канал шлюза маппится на well-known строку provider_settings
 * (ключ там шифруется envelope-схемой AES-256-GCM, см. ./secrets.ts):
 *
 *   chat        → id 'gateway-anthropic' (kind='llm'). ВЫДЕЛЕННАЯ строка,
 *                 НЕ default модели разбора: раньше ключ chat-канала брался
 *                 у findDefault('llm') — чтобы внести Anthropic-ключ для
 *                 SLAI, пришлось бы сделать Anthropic дефолтом извлечения
 *                 (и сломать локальный qwen-путь). Развязано.
 *   embeddings  → id 'openai' (kind='llm') — magic-id, который
 *                 /v1/embeddings уже читает (llm-gateway.ts findById).
 *   dadata      → default-провайдер kind='dadata' (findDefault) — то, что
 *                 /v1/dadata уже читает; если дефолта нет, PUT создаёт
 *                 строку id='dadata' и назначает её default.
 *
 * Резолв на request-path шлюза везде: env > эта строка БД. env-ключ, если
 * задан на хосте, побеждает — поэтому в состоянии канала отдаём источник
 * активного ключа (active_source), чтобы UI честно показывал «ключ из env,
 * ввод в UI не подействует, пока env не очищен».
 */

export const GATEWAY_CHANNELS = ['chat', 'embeddings', 'dadata'] as const;
export type GatewayChannel = (typeof GATEWAY_CHANNELS)[number];

/** Выделенная строка под Anthropic-ключ chat-канала шлюза. */
export const GATEWAY_CHAT_PROVIDER_ID = 'gateway-anthropic';
/** Magic-id, который /v1/embeddings уже резолвит (llm-gateway.ts). */
export const GATEWAY_EMBEDDINGS_PROVIDER_ID = 'openai';
/** id, создаваемый PUT'ом dadata-канала, если default-провайдера ещё нет. */
export const GATEWAY_DADATA_PROVIDER_ID = 'dadata';

export type GatewayChannelKeyState = {
  channel: GatewayChannel;
  /** Человекочитаемое имя канала для UI. */
  title: string;
  /** Вендор ключа (что именно вставлять). */
  vendor: string;
  /** provider_settings.id, куда пишет/откуда читает канал. */
  provider_id: string;
  /** Фича-флаг канала (env): выключен → эндпоинт отвечает 503 fail-closed. */
  channel_enabled: boolean;
  /** Только для chat: 'anthropic' | 'openai_compat'. В openai_compat-режиме ключ не используется. */
  backend?: string;
  /** Ключ задан в env хоста (побеждает БД). */
  env_configured: boolean;
  /** Ключ внесён через UI (лежит шифрованно в provider_settings). */
  ui_configured: boolean;
  /** Маска UI-ключа (••••1234), null если не внесён. */
  api_key_masked: string | null;
  /** Откуда возьмётся ключ на ближайшем запросе. null = ключа нет нигде. */
  active_source: 'env' | 'ui' | null;
};

type ChannelDef = {
  channel: GatewayChannel;
  title: string;
  vendor: string;
  envKey: () => string | undefined;
  channelEnabled: () => boolean;
  backend?: () => string;
  /** Строка БД, которую канал реально читает на request-path. */
  findRow: () => Promise<ProviderSettingRow | null>;
  /** provider_id для отображения/создания. */
  providerId: (row: ProviderSettingRow | null) => string;
};

const CHANNEL_DEFS: Record<GatewayChannel, ChannelDef> = {
  chat: {
    channel: 'chat',
    title: 'Чат (совместимый с OpenAI) · /v1/chat/completions',
    vendor: 'Anthropic',
    envKey: () => config.llmGateway.apiKey,
    channelEnabled: () => config.llmGateway.enabled,
    backend: () => config.llmGateway.backend,
    findRow: () => providerSettingsRepo.findById(GATEWAY_CHAT_PROVIDER_ID),
    providerId: () => GATEWAY_CHAT_PROVIDER_ID,
  },
  embeddings: {
    channel: 'embeddings',
    title: 'Embeddings · /v1/embeddings',
    vendor: 'OpenAI',
    envKey: () => config.llmGateway.embeddings.apiKey,
    channelEnabled: () => config.llmGateway.embeddings.enabled,
    findRow: () => providerSettingsRepo.findById(GATEWAY_EMBEDDINGS_PROVIDER_ID),
    providerId: () => GATEWAY_EMBEDDINGS_PROVIDER_ID,
  },
  dadata: {
    channel: 'dadata',
    title: 'DaData passthrough · /v1/dadata',
    vendor: 'DaData',
    envKey: () => config.llmGateway.dadata.apiKey,
    channelEnabled: () => config.llmGateway.dadata.enabled,
    findRow: () => providerSettingsRepo.findDefault('dadata'),
    providerId: (row) => row?.id ?? GATEWAY_DADATA_PROVIDER_ID,
  },
};

function toState(def: ChannelDef, row: ProviderSettingRow | null): GatewayChannelKeyState {
  const envConfigured = !!def.envKey();
  // is_active-гейт: findDefault уже фильтрует, findById — нет.
  const uiConfigured = !!row && row.is_active && !!row.api_key;
  return {
    channel: def.channel,
    title: def.title,
    vendor: def.vendor,
    provider_id: def.providerId(row),
    channel_enabled: def.channelEnabled(),
    ...(def.backend ? { backend: def.backend() } : {}),
    env_configured: envConfigured,
    ui_configured: uiConfigured,
    api_key_masked: uiConfigured ? maskKey(row!.api_key!) : null,
    active_source: envConfigured ? 'env' : uiConfigured ? 'ui' : null,
  };
}

/** Та же маска, что в providerSettingsRepo.toApi — plaintext никогда не уходит. */
function maskKey(key: string): string {
  if (key.length <= 4) return '••••';
  return `••••${key.slice(-4)}`;
}

/** Состояние всех каналов для экрана «Подключения → Ключи каналов шлюза». */
export async function getGatewayChannelKeyStates(): Promise<GatewayChannelKeyState[]> {
  return Promise.all(
    GATEWAY_CHANNELS.map(async (ch) => {
      const def = CHANNEL_DEFS[ch];
      return toState(def, await def.findRow());
    }),
  );
}

export type PutGatewayChannelKeyResult = {
  state: GatewayChannelKeyState;
  /** Для аудита: маскированные snapshot'ы до/после (toApi-shape). */
  before: ReturnType<typeof providerSettingsRepo.toApi> | null;
  after: ReturnType<typeof providerSettingsRepo.toApi>;
  created: boolean;
};

/**
 * Записать (или очистить: apiKey=null) ключ канала. Ключ шифруется в
 * providerSettingsRepo до записи; наружу возвращается только маска.
 * Отсутствующая well-known строка создаётся; для dadata дополнительно
 * назначается default (findDefault — это то, что читает request-path).
 */
export async function putGatewayChannelKey(
  channel: GatewayChannel,
  apiKey: string | null,
): Promise<PutGatewayChannelKeyResult> {
  const def = CHANNEL_DEFS[channel];
  const existing = await def.findRow();
  const before = existing ? providerSettingsRepo.toApi(existing) : null;

  let row: ProviderSettingRow;
  if (existing) {
    const patched = await providerSettingsRepo.patch(existing.id, {
      api_key: apiKey,
      is_active: true,
    });
    // Строка была прочитана строкой выше — исчезнуть могла только в гонке
    // с параллельным DELETE; тогда честно падаем, не создавая двойника.
    if (!patched) throw new Error(`provider ${existing.id} исчез во время записи ключа`);
    row = patched;
  } else {
    row = await providerSettingsRepo.upsert(newRowInput(channel, apiKey));
    if (channel === 'dadata') {
      // request-path dadata читает findDefault('dadata') — свежесозданная
      // строка обязана стать default, иначе ключ «внесён, но не работает».
      const promoted = await providerSettingsRepo.setDefault(row.id);
      if (promoted) row = promoted;
    }
  }

  return {
    state: toState(def, row),
    before,
    after: providerSettingsRepo.toApi(row),
    created: !existing,
  };
}

function newRowInput(channel: GatewayChannel, apiKey: string | null) {
  switch (channel) {
    case 'chat':
      return {
        id: GATEWAY_CHAT_PROVIDER_ID,
        kind: 'llm' as const,
        display_name: 'Anthropic · шлюз SLAI (chat)',
        description:
          'Выделенный ключ chat-канала LLM-шлюза (/v1/chat/completions). ' +
          'Не участвует в извлечении документов и не является моделью разбора.',
        api_key: apiKey,
        is_active: true,
      };
    case 'embeddings':
      return {
        id: GATEWAY_EMBEDDINGS_PROVIDER_ID,
        kind: 'llm' as const,
        display_name: 'OpenAI · шлюз SLAI (embeddings)',
        description:
          'Ключ embeddings-канала LLM-шлюза (/v1/embeddings, text-embedding-3-small). ' +
          'Не участвует в извлечении документов.',
        api_key: apiKey,
        is_active: true,
      };
    case 'dadata':
      return {
        id: GATEWAY_DADATA_PROVIDER_ID,
        kind: 'dadata' as const,
        display_name: 'DaData',
        description: 'Ключ DaData (suggestions API) — enrichment + gateway passthrough.',
        api_key: apiKey,
        is_active: true,
      };
  }
}
