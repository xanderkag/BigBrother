#!/usr/bin/env bash
# Stress (регламент §3.4): burst STRESS_RPM > capacity в течение STRESS_DURATION_S сек.
# Проверяем что doc-service: (а) отвечает 429 а не 5xx, (б) не теряет принятые job,
# (в) корректно роняет зависшие в failed по JOB_DEADLINE_MS.
set -euo pipefail
NT_ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$NT_ROOT/lib.sh"

: "${STRESS_DURATION_S:=900}"
: "${STRESS_RPM:=90}"

interval_ms=$(( 60000 / STRESS_RPM ))
RUN_ID=$(new_run_id stress)
RUN_DIR=$(ensure_run_dir "$RUN_ID")
log "stress run: $RUN_ID → $RUN_DIR (rpm=$STRESS_RPM, duration=${STRESS_DURATION_S}s)"

snapshot_env "$RUN_DIR/env.txt"
manifest_corpus > "$RUN_DIR/manifest.txt"
snapshot_ops_metrics "$RUN_DIR/ops-metrics-pre.json" 1h
init_jobs_csv "$RUN_DIR"
start_ollama_stats "$RUN_DIR"
trap 'stop_ollama_stats "$RUN_DIR"' EXIT

mapfile -t corpus < <(list_corpus)
[[ "${#corpus[@]}" -gt 0 ]] || { log "empty corpus"; exit 1; }

# Логируем сырые HTTP-коды отдельно (для подсчёта 429/5xx).
submit_log="$RUN_DIR/submit-http.csv"
printf 'ts_ms,file,http_code\n' > "$submit_log"

deadline=$(( $(date +%s) + STRESS_DURATION_S ))
idx=0; accepted=0
while (( $(date +%s) < deadline )); do
  file="${corpus[$(( idx % ${#corpus[@]} ))]}"
  ts_ms=$(( $(date +%s%N) / 1000000 ))
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "$PARSDOCS_API_URL/jobs" \
    -H "Authorization: Bearer $PARSDOCS_TOKEN" \
    -F "file=@$file" \
    -F "metadata={\"test_run\":\"$RUN_ID\",\"scenario\":\"stress\"}" || echo "000")
  printf '%s,%s,%s\n' "$ts_ms" "$file" "$code" >> "$submit_log"
  [[ "$code" == "202" || "$code" == "200" ]] && accepted=$(( accepted + 1 ))
  idx=$(( idx + 1 ))
  sleep "$(awk "BEGIN{printf \"%.3f\", $interval_ms/1000}")"
done

log "stress: подача завершена, submitted=$idx, accepted=$accepted"
log "stress: ждём 2× JOB_TIMEOUT_S, потом снимаем post-метрики"
sleep "$(( JOB_TIMEOUT_S * 2 ))"

snapshot_ops_metrics "$RUN_DIR/ops-metrics-post.json" 1h
log "stress done: $RUN_DIR"
log "→ проверьте: scripts/network-test/runs/$RUN_ID/submit-http.csv (429/5xx ratio)"
log "→ next: ./report.sh $RUN_DIR"
