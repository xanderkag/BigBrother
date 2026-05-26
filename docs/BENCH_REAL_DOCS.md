# Real-document benchmark — consolidated report

**Detailed companion to `docs/MODEL_REPORT.md` (runs #23–#28).** This file collects
every real-document benchmark run in one place at per-doc / per-field granularity.
The narrative, chronological log lives in `docs/MODEL_REPORT.md`; this is the data
table behind it.

> **Data-safety note.** This repo mirrors to a public-ish GitHub remote. Per
> `DEPLOY.md` §11.3, **no real document data lives in git.** The underlying result
> JSONs (in `eval/real/` and `~/Desktop/parsdocs-validation-bench/results/`) contain
> REAL colleague-document values (company ИНН, names, invoice numbers, totals) and are
> gitignored. **This report shows VERDICTS and field PATHS only — never raw expected /
> actual values.** Where a bug needs illustrating, the *nature* is described (e.g.
> "bank account landed in `number` slot") without the literal value.

---

## 1. Overview

| Item | Value |
|---|---|
| Dataset | 9 real colleague documents (Тайпит ЭДО) — first non-synthetic corpus |
| Doc types | invoice ×2, tax_invoice ×2, UKD ×1, transfer_note ×1, services_act ×1, contract_specification ×2 |
| Format split | 6 PDF (docs 01–06) + 3 DOCX (docs 07–09) |
| Field asserts | 60 total (40 on the 6 PDFs; only what is actually legible in the source) |
| Vision method | offline `scripts/vision-bench-real.py` → GPU-box Ollama, page rendered to PNG (pymupdf @ 200 DPI, 1 page/call, `num_ctx 8192`, `temp 0`, `format:json`, `num_predict 4096`) |
| Text method | prod doc-service via `POST /jobs/:id/reprocess` (re-run classify+extract on stored `raw_text`, no re-OCR) |
| Vision hardware | GPU node `10.10.28.10` (RTX 4000 Ada, ~20 GB VRAM) |
| Text hardware | prod doc-service `10.10.13.10:8085` (phi4 via openai-compat backend) |
| Date | 2026-05-25 (all runs) |
| SLAI gates | classification ≥ 0.95 · field exact ≥ 0.85 · critical-field (ИНН/total/number/date) ≥ 0.95 · latency ≤ 90 s/doc (MVP), ≤ 30 s (target) |

DOCX docs (07–09) have no page image → vision models were honestly **skipped** on them
(6-doc / 40-assert slice for all vision rows). phi4-text ran the full 9 (60 asserts).

---

## 2. Model leaderboard

Ranked by gates passed, then accuracy. Vision rows are the 6-PDF / 40-assert slice;
phi4-text shown on the same 6-PDF slice for apples-to-apples (its full-9 number is
noted). "Scan-СФ" = docs 03/04, "clean" = 01/02/05/06.

| Rank | Model | Channel | Exact% | Critical% | Class% | Scan-СФ% | Clean% | Lat P50/P95 (s) | In-SLA (n/6) | VRAM / GPU | Hallucination |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **qwen2.5vl:32b** | vision | **90.0** | **96.2** | **100** | **100** | 83.3 | 202 / 733 | **0/6** ❌ | 20.2 GB / ~59% (CPU-offload) | none |
| 2 | **qwen2.5vl:7b** | vision | **85.0** | 92.3 | 66.7 | **100** | 75.0 | 21 / 43 | **6/6** ✅ | 17.0 GB / 100% on-GPU | none |
| 3 | **phi4** (14B) | text+OCR | 57.5 | 57.7 | 100 | 43.8 | 66.7 | 26 / 86 | 5/6 | (prod CPU/GPU box) | none |
| 4 | llama3.2-vision:11b | vision | 32.5 | 38.5 | 33.3 | 37.5 | 29.2 | 22 / 139 | 5/6 | 11.7 GB / on-GPU | none (OCR-noisy) |
| 5 | gemma3:27b | vision | 5.0 | 3.8 | 50.0 | 0.0 | 8.3 | 23 / 25 | 6/6 ✅ | 19.9 GB / on-GPU | **YES — fabricates ИНН + year-shift** |
| 6 | gemma3:12b | vision | 0.0 | 0.0 | 50.0 | 0.0 | 0.0 | 13 / 17 | 6/6 ✅ | 10.4 GB / on-GPU | **YES — fully fabricated** |

Gates passed (out of class/exact/critical/latency-P50/latency-worst = 5):

- **qwen2.5vl:32b** — 3/5 (class, exact, critical ✅ · both latency ❌).
- **qwen2.5vl:7b** — 3/5 (exact ✅ at the line · both latency ✅ · class & critical ❌).
- **phi4** — 1/5 (class ✅; exact/critical ❌; latency MVP-ok but P95 grazes 86 s).
- **llama / gemma27b / gemma12b** — 0 accuracy gates; gemma rows disqualified on fabrication.

phi4-text on the **full 9 docs** scores exact 68.3% / critical 57.7% — the DOCX specs
(07–09) are easy and inflate it; on the comparable 6-PDF slice it is 57.5%.

---

## 3. Per-doc latency (6 PDFs, wall seconds)

| Doc (slug) | phi4-text | qwen2.5vl:7b | qwen2.5vl:32b | llama3.2-vis:11b | gemma3:27b | gemma3:12b |
|---|---|---|---|---|---|---|
| 01-invoice-doclegal | 27 | 23 | 202 | 13 | 22 | 13 |
| 02-schet-na-oplatu | 86 | 43 | 733 | 38 | 23 | 17 |
| 03-schet-faktura | 25 | 18 | 202 | 13 | 22 | 13 |
| 04-schet-faktura | 27 | 19 | 202 | 12 | 25 | 13 |
| 05-ukd | 17 | 18 | 197 | 22 | 23 | 13 |
| 06-peremeshchenie | 75 | 47 | 859 | 139† | 20 | 7 |
| **P50** | **26** | **21** | **202** | **22** | **23** | **13** |
| **P95** | **86** | **43** | **733** | **139** | **25** | **17** |
| **total (6)** | **257** | **168** | **2394** | **237** | **135** | **76** |

† llama doc-06 = 139 s **and** invalid JSON (repetition-loop, generated the full 4096-token
cap → empty `{}`). It is the only vision JSON-parse failure in the whole set.

32b latency is **hardware-bound, not model-bound**: only ~59% of the 32B fits the 20 GB
VRAM, the rest is CPU-offloaded → every doc breaches the 90 s SLA (P50 = 2.2× the gate,
worst 859 s = 9.5×). 7b fits 100% on-GPU and stays inside SLA with margin (worst 47 s).

---

## 4. Per-doc / per-field VERDICT matrix — decision models

The three models in the actual default-channel decision: **phi4-text**, **qwen2.5vl:7b**,
**qwen2.5vl:32b**. Cells: ✅ match · ❌ mismatch · ⚪ missing · `—` not asserted for that
doc. DOCX docs 07–09 (phi4 only; vision skipped) appended at the bottom.

| Doc | Field path | phi4-text | 7b | 32b |
|---|---|---|---|---|
| 01-invoice | `number` | ⚪ | ❌ | ✅ |
| 01-invoice | `date` | ❌ | ✅ | ✅ |
| 01-invoice | `seller.inn` | ⚪ | ✅ | ✅ |
| 01-invoice | `buyer.inn` | ✅ | ✅ | ✅ |
| 01-invoice | `total.amount` | ⚪ | ✅ | ✅ |
| 01-invoice | `items.0.name` | ✅ | ❌ | ✅ |
| 01-invoice | `items.0.quantity` | ✅ | ⚪ | ⚪ |
| 01-invoice | `items.0.price` | ✅ | ✅ | ✅ |
| 02-schet-na-oplatu | `number` | ✅ | ✅ | ✅ |
| 02-schet-na-oplatu | `date` | ❌ | ✅ | ✅ |
| 02-schet-na-oplatu | `seller.inn` | ❌ | ✅ | ✅ |
| 02-schet-na-oplatu | `buyer.inn` | ❌ | ✅ | ✅ |
| 02-schet-na-oplatu | `total` | ✅ | ❌ | ❌ |
| 02-schet-na-oplatu | `vat` | ✅ | ❌ | ❌ |
| 03-schet-faktura | `number` | ✅ | ✅ | ✅ |
| 03-schet-faktura | `date` | ❌ | ✅ | ✅ |
| 03-schet-faktura | `seller.inn` | ✅ | ✅ | ✅ |
| 03-schet-faktura | `buyer.inn` | ✅ | ✅ | ✅ |
| 03-schet-faktura | `total` | ❌ | ✅ | ✅ |
| 03-schet-faktura | `total_without_vat` | ⚪ | ✅ | ✅ |
| 03-schet-faktura | `vat` | ✅ | ✅ | ✅ |
| 03-schet-faktura | `vat_rate` | ⚪ | ✅ | ✅ |
| 04-schet-faktura | `number` | ✅ | ✅ | ✅ |
| 04-schet-faktura | `date` | ❌ | ✅ | ✅ |
| 04-schet-faktura | `seller.inn` | ✅ | ✅ | ✅ |
| 04-schet-faktura | `buyer.inn` | ✅ | ✅ | ✅ |
| 04-schet-faktura | `total` | ❌ | ✅ | ✅ |
| 04-schet-faktura | `total_without_vat` | ⚪ | ✅ | ✅ |
| 04-schet-faktura | `vat` | ❌ | ✅ | ✅ |
| 04-schet-faktura | `vat_rate` | ⚪ | ✅ | ✅ |
| 05-ukd | `number` | ✅ | ✅ | ✅ |
| 05-ukd | `date` | ✅ | ✅ | ✅ |
| 05-ukd | `base_doc_number` | ✅ | ✅ | ✅ |
| 05-ukd | `seller.inn` | ✅ | ✅ | ✅ |
| 05-ukd | `buyer.inn` | ✅ | ✅ | ✅ |
| 06-peremeshchenie | `number` | ✅ | ✅ | ✅ |
| 06-peremeshchenie | `date` | ✅ | ✅ | ✅ |
| 06-peremeshchenie | `items.0.code` | ❌ | ✅ | ✅ |
| 06-peremeshchenie | `items.0.name` | ✅ | ❌ | ❌ |
| 06-peremeshchenie | `items.0.qty` | ✅ | ✅ | ✅ |

Classification (doc-level): phi4 ✅ all 6; 7b ❌ on 03 & 04 (called `tax_invoice` →
`invoice`), ✅ on 01/02/05/06; 32b ✅ all 6.

**DOCX docs (phi4-text only; vision skipped — no page image):**

| Doc | Field path | phi4-text |
|---|---|---|
| 07-akt-dogovor | `date` | ✅ |
| 07-akt-dogovor | `total_with_vat` | ✅ |
| 08-spec-1 | `number` | ✅ |
| 08-spec-1 | `date` | ✅ |
| 08-spec-1 | `parent_contract_number` | ✅ |
| 08-spec-1 | `parent_contract_date` | ✅ |
| 08-spec-1 | `total` | ✅ |
| 08-spec-1 | `positions.0.name` | ❌ |
| 08-spec-1 | `positions.0.qty` | ✅ |
| 08-spec-1 | `positions.0.price` | ❌ |
| 08-spec-1 | `positions.0.total` | ✅ |
| 09-spec-5 | `number` | ✅ |
| 09-spec-5 | `date` | ✅ |
| 09-spec-5 | `parent_contract_number` | ✅ |
| 09-spec-5 | `parent_contract_date` | ✅ |
| 09-spec-5 | `total` | ✅ |
| 09-spec-5 | `positions.0.name` | ✅ |
| 09-spec-5 | `positions.0.qty` | ✅ |
| 09-spec-5 | `positions.0.price` | ✅ |
| 09-spec-5 | `positions.0.total` | ✅ |

---

## 5. Key findings (verdicts only, no raw values)

1. **7b vs 32b differ on critical fields by exactly ONE field.** The only critical-field
   delta is doc-01 `number`: 7b put a value in the `number` slot that is actually the
   seller's bank account (a slot error, not a fabrication — the real order number went to
   `base_doc_number`); 32b placed the correct order number. Everything else critical is
   identical between the two. Both share the same two non-critical misses: doc-01
   `items.0.quantity` is a scoring artifact (the qty *is* present under `items.0.qty`, a
   path the harness does not map — hits both models) and doc-06 `items.0.name` is a
   Cyrillic/Latin homoglyph confusion in the device model token (value essentially correct,
   strict string comparator rejects it).

