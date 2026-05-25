#!/usr/bin/env python3
"""
Run #26 — vision-from-image benchmark on the 9-doc real golden set (PDF subset).

Rasterizes each PDF (pymupdf), sends page image(s) to Ollama qwen2.5vl:32b with a
structured-extraction prompt (format:json), maps the returned shape onto the
golden-set.v1.json field paths, and scores with the same comparator logic as
src/scripts/eval/compare.ts (money +-0.01, date ISO-normalize, inn digits-only...).

.docx fixtures (07/08/09) have no image -> skipped honestly (vision = PDF subset).
"""
import argparse, base64, glob, io, json, math, re, time
from pathlib import Path
import urllib.request
import fitz  # pymupdf

OLLAMA_URL = "http://10.10.28.10:11434"
SAMPLES = Path("u:/Users/lyapustin.a/AIProjects/Big Brother/doc-service/eval/real/samples")
GOLDEN = Path("u:/Users/lyapustin.a/AIProjects/Big Brother/doc-service/eval/real/golden-set.v1.json")
OUT_DIR = Path("u:/Users/lyapustin.a/Desktop/parsdocs-validation-bench/results")

PROMPT = """Это российский деловой документ (счёт на оплату, счёт-фактура, УКД, накладная-перемещение, акт работ или спецификация). Извлеки данные строго из изображения в JSON формате со следующими полями. Если поля нет в документе — поставь null, НЕ выдумывай значения.

{
  "document_type": "invoice|tax_invoice|UKD|transfer_note|services_act|contract_specification",
  "number": "номер документа (строка)",
  "date": "YYYY-MM-DD",
  "base_doc_number": "номер документа-основания (для УКД)",
  "parent_contract_number": "номер родительского договора (для спецификации)",
  "parent_contract_date": "YYYY-MM-DD дата родительского договора",
  "seller": {"name": "...", "inn": "...", "kpp": "..."},
  "buyer": {"name": "...", "inn": "...", "kpp": "..."},
  "items": [
    {"line_no": 1, "code": "артикул", "name": "...", "qty": 0, "unit": "...", "price": 0, "total": 0}
  ],
  "total_without_vat": 0,
  "vat_amount": 0,
  "vat_rate": 0,
  "total_with_vat": 0
}

Верни ТОЛЬКО валидный JSON, без комментариев и markdown-обёртки."""


def render(pdf: Path, dpi: int, max_pages: int = 0):
    doc = fitz.open(pdf)
    imgs = []
    for i, page in enumerate(doc):
        if max_pages and i >= max_pages:
            break
        pix = page.get_pixmap(dpi=dpi)
        imgs.append(pix.tobytes("png"))
    doc.close()
    return imgs


