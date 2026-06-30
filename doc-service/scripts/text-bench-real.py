#!/usr/bin/env python3
"""
Bench v3 — TEXT-model benchmark on the 9-doc real golden set.

Counterpart to vision-bench-real.py. Instead of rasterizing the document and
sending a page image to a vision model, this feeds the *text layer* of each
fixture (pymupdf get_text() for PDF, raw XML text for DOCX) to a text LLM via
Ollama /api/generate (format:json), maps the returned shape onto the
golden-set.v1.json field paths, and scores with the same comparator logic as
src/scripts/eval/compare.ts (money +-0.01, date ISO-normalize, inn digits-only).

Why text-layer and not Tesseract OCR: for *model selection* we want to compare
pure extraction skill on identical clean input, removing OCR noise as a
confounder. (Production still runs OCR; a follow-up pass can feed OCR'd text via
--text-dir to measure OCR-robustness once a winner is short-listed.)

This rig is the bench v3 tool for the 96 GB VRAM server. Point --url at that
host's Ollama, pull the candidate model, run:

  python3 text-bench-real.py --url http://<host>:11434 --model llama3.3:70b
  python3 text-bench-real.py --url http://<host>:11434 --model qwen2.5:72b
  python3 text-bench-real.py --url http://<host>:11434 --model phi4:14b   # baseline

All 9 fixtures are used (DOCX included — text models don't need an image).
Compare the per-model JSON reports to find the new production default.
"""
import argparse, glob, json, math, os, re, time, zipfile
from pathlib import Path
import urllib.request
import fitz  # pymupdf

DEFAULT_URL = os.environ.get("OLLAMA_URL", "http://10.10.28.10:11434")
DEFAULT_API = os.environ.get("BENCH_API", "ollama")  # ollama | openai
DEFAULT_API_KEY = os.environ.get("OPENAI_API_KEY", "")
BASE = Path("u:/Users/lyapustin.a/AIProjects/Big Brother/doc-service")
SAMPLES = BASE / "eval/real/samples"
GOLDEN = BASE / "eval/real/golden-set.v1.json"
OUT_DIR = Path("u:/Users/lyapustin.a/Desktop/parsdocs-validation-bench/results")

PROMPT_HEAD = """Это российский деловой документ (счёт на оплату, счёт-фактура, УКД, накладная-перемещение, акт работ или спецификация). Извлеки данные строго из текста ниже в JSON формате со следующими полями. Если поля нет в документе — поставь null, НЕ выдумывай значения.

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

Верни ТОЛЬКО валидный JSON, без комментариев и markdown-обёртки.

=== ТЕКСТ ДОКУМЕНТА ===
"""


# ---- text extraction ----
def extract_pdf_text(pdf: Path) -> str:
    doc = fitz.open(pdf)
    parts = []
    for page in doc:
        parts.append(page.get_text("text"))
    doc.close()
    return "\n".join(parts).strip()


def extract_docx_text(docx: Path) -> str:
    """DOCX = zip of XML. Pull <w:t> runs, newline per paragraph, tab per <w:tab>.
    Avoids a python-docx dependency."""
    with zipfile.ZipFile(docx) as z:
        xml = z.read("word/document.xml").decode("utf-8", errors="replace")
    # Turn structural tags into literal whitespace BEFORE pulling text runs, so
    # paragraph/tab boundaries survive into the extracted stream.
    xml = re.sub(r"<w:tab\b[^>]*/>", "\t", xml)
    xml = re.sub(r"</w:p>", "\n", xml)
    xml = re.sub(r"<w:br\b[^>]*/>", "\n", xml)
    out = []
    for m in re.finditer(r"<w:t\b[^>]*>(.*?)</w:t>|(\n)|(\t)", xml, flags=re.S):
        if m.group(1) is not None:
            out.append(m.group(1))
        elif m.group(2):
            out.append("\n")
        elif m.group(3):
            out.append("\t")
    text = "".join(out)
    # unescape minimal XML entities
    text = (text.replace("&amp;", "&").replace("&lt;", "<")
                .replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'"))
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_text(path: Path) -> str:
    if path.suffix.lower() == ".pdf":
        return extract_pdf_text(path)
    if path.suffix.lower() == ".docx":
        return extract_docx_text(path)
    return path.read_text(encoding="utf-8", errors="replace").strip()


# ---- model backends ----
def call_ollama(url, model, text, num_ctx, num_predict, api_key=""):
    """Ollama native /api/generate. Hot-swaps models, ideal for a sweep."""
    body = json.dumps({
        "model": model, "prompt": PROMPT_HEAD + text,
        "stream": False, "format": "json",
        "options": {"temperature": 0.0, "num_predict": num_predict, "num_ctx": num_ctx},
    }).encode()
    req = urllib.request.Request(f"{url}/api/generate", data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=1800) as r:
            d = json.loads(r.read())
        # thinking-family models (qwen3*) emit the JSON into `thinking`, leaving
        # `response` empty under format:json — fall back so they score on real output.
        out = d.get("response", "") or d.get("thinking", "") or ""
        return {"ok": True, "text": out, "dt": time.monotonic() - t0,
                "eval_count": d.get("eval_count"), "prompt_eval_count": d.get("prompt_eval_count")}
    except Exception as e:
        return {"ok": False, "error": str(e), "dt": time.monotonic() - t0}


def call_openai(url, model, text, num_ctx, num_predict, api_key=""):
    """OpenAI-compatible /chat/completions — works against vLLM, ollama's /v1,
    and the corp gateway. --url must be the base ending in /v1
    (e.g. http://<host>:8000/v1). num_ctx is fixed at vLLM launch, so it's
    ignored here."""
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": PROMPT_HEAD + text}],
        "temperature": 0.0,
        "max_tokens": num_predict,
        "response_format": {"type": "json_object"},
    }).encode()
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(f"{url.rstrip('/')}/chat/completions", data=body,
                                 headers=headers, method="POST")
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=1800) as r:
            d = json.loads(r.read())
        choice = (d.get("choices") or [{}])[0]
        txt = (choice.get("message") or {}).get("content", "")
        usage = d.get("usage") or {}
        return {"ok": True, "text": txt, "dt": time.monotonic() - t0,
                "eval_count": usage.get("completion_tokens"),
                "prompt_eval_count": usage.get("prompt_tokens")}
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
    if kind in ("money", "number"):
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


