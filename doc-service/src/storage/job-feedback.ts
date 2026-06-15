import { db } from '../db.js';

/**
 * job_feedback — внешний фидбек потребителей о качестве извлечения по job.
 *
 * Потребительские системы (клиент №1 — SLAI) присылают вердикт «насколько
 * хорошо распознан/извлечён документ». Сырьё для ручного анализа гипотез по
 * улучшению пайплайна — на сам job (extracted/confidence/status) НЕ влияет.
 *
 * Старт простой — на уровне вердикта (correct|partial|incorrect) + коммент;
 * fields[] заложен под field-level детализацию на будущее.
 *
 * source_system НЕ берётся из тела запроса — он приходит из аутентифицированного
 * caller'а (named API key / service-аккаунт), чтобы источник оценки нельзя было
 * подделать. См. POST /api/v1/jobs/:id/feedback в routes/jobs.ts.
 */

export type FeedbackVerdict = 'correct' | 'partial' | 'incorrect';

/** Опц. field-level деталь — свободная форма, нормализуется на чтении API. */
export type FeedbackField = {
  path: string;
  note?: string;
  correct_value?: unknown;
};

export type JobFeedbackRow = {
  id: string;
  job_id: string;
  source_system: string;
  verdict: FeedbackVerdict;
  comment: string | null;
  fields: FeedbackField[] | null;
  rated_by: string | null;
  created_at: Date;
};

export type JobFeedbackInput = {
  jobId: string;
  sourceSystem: string;
  verdict: FeedbackVerdict;
  comment?: string | null;
  fields?: FeedbackField[] | null;
  ratedBy?: string | null;
};

class JobFeedbackRepo {
  /** Вставить одну запись фидбека. Возвращает созданную строку. */
  async create(input: JobFeedbackInput): Promise<JobFeedbackRow> {
    const { rows } = await db.query<JobFeedbackRow>(
      `INSERT INTO job_feedback
         (job_id, source_system, verdict, comment, fields, rated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.jobId,
        input.sourceSystem,
        input.verdict,
        input.comment ?? null,
        input.fields ? JSON.stringify(input.fields) : null,
        input.ratedBy ?? null,
      ],
    );
    return rows[0]!;
  }

  /** Весь фидбек по job, новые сверху. */
  async listByJob(jobId: string): Promise<JobFeedbackRow[]> {
    const { rows } = await db.query<JobFeedbackRow>(
      `SELECT * FROM job_feedback WHERE job_id = $1 ORDER BY created_at DESC, id DESC`,
      [jobId],
    );
    return rows;
  }

  // BIGSERIAL id приходит из pg как строка — оставляем как есть (string).
  // fields из JSONB pg уже распарсит в объект; нормализуем null/массив.
  toApi(row: JobFeedbackRow) {
    return {
      id: String(row.id),
      job_id: row.job_id,
      source_system: row.source_system,
      verdict: row.verdict,
      comment: row.comment,
      fields: row.fields ?? null,
      rated_by: row.rated_by,
      created_at: row.created_at.toISOString(),
    };
  }
}

export const jobFeedbackRepo = new JobFeedbackRepo();
export { JobFeedbackRepo };
