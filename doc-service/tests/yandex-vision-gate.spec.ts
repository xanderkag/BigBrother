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

vi.mock('../src/storage/gateway-connectors.js', () => ({
  checkConsumerQuota: (...args: unknown[]) => checkConsumerQuota(...args),
}));
vi.mock('../src/storage/llm-usage.js', () => ({
  llmGatewayUsageRepo: { record: (...args: unknown[]) => record(...args) },
}));

const { isYandexVisionAllowed, recordYandexVisionPages, YANDEX_VISION_CONNECTOR, INTERNAL_CONSUMER } =
  await import('../src/pipeline/ocr/yandex-gate.js');

// Минимальный логгер-заглушка вместо pino.
const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;

beforeEach(() => {
  checkConsumerQuota.mockReset();
  record.mockReset();
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