# map golden field paths -> prompt JSON shape (where they differ)
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
    ap.add_argument("--model", required=True)
    ap.add_argument("--url", default=DEFAULT_URL,
                    help=f"backend base URL. ollama: http://host:11434 ; openai/vLLM: http://host:8000/v1 (default {DEFAULT_URL})")
    ap.add_argument("--api", default=DEFAULT_API, choices=["ollama", "openai"],
                    help="backend protocol: ollama /api/generate (hot-swap, good for sweep) or openai /v1/chat/completions (vLLM / corp gateway)")
    ap.add_argument("--api-key", default=DEFAULT_API_KEY, help="bearer token for openai-mode (env OPENAI_API_KEY)")
    ap.add_argument("--out", default=None)
    ap.add_argument("--only", default=None, help="comma-separated fixture ids")
    ap.add_argument("--num-ctx", type=int, default=32768, help="context window (big docs need room)")
    ap.add_argument("--num-predict", type=int, default=4096)
    ap.add_argument("--text-dir", default=None,
                    help="optional dir of pre-OCR'd <fixture-id>.txt to feed instead of PDF/DOCX text layer")
    ap.add_argument("--run", default="bench-v3", help="run label for report")
    args = ap.parse_args()
    only = set(args.only.split(",")) if args.only else None

    gold = json.loads(GOLDEN.read_text(encoding="utf-8"))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    safe = args.model.replace(":", "_").replace("/", "_")
    out_path = Path(args.out) if args.out else OUT_DIR / f"text-{safe}-real-{time.strftime('%Y-%m-%d')}.json"

    results = []
    field_match = field_total = 0
    total_match = total_total = 0  # arithmetic 'total' field hit-rate (the headline metric)
    for fx in gold["fixtures"]:
        fid = fx["id"]
        if only and fid not in only:
            continue
        src = SAMPLES / Path(fx["file"]).name
        try:
            if args.text_dir:
                text = (Path(args.text_dir) / f"{fid}.txt").read_text(encoding="utf-8", errors="replace").strip()
            else:
                text = extract_text(src)
        except Exception as e:
            print(f"[{fid}] TEXT-EXTRACT FAILED {e}")
            results.append({"id": fid, "ok": False, "error": f"text-extract: {e}"})
            continue
        if not text:
            print(f"[{fid}] EMPTY TEXT (no text layer? needs OCR) — skip")
            results.append({"id": fid, "skipped": True, "reason": "empty-text-layer"})
            continue

        print(f"[{fid}] chars={len(text)} model={args.model} ... ", end="", flush=True)
        backend = call_openai if args.api == "openai" else call_ollama
        r = backend(args.url, args.model, text, args.num_ctx, args.num_predict, args.api_key)
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
            field_total += 1
            if v == "match": field_match += 1
            if path in ("total", "total.amount", "total_with_vat"):
                total_total += 1
                if v == "match": total_match += 1
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

    summary = {
        "field_match": field_match, "field_total": field_total,
        "field_exact_match_pct": round(100 * field_match / field_total, 1) if field_total else None,
        "total_field_match": total_match, "total_field_total": total_total,
        "total_field_pct": round(100 * total_match / total_total, 1) if total_total else None,
    }
    report = {"run": args.run, "mode": "text", "api": args.api, "model": args.model,
              "num_ctx": args.num_ctx, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
              "endpoint": args.url, "text_source": args.text_dir or "pdf/docx-text-layer",
              "summary": summary, "results": results}
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n--- {args.model} ---")
    print(f"field exact-match: {summary['field_exact_match_pct']}%  ({field_match}/{field_total})")
    print(f"'total' arithmetic: {summary['total_field_pct']}%  ({total_match}/{total_total})")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
