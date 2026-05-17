/**
 * Per-field confidence (F2) — пост-обработка от LLM.
 *
 * Контракт:
 *   - LLM в инстракции просим вернуть `field_confidence` map. Backend
 *     (inference-service) валидирует и кладёт в `extracted._field_confidence`
 *   - Здесь мы:
 *     1. Дополняем недостающие критические поля (если LLM забыла указать
 *        confidence для seller.inn — ставим по умолчанию)
 *     2. Калибруем: если ИНН по checksum невалидный — снижаем confidence
 *        в 2× (LLM могла «галлюцинировать»)
 *     3. Если plate нормализован успешно — ставим минимум 0.9
 *     4. Поднимаем `_field_confidence` map наверх webhook payload
 *        (как top-level поле, не внутри extracted)
 *
 * Идемпотентно, pure-function.
 */
import { validateInn } from '../validation/validators.js';
import { normalizePlate } from './identifiers.js';

const CRITICAL_PATHS = [
  'number',
  'date',
  'seller.inn',
  'buyer.inn',
  'total_with_vat',
] as const;

const DEFAULT_CONFIDENCE_WHEN_PRESENT = 0.7; // если LLM забыла указать
const CONFIDENCE_PENALTY_BAD_CHECKSUM = 0.5;  // множитель при невалид checksum
const CONFIDENCE_BOOST_VALID_PLATE = 0.9;     // минимум для plate после normalize

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export interface FieldConfidenceResult {
  /** Финальный map для webhook payload (`_field_confidence` top-level) */
  fieldConfidence: Record<string, number>;
  /** extracted без `_field_confidence` (мы перенесли на верх) */
  cleanedExtracted: Record<string, unknown>;
}

export function processFieldConfidence(
  extracted: Record<string, unknown> | null,
): FieldConfidenceResult {
  if (!extracted || typeof extracted !== 'object') {
    return { fieldConfidence: {}, cleanedExtracted: extracted ?? {} };
  }

  const rawFc = extracted._field_confidence;
  const fc: Record<string, number> = {};

  // 1. Импортируем то что LLM прислала
  if (rawFc && typeof rawFc === 'object' && !Array.isArray(rawFc)) {
    for (const [k, v] of Object.entries(rawFc as Record<string, unknown>)) {
      if (typeof v === 'number' && v >= 0 && v <= 1) fc[k] = v;
      else if (typeof v === 'string') {
        const num = parseFloat(v);
        if (!isNaN(num) && num >= 0 && num <= 1) fc[k] = num;
      }
    }
  }

  // 2. Дефолты для критичных полей если LLM не указала
  for (const path of CRITICAL_PATHS) {
    if (path in fc) continue;
    const value = getByPath(extracted, path);
    if (value === undefined || value === null || value === '') continue;
    fc[path] = DEFAULT_CONFIDENCE_WHEN_PRESENT;
  }

  // 3. Калибровка по checksum ИНН
  for (const innPath of ['seller.inn', 'buyer.inn', 'shipper.inn', 'consignee.inn', 'carrier.inn']) {
    const inn = getByPath(extracted, innPath);
    if (typeof inn !== 'string') continue;
    const digitsOnly = inn.replace(/\D/g, '');
    if (digitsOnly.length !== 10 && digitsOnly.length !== 12) {
      // Невалидная длина — confidence резко падает
      if (innPath in fc) fc[innPath] = Math.min(fc[innPath]!, 0.3);
      continue;
    }
    const validationError = validateInn(digitsOnly);
    if (validationError !== null) {
      // Checksum не сошёлся — LLM могла «угадать» цифры. Снижаем 2×.
      if (innPath in fc) fc[innPath] = fc[innPath]! * CONFIDENCE_PENALTY_BAD_CHECKSUM;
      else fc[innPath] = 0.3;
    } else {
      // Checksum валидный — поднимаем минимум до 0.95 (даже если LLM
      // / дефолт ставили ниже). Если LLM ставила выше (например 0.99) —
      // оставляем её значение.
      fc[innPath] = Math.max(fc[innPath] ?? 0, 0.95);
    }
  }

  // 4. Калибровка по госномеру (нормализация успешна → высокий confidence)
  const plate = getByPath(extracted, 'vehicle.plate');
  if (typeof plate === 'string') {
    const normalized = normalizePlate(plate);
    if (normalized !== null) {
      // Plate в правильном формате — точно угадали
      if (!('vehicle.plate' in fc)) fc['vehicle.plate'] = CONFIDENCE_BOOST_VALID_PLATE;
      else fc['vehicle.plate'] = Math.max(fc['vehicle.plate']!, CONFIDENCE_BOOST_VALID_PLATE);
    } else if ('vehicle.plate' in fc) {
      // Plate не нормализован — снижаем
      fc['vehicle.plate'] = Math.min(fc['vehicle.plate']!, 0.4);
    }
  }

  // Округляем до 2 знаков чтобы не плодить мусор
  for (const k of Object.keys(fc)) {
    fc[k] = Math.round(fc[k]! * 100) / 100;
  }

  // 5. Извлекаем _field_confidence из extracted (он должен быть top-level
  // в webhook, а в extracted он мешает SLAI matcher'у — там должны быть
  // только бизнес-поля документа).
  const cleaned = { ...extracted } as Record<string, unknown>;
  delete cleaned._field_confidence;

  return { fieldConfidence: fc, cleanedExtracted: cleaned };
}
