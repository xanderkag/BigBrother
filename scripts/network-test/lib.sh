# shellcheck shell=bash
# Общие функции для сценариев network-test.
# source-ить из run-*.sh — самостоятельно не запускается.

set -euo pipefail

# --- env loader -------------------------------------------------------------

NT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$NT_ROOT/.env" ]]; then
  set -a; . "$NT_ROOT/.env"; set +a
fi

: "${PARSDOCS_API_URL:?PARSDOCS_API_URL is required (см. .env)}"
: "${PARSDOCS_TOKEN:?PARSDOCS_TOKEN is required (см. .env)}"
: "${CORPUS_DIR:?CORPUS_DIR is required (см. .env)}"
: "${POLL_INTERVAL_S:=2}"
: "${JOB_TIMEOUT_S:=300}"

# --- helpers ----------------------------------------------------------------

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

new_run_id() {
  local scenario="$1"
  printf '%s-%s' "$(date -u +%Y%m%d-%H%M%S)" "$scenario"
}

ensure_run_dir() {
  local run_id="$1"
  local dir="$NT_ROOT/runs/$run_id"
  mkdir -p "$dir"
  printf '%s\n' "$dir"
}

# Список файлов корпуса. Если CORPUS_LIST указан и существует — берём оттуда,
# иначе find по CORPUS_DIR. Печатает абсолютные пути по одному на строку.
list_corpus() {
  if [[ -n "${CORPUS_LIST:-}" && -f "$CORPUS_LIST" ]]; then
    awk 'NF' "$CORPUS_LIST" | while IFS= read -r rel; do
      [[ "$rel" = /* ]] && printf '%s\n' "$rel" || printf '%s/%s\n' "$CORPUS_DIR" "$rel"
    done
  else
    find "$CORPUS_DIR" -type f \
      \( -iname '*.pdf' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \
         -o -iname '*.bmp' -o -iname '*.tif' -o -iname '*.tiff' -o -iname '*.webp' \) \
      | sort
  fi
}

manifest_corpus() {
  list_corpus | while IFS= read -r f; do
    local size sha
    size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
    sha=$(sha256sum "$f" 2>/dev/null | awk '{print $1}')
    [[ -z "$sha" ]] && sha=$(shasum -a 256 "$f" | awk '{print $1}')
    printf '%s\t%s\t%s\n' "$sha" "$size" "$f"
  done
}

snapshot_env() {
  local out="$1"
  {
    echo "## git"
    git -C "$NT_ROOT/../.." rev-parse HEAD 2>/dev/null || true
    git -C "$NT_ROOT/../.." describe --all --long 2>/dev/null || true
    echo
    echo "## host"
    uname -a
    echo
    echo "## cpu"
    lscpu 2>/dev/null | head -25 || sysctl -n machdep.cpu.brand_string 2>/dev/null || true
    echo
    echo "## mem"
    free -h 2>/dev/null || vm_stat 2>/dev/null || true
    echo
    echo "## gpu"
    nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv 2>/dev/null || echo "nvidia-smi not available"
    echo
    echo "## docker"
    docker version --format '{{.Server.Version}}' 2>/dev/null || echo "docker not available"
    docker compose version 2>/dev/null || true
    echo
    echo "## config"
    echo "PARSDOCS_API_URL=$PARSDOCS_API_URL"
    echo "CORPUS_DIR=$CORPUS_DIR"
    echo "POLL_INTERVAL_S=$POLL_INTERVAL_S"
    echo "JOB_TIMEOUT_S=$JOB_TIMEOUT_S"
  } > "$out"
}

# Snapshot /metrics/operational в JSON.
snapshot_ops_metrics() {
  local out="$1"; local window="${2:-1h}"
  curl -fsS -H "Authorization: Bearer $PARSDOCS_TOKEN" \
    "$PARSDOCS_API_URL/metrics/operational?window=$window" \
    -o "$out" || log "warn: ops-metrics snapshot failed"
}

# --- core: submit + poll ----------------------------------------------------

# Загружает файл, возвращает job_id (или пусто при ошибке).
# Аргументы: <file> [<run_id>] [<scenario>]
submit_job() {
  local file="$1"; local run_id="${2:-}"; local scenario="${3:-}"
  local meta="{}"
  if [[ -n "$run_id" ]]; then
    meta=$(jq -nc --arg r "$run_id" --arg s "$scenario" '{test_run:$r, scenario:$s}')
  fi
  curl -fsS -X POST "$PARSDOCS_API_URL/jobs" \
    -H "Authorization: Bearer $PARSDOCS_TOKEN" \
    -F "file=@$file" \
    -F "metadata=$meta" \
    | jq -r '.job_id // empty'
}

# Поллит статус job до терминального или таймаута. Печатает финальный статус.
# Аргументы: <job_id>
wait_for_job() {
  local id="$1"
  local deadline=$(( $(date +%s) + JOB_TIMEOUT_S ))
  while (( $(date +%s) < deadline )); do
    local status
    status=$(curl -fsS -H "Authorization: Bearer $PARSDOCS_TOKEN" \
      "$PARSDOCS_API_URL/jobs/$id" | jq -r '.status // "unknown"') || status="unknown"
    case "$status" in
      done|failed|needs_review) printf '%s\n' "$status"; return 0 ;;
    esac
    sleep "$POLL_INTERVAL_S"
  done
  printf 'timeout\n'
  return 0
}

# submit + wait, аппендит строку в jobs.csv.
# CSV: submit_ts,job_id,file,size,status,wallclock_ms
# Аргументы: <run_dir> <scenario> <file>
submit_and_wait() {
  local run_dir="$1"; local scenario="$2"; local file="$3"
  local csv="$run_dir/jobs.csv"
  local size submit_epoch_ms end_epoch_ms job_id status
  size=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file")
  submit_epoch_ms=$(( $(date +%s%N) / 1000000 ))
  job_id=$(submit_job "$file" "$(basename "$run_dir")" "$scenario" || true)
  if [[ -z "$job_id" ]]; then
    end_epoch_ms=$(( $(date +%s%N) / 1000000 ))
    printf '%s,,%s,%s,submit_failed,%s\n' \
      "$submit_epoch_ms" "$file" "$size" "$((end_epoch_ms - submit_epoch_ms))" >> "$csv"
    return 0
  fi
  status=$(wait_for_job "$job_id")
  end_epoch_ms=$(( $(date +%s%N) / 1000000 ))
  printf '%s,%s,%s,%s,%s,%s\n' \
    "$submit_epoch_ms" "$job_id" "$file" "$size" "$status" \
    "$((end_epoch_ms - submit_epoch_ms))" >> "$csv"
}

# Заголовок CSV — вызвать один раз в начале прогона.
init_jobs_csv() {
  local run_dir="$1"
  printf 'submit_ts_ms,job_id,file,size_bytes,status,wallclock_ms\n' > "$run_dir/jobs.csv"
}

# --- side metrics -----------------------------------------------------------

# Минутные снимки docker stats для контейнера parsdocs-ollama.
# Запускать в фоне, kill'ать по завершении прогона.
# CSV: ts,cpu_pct,mem_mb,net_rx_mb,net_tx_mb
start_ollama_stats() {
  local run_dir="$1"
  local csv="$run_dir/ollama-stats.csv"
  printf 'ts,cpu_pct,mem_mb,net_rx_mb,net_tx_mb\n' > "$csv"
  (
    while :; do
      docker stats --no-stream --format \
        '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}' parsdocs-ollama 2>/dev/null \
        | awk -v ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)" -F'\t' '
            { print ts","$2","$3","$4 }' \
        | tr -d '%' >> "$csv" || true
      sleep 60
    done
  ) &
  echo $! > "$run_dir/.ollama-stats.pid"
}

stop_ollama_stats() {
  local run_dir="$1"
  local pid_file="$run_dir/.ollama-stats.pid"
  [[ -f "$pid_file" ]] || return 0
  kill "$(cat "$pid_file")" 2>/dev/null || true
  rm -f "$pid_file"
}
