/**
 * ТНВЭД / HS-код: санитизация и восстановление из текста.
 *
 * Запрос SLAI 2026-07-19 (§4 — справочник ТНВЭД + автозаполнение графы 33 ЭТД):
 * код ТН ВЭД нужен СТРУКТУРНЫМ полем (`items[].hs_code` + doc-level `hs_codes[]`),
 * а не зашитым в текст названий позиций. На живом потоке две проблемы:
 *   1. модель кладёт в `hs_code` мусор — артикул, «22000», «6195622 1BBEA…» —
 *      его надо канонизировать/выкинуть (по образцу sanitize-inns);
 *   2. на части типов код в тексте есть, а полем не приезжает (proforma — 0/82,
 *      т.к. в схеме не было `hs_code`) — добить из текста (по образцу
 *      container-recovery / inn-recovery).
 *
 * Канон: `normalizeHsCode` (ved-fields) — только цифры, длина 6/8/10 (HS-6, ЕС-8,
 * ТН ВЭД ЕАЭС-10); иначе null. Валидатор `items_hs_code_format` принимает 8/10.
 * Обе функции pure / идемпотентны.
 */
import { normalizeHsCode } from './ved-fields.js';

/**
 * Типы, где ТН ВЭД осмыслен (товарные / ВЭД / таможня) — только для recovery.
 * sanitize безопасен везде (лишь чистит уже стоящий hs_code), поэтому без гейта.
 */
const HS_TYPES = new Set([
  'commercial_invoice',
  'proforma_invoice',
  'packing_list',
  'price_list',
  'contract_specification',
  'customs_declaration',
  'delivery_note',
]);

// Метка кода ТН ВЭД / HS перед цифрами. ГНГ/ЕТСНГ (ж/д-номенклатуры) намеренно
// НЕ здесь — это другой классификатор, не графа 33.
const HS_LABEL_SRC = '(?:тн\\s?вэд|тнвэд|hs[\\s._-]?code|hs[\\s._-]?код|код\\s+тн\\s?вэд|commodity\\s+code|код\\s+товара)';
// Кандидат: 8–10 цифр, возможно разбитых пробелами/точками («9403 20 080 9»).
const HS_CAND = /\d[\d .]{6,14}\d/g;
// Окно после метки — код обычно вплотную; 40 символов с запасом на разделители.
const WINDOW = 40;

function itemsArray(extracted: Record<string, unknown>): Record<string, unknown>[] | null {
  const it = extracted.items;
  return Array.isArray(it) ? (it as Record<string, unknown>[]) : null;
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || String(v).trim() === '';
}

/** Все коды ТН ВЭД, стоящие в тексте после метки (канонизированные, дедуп). */
function findAllHsNearLabel(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  const label = new RegExp(HS_LABEL_SRC, 'gi');
  let m: RegExpExecArray | null;
  while ((m = label.exec(text)) !== null) {
    const start = m.index + m[0].length;
    const window = text.slice(start, start + WINDOW);
    HS_CAND.lastIndex = 0;
    let c: RegExpExecArray | null;
    while ((c = HS_CAND.exec(window)) !== null) {
      const canon = normalizeHsCode(c[0]);
      if (canon && !out.includes(canon)) out.push(canon);
    }
  }
  return out;
}

/**
 * Канонизировать hs_code в `extracted` и ВЫКИНУТЬ мусор (не 6/8/10 цифр).
 * Чистит `items[].hs_code`, doc-level `hs_code` и `hs_codes[]`. Выброшенное —
 * в аудит `_hs_dropped`. Pure/идемпотентна, тип-агностична.
 */