2. **Both qwen models are ИНН-clean — zero fabrication.** Across the set, every ИНН either
   matches the document or is a legible read; neither model invents an identifier. The 02
   `total`/`vat` mismatch on both is **under-reading a multi-line totals block** (picked an
   intermediate/partial sum), not a hallucinated number.

3. **gemma fabricates identifiers → disqualified.** gemma3:27b partially fabricates ИНН
   (returns well-known third-party ИНН not present in the doc) and systematically shifts
   all dates to prior years; gemma3:12b fabricates the entire payload (0/40, yet valid,
   plausible-looking JSON — the most dangerous failure mode: fast and confidently wrong).
   For financial documents this is negative value regardless of $0 cost. **Both gemma rows
   are off the table for extraction.**

4. **32b is VRAM-starved → its latency is hardware, not the model.** ~59% on-GPU / ~41%
   CPU-offload on the 20 GB box. P50 202 s / worst 859 s breach the 90 s SLA on every doc.
   This is a capacity problem, not a tuning problem — the 32B accuracy is real and stable
   (matches run #26: exact 90% / critical 96%).

5. **A 96 GB box unlocks 32b.** With enough VRAM to hold 32B fully resident (ideally via
   vLLM rather than Ollama), the accuracy-leading model would drop into SLA. That is the
   single highest-leverage hardware change for this pipeline.

6. **phi4-text wins clean clean-text docs, loses scans.** It is the only model with 100%
   classification and it nails the DOCX specs and UKD, but on the scan-rendered СФ (03/04)
   it returns wordy free-text dates (e.g. `"<день> <месяц> <год> г."` instead of ISO),
   nests `total` as an object the
   comparator rejects, and drops ИНН on doc-02 (`"НЕ УКАЗАНО"`). Scan-СФ exact 43.8% vs
   vision's 100% is the decisive split.

7. **llama3.2-vision:11b is honest but too OCR-noisy**, and trips a repetition-loop /
   JSON-fail on doc-06. Not a candidate as-is.

---

## 6. Verdict + recommendation

- **Now (stopgap): qwen2.5vl:7b as the vision channel.** It is the only model that is both
  in-SLA (P50 21 s, worst 47 s, 6/6 inside 90 s) and near the accuracy leader (exact 85.0%
  at the gate line, ИНН-clean, scan-СФ 100%). Its two real gate failures are addressable
  *outside* the model: classification 0.667 (fix with a cheap classical number/date/type
  classifier layered over the 7b extraction — the `tax_invoice`↔`invoice` confusion on
  03/04 is the whole gap) and critical 0.923 (the single doc-01 `number`-slot bug + the
  doc-02 multi-line total under-read). Do **not** ship 7b as the sole channel for critical
  fields until classification and the slot bug are closed.

- **Next (accuracy ceiling): qwen2.5vl:32b — or Phi-4-mm — on the incoming 96 GB box via
  vLLM.** 32b already passes all three accuracy gates; the only blocker is VRAM-driven
  latency. Move it to the 96 GB node, serve via vLLM, and re-bench latency. Phi-4-multimodal
  is the parallel candidate to evaluate on the same box.

- **Routing: hybrid text↔vision.** Clean text-PDFs with a good text layer → phi4-text
  (in-SLA, strong on specs/UKD). Scans / СФ / low OCR-confidence → vision. This matches the
  per-doc split: text wins clean structured docs, vision wins scans.

- **Cost.** All local models = $0 API / $0 per month at 50 doc/day (GPU amortization only).
  Cloud Claude (run #22) remains the only option that delivers accuracy-in-SLA today at
  ~$30/month, but carries 152-ФЗ and $/doc considerations — that call is `product`'s.

**No regression-gate breach to flag here:** none of these models is the deployed default,
so there is no production baseline to regress against. The accuracy *floor* (gemma) and the
SLA *breach* (32b on current hardware) are both called out above and neither is recommended
for merge in its current form.

---

## 7. See also

`docs/MODEL_REPORT.md` — chronological run log (#21–#28) with full narrative, prompt-version
notes, and the synthetic-corpus history that precedes these real-document runs.
