/**
 * Validator registry — resolves the string specs stored in the
 * `document_types.validators` column to real builtin functions.
 *
 * Spec format: `name` or `name:arg1[,arg2,...]`. Args are typically
 * dot-paths into the `extracted` object (`seller.inn`, `vehicle.plate`)
 * or comma-separated paths for cross-field validators (`parties_differ:
 * seller.inn,buyer.inn`).
 *
 * Why string specs (vs serialised JS): the registry stays in code,
 * controlled by us; only the DECLARATION of which validators apply to
 * which document type lives in the DB. Admins can recombine builtins,
 * but cannot inject arbitrary code — the attack surface stays small.
 *
 * Adding a new validator: implement the function in `./validators.ts`,
 * register it here under a stable name. Specs reference that name from
 * the DB; no migration needed.
 */

import {
  validateCountryCode,
  validateDate,
  validateInn,
  validateKpp,
  validateMoney,
  validatePartiesDiffer,
  validateVatConsistency,
  validateVehiclePlate,
} from './validators.js';
import { resolveItemsArray } from '../../storage/normalize-extracted.js';

// Допустимые единицы измерения в РФ-учёте. Используется builtin'ом
// units_known для items[]. Список покрывает 95% B2B-кейсов; "штука"
// записывается по-разному, поэтому собираем варианты.
const KNOWN_UNITS = new Set([
  'шт', 'штука', 'штук', 'pcs', 'pc',
  'кг', 'kg', 'г', 'грамм', 'граммов', 'тонна', 'т',
  'м', 'метр', 'метров', 'm',
  'м²', 'м^2', 'кв.м', 'кв. м', 'кв.м.',
  'м³', 'м^3', 'куб.м', 'куб. м', 'куб.м.',
  'л', 'литр', 'литров', 'мл',
  'упак', 'упаковка', 'упак.', 'pack', 'packages',
  'компл', 'комплект', 'компл.', 'набор',
  'час', 'часов', 'мин', 'сек', 'день', 'месяц',
  'усл.ед', 'у.е.', 'уе',
]);

// Допустимые ставки НДС в РФ (плюс 7% временная для Дальнего Востока)
const VALID_VAT_RATES = new Set([0, 5, 7, 10, 20]);

export type Extracted = Record<string, unknown>;

/** Pluck a value at a dot-path. Returns `undefined` for any traversal miss. */
function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

type BuiltinValidator = (extracted: Extracted, args: string[]) => string | null;

/**
 * Each entry takes `(extracted, args)` and returns an issue message or
 * `null` for "ok / not applicable". Validators NEVER throw — bad inputs
 * resolve to `null` (skip) so a malformed spec or missing field doesn't
 * crash the pipeline.
 */
