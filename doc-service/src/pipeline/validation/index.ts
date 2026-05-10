/**
 * Validation composer. Reads `extracted` and runs the validators that apply
 * for the given document type, returning a flat `string[]` of issues.
 *
 * Validators don't throw and don't mutate. The composer only knows which
 * fields exist on each document type; the actual rules live in
 * `./validators.ts`. Adding a new document type means: add a case here +
 * (optionally) extend validators.
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
 * Run validators relevant to `type` over `extracted`. Returns 0..N issues.
 * Empty array = nothing wrong (or nothing to check).
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
