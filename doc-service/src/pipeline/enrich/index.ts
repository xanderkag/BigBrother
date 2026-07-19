/**
 * Enrichment-стадия: DaData party-by-INN.
 *
 * После extract (и validate) находим в extracted ИНН контрагентов, ходим в
 * DaData за официальной карточкой ЕГРЮЛ и кладём результат additive'ом под
 * `extracted._enrichment`. НИЧЕГО не перезаписываем — это provenance + флаги
 * расхождений для потребителя (SLAI и т.п.).
 *
 * Контракт жёсткий: стадия НИКОГДА не бросает наружу. Любая ошибка → caller
 * (orchestrator) логирует warn и пишет pipeline-step `enrich:failed`, job
 * продолжается в финальном статусе.
 *
 * `_enrichment` — НОВЫЙ опциональный reserved-key внутри extracted. v1 webhook
 * контракт не меняется: relay просто пронесёт его внутри `extracted`.
 *
 * NOTE (follow-up): кэш сейчас in-memory Map с TTL-эвикцией — на multi-instance
 * (несколько worker-pod'ов) каждый держит свой. Shared/Redis-кэш — отдельный
 * слайс (см. TECH_DEBT). Для первой версии in-process кэша достаточно.
 */
import type { Logger } from 'pino';
import type { DadataClient, DadataParty } from './dadata.js';

/** Пути party-объектов, в которых ищем ИНН. Алиасы — как в parsers/normalize. */
const PARTY_PATHS = [
  'seller',
  'shipper',
  'supplier',
  'buyer',
  'consignee',
  'customer',
  'carrier',
  'payer',
  'recipient',
  'client', // forwarding_order
  'expeditor', // forwarding_order
] as const;

export type EnrichmentBlock = {
  parties: Record<string, DadataParty>;
  _meta: {
    provider: 'dadata';
    at: string;
    mismatches: string[];
  };
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Цифры ИНН (10/12) из произвольной строки, иначе null. */
function extractInnDigits(raw: unknown): string | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length === 10 || digits.length === 12 ? digits : null;
}

/**
 * Собрать distinct ИНН из extracted + наблюдаемое имя контрагента для каждого
 * (для mismatch-флага). top-level `inn` тоже учитываем.
 */
function collectParties(
  extracted: Record<string, unknown>,
): Map<string, { name: string | null; paths: string[] }> {
  const out = new Map<string, { name: string | null; paths: string[] }>();

  const add = (innRaw: unknown, name: unknown, path: string | null): void => {
    const inn = extractInnDigits(innRaw);
    if (!inn) return;
    const nm = typeof name === 'string' && name.length > 0 ? name : null;
    const existing = out.get(inn);
    if (!existing) out.set(inn, { name: nm, paths: path ? [path] : [] });
    else {
      if (!existing.name && nm) existing.name = nm;
      if (path && !existing.paths.includes(path)) existing.paths.push(path);
    }
  };

  for (const path of PARTY_PATHS) {
    const party = extracted[path];
    if (!isObject(party)) continue;
    add(party.inn, party.name ?? party.name_full ?? party.title, path);
  }

  // top-level inn (некоторые типы кладут ИНН без вложенного party-объекта).
  add(extracted.inn, extracted.name ?? null, null);

  return out;
}

/**
 * Имя «преимущественно кириллическое» → сравнение с ЕГРЮЛ (кириллица) надёжно,
 * можно занулять ИНН при расхождении. Латиница/транслит («East-West Logistic»
 * ↔ «ИСТ-ВЕСТ ЛОДЖИСТИК») наивно не совпадёт — там только флаг, НЕ зануляем
 * (иначе убьём верный ИНН). ≥60% букв кириллица.
 */
function isCyrillicName(s: string): boolean {
  const cyr = (s.match(/[а-яё]/gi) ?? []).length;
  const lat = (s.match(/[a-z]/gi) ?? []).length;
  const total = cyr + lat;
  return total > 0 && cyr / total >= 0.6;
}

/** Нормализованное имя для сравнения: lower, без ОПФ-кавычек/пунктуации/пробелов. */
function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/["«»'`]/g, '')
    .replace(/\b(ооо|оао|зао|пао|ао|ип|нпо|гуп|муп)\b/g, '')
    .replace(/[^a-zа-я0-9]/gi, '')
    .trim();
}

function nameMatches(extractedName: string, party: DadataParty): boolean {
  const a = normName(extractedName);
  if (!a) return true; // нечего сравнивать
  for (const cand of [party.name_short, party.name_full]) {
    if (!cand) continue;
    const b = normName(cand);
    if (!b) continue;
    if (a === b || a.includes(b) || b.includes(a)) return true;
  }
  return false;
}

