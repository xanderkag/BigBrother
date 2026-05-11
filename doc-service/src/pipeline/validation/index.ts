/**
 * Validation composer.
 *
 * Two entry points exist side-by-side during the Document-Type-Registry
 * migration:
 *
 *   `validateExtractedWithResolver` — primary, async. Reads validator
 *     specs from the DB-backed registry via DocumentTypeResolver and
 *     runs them through the builtin function registry. Falls back to
 *     the hardcoded composer when the type isn't (yet) in the DB.
 *
 *   `validateExtracted` — sync, hardcoded. Pre-existing composer kept
 *     as fallback and for direct unit tests of the validation logic
 *     without DB dependencies. Will be retired when every caller is
 *     migrated to the async variant.
 *
 * Validators themselves don't throw and don't mutate. The actual rules
 * live in `./validators.ts`; the registry binds them to string names in
 * `./registry.ts`.
 */

import type { DocumentType } from '../../types/documents.js';
import {
  validateCountryCode,
  validateDate,
  validateInn,
  validateKpp,
  validateMoney,
  validatePartiesDiffer,
  validatePositionsSum,
  validateVatConsistency,
  validateVehiclePlate,
} from './validators.js';
import { runValidatorSpecs } from './registry.js';
import { documentTypeResolver } from '../document-type-resolver.js';

type WarnLogger = { warn: (data: Record<string, unknown>, msg: string) => void };

type Bag = Record<string, unknown>;

function s(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const v = (obj as Bag)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function n(obj: unknown, key: string): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const v = (obj as Bag)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function arr(obj: unknown, key: string): unknown[] | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const v = (obj as Bag)[key];
  return Array.isArray(v) ? v : undefined;
}

function push(into: string[], msg: string | null): void {
  if (msg) into.push(msg);
}

/**
 * Async variant: consults the Document Type Registry first. When the
 * type has DB-configured validators, runs them via the registry; when
 * not (slug missing from `document_types`, e.g. early dev DBs), falls
 * back to the hardcoded composer below.
 *
 * Unknown validator names are logged through the supplied logger and
 * skipped — preferable to crashing the orchestrator on a typo.
 */
export async function validateExtractedWithResolver(
  extracted: Bag,
  type: DocumentType,
  log?: WarnLogger,
): Promise<string[]> {
  const typeConfig = await documentTypeResolver.get(type);
  if (typeConfig && typeConfig.validators.length > 0) {
    return runValidatorSpecs(extracted, typeConfig.validators, {
      onUnknown: (spec) => {
        log?.warn({ spec: spec.raw, document_type: type }, 'unknown validator spec, skipping');
      },
    });
  }
  // No DB entry → keep validating with the legacy hardcoded composer so
  // a fresh DB or a deliberately-removed type doesn't lose coverage.
  return validateExtracted(extracted, type);
}

/**
 * Run validators relevant to `type` over `extracted`. Returns 0..N issues.
 * Empty array = nothing wrong (or nothing to check).
 *
 * Synchronous, hardcoded fallback. See `validateExtractedWithResolver`
 * for the DB-driven path.
 */
export function validateExtracted(extracted: Bag, type: DocumentType): string[] {
  const issues: string[] = [];

  switch (type) {
    case 'invoice':
    case 'factInvoice':
    case 'UPD':
      validateInvoiceFamily(extracted, issues);
      break;
    case 'TTN':
      validateTtn(extracted, issues);
      break;
    case 'CMR':
      validateCmr(extracted, issues);
      break;
    case 'AKT':
      validateAkt(extracted, issues);
      break;
  }

  // Date check applies to every document type with a `date` field.
  const date = s(extracted, 'date');
  if (date) push(issues, validateDate(date));

  return issues;
}

function validateInvoiceFamily(e: Bag, issues: string[]): void {
  const sellerInn = s(e.seller, 'inn');
  const buyerInn = s(e.buyer, 'inn');
  if (sellerInn) push(issues, validateInn(sellerInn));
  if (buyerInn) push(issues, validateInn(buyerInn));
  push(issues, validatePartiesDiffer(sellerInn, buyerInn));

  const sellerKpp = s(e.seller, 'kpp');
  const buyerKpp = s(e.buyer, 'kpp');
  if (sellerKpp) push(issues, validateKpp(sellerKpp));
  if (buyerKpp) push(issues, validateKpp(buyerKpp));

  const total = n(e, 'total');
  const vat = n(e, 'vat');
  const vatRate = n(e, 'vat_rate');
  if (total !== undefined) push(issues, validateMoney(total, 'total'));
  if (vat !== undefined) push(issues, validateMoney(vat, 'vat'));
  push(issues, validateVatConsistency(total, vat, vatRate));

  const positions = arr(e, 'positions') as
    | Array<{ total?: number | null }>
    | undefined;
  push(issues, validatePositionsSum(positions, total));
}

function validateTtn(e: Bag, issues: string[]): void {
  const shipperInn = s(e.shipper, 'inn');
  const consigneeInn = s(e.consignee, 'inn');
  if (shipperInn) push(issues, validateInn(shipperInn));
  if (consigneeInn) push(issues, validateInn(consigneeInn));
  push(issues, validatePartiesDiffer(shipperInn, consigneeInn));

  const plate = s(e.vehicle, 'plate');
  if (plate) push(issues, validateVehiclePlate(plate));

  const cargoWeight = n(e.cargo, 'weight_gross');
  const cargoNett = n(e.cargo, 'weight_nett');
  if (cargoWeight !== undefined && cargoNett !== undefined && cargoNett > cargoWeight) {
    issues.push(`Масса нетто (${cargoNett}) больше массы брутто (${cargoWeight})`);
  }
}

function validateCmr(e: Bag, issues: string[]): void {
  const senderCountry = s(e.sender, 'country');
  const recipientCountry = s(e.recipient, 'country');
  if (senderCountry) push(issues, validateCountryCode(senderCountry));
  if (recipientCountry) push(issues, validateCountryCode(recipientCountry));
}

function validateAkt(e: Bag, issues: string[]): void {
  const aInn = s(e.party_a, 'inn');
  const bInn = s(e.party_b, 'inn');
  if (aInn) push(issues, validateInn(aInn));
  if (bInn) push(issues, validateInn(bInn));
  push(issues, validatePartiesDiffer(aInn, bInn));

  const total = n(e, 'total');
  const vat = n(e, 'vat');
  if (total !== undefined) push(issues, validateMoney(total, 'total'));
  if (vat !== undefined) push(issues, validateMoney(vat, 'vat'));
}
