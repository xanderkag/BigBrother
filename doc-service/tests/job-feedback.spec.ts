/**
 * Unit-тесты внешнего фидбека (job_feedback): toApi-форма + валидация вердикта
 * через zod-схему CreateFeedbackBody.
 *
 * Lifecycle (create/listByJob) требует живой БД — это интеграционный уровень;
 * здесь только pure-юниты без БД.
 */

import { describe, it, expect } from 'vitest';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import { jobFeedbackRepo, type JobFeedbackRow } from '../src/storage/job-feedback.js';
import { CreateFeedbackBody, FeedbackVerdictSchema } from '../src/types/api-schemas.js';

function row(overrides: Partial<JobFeedbackRow> = {}): JobFeedbackRow {
  return {
    id: '42',
    job_id: '00000000-0000-0000-0000-000000000001',
    source_system: 'SLAI',
    verdict: 'correct',
    comment: null,
    fields: null,
    rated_by: null,
    created_at: new Date('2026-06-15T10:00:00Z'),
    ...overrides,
  };
}

describe('jobFeedbackRepo.toApi', () => {
  it('snake_case ключи + дата → ISO', () => {
    const api = jobFeedbackRepo.toApi(
      row({ comment: 'ок', rated_by: 'user-7', verdict: 'partial' }),
    );
    expect(api).toEqual({
      id: '42',
      job_id: '00000000-0000-0000-0000-000000000001',
      source_system: 'SLAI',
      verdict: 'partial',
      comment: 'ок',
      fields: null,
      rated_by: 'user-7',
      created_at: '2026-06-15T10:00:00.000Z',
    });
  });

  it('BIGSERIAL id всегда строка (даже если пришёл числом)', () => {
    const api = jobFeedbackRepo.toApi(row({ id: 100 as unknown as string }));
    expect(api.id).toBe('100');
    expect(typeof api.id).toBe('string');
  });

  it('fields пробрасывается как есть, null остаётся null', () => {
    const withFields = jobFeedbackRepo.toApi(
      row({ fields: [{ path: 'seller_inn', note: 'wrong' }] }),
    );
    expect(withFields.fields).toEqual([{ path: 'seller_inn', note: 'wrong' }]);
    expect(jobFeedbackRepo.toApi(row({ fields: null })).fields).toBeNull();
  });

  it('null comment / rated_by остаются null', () => {
    const api = jobFeedbackRepo.toApi(row({ comment: null, rated_by: null }));
    expect(api.comment).toBeNull();
    expect(api.rated_by).toBeNull();
  });
});

describe('verdict validation (FeedbackVerdictSchema)', () => {
  it('принимает три валидных значения', () => {
    for (const v of ['correct', 'partial', 'incorrect'] as const) {
      expect(FeedbackVerdictSchema.safeParse(v).success).toBe(true);
    }
  });

  it('отвергает прочие значения', () => {
    for (const v of ['good', 'CORRECT', '', 'ok', 'wrong', null, 1]) {
      expect(FeedbackVerdictSchema.safeParse(v).success).toBe(false);
    }
  });
});

describe('CreateFeedbackBody', () => {
  it('минимальное тело — только verdict', () => {
    const parsed = CreateFeedbackBody.safeParse({ verdict: 'incorrect' });
    expect(parsed.success).toBe(true);
  });

  it('verdict обязателен', () => {
    expect(CreateFeedbackBody.safeParse({ comment: 'нет вердикта' }).success).toBe(false);
  });

  it('не берёт source_system из тела (игнорирует лишнее)', () => {
    const parsed = CreateFeedbackBody.safeParse({
      verdict: 'correct',
      source_system: 'spoofed',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect('source_system' in parsed.data).toBe(false);
    }
  });

  it('fields[] — loose, требует хотя бы path, пропускает доп. ключи', () => {
    const parsed = CreateFeedbackBody.safeParse({
      verdict: 'partial',
      fields: [{ path: 'buyer_kpp', note: 'mismatch', correct_value: '770101001' }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.fields?.[0]).toMatchObject({
        path: 'buyer_kpp',
        correct_value: '770101001',
      });
    }
    // fields без path отвергается
    expect(
      CreateFeedbackBody.safeParse({ verdict: 'partial', fields: [{ note: 'no path' }] }).success,
    ).toBe(false);
  });

  it('comment > 2000 и rated_by > 200 отвергаются', () => {
    expect(
      CreateFeedbackBody.safeParse({ verdict: 'correct', comment: 'x'.repeat(2001) }).success,
    ).toBe(false);
    expect(
      CreateFeedbackBody.safeParse({ verdict: 'correct', rated_by: 'x'.repeat(201) }).success,
    ).toBe(false);
  });
});
