/**
 * Golden-set schema. Минимальный, но самодостаточный.
 *
 * Один файл описывает прогон: куда обращаться, чем авторизоваться,
 * и список фикстур. Каждая фикстура — путь к документу + ожидаемые
 * поля. Никакой магии «угадай ожидаемое»: всё что не указано — не
 * проверяется, всё что указано — должно сойтись.
 */
import { z } from 'zod';

const FieldExpectation = z
  .object({
    /** Dot-path внутри extracted: 'carrier.inn', 'positions.0.qty'. */
    path: z.string().min(1),
    /** Ожидаемое значение. null = ждём что поле явно null. */
    expected: z.unknown(),
    /** Принудительный компаратор. По умолчанию авто из path. */
    kind: z
      .enum([
        'string',
        'money',
        'percent',
        'date',
        'inn',
        'kpp',
        'account',
        'plate',
        'country',
        'integer',
        'number',
      ])
      .optional(),
    /** Опциональное человекочитаемое описание поля, в отчёт. */
    label: z.string().optional(),
  })
  .strict();

export const FixtureSchema = z
  .object({
    /** Стабильный человекочитаемый id, попадает в отчёт. */
    id: z.string().min(1),
    /** Путь к файлу — абсолютный или относительный к golden-set.json. */
    file: z.string().min(1),
    /**
     * Опц. document_type_hint в API. Если задан — pipeline не будет
     * запускать classifier и пойдёт сразу в extract. Нужно, когда мы
     * меряем только качество extract, не classify.
     */
    document_type_hint: z.string().optional(),
    /** Metadata, прокидывается в POST /jobs. */
    metadata: z.record(z.unknown()).optional(),
    /** Ожидания. */
    expected: z
      .object({
        document_type: z.string().optional(),
        fields: z.array(FieldExpectation).default([]),
        /** Если true — наличие validation_issues = провал фикстуры. */
        no_issues: z.boolean().optional(),
        /** SLA для этой фикстуры. Опц. */
        max_total_duration_ms: z.number().int().positive().optional(),
        /** Финальный статус, который ожидаем. По умолчанию любой не failed. */
        terminal_status: z.enum(['done', 'needs_review']).optional(),
      })
      .strict()
      .default({ fields: [] }),
  })
  .strict();

export const GoldenSetSchema = z
  .object({
    /**
     * Pass-through JSON-schema link (для подсветки в IDE) — игнорируется
     * рантаймом, но без него `.strict()` выкидывает «unrecognized key».
     */
    $schema: z.string().optional(),
    /** Базовый URL doc-service, http://host:port. */
    instance: z.string().url(),
    /** PAT-токен или legacy api_token. */
    token: z.string().min(1),
    /** project_id (опц.) — если у пользователя несколько проектов. */
    project_id: z.string().uuid().optional(),
    /** Polling: интервал и таймаут на одну фикстуру. */
    poll: z
      .object({
        interval_ms: z.number().int().positive().default(2000),
        timeout_ms: z.number().int().positive().default(300_000),
      })
      .default({ interval_ms: 2000, timeout_ms: 300_000 }),
    fixtures: z.array(FixtureSchema).min(1),
  })
  .strict();

export type Fixture = z.infer<typeof FixtureSchema>;
export type GoldenSet = z.infer<typeof GoldenSetSchema>;
export type FieldExpectationT = z.infer<typeof FieldExpectation>;
