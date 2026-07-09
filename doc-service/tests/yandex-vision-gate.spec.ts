/**
 * Гейт облачного OCR (`yandex_vision`).
 *
 * Главное, что тут защищается — FAIL-CLOSED: при любой неопределённости
 * изображения документов НЕ уходят третьей стороне. `checkConsumerQuota`
 * для неизвестного коннектора отвечает fail-open (allowed:true) — это
 * биллинговая семантика, и для egress ПДн она неприемлема.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const checkConsumerQuota = vi.fn();
const record = vi.fn();
const findById = vi.fn();
// Мутабельный env-конфиг: подменяем YANDEX_VISION_API_KEY / YANDEX_FOLDER_ID.
const { cfg } = vi.hoisted(() => ({
  cfg: {
    yandex: {
      apiKey: 'env-key' as string | undefined,
      folderId: 'env-folder' as string | undefined,
    },
  },
}));

vi.mock('../src/storage/gateway-connectors.js', () => ({
  checkConsumerQuota: (...args: unknown[]) => checkConsumerQuota(...args),
}));
vi.mock('../src/storage/llm-usage.js', () => ({
  llmGatewayUsageRepo: { record: (...args: unknown[]) => record(...args) },
}));
vi.mock('../src/storage/provider-settings.js', () => ({
  providerSettingsRepo: { findById: (...args: unknown[]) => findById(...args) },
}));
vi.mock('../src/config.js', () => ({ config: cfg }));

const {
  isYandexVisionAllowed,
  recordYandexVisionPages,
  pagesSentFrom,
  resolveYandexVisionCredentials,
  YANDEX_VISION_CONNECTOR,
  YANDEX_VISION_PROVIDER_ID,
  INTERNAL_CONSUMER,
} = await import('../src/pipeline/ocr/yandex-gate.js');

// Минимальный логгер-заглушка вместо pino.
const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

// Активная строка провайдера (усечённая до нужных полей). `extra.folder_id`
// опционально — так админ задаёт folder через UI.
function activeRow(api_key: string | null, folderId?: string | null) {
  const extra = folderId === undefined ? null : { folder_id: folderId };
  return { id: YANDEX_VISION_PROVIDER_ID, kind: 'ocr', is_active: true, api_key, extra } as never;
}

beforeEach(() => {
  checkConsumerQuota.mockReset();
  record.mockReset();
  findById.mockReset();
  cfg.yandex.apiKey = 'env-key';
  cfg.yandex.folderId = 'env-folder';
});

describe('isYandexVisionAllowed', () => {
  it('коннектор включён и лимит не исчерпан → разрешено', async () => {
    checkConsumerQuota.mockResolvedValue({ allowed: true, used: 5, dailyCap: 100, dailyBudget: null });
    await expect(isYandexVisionAllowed(log)).resolves.toBe(true);
    expect(checkConsumerQuota).toHaveBeenCalledWith(INTERNAL_CONSUMER, YANDEX_VISION_CONNECTOR);
  });

  it('тумблер выключен → запрещено (это и есть рубильник)', async () => {
    checkConsumerQuota.mockResolvedValue({
      allowed: false, used: 0, dailyCap: null, dailyBudget: null, reason: 'connector_disabled',
    });
    await expect(isYandexVisionAllowed(log)).resolves.toBe(false);
  });

  it('суточный лимит исчерпан → запрещено', async () => {
    checkConsumerQuota.mockResolvedValue({
      allowed: false, used: 100, dailyCap: 100, dailyBudget: null, reason: 'cap_exceeded',
    });
    await expect(isYandexVisionAllowed(log)).resolves.toBe(false);
  });

  // ── FAIL-CLOSED ────────────────────────────────────────────────────
  it('строки коннектора нет → ЗАПРЕЩЕНО, несмотря на allowed:true от квоты', async () => {
    // checkConsumerQuota здесь честно отвечает fail-open — мы обязаны это переопределить.
    checkConsumerQuota.mockResolvedValue({
      allowed: true, used: 0, dailyCap: null, dailyBudget: null, reason: 'unknown_connector',
    });
    await expect(isYandexVisionAllowed(log)).resolves.toBe(false);
  });

  it('БД упала → ЗАПРЕЩЕНО (деградируем на локальный OCR, не в облако)', async () => {
    checkConsumerQuota.mockRejectedValue(new Error('connection refused'));
    await expect(isYandexVisionAllowed(log)).resolves.toBe(false);
  });
});

describe('recordYandexVisionPages', () => {
  it('пишет расход в страницах под нужным коннектором', async () => {
    record.mockResolvedValue(undefined);
    await recordYandexVisionPages({ pages: 3, latencyMs: 1200, model: 'yandex-vision' }, log);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: INTERNAL_CONSUMER,
        connector: YANDEX_VISION_CONNECTOR,
        units: 3,
        unitKind: 'pages',
        status: 'success',
      }),
    );
  });

  it('нулевые страницы не пишутся', async () => {
    await recordYandexVisionPages({ pages: 0, latencyMs: 10, model: 'yandex-vision' }, log);
    expect(record).not.toHaveBeenCalled();
  });

  it('сбой учёта НЕ роняет джобу', async () => {
    record.mockRejectedValue(new Error('db down'));
    await expect(
      recordYandexVisionPages({ pages: 2, latencyMs: 10, model: 'yandex-vision' }, log),
    ).resolves.toBeUndefined();
  });
});

// Страницы, улетевшие до падения движка, обязаны быть списаны — иначе лимит
// не сдвинется, а ретрай отправит и оплатит их заново.
describe('pagesSentFrom', () => {
  it('достаёт число страниц из ошибки, помеченной движком', () => {
    expect(pagesSentFrom(Object.assign(new Error('429'), { pagesSent: 2 }))).toBe(2);
  });

  it('0 для обычной ошибки без пометки', () => {
    expect(pagesSentFrom(new Error('boom'))).toBe(0);
  });

  it('0 для мусора и нечисловых/отрицательных значений', () => {
    expect(pagesSentFrom(null)).toBe(0);
    expect(pagesSentFrom(undefined)).toBe(0);
    expect(pagesSentFrom('строка')).toBe(0);
    expect(pagesSentFrom({ pagesSent: 'два' })).toBe(0);
    expect(pagesSentFrom({ pagesSent: -1 })).toBe(0);
    expect(pagesSentFrom({ pagesSent: Number.NaN })).toBe(0);
  });
});

// Учётные данные вводятся в интерфейсе (provider_settings, api_key шифруется at
// rest), а не в .env. Свойство: активная строка ПОБЕЖДАЕТ env ПО КАЖДОМУ полю;
// во всех неоднозначных случаях откатываемся на env — это выбор источника, а не
// разрешение egress.
describe('resolveYandexVisionCredentials', () => {
  it('активная строка с ключом+folder → оба из БД (приоритет над env)', async () => {
    findById.mockResolvedValue(activeRow('ui-secret-key', 'ui-folder'));
    await expect(resolveYandexVisionCredentials(log)).resolves.toEqual({
      apiKey: 'ui-secret-key',
      folderId: 'ui-folder',
    });
    expect(findById).toHaveBeenCalledWith(YANDEX_VISION_PROVIDER_ID);
  });

  it('ключ и folder из БД триммятся', async () => {
    findById.mockResolvedValue(activeRow('  spaced-key  ', '  spaced-folder  '));
    await expect(resolveYandexVisionCredentials(log)).resolves.toEqual({
      apiKey: 'spaced-key',
      folderId: 'spaced-folder',
    });
  });

  it('ключ из UI, folder не задан в строке → folder из env (пофайловый откат)', async () => {
    findById.mockResolvedValue(activeRow('ui-secret-key')); // extra=null
    await expect(resolveYandexVisionCredentials(log)).resolves.toEqual({
      apiKey: 'ui-secret-key',
      folderId: 'env-folder',
    });
  });

  it('строка есть, но НЕ активна → оба из env (тумблер уважается)', async () => {
    findById.mockResolvedValue({ ...activeRow('ui-secret-key', 'ui-folder'), is_active: false });
    await expect(resolveYandexVisionCredentials(log)).resolves.toEqual({
      apiKey: 'env-key',
      folderId: 'env-folder',
    });
  });

  it('активная строка с пустым ключом → ключ из env, а не «выключить»', async () => {
    findById.mockResolvedValue(activeRow('   ', 'ui-folder'));
    await expect(resolveYandexVisionCredentials(log)).resolves.toEqual({
      apiKey: 'env-key',
      folderId: 'ui-folder',
    });
  });

  it('строки нет (миграция/сид не применён) → env', async () => {
    findById.mockResolvedValue(null);
    await expect(resolveYandexVisionCredentials(log)).resolves.toEqual({
      apiKey: 'env-key',
      folderId: 'env-folder',
    });
  });

  it('БД упала → откат на env (это выбор источника, а НЕ разрешение egress)', async () => {
    findById.mockRejectedValue(new Error('connection refused'));
    await expect(resolveYandexVisionCredentials(log)).resolves.toEqual({
      apiKey: 'env-key',
      folderId: 'env-folder',
    });
    expect(log.warn).toHaveBeenCalled();
  });

  it('ни БД, ни env → пусто (Yandex недоступен, деградация на tesseract)', async () => {
    cfg.yandex.apiKey = undefined;
    cfg.yandex.folderId = undefined;
    findById.mockResolvedValue(null);
    await expect(resolveYandexVisionCredentials(log)).resolves.toEqual({
      apiKey: undefined,
      folderId: undefined,
    });
  });

  it('нестроковый folder_id в extra игнорируется → folder из env', async () => {
    findById.mockResolvedValue({ ...activeRow('ui-secret-key'), extra: { folder_id: 12345 } });
    await expect(resolveYandexVisionCredentials(log)).resolves.toEqual({
      apiKey: 'ui-secret-key',
      folderId: 'env-folder',
    });
  });
});
