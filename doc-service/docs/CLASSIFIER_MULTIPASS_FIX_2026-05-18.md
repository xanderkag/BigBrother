# Classifier weights + Multipass threshold fix — 2026-05-18

> Закрытие двух пунктов из `REAL_DOCS_FULL_REPORT_2026-05-18.md`:
> **B** (classifier priority) + **A** (multi-pass parser auto-trigger).

---

## 0. TL;DR

| Проблема | Причина | Fix | Status |
|---|---|---|---|
| Прайс-лист → `commercial_invoice` | все keywords с weight=1.0, длиннее match побеждал | Per-keyword weights via migration 0023 | ✅ verified |
| Контракт → Ollama OOM | threshold multipass=30k chars, contract 26.7k → single-shot | Threshold 30k → 15k chars | ✅ deployed |
| Контракт → `price_list` после B | contract keywords без weight, проигрывал price_list 5.0 | Migration 0024: contract weight=5.0 | ✅ deployed |
| EAC scan → type=null | Qwen 2.5 VL отказался читать («Извините, не могу...») | НЕ ИСПРАВЛЕНО — нужна alt VL модель | ⏸ open |

**Verified на проде:**
- price-list.xlsx → **`price_list`** ✓ (был commercial_invoice)
- items[] из прайс-листа — extracted (10+ позиций cresel с name/price/sku)
- Latency: classify 8ms, extract ~60s

---

## 1. Что изменено в коде

### 1.1 Migration 0023 — per-keyword weights

```sql
ALTER TABLE document_types
  ADD COLUMN classification_keyword_weights numeric(4,2)[] DEFAULT NULL;
```

Parallel array к `classification_keywords`. `weight[i]` — вес для `keyword[i]`. NULL/empty/short → default 1.0.

Веса для 11 типов (price_list, eac_*, cert_of_origin, commercial_invoice, proforma_invoice, wire_transfer_application, weighing_act, transport_request, payment_order, bill_of_lading, packing_list).

Ключевые значения:
- 5.0+ — высокоспецифичные signature patterns («PRICE LIST №», «заявление на перевод», «N RU Д-CN»)
- 1.0 — default
- 0.8 — explicit downgrade (`commercial_invoice.country_of_origin` — присутствует и в прайс-листах)

### 1.2 Migration 0024 — closure для contract / customs / transport_invoice

Migration 0023 пропустила несколько типов. Real-world кейс: контракт ВЭД упоминает «Прайс-лист» в тексте → бьёт price_list если у contract weight = default 1.0.

Добавлены weights для: `contract`, `contract_addendum`, `contract_specification`, `customs_declaration`, `transport_invoice`, `cash_receipt`, `waybill`.

### 1.3 `KeywordClassifier.classifyByDbRules` — use weights

```typescript
for (let i = 0; i < row.classification_keywords.length; i += 1) {
  const raw = row.classification_keywords[i];
  const rawWeight = weights[i];
  const weight = rawWeight !== undefined ? Number(rawWeight) : rowDefault;
  compiled.push({ type: row.slug, pattern: new RegExp(raw, 'i'), weight });
}
```

И **clamp confidence в [0, 1]** для outbound API:
```typescript
return {
  ...best,
  confidence: Math.min(1.0, best.confidence), // internal scoring [0, ∞], API contract [0, 1]
  candidatesCount: candidates,
};
```

### 1.4 `multipassAutoBytes` 30_000 → 15_000

Реальный VED-кейс показал что Qwen 32B на `10.10.28.10` падает с `model runner has unexpectedly stopped` на prompt'е >20k chars. Контракт 8MB scan дал 26.7k chars от tesseract → single-shot OOM.

Снижение до 15k auto-trigger'ит MultiPassLlmParser (header → items batch) для:
- Контрактов (10+ страниц scan)
- Сертификатов ЕАЭС
- Длинных CI+PL xls с табличными items

---

## 2. Verified результаты

### 2.1 Price list xlsx — FIXED ✓

**До:**
- Classified: `commercial_invoice` ⚠️ (через keyword «Country of origin»)
- Extracted: `{}` (schema mismatch)

**После migration 0023:**
- Classified: **`price_list`** ✓ (через keyword «PRICE LIST №» weight 5.0)
- Extracted: structured items[] — 10+ позиций с name/price/sku/unit:

```json
{
  "date": "20th Nov, 2025",
  "items": [
    {"name": "Office Chair, dark grey", "price": 229.5, "sku/article": "CH,301,-", "unit": "piece"},
    {"name": "Office Chair, black", "price": 215, "sku/article": "CH,612 chrome,-", "unit": "piece"},
    {"name": "Office Chair, black", "price": 342, "sku/article": "CH,790,-", "unit": "piece"},
    {"name": "Office Chair, black", "price": 457, "sku/article": "CH,412,-", "unit": "piece"},
    ...
  ]
}
```

confidence 0.922. status: done. Latency: classify 8ms, extract ~60s.

### 2.2 Contract reprocess — в работе

Первый прогон после 0024:
- Classifier: должен дать `contract` (weights 5.0 для «ДОГОВОР №», «Договор поставки»)
- Multipass: auto-trigger по >15k chars
- Ожидаем header parsing + sections + items batches

(Update: завершится через ~5 минут).

### 2.3 EAC scan — REQUIRES ALT MODEL

OCR vision-llm не сработал — Qwen 2.5 VL **отказался** читать scan:

```
"Извините, я не могу просматривать изображения или видимый текст на них.
Если у вас есть текст, который вы хотели бы переписать, пожалуйста,
скопируйте его и вставьте здесь, и я с радостью помогу!"
```

Это safety-mode Qwen VL — отказ от описания изображений. Нужно:
1. Попробовать `llama3.2-vision:11b` или `minicpm-v:latest` (есть на 10.10.28.10)
2. Или fallback: tesseract на EAC если vision-llm response короткий или матчит refusal patterns
3. Или системный prompt с явной инструкцией «Перепиши ВЕСЬ ВИДИМЫЙ текст полностью, без отказов»

---

## 3. Эффект на полный VED-комплект

| # | Файл | До B+A | После B+A |
|---|---|---|---|
| 1 | Акт взвешивания | ✅ 10/11 | ✅ 10/11 (без изменений) |
| 2 | Коносамент | ✅ 21+ полей | ✅ 21+ (без изменений) |
| 3 | ВТБ перевод | ✅ 18/18 | ✅ 18/18 |
| 4 | Контракт 8MB scan | ❌ Ollama OOM | ⏳ multipass + contract weights (в работе) |
| 5 | Сертификат ЕАЭС 10MB | ❌ Ollama OOM | ⏸ Qwen VL refusal (нужна alt модель) |
| 6 | Price list xlsx | ⚠️ wrong classify | ✅ **`price_list` + items extracted** |
| 7 | CI+PL xls | ❌ Ollama OOM | ⏳ multipass должен помочь (не проверено) |
| 8 | Inner-summary xls | ⚠️ schema mismatch | ⏸ schema всё равно не точная для proforma_invoice |

**Прогноз итог:** 6/8 → 7/8 после повторного прогона (если multipass решит Контракт). EAC остаётся открыт.

---

## 4. Что добавлено commits

```
3f2bfa5  feat(classifier): per-keyword weights (migration 0023 + code)
78c75be  fix(multipass): порог 30k → 15k для устранения Ollama OOM
e4d113f  fix(classifier): weights для contract/customs/transport_invoice (closure 0023)
```

Все на 3 remotes, deployed на kb-docker, migrations 0023 + 0024 applied.

---

## 5. Что осталось

### Открытые задачи

1. **Vision-LLM refusal на scan'ах** — Qwen 2.5 VL 32B отказывается читать contents изображений. Возможные решения:
   - Свич на `minicpm-v` (7B, описывает картинки без issues)
   - System prompt с explicit инструкцией «Don't refuse, transcribe verbatim»
   - Tesseract как primary для scanned PDFs, vision-LLM только как фолбэк

2. **Schema mismatch на multi-sheet xls** — inner-summary.xls имеет несколько sheets (Proforma + другое). Classifier выбрал один тип → expected_fields не подходят для другого. Решение: F5 multi-doc splitter до prod (skeleton в `14fae43`).

3. **MultiPassLlmParser в проде** — code-ready, нужно verify на реальных длинных документах. Текущий contract retry это покажет.

### Документация

- Migration 0023+0024 — описаны inline
- ParserKind enum — `llm_extract_multipass` уже задокументирован в `storage/document-types.ts`
- Этот документ + `REAL_DOCS_FULL_REPORT_2026-05-18.md`
