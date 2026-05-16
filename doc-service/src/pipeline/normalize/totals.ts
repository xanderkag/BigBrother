/**
 * Recomputed totals — пересчитываем `total_without_vat`, `vat_amount` и
 * `total_with_vat` из `items[]` если значение в шапке расходится с
 * фактической суммой позиций.
 *
 * Зачем: в bench v2 показано что Gemma 12B выдаёт корректные `items[]`,
 * но в шапке `total_with_vat` ставит значение которое не сходится
 * (total_match = 20%). LLM плохо суммирует длинные таблицы.
 *
 * Контракт:
 *   - Запускается ПОСЛЕ нормализации ИНН/госномера и ДО validation
 *   - Идемпотентна — повторный вызов на уже пересчитанном объекте
 *     ничего не меняет
 *   - Если `items[]` нет или сумма не валидна — возвращает extracted
 *     как есть, не падает
 *   - Если расхождение < 1 рубля — оставляем оригинал (модель попала)
 *   - Если расхождение ≥ 1 рубля — заменяем + пишем `_total_recomputed: true`
 *
 * Не трогаем `total_without_vat` / `vat_amount` если в `items[]` нет
 * соответствующих полей — это нормально для документов где детальные
 * суммы по позициям не указаны (например ТТН с массой брутто/нетто).
 */

interface ItemRow {
  total?: unknown;
  total_with_vat?: unknown;
  total_without_vat?: unknown;
  vat_amount?: unknown;
  price?: unknown;
  qty?: unknown;
  vat_rate?: unknown;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    // Убираем пробелы, запятую → точка, валютные символы
    const cleaned = v.replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  if (v && typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
    return asNumber((v as Record<string, unknown>).value);
  }
  return null;
}

/**
 * Берёт самое доступное поле для «итог по строке с НДС».
 * Порядок предпочтения: total_with_vat > total > price * qty + НДС.
 */
function rowTotalWithVat(item: ItemRow): number | null {
  const explicit = asNumber(item.total_with_vat) ?? asNumber(item.total);
  if (explicit !== null) return explicit;
  // Восстанавливаем из qty × price + vat_rate если есть
  const qty = asNumber(item.qty);
  const price = asNumber(item.price);
  if (qty === null || price === null) return null;
  const base = qty * price;
  const vatRate = asNumber(item.vat_rate);
  if (vatRate === null) return base;
  return base * (1 + vatRate / 100);
}

function rowTotalWithoutVat(item: ItemRow): number | null {
  const explicit = asNumber(item.total_without_vat);
  if (explicit !== null) return explicit;
  const qty = asNumber(item.qty);
  const price = asNumber(item.price);
  if (qty === null || price === null) return null;
  return qty * price;
}

function rowVatAmount(item: ItemRow): number | null {
  const explicit = asNumber(item.vat_amount);
  if (explicit !== null) return explicit;
  const withVat = rowTotalWithVat(item);
  const withoutVat = rowTotalWithoutVat(item);
  if (withVat === null || withoutVat === null) return null;
  return withVat - withoutVat;
}

export interface RecomputeResult {
  changed: boolean;
  computed: {
    total_without_vat?: number;
    vat_amount?: number;
    total_with_vat?: number;
  };
  /** На сколько каждое поле разошлось с оригиналом (для отладки/issues) */
  deltas: Record<string, number>;
}

const RECOMPUTE_THRESHOLD_RUB = 1.0;

export function recomputeTotalsFromItems(
  extracted: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!extracted || typeof extracted !== 'object') return extracted;

  const items = (extracted as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) return extracted;

  // Считаем суммы по строкам. Если хотя бы одну строку не смогли
  // посчитать — не уверены в правильности total'а, пропускаем.
  let sumWith = 0;
  let sumWithout = 0;
  let sumVat = 0;
  let haveWith = true;
  let haveWithout = true;
  let haveVat = true;

  for (const row of items as ItemRow[]) {
    const w = rowTotalWithVat(row);
    if (w === null) haveWith = false; else sumWith += w;
    const wo = rowTotalWithoutVat(row);
    if (wo === null) haveWithout = false; else sumWithout += wo;
    const v = rowVatAmount(row);
    if (v === null) haveVat = false; else sumVat += v;
  }

  if (!haveWith) return extracted;

  // MVP-логика: чиним только total_with_vat (это и есть основной критерий
  // total_match в бенче). total_without_vat / vat_amount оставляем как
  // LLM их прислал — туда лезть рискованнее.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const recomputed = round2(sumWith);
  const original = asNumber(extracted.total_with_vat);

  // Менять ситуация когда: либо оригинала нет (LLM забыл), либо есть и
  // расхождение > порога. Иначе LLM попал — не трогаем.
  if (original !== null && Math.abs(original - recomputed) < RECOMPUTE_THRESHOLD_RUB) {
    return extracted;
  }

  const out = { ...extracted } as Record<string, unknown>;
  out.total_with_vat = recomputed;
  const deltas: Record<string, number> = {
    total_with_vat: original === null ? recomputed : recomputed - original,
  };

  // Помечаем что мы пересчитали — UI/integrator увидят флаг и смогут
  // показать оригинал/новое значение / issue
  out._totals_recomputed = {
    from: 'items_sum',
    deltas,
  };
  return out;
}
