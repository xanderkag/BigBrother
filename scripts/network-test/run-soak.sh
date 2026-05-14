#!/usr/bin/env bash
# Soak (регламент §3.3): равномерная подача SOAK_RPM док/мин в течение SOAK_DURATION_S сек.
# Корпус циклически перебираем по кругу — на длинных прогонах одних файлов мало.
set -euo pipefail
NT_ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$NT_ROOT/lib.sh"

: "${SOAK_DURATION_S:=7200}"
: "${SOAK_RPM:=30}"

interval_ms=$(( 60000 / SOAK_RPM ))
RUN_ID=$(new_run_id soak)
RUN_DIR=$(ensure_run_dir "$RUN_ID")
log "soak run: $RUN_ID → $RUN_DIR (rpm=$SOAK_RPM, duration=${SOAK_DURATION_S}s, interval=${interval_ms}ms)"

snapshot_env "$RUN_DIR/env.txt"
manifest_corpus > "$RUN_DIR/manifest.txt"
snapshot_ops_metrics "$RUN_DIR/ops-metrics-pre.json" 24h
init_jobs_csv "$RUN_DIR"
start_ollama_stats "$RUN_DIR"
trap 'stop_ollama_stats "$RUN_DIR"' EXIT

# Сложим корпус в массив; idx по модулю.
mapfile -t corpus < <(list_corpus)
[[ "${#corpus[@]}" -gt 0 ]] || { log "empty corpus"; exit 1; }

deadline=$(( $(date +%s) + SOAK_DURATION_S ))
idx=0
while (( $(date +%s) < deadline )); do
  file="${corpus[$(( idx % ${#corpus[@]} ))]}"
  # submit_and_wait запускается в фоне — soak не должен ждать каждый job, иначе
  # rate падает на медленных документах. wait в конце добирает хвост.
  submit_and_wait "$RUN_DIR" soak "$file" &
  idx=$(( idx + 1 ))
  sleep "$(awk "BEGIN{printf \"%.3f\", $interval_ms/1000}")"
done

log "soak: waiting tail jobs to drain..."
wait
snapshot_ops_metrics "$RUN_DIR/ops-metrics-post.json" 24h
log "soak done: $RUN_DIR (submitted=$idx)"
log "→ next: ./report.sh $RUN_DIR"
