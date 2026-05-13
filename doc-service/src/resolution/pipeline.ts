/**
 * Resolution Pipeline — главный оркестратор фазы привязки документа.
 *
 * Запускается после `finalize()` в processJob(). Ошибки здесь не валят job —
 * резолюция best-effort: если справочник недоступен или конфиг неверный,
 * документ всё равно остаётся в финальном статусе.
 *
 * Алгоритм:
 *   1. Для каждого entity_link config: найти значения полей в extracted,
 *      запустить exact-матч против справочника, записать job_entity_links.
 *   2. Если item_matching config: пройтись по extracted.items[],
 *      для каждой строки запустить exact-матч (по code, затем по name),
 *      записать job_item_matches.
 *   3. Для каждого not_found при on_not_found='needs_review':
 *      принудительно перевести job в needs_review с описанием проблемы.
 */

import type { Logger } from 'pino';
import { db } from '../db.js';
import { jobsRepo } from '../storage/jobs.js';
import { listEntriesRepo, resolutionResultsRepo } from './list-repo.js';
import type {
  EntityLinkConfig,
  ItemMatchingConfig,
  ResolutionConfig,
  OnNotFound,
} from './types.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Извлекает значения скалярных полей из `extracted` для поиска в справочнике.
 *
 * Принимаются только `string` и `number` — массив/объект не имеет смысла как
 * exact-ключ (превратился бы в "[object Object]"). Числа приводятся к строке
 * как естественное представление. Пробелы по краям убираются — у админа в
 * справочнике search_keys могут быть без пробелов, а OCR любит лишние.
 */
function extractFieldValues(
  extracted: Record<string, unknown>,
  fields: string[],
): { field: string; value: string }[] {
  const result: { field: string; value: string }[] = [];
  for (const field of fields) {
    const raw = extracted[field];
    if (raw == null || raw === '') continue;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed) result.push({ field, value: trimmed });
    } else if (typeof raw === 'number' || typeof raw === 'bigint') {
      result.push({ field, value: String(raw) });
    }
    // boolean / object / array — для exact-матча бессмысленны, пропускаем
  }
  return result;
}

async function pushToNeedsReview(jobId: string, reason: string): Promise<void> {
  // Идём через jobsRepo чтобы переход был виден всем потенциальным
  // подписчикам (audit-log, observability). Сам метод не валит если job
  // уже не в done/needs_review — это OK, резолюция best-effort.
  await jobsRepo.markNeedsReview(jobId, reason);
}

// ---------------------------------------------------------------------------
// Entity linking
// ---------------------------------------------------------------------------

async function runEntityLink(
  jobId: string,
  organizationId: string,
  extracted: Record<string, unknown>,
  cfg: EntityLinkConfig,
  log: Logger,
): Promise<boolean> {
  // Нет сущностей → not_found
  const fieldValues = extractFieldValues(extracted, cfg.match_fields);
  if (fieldValues.length === 0) {
    await resolutionResultsRepo.insertEntityLink({
      jobId,
      organizationId,
      listTypeSlug: cfg.list_type,
      entryId: null,
      matchScore: null,
      matchMethod: null,
      matchField: null,
      matchValue: null,
      status: 'not_found',
    });
    log.debug(
      { jobId, list_type: cfg.list_type, match_fields: cfg.match_fields },
      'resolution: entity fields empty in extracted → not_found',
    );
    return false;
  }

  // Идём по полям в порядке match_fields: первое поле с матчем побеждает.
  // Это позволяет приоритезировать «более точные» поля (cargo_id > cargo_number).
  // Также: ищем по конкретному значению — точно знаем, какое поле дало match.
  for (const fv of fieldValues) {
    const entries = await listEntriesRepo.exactSearch({
      listTypeSlug: cfg.list_type,
      organizationId,
      values: [fv.value],
    });
    if (entries.length === 0) continue;

    for (const entry of entries) {
      await resolutionResultsRepo.insertEntityLink({
        jobId,
        organizationId,
        listTypeSlug: cfg.list_type,
        entryId: entry.id,
        matchScore: 1.0,
        matchMethod: 'exact',
        matchField: fv.field,
        matchValue: fv.value,
        status: 'suggested',
      });
    }
    log.info(
      { list_type: cfg.list_type, field: fv.field, matches: entries.length },
      'resolution: entity links created',
    );
    return true;
  }

  // Ни одно поле не нашлось — пишем not_found с первым попробованным значением
  const fv = fieldValues[0]!;
  await resolutionResultsRepo.insertEntityLink({
    jobId,
    organizationId,
    listTypeSlug: cfg.list_type,
    entryId: null,
    matchScore: null,
    matchMethod: 'exact',
    matchField: fv.field,
    matchValue: fv.value,
    status: 'not_found',
  });
  log.info(
    { list_type: cfg.list_type, values: fieldValues.map((v) => v.value) },
    'resolution: entity not found in reference list',
  );
  return false;
}

// ---------------------------------------------------------------------------
// Item matching
// ---------------------------------------------------------------------------

