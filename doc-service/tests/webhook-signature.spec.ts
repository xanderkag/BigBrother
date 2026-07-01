/**
 * EXT-A (2026-05-26) — outbound webhook signature aliases.
 *
 * deliverWebhook (src/webhooks/deliver.ts) подписывает body HMAC-SHA256 и
 * рассылает подпись под ТРЕМЯ header-алиасами одного и того же значения:
 *   - x-docservice-signature (legacy, back-compat)
 *   - x-parsdocs-signature   (SLAI Issue #5)
 *   - x-extractor-signature  (EXT-A, extractor-agnostic для ExtractorGateway)
 * плюс job-id / attempt под каждым префиксом.
 *
 * Harness: мокаем undici.request чтобы перехватить headers без сети,
 * jobsRepo/metrics — чтобы recordWebhookAttempt не дёргал БД.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import pino from 'pino';
import type { WebhookPayload } from '../src/webhooks/deliver.js';

const requestMock = vi.fn();
vi.mock('undici', () => ({ request: requestMock }));
vi.mock('../src/storage/jobs.js', () => ({
  jobsRepo: { recordWebhookAttempt: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../src/metrics.js', () => ({
  webhookAttemptsTotal: { inc: vi.fn() },
}));

let deliverWebhook: typeof import('../src/webhooks/deliver.js').deliverWebhook;
let config: typeof import('../src/config.js').config;

beforeAll(async () => {
  ({ deliverWebhook } = await import('../src/webhooks/deliver.js'));
  ({ config } = await import('../src/config.js'));
});

const log = pino({ level: 'silent' });

function ok() {
  return {
    statusCode: 200,
    body: { dump: vi.fn().mockResolvedValue(undefined), text: vi.fn().mockResolvedValue('') },
  };
}

function payload(over: Partial<WebhookPayload> = {}): WebhookPayload {
  return {
    version: 'v1',
    schema_version: '1.1',
    job_id: 'job-123',
    status: 'completed',
    document_type: 'invoice',
    confidence: 0.99,
    ocr_engine: null,
    extracted: {},
    metadata: null,
    error: null,
    ...over,
  };
}

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue(ok());
});

describe('deliverWebhook — EXT-A signature aliases', () => {
  it('x-docservice / x-parsdocs / x-extractor signature равны одному sha256=<hmac>', async () => {
    const p = payload();
    const body = JSON.stringify(p);
    const expected = `sha256=${createHmac('sha256', config.webhook.hmacSecret).update(body).digest('hex')}`;

    await deliverWebhook('job-123', 'https://consumer.test/hook', p, log);

    expect(requestMock).toHaveBeenCalledTimes(1);
    const headers = requestMock.mock.calls[0]![1].headers as Record<string, string>;

    expect(headers['x-extractor-signature']).toBe(expected);
    expect(headers['x-docservice-signature']).toBe(expected);
    expect(headers['x-parsdocs-signature']).toBe(expected);
    expect(headers['x-extractor-signature']).toBe(headers['x-docservice-signature']);
    expect(headers['x-extractor-signature']).toBe(headers['x-parsdocs-signature']);
    expect(headers['x-extractor-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('x-extractor-job-id / x-extractor-attempt проставлены', async () => {
    await deliverWebhook('job-abc', 'https://consumer.test/hook', payload({ job_id: 'job-abc' }), log);

    const headers = requestMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['x-extractor-job-id']).toBe('job-abc');
    expect(headers['x-extractor-attempt']).toBe('1');
  });

  it('подпись считается с per-consumer override-секретом (Phase 3 CP7)', async () => {
    const p = payload();
    const body = JSON.stringify(p);
    const secret = 'per-org-secret';
    const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

    await deliverWebhook('job-123', 'https://consumer.test/hook', p, log, secret);

    const headers = requestMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['x-extractor-signature']).toBe(expected);
    expect(headers['x-extractor-signature']).not.toMatch(
      new RegExp(createHmac('sha256', config.webhook.hmacSecret).update(body).digest('hex')),
    );
  });

  it('attempt-алиасы консистентны между префиксами', async () => {
    await deliverWebhook('job-z', 'https://consumer.test/hook', payload({ job_id: 'job-z' }), log);
    const headers = requestMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['x-extractor-attempt']).toBe(headers['x-parsdocs-attempt']);
    expect(headers['x-extractor-attempt']).toBe(headers['x-docservice-attempt']);
    expect(headers['x-extractor-job-id']).toBe(headers['x-docservice-job-id']);
  });
});

describe('buildWebhookPayload — единый билдер для всех путей доставки', () => {
  // Envelope-источник в форме, которую отдают все три пути (finalize/sweeper/
  // redeliver). confidence приходит строкой (pg NUMERIC) или числом.
  const src = {
    id: 'job-1',
    status: 'done',
    document_type: 'TTN', // исторический UPPERCASE-слаг
    classification: null,
    confidence: '0.87',
    ocr_engine: 'pdf-text',
    error: null,
  };

  it('нормальный job → v1 / schema_version 1.1 / нормализованный slug', async () => {
    const { buildWebhookPayload } = await import('../src/webhooks/deliver.js');
    const p = buildWebhookPayload(src, { extracted: { number: '5' }, metadata: null });
    expect(p.version).toBe('v1');
    expect(p.schema_version).toBe('1.1');
    // TTN → ttn (outbound normalize).
    expect(p.document_type).toBe('ttn');
    expect(p.confidence).toBe(0.87);
    expect(p.extracted).toEqual({ number: '5' });
  });

  it('classification.unknown → document_type "unknown", ключа unrecognized нет', async () => {
    const { buildWebhookPayload } = await import('../src/webhooks/deliver.js');
    const p = buildWebhookPayload(
      { ...src, document_type: null, classification: { unknown: true } },
      { extracted: null, metadata: null },
    );
    expect(p.document_type).toBe('unknown');
    expect(p).not.toHaveProperty('unrecognized');
  });

  it('пути sweeper/redeliver: без content-хинтов → нет _field_confidence/documents/target_entity_hint в body', async () => {
    const { buildWebhookPayload } = await import('../src/webhooks/deliver.js');
    // sweeper: только extracted/metadata; redeliver добавляет targetEntityHint.
    const sweeper = buildWebhookPayload(src, { extracted: {}, metadata: null });
    // undefined-поля не сериализуются → ключей нет в body (byte-identical
    // с прежним sweeper-литералом, где их не было вовсе).
    const parsed = JSON.parse(JSON.stringify(sweeper)) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('_field_confidence');
    expect(parsed).not.toHaveProperty('documents');
    expect(parsed).not.toHaveProperty('target_entity_hint');
    // Общий envelope тот же самый, что и на finalize-пути.
    expect(parsed.version).toBe('v1');
    expect(parsed.schema_version).toBe('1.1');
  });
});

describe('webhook payload — top-level schema_version drift marker (SLAI)', () => {
  it('доставленный body несёт schema_version: "1.1" и version: "v1" не тронут', async () => {
    const { WEBHOOK_SCHEMA_VERSION } = await import('../src/webhooks/deliver.js');
    expect(WEBHOOK_SCHEMA_VERSION).toBe('1.1');

    await deliverWebhook('job-sv', 'https://consumer.test/hook', payload({ job_id: 'job-sv' }), log);

    const body = requestMock.mock.calls[0]![1].body as string;
    const sent = JSON.parse(body) as Record<string, unknown>;
    // Drift-маркер — top-level sibling к version, не внутри extracted.
    expect(sent.schema_version).toBe('1.1');
    // Envelope-версия контракта осталась v1 (НЕ бампается вместе со schema_version).
    expect(sent.version).toBe('v1');
  });
});

describe('webhook payload — unrecognized → document_type "unknown" (schema_version 1.1)', () => {
  it('нормальный распознанный документ → document_type slug, поля unrecognized нет', async () => {
    await deliverWebhook(
      'job-ok',
      'https://consumer.test/hook',
      payload({ job_id: 'job-ok', document_type: 'invoice' }),
      log,
    );

    const body = requestMock.mock.calls[0]![1].body as string;
    const sent = JSON.parse(body) as Record<string, unknown>;
    expect(sent.document_type).toBe('invoice');
    expect(sent.schema_version).toBe('1.1');
    // Поле unrecognized удалено из контракта (SLAI 2026-07-01).
    expect(sent).not.toHaveProperty('unrecognized');
  });

  it('не опознанный документ → document_type:"unknown", поля unrecognized нет', async () => {
    // Builders проставляют строку "unknown" при classification.unknown;
    // здесь проверяем wire-репрезентацию — payload несёт "unknown".
    await deliverWebhook(
      'job-unk',
      'https://consumer.test/hook',
      payload({ job_id: 'job-unk', document_type: 'unknown' }),
      log,
    );

    const body = requestMock.mock.calls[0]![1].body as string;
    const sent = JSON.parse(body) as Record<string, unknown>;
    expect(sent.document_type).toBe('unknown');
    expect(sent.schema_version).toBe('1.1');
    expect(sent).not.toHaveProperty('unrecognized');
  });
});
