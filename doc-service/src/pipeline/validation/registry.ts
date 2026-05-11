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