const BUILTINS: Record<string, BuiltinValidator> = {
  // inn_checksum:<path> — ИНН чек-сумма по приказу ФНС
  inn_checksum: (e, [path]) => {
    const value = asString(getPath(e, path ?? ''));
    return value ? validateInn(value) : null;
  },

  // kpp_format:<path> — формат NNNNCCNNN
  kpp_format: (e, [path]) => {
    const value = asString(getPath(e, path ?? ''));
    return value ? validateKpp(value) : null;
  },

  // vehicle_plate:<path> — российский госномер (12 разрешённых букв)
  vehicle_plate: (e, [path]) => {
    const value = asString(getPath(e, path ?? ''));
    return value ? validateVehiclePlate(value) : null;
  },

  // country_code:<path> — ISO 3166 alpha-2
  country_code: (e, [path]) => {
    const value = asString(getPath(e, path ?? ''));
    return value ? validateCountryCode(value) : null;
  },

  // date_range — проверяет поле `date` на диапазон и валидность даты
  date_range: (e) => {
    const value = asString(getPath(e, 'date'));
    return value ? validateDate(value) : null;
  },

  // money_sanity:<path> — finite, >=0, <1 trln
  money_sanity: (e, [path]) => {
    const value = asNumber(getPath(e, path ?? ''));
    return value !== undefined ? validateMoney(value, path ?? 'amount') : null;
  },

  // vat_consistency — vat ≈ total × rate / (100 + rate) на верхнем уровне
  vat_consistency: (e) => {
    return validateVatConsistency(asNumber(e.total), asNumber(e.vat), asNumber(e.vat_rate));
  },

  // parties_differ:<pathA>,<pathB> — два ИНН не совпадают
  parties_differ: (e, args) => {
    if (args.length < 2) return null;
    const a = asString(getPath(e, args[0]!));
    const b = asString(getPath(e, args[1]!));
    return validatePartiesDiffer(a, b);
  },

  // weight_nett_le_gross — масса нетто ≤ массы брутто на cargo
  weight_nett_le_gross: (e) => {
    const cargo = (e.cargo ?? null) as Record<string, unknown> | null;
    if (!cargo) return null;
    const gross = asNumber(cargo.weight_gross);
    const nett = asNumber(cargo.weight_nett);
    if (gross === undefined || nett === undefined) return null;
    if (nett > gross) return `Масса нетто (${nett}) больше массы брутто (${gross})`;
    return null;
  },

  // ── Phase D: per-line validators для items[] ──────────────────────────────

  /**
   * items_total_sum:<headerTotalField>[,tolerance] — сумма total_with_vat по
   * строкам сходится с шапкой ±tolerance (default 0.02 — две копейки на
   * округления). Если шапка пуста или items[] пуст — null (skip).
   */
  items_total_sum: (e, args) => {
    const headerField = args[0] ?? 'total';
    const tolerance = args[1] ? Number.parseFloat(args[1]) : 0.02;
    const headerTotal = asNumber(getPath(e, headerField));
    if (headerTotal === undefined) return null;
    const items = resolveItemsArray(e);
    if (items.length === 0) return null;
    let sum = 0;
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const t = asNumber((item as Record<string, unknown>).total_with_vat)
        ?? asNumber((item as Record<string, unknown>).total);
      if (t !== undefined) sum += t;
    }
    if (Math.abs(sum - headerTotal) > tolerance) {
      return `Сумма строк ${sum.toFixed(2)} не сходится с шапкой ${headerTotal.toFixed(2)} (расхождение ${(sum - headerTotal).toFixed(2)})`;
    }
    return null;
  },

  /**
   * items_vat_rates — каждая строка должна иметь vat_rate из {0, 5, 7, 10, 20}.
   * Сообщения агрегируются: пишем сводно «строки 3, 7, 12 имеют недопустимую
   * ставку», чтобы не засорять issues по 500 раз.
   */
  items_vat_rates: (e) => {
    const items = resolveItemsArray(e);
    if (items.length === 0) return null;
    const bad: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== 'object') continue;
      const rate = asNumber((item as Record<string, unknown>).vat_rate);
      if (rate !== undefined && !VALID_VAT_RATES.has(rate)) {
        bad.push(i + 1);
      }
    }
    if (bad.length === 0) return null;
    const sample = bad.slice(0, 10).join(', ');
    return `Недопустимая ставка НДС в строк${bad.length === 1 ? 'е' : 'ах'} ${sample}${bad.length > 10 ? ` (+${bad.length - 10})` : ''} (разрешены: 0, 5, 7, 10, 20)`;
  },

  /**
   * items_unit_known — единицы измерения должны быть из словаря KNOWN_UNITS.
   * Невидимые в словаре кейсы заметят оператора но не блочат job.
   */
  items_unit_known: (e) => {
    const items = resolveItemsArray(e);
    if (items.length === 0) return null;
    const unknown = new Map<string, number[]>();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== 'object') continue;
      const unit = asString((item as Record<string, unknown>).unit)?.toLowerCase().trim();
      if (unit && !KNOWN_UNITS.has(unit)) {
        if (!unknown.has(unit)) unknown.set(unit, []);
        unknown.get(unit)!.push(i + 1);
      }
    }
    if (unknown.size === 0) return null;
    const samples = [...unknown.entries()]
      .slice(0, 3)
      .map(([u, lines]) => `«${u}» (стр. ${lines.slice(0, 3).join(',')})`)
      .join('; ');
    return `Неизвестные единицы измерения: ${samples}`;
  },

  /**
   * items_line_consistency — qty × price ≈ total_without_vat (±0.02) для
   * каждой строки. Полезно ловит OCR-ошибки в количестве/цене.
   */
  items_line_consistency: (e) => {
    const items = resolveItemsArray(e);
    if (items.length === 0) return null;
    const bad: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      const qty = asNumber(it.qty);
      const price = asNumber(it.price);
      const total = asNumber(it.total_without_vat) ?? asNumber(it.total);
      if (qty === undefined || price === undefined || total === undefined) continue;
      if (Math.abs(qty * price - total) > 0.02) bad.push(i + 1);
    }
    if (bad.length === 0) return null;
    const sample = bad.slice(0, 10).join(', ');
    return `Расхождение qty×price ≠ total в строк${bad.length === 1 ? 'е' : 'ах'} ${sample}${bad.length > 10 ? ` (+${bad.length - 10})` : ''}`;
  },

  /**
   * items_hs_code_format — для документов с международной торговлей. ТН ВЭД
   * РФ/ЕАЭС — 10 цифр, EU — 8 цифр. Принимаем оба варианта.
   */
  items_hs_code_format: (e) => {
    const items = resolveItemsArray(e);
    if (items.length === 0) return null;
    const bad: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item || typeof item !== 'object') continue;
      const code = asString((item as Record<string, unknown>).hs_code)?.replace(/\s/g, '');
      if (!code) continue;
      if (!/^(\d{8}|\d{10})$/.test(code)) bad.push(i + 1);
    }
    if (bad.length === 0) return null;
    return `Неверный формат ТН ВЭД в строках ${bad.slice(0, 10).join(', ')}${bad.length > 10 ? ` (+${bad.length - 10})` : ''} (ожидается 8 или 10 цифр)`;
  },
};