export function sanitizeHsCodes(
  extracted: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!extracted || typeof extracted !== 'object') return extracted;

  let changed = false;
  const dropped: string[] = [];
  const next: Record<string, unknown> = { ...extracted };

  // items[].hs_code
  const items = itemsArray(extracted);
  if (items) {
    let itemsChanged = false;
    const outItems = items.map((it) => {
      if (!it || typeof it !== 'object') return it;
      const raw = it.hs_code;
      if (isBlank(raw)) return it;
      const rawStr = String(raw).trim();
      const canon = normalizeHsCode(raw);
      if (canon === null) {
        dropped.push(rawStr);
        itemsChanged = true;
        return { ...it, hs_code: null };
      }
      if (canon !== rawStr) {
        itemsChanged = true;
        return { ...it, hs_code: canon };
      }
      return it;
    });
    if (itemsChanged) {
      next.items = outItems;
      changed = true;
    }
  }

  // doc-level плоский hs_code
  if (!isBlank(extracted.hs_code)) {
    const rawStr = String(extracted.hs_code).trim();
    const canon = normalizeHsCode(extracted.hs_code);
    if (canon === null) {
      dropped.push(rawStr);
      next.hs_code = null;
      changed = true;
    } else if (canon !== rawStr) {
      next.hs_code = canon;
      changed = true;
    }
  }

  // doc-level hs_codes[]
  const hsCodesRaw = extracted.hs_codes;
  if (Array.isArray(hsCodesRaw)) {
    const cleaned: string[] = [];
    for (const c of hsCodesRaw) {
      const canon = normalizeHsCode(c);
      if (canon === null) {
        if (!isBlank(c)) dropped.push(String(c).trim());
        continue;
      }
      if (!cleaned.includes(canon)) cleaned.push(canon);
    }
    const same =
      cleaned.length === hsCodesRaw.length &&
      cleaned.every((v, i) => v === hsCodesRaw[i]);
    if (!same) {
      next.hs_codes = cleaned;
      changed = true;
    }
  }

  if (!changed) return extracted;
  if (dropped.length) {
    const prev = Array.isArray(extracted._hs_dropped) ? (extracted._hs_dropped as string[]) : [];
    next._hs_dropped = [...new Set([...prev, ...dropped])];
  }
  return next;
}

/**
 * Добить ТН ВЭД из текста, если модель код не вернула. Только товарные типы.
 *   - Per-item: код внутри собственного текста позиции (name/description/notes) —
 *     привязка однозначна (код принадлежит своей строке). Заполняет только
 *     пустой `hs_code`, извлечённое моделью НИКОГДА не перетираем.
 *   - Doc-level: все коды по метке из raw_text → `hs_codes[]` (мердж+дедуп).
 * Помечает `_hs_recovered`. Pure/идемпотентна.
 */
export function recoverHsCodesFromText(
  extracted: Record<string, unknown> | null,
  rawText: string | null | undefined,
  documentType?: string | null,
): Record<string, unknown> | null {
  if (!extracted || typeof extracted !== 'object') return extracted;
  if (!documentType || !HS_TYPES.has(documentType)) return extracted;
  if (!rawText || typeof rawText !== 'string' || rawText.length === 0) return extracted;

  let changed = false;
  const recovered: string[] = [];
  const next: Record<string, unknown> = { ...extracted };

  // Per-item — код в тексте самой позиции.
  const items = itemsArray(extracted);
  if (items) {
    let itemsChanged = false;
    const outItems = items.map((it) => {
      if (!it || typeof it !== 'object') return it;
      if (normalizeHsCode(it.hs_code)) return it; // валидный код уже есть
      const text = [it.name, it.description, it.notes]
        .filter((v): v is string => typeof v === 'string')
        .join(' ');
      const code = findAllHsNearLabel(text)[0];
      if (!code) return it;
      recovered.push(code);
      itemsChanged = true;
      return { ...it, hs_code: code };
    });
    if (itemsChanged) {
      next.items = outItems;
      changed = true;
    }
  }

  // Doc-level — коды по метке из всего текста.
  const docCodes = findAllHsNearLabel(rawText);
  if (docCodes.length) {
    const existing = Array.isArray(extracted.hs_codes)
      ? (extracted.hs_codes.map((c) => normalizeHsCode(c)).filter(Boolean) as string[])
      : [];
    const fresh = docCodes.filter((c) => !existing.includes(c));
    if (fresh.length) {
      next.hs_codes = [...existing, ...fresh];
      recovered.push(...fresh);
      changed = true;
    }
  }

  if (!changed) return extracted;
  const prev = Array.isArray(extracted._hs_recovered) ? (extracted._hs_recovered as string[]) : [];
  next._hs_recovered = [...new Set([...prev, ...recovered])];
  return next;
}
