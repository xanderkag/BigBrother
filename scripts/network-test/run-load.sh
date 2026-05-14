#!/usr/bin/env bash
# Load (регламент §3.2): полный корпус, конкурентность $CONCURRENCY.
set -euo pipefail
NT_ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$NT_ROOT/lib.sh"

: "${CONCURRENCY:=4}"

RUN_ID=$(new_run_id load)
RUN_DIR=$(ensure_run_dir "$RUN_ID")
log "load run: $RUN_ID → $RUN_DIR (concurrency=$CONCURRENCY)"

snapshot_env "$RUN_DIR/env.txt"
manifest_corpus > "$RUN_DIR/manifest.txt"
snapshot_ops_metrics "$RUN_DIR/ops-metrics-pre.json" 1h
init_jobs_csv "$RUN_DIR"
start_ollama_stats "$RUN_DIR"
trap 'stop_ollama_stats "$RUN_DIR"' EXIT

export NT_ROOT RUN_DIR
export -f submit_job wait_for_job submit_and_wait log
export PARSDOCS_API_URL PARSDOCS_TOKEN POLL_INTERVAL_S JOB_TIMEOUT_S

list_corpus | xargs -I{} -P "$CONCURRENCY" bash -c '
  submit_and_wait "$RUN_DIR" load "$1"
' _ {}

snapshot_ops_metrics "$RUN_DIR/ops-metrics-post.json" 1h

log "load done: $RUN_DIR"
log "→ next: ./report.sh $RUN_DIR"
