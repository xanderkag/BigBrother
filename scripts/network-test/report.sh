#!/usr/bin/env bash
# Агрегация артефактов прогона в summary.md.
# Usage: ./report.sh runs/<run_id>
set -euo pipefail

run_dir="${1:?usage: $0 <run_dir>}"
[[ -d "$run_dir" ]] || { echo "no such dir: $run_dir" >&2; exit 1; }
jobs_csv="$run_dir/jobs.csv"
[[ -f "$jobs_csv" ]] || { echo "no jobs.csv in $run_dir" >&2; exit 1; }

run_id=$(basename "$run_dir")
out="$run_dir/summary.md"

# Считаем p50/p95/p99 по wallclock_ms среди терминальных done|needs_review.
percentiles=$(awk -F, '
  NR>1 && ($5=="done" || $5=="needs_review") { a[++n]=$6 }
  END {
    if (n==0) { print "0\t0\t0\t0"; exit }
    asort(a)
    p50 = a[int(n*0.50 + 0.5)]
    p95 = a[int(n*0.95 + 0.5)]
    p99 = a[int(n*0.99 + 0.5)]
    printf "%d\t%d\t%d\t%d\n", n, p50, p95, p99
  }
' "$jobs_csv")
ok=$(printf '%s\n' "$percentiles" | awk '{print $1}')
p50=$(printf '%s\n' "$percentiles" | awk '{print $2}')
p95=$(printf '%s\n' "$percentiles" | awk '{print $3}')
p99=$(printf '%s\n' "$percentiles" | awk '{print $4}')

total=$(awk -F, 'NR>1' "$jobs_csv" | wc -l | tr -d ' ')
failed=$(awk -F, 'NR>1 && $5=="failed"' "$jobs_csv" | wc -l | tr -d ' ')
timeout=$(awk -F, 'NR>1 && $5=="timeout"' "$jobs_csv" | wc -l | tr -d ' ')
submit_failed=$(awk -F, 'NR>1 && $5=="submit_failed"' "$jobs_csv" | wc -l | tr -d ' ')

# Окно прогона — для throughput.
window_ms=$(awk -F, '
  NR>1 { if (min==""||$1<min) min=$1; if ($1+$6>max) max=$1+$6 }
  END { if (min!="" && max!="") print max-min; else print 0 }
' "$jobs_csv")
throughput_per_min=$(awk -v ok="$ok" -v ms="$window_ms" \
  'BEGIN{ if (ms>0) printf "%.2f", ok*60000/ms; else print "n/a" }')

success_rate=$(awk -v ok="$ok" -v total="$total" \
  'BEGIN{ if (total>0) printf "%.1f", ok*100/total; else print "n/a" }')

http_429="n/a"; http_5xx="n/a"
if [[ -f "$run_dir/submit-http.csv" ]]; then
  http_429=$(awk -F, 'NR>1 && $3=="429"' "$run_dir/submit-http.csv" | wc -l | tr -d ' ')
  http_5xx=$(awk -F, 'NR>1 && $3 ~ /^5/' "$run_dir/submit-http.csv" | wc -l | tr -d ' ')
fi

{
  echo "# Summary — $run_id"
  echo
  echo "## Totals"
  echo
  echo "| Метрика | Значение |"
  echo "| --- | --- |"
  echo "| Submitted | $total |"
  echo "| Done + needs_review | $ok |"
  echo "| Failed | $failed |"
  echo "| Timeout (клиентский) | $timeout |"
  echo "| Submit failed | $submit_failed |"
  echo "| Success-rate | ${success_rate} % |"
  echo "| Throughput | ${throughput_per_min} док/мин |"
  echo
  echo "## Latency (wallclock от submit до терминального статуса)"
  echo
  echo "| Percentile | ms |"
  echo "| --- | --- |"
  echo "| p50 | $p50 |"
  echo "| p95 | $p95 |"
  echo "| p99 | $p99 |"
  echo
  if [[ -f "$run_dir/submit-http.csv" ]]; then
    echo "## HTTP коды при подаче (stress)"
    echo
    echo "- HTTP 429: $http_429"
    echo "- HTTP 5xx: $http_5xx"
    echo
  fi
  echo "## Артефакты"
  echo
  for f in env.txt manifest.txt jobs.csv submit-http.csv ollama-stats.csv ops-metrics-pre.json ops-metrics-post.json; do
    [[ -f "$run_dir/$f" ]] && echo "- \`$f\`"
  done
} > "$out"

echo "wrote $out"