export type ValidatorSpec = {
  /** Original string, kept for warnings/logs. */
  raw: string;
  name: string;
  args: string[];
};

export function parseSpec(raw: string): ValidatorSpec {
  const colonAt = raw.indexOf(':');
  if (colonAt === -1) return { raw, name: raw, args: [] };
  const name = raw.slice(0, colonAt);
  const args = raw
    .slice(colonAt + 1)
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  return { raw, name, args };
}

export type RunValidatorsOptions = {
  /** Called once per unknown spec name — defaults to silent. Hook for logging. */
  onUnknown?: (spec: ValidatorSpec) => void;
};

/**
 * Run an ordered list of validator specs against `extracted`. Returns
 * the collected issues. Unknown specs are silently skipped (or routed
 * through `onUnknown` for logging) — better to mis-configure than crash.
 */
export function runValidatorSpecs(
  extracted: Extracted,
  specs: readonly string[],
  options: RunValidatorsOptions = {},
): string[] {
  const issues: string[] = [];
  for (const raw of specs) {
    const spec = parseSpec(raw);
    const fn = BUILTINS[spec.name];
    if (!fn) {
      options.onUnknown?.(spec);
      continue;
    }
    try {
      const msg = fn(extracted, spec.args);
      if (msg) issues.push(msg);
    } catch {
      // Validators are pure & defensive; this should not fire. Swallow to
      // avoid breaking the orchestrator on unexpected runtime errors.
    }
  }
  return issues;
}

/** Exposed for tests + future admin-side "show me all available validators". */
export function listBuiltinNames(): string[] {
  return Object.keys(BUILTINS).sort();
}
