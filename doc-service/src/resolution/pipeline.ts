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

function extractFieldValues(
  extracted: Record<string, unknown>,
  fields: string[],
): { field: string; value: string }[] {
  const result: { field: string; value: string }[] = [];
  for (const field of fields) {
    const raw = extracted[field];
    if (raw != null && raw !== '') {
      result.push({ field, value: String(raw).trim() });
    }
  }
  return result;
}

async function pushToNeedsReview(jobId: string, reason: string): Promise<void> {
  // Добавляем reason в extracted._issues и переводим в needs_review.
  // Работает только если job в статусе 'done' — если уже needs_review, просто добавляем issue.
  await db.query(
    `UPDATE jobs
     SET status    = 'needs_review',
         extracted = CASE
           WHEN extracted IS NULL THEN
             jsonb_build_object('_issues', jsonb_build_array($2::text))
           ELSE
             jsonb_set(
               extracted,
               '{_issues}',
               COALESCE(extracted->'_issues', '[]'::jsonb) || to_jsonb($2::text),
               true
             )
         END
     WHERE id = $1 AND status IN ('done', 'needs_review')`,
    [jobId, reason],
  );
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

  // Собираем все значения для поиска
  const values = fieldValues.map((fv) => fv.value);
  const entries = await listEntriesRepo.exactSearch({
    listTypeSlug: cfg.list_type,
    organizationId,
    values,
  });

  if (entries.length === 0) {
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
      { jobId, list_type: cfg.list_type, values },
      'resolution: entity not found in reference list',
    );
    return false;
  }

  // Записываем все найденные кандидаты как 'suggested'
  for (const entry of entries) {
    // Определяем какое именно поле дало матч
    const matched = fieldValues.find((fv) => entry.search_keys.includes(fv.value));
    await resolutionResultsRepo.insertEntityLink({
      jobId,
      organizationId,
      listTypeSlug: cfg.list_type,
      entryId: entry.id,
      matchScore: 1.0,
      matchMethod: 'exact',
      matchField: matched?.field ?? null,
      matchValue: matched?.value ?? null,
      status: 'suggested',
    });
  }

  log.info(
    { jobId, list_type: cfg.list_type, matches: entries.length },
    'resolution: entity links created',
  );
  return true;
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
    const item = rawItems[i] as Record<string, unknown>;
    const code = item[codeField] != null ? String(item[codeField]).trim() : '';
    const name = item[nameField] != null ? String(item[nameField]).trim() : '';

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