def call_ollama(model, png_list, num_ctx=8192):
    b64 = [base64.b64encode(p).decode("ascii") for p in png_list]
    body = json.dumps({
        "model": model, "prompt": PROMPT, "images": b64,
        "stream": False, "format": "json",
        "options": {"temperature": 0.0, "num_predict": 4096, "num_ctx": num_ctx},
    }).encode()
    req = urllib.request.Request(f"{OLLAMA_URL}/api/generate", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            d = json.loads(r.read())
        return {"ok": True, "text": d.get("response", ""), "dt": time.monotonic() - t0,
                "eval_count": d.get("eval_count"), "prompt_eval_count": d.get("prompt_eval_count")}
    except Exception as e:
        return {"ok": False, "error": str(e), "dt": time.monotonic() - t0}


# ---- comparator logic mirrored from src/scripts/eval/compare.ts ----
def is_absent(v):
    if v is None: return True
    if isinstance(v, str) and v.strip() == "": return True
    if isinstance(v, float) and math.isnan(v): return True
    return False

def norm_str(s):
    s = str(s).lower()
    s = re.sub(r'[«»"\']', '', s)
    s = re.sub(r'[.,;]', ' ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

def parse_money(v):
    if isinstance(v, (int, float)) and not (isinstance(v, float) and math.isnan(v)): return float(v)
    if not isinstance(v, str): return None
    c = re.sub(r'[\s ]', '', v)
    c = re.sub(r'[₽$€£¥]', '', c)
    c = re.sub(r'руб\.?', '', c, flags=re.I)
    c = re.sub(r'\b(RUB|USD|EUR|GBP|JPY)\b', '', c, flags=re.I)
    c = c.replace(',', '.')
    try: return float(c)
    except: return None

def parse_percent(v):
    n = None
    if isinstance(v, (int, float)): n = float(v)
    elif isinstance(v, str):
        c = re.sub(r'[\s%]', '', v).replace(',', '.')
        try: n = float(c)
        except: return None
    if n is None: return None
    return n * 100 if n <= 1 else n

def parse_date(v):
    if not isinstance(v, str): return None
    s = v.strip()
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', s)
    if m: return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.match(r'^(\d{1,2})[./](\d{1,2})[./](\d{4})$', s)
    if m: return f"{m.group(3)}-{m.group(2).zfill(2)}-{m.group(1).zfill(2)}"
    return None

def digits_only(v):
    if isinstance(v, (int, float)): return str(int(v))
    if not isinstance(v, str): return None
    d = re.sub(r'\D', '', v)
    return d if d else None

def compare(kind, exp, act):
    if is_absent(act): return "match" if is_absent(exp) else "missing"
    if is_absent(exp): return "match"
    if kind == "money":
        e, a = parse_money(exp), parse_money(act)
        if e is None or a is None: return "mismatch"
        return "match" if abs(e - a) <= 0.01 else "mismatch"
    if kind == "number":
        e, a = parse_money(exp), parse_money(act)
        if e is None or a is None: return "mismatch"
        return "match" if abs(e - a) <= 0.01 else "mismatch"
    if kind == "percent":
        e, a = parse_percent(exp), parse_percent(act)
        if e is None or a is None: return "mismatch"
        return "match" if abs(e - a) <= 0.01 else "mismatch"
    if kind == "date":
        e, a = parse_date(str(exp)), parse_date(str(act))
        if e is None or a is None: return "mismatch"
        return "match" if e == a else "mismatch"
    if kind in ("inn", "kpp", "account"):
        e, a = digits_only(exp), digits_only(act)
        if e is None or a is None: return "mismatch"
        return "match" if e == a else "mismatch"
    return "match" if norm_str(exp) == norm_str(act) else "mismatch"  # string


def get_path(obj, path):
    cur = obj
    for part in path.split('.'):
        if cur is None: return None
        if isinstance(cur, list):
            try: cur = cur[int(part)]
            except: return None
        elif isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
    return cur


# map golden field paths -> vision JSON shape (where they differ)
PATH_MAP = {
    "total.amount": "total_with_vat",
    "total": "total_with_vat",
    "vat": "vat_amount",
    "positions.0.name": "items.0.name",
    "positions.0.qty": "items.0.qty",
    "positions.0.price": "items.0.price",
    "positions.0.total": "items.0.total",
}

def resolve(extracted, gold_path):
    # try direct, then mapped
    v = get_path(extracted, gold_path)
    if not is_absent(v): return v
    mapped = PATH_MAP.get(gold_path)
    if mapped:
        v2 = get_path(extracted, mapped)
        if not is_absent(v2): return v2
    return v


def parse_json(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1]
        text = re.sub(r'^json\s*', '', text)
        if "```" in text: text = text.rsplit("```", 1)[0]
    try: return json.loads(text), None
    except Exception as e: return None, str(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="qwen2.5vl:32b")
    ap.add_argument("--dpi", type=int, default=200)
    ap.add_argument("--out", default=None)
    ap.add_argument("--only", default=None, help="comma-separated fixture ids")
    ap.add_argument("--max-pages", type=int, default=1, help="0 = all pages")
    ap.add_argument("--num-ctx", type=int, default=8192)
    args = ap.parse_args()
    only = set(args.only.split(",")) if args.only else None

    gold = json.loads(GOLDEN.read_text(encoding="utf-8"))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = Path(args.out) if args.out else OUT_DIR / f"qwen25vl-32b-vision-real-{time.strftime('%Y-%m-%d')}.json"

    results = []
    for fx in gold["fixtures"]:
        fid = fx["id"]
        if only and fid not in only:
            continue
        pdf = SAMPLES / Path(fx["file"]).name
        if pdf.suffix.lower() != ".pdf":
            print(f"[{fid}] SKIP (no image: {pdf.suffix})")
            results.append({"id": fid, "skipped": True, "reason": "docx-no-image"})
            continue
        pngs = render(pdf, args.dpi, args.max_pages)
        print(f"[{fid}] pages={len(pngs)} dpi={args.dpi} ... ", end="", flush=True)
        r = call_ollama(args.model, pngs, args.num_ctx)
        if not r["ok"]:
            print(f"FAILED {r['error'][:80]}")
            results.append({"id": fid, "ok": False, "error": r["error"], "wall_ms": round(r["dt"]*1000)})
            continue
        extracted, perr = parse_json(r["text"])
        exp_type = fx["expected"]["document_type"]
        act_type = (extracted or {}).get("document_type")
        cls_match = norm_str(exp_type) == norm_str(act_type) if act_type else False
        fields = []
        for fdef in fx["expected"]["fields"]:
            path = fdef["path"]
            kind = fdef.get("kind", "string")
            exp = fdef["expected"]
            act = resolve(extracted or {}, path)
            v = compare(kind, exp, act)
            fields.append({"path": path, "kind": kind, "expected": exp, "actual": act, "verdict": v})
        results.append({
            "id": fid, "file": fx["file"], "ok": True,
            "valid_json": extracted is not None, "parse_error": perr,
            "document_type_expected": exp_type, "document_type_actual": act_type,
            "classification_match": cls_match,
            "fields": fields, "wall_ms": round(r["dt"]*1000),
            "eval_count": r.get("eval_count"), "prompt_eval_count": r.get("prompt_eval_count"),
            "raw": (r["text"] or "")[:4000],
        })
        nm = sum(1 for f in fields if f["verdict"] == "match")
        print(f"{r['dt']:.0f}s json={extracted is not None} cls={cls_match} match={nm}/{len(fields)}")

    report = {"run": "#26", "model": args.model, "dpi": args.dpi,
              "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
              "endpoint": OLLAMA_URL, "results": results}
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nWrote {out_path}")


if __name__ == "__main__":
    main()
