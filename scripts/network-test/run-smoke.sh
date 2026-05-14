#!/usr/bin/env bash
# Smoke (регламент §3.1): 5 файлов, последовательно. Проверяем что pipeline жив.
set -euo pipefail
NT_ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$NT_ROOT/lib.sh"

RUN_ID=$(new_run_id smoke)
RUN_DIR=$(ensure_run_dir "$RUN_ID")
log "smoke run: $RUN_ID → $RUN_DIR"

snapshot_env "$RUN_DIR/env.txt"
manifest_corpus > "$RUN_DIR/manifest.txt"
snapshot_ops_metrics "$RUN_DIR/ops-metrics-pre.json" 1h
init_jobs_csv "$RUN_DIR"

list_corpus | head -5 | while IFS= read -r f; do
  log "submit: $f"
  submit_and_wait "$RUN_DIR" smoke "$f"
done

snapshot_ops_metrics "$RUN_DIR/ops-metrics-post.json" 1h

# Pass-критерий: все 5 в done|needs_review.
ok=$(awk -F, 'NR>1 && ($5=="done" || $5=="needs_review")' "$RUN_DIR/jobs.csv" | wc -l)
total=$(awk -F, 'NR>1' "$RUN_DIR/jobs.csv" | wc -l)
log "smoke result: $ok/$total ok"
[[ "$ok" -eq "$total" && "$total" -gt 0 ]] || { log "SMOKE FAILED"; exit 1; }
log "SMOKE PASS"