async function runItemMatching(
  jobId: string,
  organizationId: string,
  extracted: Record<string, unknown>,
  cfg: ItemMatchingConfig,
  log: Logger,
): Promise<{ matched: number; notFound: number }> {
  const nameField = cfg.name_field ?? 'name';
  const codeField = cfg.code_field ?? 'code';

  // Извлекаем массив строк из extracted
  const rawItems = extracted[cfg.items_field];
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { matched: 0, notFound: 0 };
  }

  let matched = 0;
  let notFound = 0;

  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    // OCR/LLM иногда отдают null/строки в items[] — пропускаем безопасно
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const code =
      typeof item[codeField] === 'string'
        ? (item[codeField] as string).trim()
        : typeof item[codeField] === 'number'
          ? String(item[codeField])
          : '';
    const name =
      typeof item[nameField] === 'string'
        ? (item[nameField] as string).trim()
        : typeof item[nameField] === 'number'
          ? String(item[nameField])
          : '';

    // Шаг 1: exact по коду
    let entries = code
      ? await listEntriesRepo.exactSearch({
          listTypeSlug: cfg.list_type,
          organizationId,
          values: [code],
          limit: 3,
        })
      : [];

    let method: string | null = code && entries.length > 0 ? 'exact_code' : null;

    // Шаг 2: exact по названию (нормализованное)
    if (entries.length === 0 && name) {
      entries = await listEntriesRepo.exactSearch({
        listTypeSlug: cfg.list_type,
        organizationId,
        values: [name.toLowerCase()],
        limit: 3,
      });
      if (entries.length > 0) method = 'exact_name';
    }

    if (entries.length > 0) {
      const best = entries[0]!;
      await resolutionResultsRepo.insertItemMatch({
        jobId,
        organizationId,
        listTypeSlug: cfg.list_type,
        itemIndex: i,
        itemRaw: item,
        entryId: best.id,
        matchScore: 1.0,
        matchMethod: method,
        status: 'suggested',
      });
      matched++;
    } else {
      await resolutionResultsRepo.insertItemMatch({
        jobId,
        organizationId,
        listTypeSlug: cfg.list_type,
        itemIndex: i,
        itemRaw: item,
        entryId: null,
        matchScore: null,
        matchMethod: 'exact',
        status: 'not_found',
        issues: ['not_in_catalog'],
      });
      notFound++;
    }
  }

  log.info(
    { jobId, list_type: cfg.list_type, total: rawItems.length, matched, not_found: notFound },
    'resolution: item matching complete',
  );

  return { matched, notFound };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runResolutionPipeline(params: {
  jobId: string;
  organizationId: string;
  extracted: Record<string, unknown>;
  resolutionConfig: ResolutionConfig;
  log: Logger;
}): Promise<void> {
  const { jobId, organizationId, extracted, resolutionConfig, log } = params;

  const resolutionLog = log.child({ phase: 'resolution', jobId });

  // Advisory lock на jobId — защита от двойного запуска (finalize + re-resolve).
  // pg_try_advisory_lock возвращает false если кто-то держит lock — тогда тихо
  // выходим, тот процесс закончит сам. hashtextextended даёт стабильный int8.
  const lockKey = `resolution:${jobId}`;
  const { rows: lockRows } = await db.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
    [lockKey],
  );
  if (!lockRows[0]?.locked) {
    resolutionLog.info('resolution: another worker holds the lock, skipping');
    return;
  }

  try {
    // Очищаем предыдущие результаты (при повторном прогоне через /re-resolve)
    await resolutionResultsRepo.deleteByJob(jobId);

    // ── Entity links ──────────────────────────────────────────────────────────
    for (const linkCfg of resolutionConfig.entity_links ?? []) {
      try {
        const found = await runEntityLink(jobId, organizationId, extracted, linkCfg, resolutionLog);
        if (!found) {
          await handleNotFound(jobId, `entity not resolved: ${linkCfg.list_type}`, linkCfg.on_not_found);
        }
      } catch (err) {
        resolutionLog.warn(
          { err, list_type: linkCfg.list_type },
          'resolution: entity link failed, skipping',
        );
      }
    }

    // ── Item matching ─────────────────────────────────────────────────────────
    const itemCfg = resolutionConfig.item_matching;
    if (itemCfg) {
      try {
        const { notFound } = await runItemMatching(
          jobId,
          organizationId,
          extracted,
          itemCfg,
          resolutionLog,
        );
        if (notFound > 0) {
          await handleNotFound(
            jobId,
            `${notFound} item(s) not found in ${itemCfg.list_type}`,
            itemCfg.on_not_found ?? 'warn',
          );
        }
      } catch (err) {
        resolutionLog.warn({ err }, 'resolution: item matching failed, skipping');
      }
    }

    resolutionLog.info('resolution pipeline complete');
  } finally {
    // Освобождаем lock в любом случае. Ошибка освобождения — лог, не throw.
    await db.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey])
      .catch((err: unknown) =>
        resolutionLog.warn({ err }, 'resolution: failed to release advisory lock'),
      );
  }
}

async function handleNotFound(
  jobId: string,
  reason: string,
  onNotFound: OnNotFound | undefined,
): Promise<void> {
  const policy = onNotFound ?? 'needs_review';
  if (policy === 'needs_review') {
    await pushToNeedsReview(jobId, `[resolution] ${reason}`);
  }
  // 'warn' и 'ignore' — в лог уже записано выше, ничего дополнительного
}