function statusNote(inn: string, status: string | null): string | null {
  switch (status) {
    case 'LIQUIDATED':
      return `ИНН ${inn}: организация ликвидирована (ЕГРЮЛ)`;
    case 'LIQUIDATING':
      return `ИНН ${inn}: организация в процессе ликвидации (ЕГРЮЛ)`;
    case 'BANKRUPT':
      return `ИНН ${inn}: организация в стадии банкротства (ЕГРЮЛ)`;
    case 'REORGANIZING':
      return `ИНН ${inn}: организация в процессе реорганизации (ЕГРЮЛ)`;
    case 'ACTIVE':
    case null:
      return null;
    default:
      return `ИНН ${inn}: статус в ЕГРЮЛ — ${status}`;
  }
}

/** TTL-кэш по ИНН. In-memory; follow-up — shared/Redis для multi-instance. */
class DadataCache {
  private readonly store = new Map<string, { at: number; value: DadataParty | null }>();
  constructor(private readonly ttlMs: number) {}

  get(inn: string): { hit: boolean; value: DadataParty | null } {
    const e = this.store.get(inn);
    if (!e) return { hit: false, value: null };
    if (Date.now() - e.at > this.ttlMs) {
      this.store.delete(inn);
      return { hit: false, value: null };
    }
    return { hit: true, value: e.value };
  }

  set(inn: string, value: DadataParty | null): void {
    this.store.set(inn, { at: Date.now(), value });
  }
}

let sharedCache: DadataCache | null = null;
function getCache(ttlMs: number): DadataCache {
  if (!sharedCache) sharedCache = new DadataCache(ttlMs);
  return sharedCache;
}

/** Тест-хелпер: сбросить in-memory кэш между прогонами. */
export function __resetEnrichCache(): void {
  sharedCache = null;
}

/**
 * Обогатить extracted данными DaData. Возвращает НОВЫЙ объект с
 * `_enrichment`-блоком, либо исходный extracted без изменений если ИНН не
 * найдены / клиент недоступен / любая ошибка (fail-soft).
 *
 * Никогда не бросает.
 */
export async function enrichWithDadata(
  extracted: Record<string, unknown>,
  client: DadataClient,
  cacheTtlMs: number,
  log: Logger,
): Promise<{ extracted: Record<string, unknown>; ok: boolean; lookups: number }> {
  try {
    const parties = collectParties(extracted);
    if (parties.size === 0) {
      return { extracted, ok: true, lookups: 0 };
    }

    const cache = getCache(cacheTtlMs);
    const enrichedParties: Record<string, DadataParty> = {};
    const mismatches: string[] = [];
    // Занулить чужой ИНН у стороны: {путь party → сырьё+ЕГРЮЛ-имя}.
    const dropPaths: Array<{ path: string; inn: string; dadataName: string }> = [];
    let lookups = 0;

    for (const [inn, { name, paths }] of parties) {
      let party: DadataParty | null;
      const cached = cache.get(inn);
      if (cached.hit) {
        party = cached.value;
      } else {
        party = await client.findByInn(inn);
        cache.set(inn, party);
        lookups += 1;
      }

      if (!party) {
        mismatches.push(`ИНН ${inn}: не найден в ЕГРЮЛ (DaData)`);
        continue;
      }

      enrichedParties[inn] = party;

      const sNote = statusNote(inn, party.status);
      if (sNote) mismatches.push(sNote);

      if (name && !nameMatches(name, party)) {
        const egrul = party.name_short ?? party.name_full ?? '';
        mismatches.push(`ИНН ${inn}: название "${name}" не совпадает с ЕГРЮЛ "${egrul}"`);
        // Чужой ИНН (не та сторона): зануляем ТОЛЬКО при кириллическом имени —
        // там сравнение с ЕГРЮЛ надёжно. Латиница-транслит остаётся флагом,
        // чтобы не убить верный ИНН из-за несовпадения письменности.
        if (isCyrillicName(name)) {
          for (const p of paths) dropPaths.push({ path: p, inn, dadataName: egrul });
        }
      }
    }

    const block: EnrichmentBlock = {
      parties: enrichedParties,
      _meta: {
        provider: 'dadata',
        at: new Date().toISOString(),
        mismatches,
      },
    };

    let out: Record<string, unknown> = { ...extracted, _enrichment: block };
    if (dropPaths.length > 0) {
      const dropped: Record<string, string> = { ...((out._inn_dropped as Record<string, string>) ?? {}) };
      for (const d of dropPaths) {
        const partyObj = { ...(out[d.path] as Record<string, unknown>) };
        partyObj.inn = null;
        out = { ...out, [d.path]: partyObj };
        dropped[`${d.path}.inn`] = `${d.inn} (имя↔ЕГРЮЛ не сошлось: "${d.dadataName}")`;
      }
      out._inn_dropped = dropped;
    }

    return { extracted: out, ok: true, lookups };
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'dadata enrichment failed (non-fatal)');
    return { extracted, ok: false, lookups: 0 };
  }
}
