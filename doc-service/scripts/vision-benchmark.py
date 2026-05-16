#!/usr/bin/env python3
"""
Vision-режим: прогоняет 8 растеризованных PNG через Ollama-модель (image input)
и собирает результаты: время, валидность JSON, найденные поля.

Использование на kb-docker:
  python3 vision-benchmark.py --model gemma3:12b
  python3 vision-benchmark.py --model minicpm-v
  python3 vision-benchmark.py --model llama3.2-vision:11b
"""
import argparse
import base64
import json
import sys
import time
from pathlib import Path
import urllib.request

OLLAMA_URL = "http://10.10.28.10:11434"
PNG_DIR = Path("/tmp/vision-test/pngs")
RESULTS_DIR = Path("/tmp/vision-test/results")

PROMPT = """Это российский деловой документ (счёт, УПД, ТТН или акт работ). Извлеки данные в JSON формате со следующими полями:

{
  "document_type": "invoice|UPD|TTN|AKT",
  "number": "номер документа",
  "date": "YYYY-MM-DD",
  "seller": {"name": "...", "inn": "...", "kpp": "..."},
  "buyer": {"name": "...", "inn": "...", "kpp": "..."},
  "items": [
    {"line_no": 1, "name": "...", "qty": ..., "unit": "...", "price": ..., "total": ...}
  ],
  "total_without_vat": ...,
  "vat_amount": ...,
  "total_with_vat": ...
}

Верни ТОЛЬКО валидный JSON, без комментариев и markdown-обёртки."""


def call_ollama(model: str, image_path: Path) -> dict:
    """Send image+prompt to Ollama, return {text, duration_sec, ok}."""
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    body = json.dumps({
        "model": model,
        "prompt": PROMPT,
        "images": [b64],
        "stream": False,
        "format": "json",
        "options": {"temperature": 0.0, "num_predict": 4096},
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/generate",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=900) as resp:
            data = json.loads(resp.read())
        dt = time.monotonic() - t0
        return {"ok": True, "text": data.get("response", ""), "duration_sec": dt, "eval_count": data.get("eval_count")}
    except Exception as e:
        dt = time.monotonic() - t0
        return {"ok": False, "error": str(e), "duration_sec": dt}


def parse_response(text: str) -> dict:
    """Try to parse JSON; report what fields are present."""
    text = text.strip()
    # Strip markdown fences if any
    if text.startswith("```"):
        text = text.split("```", 2)[1].lstrip("json\n")
        if "```" in text:
            text = text.rsplit("```", 1)[0]
    try:
        d = json.loads(text)
        return {
            "valid_json": True,
            "type": d.get("document_type"),
            "number": d.get("number"),
            "date": d.get("date"),
            "seller_inn": (d.get("seller") or {}).get("inn"),
            "buyer_inn": (d.get("buyer") or {}).get("inn"),
            "items_count": len(d.get("items") or []),
            "total_with_vat": d.get("total_with_vat"),
        }
    except Exception as e:
        return {"valid_json": False, "parse_error": str(e), "raw_preview": text[:200]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    args = ap.parse_args()

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    safe = args.model.replace(":", "_").replace("/", "_")
    log_path = RESULTS_DIR / f"{safe}.log"
    json_path = RESULTS_DIR / f"{safe}.json"

    pngs = sorted(PNG_DIR.glob("*.png"))
    print(f"Model: {args.model}")
    print(f"Files: {len(pngs)}")
    print(f"Log:   {log_path}")
    print()

    rows = []
    total_start = time.monotonic()
    with open(log_path, "w", encoding="utf-8") as logf:
        logf.write(f"Model: {args.model}\nStart: {time.strftime('%FT%T')}\n\n")
        for png in pngs:
            name = png.stem
            print(f"[{name}] ", end="", flush=True)
            r = call_ollama(args.model, png)
            if r["ok"]:
                parsed = parse_response(r["text"])
                row = {"file": name, "duration_sec": round(r["duration_sec"], 1), **parsed}
                rows.append(row)
                vj = "JSON" if parsed["valid_json"] else "BAD-JSON"
                print(f"{r['duration_sec']:.0f}s | {vj} | type={parsed.get('type')} | items={parsed.get('items_count')}")
                logf.write(f"=== {name} ===\nduration={r['duration_sec']:.1f}s ok=True\n{json.dumps(parsed, ensure_ascii=False, indent=2)}\nraw:\n{r['text'][:1500]}\n\n")
            else:
                print(f"FAILED: {r['error'][:100]}")
                rows.append({"file": name, "duration_sec": round(r["duration_sec"], 1), "ok": False, "error": r["error"]})
                logf.write(f"=== {name} ===\nFAILED: {r['error']}\n\n")
            logf.flush()

        total = time.monotonic() - total_start
        logf.write(f"\nTotal: {total:.1f}s\n")
    with open(json_path, "w", encoding="utf-8") as jf:
        json.dump({"model": args.model, "total_sec": round(total, 1), "rows": rows}, jf, ensure_ascii=False, indent=2)

    # Summary
    print()
    print(f"Total: {total:.1f} sec ({total/60:.1f} min)")
    ok_count = sum(1 for r in rows if r.get("valid_json"))
    print(f"Valid JSON: {ok_count}/{len(rows)}")
    avg = sum(r.get("items_count", 0) for r in rows if r.get("valid_json")) / max(ok_count, 1)
    print(f"Avg items: {avg:.1f}")
    print(f"Per-file:")
    for r in rows:
        if r.get("valid_json"):
            print(f"  {r['file']:<30} {r['duration_sec']:>5.1f}s  type={r.get('type'):<10} items={r.get('items_count')} num={r.get('number')}")
        else:
            print(f"  {r['file']:<30} {r['duration_sec']:>5.1f}s  FAILED/BAD-JSON")


if __name__ == "__main__":
    main()
