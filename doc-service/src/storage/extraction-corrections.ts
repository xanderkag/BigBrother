import { db } from '../db.js';

/**
 * extraction_corrections — внутренний леджер ручных правок операторов.
 *
 * Когда оператор редактирует extracted у job (PATCH /jobs/:id/extracted),
 * каждое изменённое поле фиксируется как before→after. Это самый ценный
 * сигнал для обучения: раньше правка просто перезаписывала extracted, а
 * разница (что выдала система vs на что исправил человек) терялась.
 *
 * Парная сущность к job_feedback: тот — внешний вердикт потребителей,
 * этот — внутренние правки наших операторов. На сам job НЕ влияет
 * (extracted/confidence/status не трогаем) — копится как сырьё для
 * ручного анализа «по типу/полю чаще всего промахи».
 */

export type ExtractionCorrectionRow = {
  id: string;
  job_id: string;
  document_type: string | null;
  field_path: string;
  value_before: string | null;
  value_after: string | null;
  source_system: string | null;
  corrected_by: string | null;
  created_at: Date;
};

export type ExtractionCorrectionInput = {
  jobId: string;
  documentType?: string | null;
  fieldPath: string;
  valueBefore?: string | null;
  valueAfter?: string | null;
  sourceSystem?: string | null;
  correctedBy?: string | null;
};

class ExtractionCorrectionsRepo {
  /** Батч-вставка правок. No-op на пустом массиве. Возвращает созданные строки. */
  async createMany(rows: ExtractionCorrectionInput[]): Promise<ExtractionCorrectionRow[]> {
    if (rows.length === 0) return [];

    const cols = 7;
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const base = i * cols;
      tuples.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`,
      );
      values.push(
        r.jobId,
        r.documentType ?? null,
        r.fieldPath,
        r.valueBefore ?? null,
        r.valueAfter ?? null,
        r.sourceSystem ?? null,
        r.correctedBy ?? null,
      );
    }

    const { rows: inserted } = await db.query<ExtractionCorrectionRow>(
      `INSERT INTO extraction_corrections
         (job_id, document_type, field_path, value_before, value_after, source_system, corrected_by)
       VALUES ${tuples.join(', ')}
       RETURNING *`,
      values,
    );
    return inserted;
  }

  /** Все правки по job, новые сверху. */
  async listByJob(jobId: string): Promise<ExtractionCorrectionRow[]> {
    const { rows } = await db.query<ExtractionCorrectionRow>(
      `SELECT * FROM extraction_corrections WHERE job_id = $1 ORDER BY created_at DESC, id DESC`,
      [jobId],
    );
    return rows;
  }

  // BIGSERIAL id приходит из pg строкой — приводим явно (на случай числа).
  toApi(row: ExtractionCorrectionRow) {
    return {
      id: String(row.id),
      job_id: row.job_id,
      document_type: row.document_type,
      field_path: row.field_path,
      value_before: row.value_before,
      value_after: row.value_after,
      source_system: row.source_system,
      corrected_by: row.corrected_by,
      created_at: row.created_at.toISOString(),
    };
  }
}

export const extractionCorrectionsRepo = new ExtractionCorrectionsRepo();
export { ExtractionCorrectionsRepo };
