/**
 * Golden-set eval runner.
 *
 *   tsx src/scripts/eval/run.ts \
 *       --golden-set ./eval/golden-set.json \
 *       [--out ./eval/report.json] \
 *       [--max-parallel 2] \
 *       [--fail-on-mismatch]   # exit 1 если есть fixture с mismatch'ами
 *
 * Что делает:
 *   1. Читает golden-set.json (schema из ./schema.ts).
 *   2. На каждую фикстуру: POST /jobs (multipart) → poll GET /jobs/:id →
 *      сравнение ожидаемых полей через compare.ts.
 *   3. Считает метрики: classification accuracy, per-field coverage,
 *      per-field exact-match, needs_review rate, validation issue rate,
 *      latency P50/P95, LLM-fallback rate.
 *   4. Печатает читабельную таблицу + (опц.) пишет полный JSON.
 *   5. Exit-код 0 / 1 — для CI gating.
 *
 * Зачем именно через HTTP, а не in-process: harness должен работать
 * против любого инстанса — локального dev, staging, prod-копии. И мы
 * хотим мерить ровно то, что меряет клиент: со всем стэком (auth,
 * валидация, очередь, polling), а не «голый pipeline».
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { lookup as lookupMime } from 'mime-types';
import { GoldenSetSchema, type Fixture, type GoldenSet } from './schema.js';
import {
  compareByKind,
  getByPath,
  inferKind,
  type ComparatorKind,
  type FieldComparison,
} from './compare.js';

// ---------------------- CLI ----------------------

interface CliArgs {
  goldenSet: string;
  outPath?: string;
  maxParallel: number;
  failOnMismatch: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let goldenSet: string | undefined;
  let outPath: string | undefined;
  let maxParallel = 1;
  let failOnMismatch = false;
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--golden-set') {
      goldenSet = argv[++i];
    } else if (a === '--out') {
      outPath = argv[++i];
    } else if (a === '--max-parallel') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 16) {
        throw new Error('--max-parallel must be integer 1..16');
      }
      maxParallel = n;
    } else if (a === '--fail-on-mismatch') {
      failOnMismatch = true;
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  if (!goldenSet) {
    printUsage();
    throw new Error('--golden-set is required');
  }
  return { goldenSet, outPath, maxParallel, failOnMismatch };
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      'Usage: tsx src/scripts/eval/run.ts --golden-set <path> [options]',
      '',
      'Options:',
      '  --golden-set <path>   golden-set JSON (required)',
      '  --out <path>          write full report JSON here',
      '  --max-parallel <n>    upload concurrency (default 1)',
      '  --fail-on-mismatch    exit 1 if any field comparison failed',
    ].join('\n'),
  );
}

// ---------------------- HTTP helpers ----------------------

async function postJob(
  golden: GoldenSet,
  fixture: Fixture,
  filePath: string,
): Promise<string> {
  const data = await readFile(filePath);
  const mime = lookupMime(filePath) || 'application/octet-stream';
  const form = new FormData();
  form.append('file', new Blob([data], { type: mime }), basename(filePath));
  if (fixture.document_type_hint) {
    form.append('document_hint', fixture.document_type_hint);
  }
  if (golden.project_id) {
    form.append('project_id', golden.project_id);
  }
  if (fixture.metadata) {
    form.append('metadata', JSON.stringify(fixture.metadata));
  }
  const res = await fetch(`${golden.instance}/api/v1/jobs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${golden.token}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`POST /jobs failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { job_id?: string };
  if (!json.job_id) throw new Error(`POST /jobs returned no job_id: ${JSON.stringify(json)}`);
  return json.job_id;
}

type TerminalStatus = 'done' | 'needs_review' | 'failed';
function isTerminal(s: string): s is TerminalStatus {
  return s === 'done' || s === 'needs_review' || s === 'failed';
}

interface JobApi {
  job_id: string;
  status: string;
  document_type: string | null;
  document_hint: string | null;
  confidence: number | null;
  ocr_engine: string | null;
  extracted: Record<string, unknown> | null;
  validation_issues: string[];
  last_llm_call: {
    backend?: string;
    model?: string;
    duration_ms?: number;
    prompt_tokens?: number;
    output_tokens?: number;
  } | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

async function pollJob(
  golden: GoldenSet,
  jobId: string,
): Promise<JobApi> {
  const start = Date.now();
  while (Date.now() - start < golden.poll.timeout_ms) {
    const res = await fetch(`${golden.instance}/api/v1/jobs/${jobId}`, {
      headers: { authorization: `Bearer ${golden.token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GET /jobs/${jobId} failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const job = (await res.json()) as JobApi;
    if (isTerminal(job.status)) return job;
    await sleep(golden.poll.interval_ms);
  }
  throw new Error(`job ${jobId} did not reach terminal status within ${golden.poll.timeout_ms}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------- Per-fixture eval ----------------------

interface FixtureResult {
  id: string;
  file: string;
  document_type_expected: string | null;
  document_type_actual: string | null;
  classification_match: boolean | null; // null если expected не задан
  status: string;
  status_match: boolean | null;
  fields: FieldComparison[];
  validation_issues: string[];
  validation_issues_acceptable: boolean | null;
  total_duration_ms: number;
  sla_ok: boolean | null;
  llm: {
    backend?: string;
    model?: string;
    duration_ms?: number;
    prompt_tokens?: number;
    output_tokens?: number;
  } | null;
  error: string | null;
  /** true если фикстура считается «прошедшей» — нет mismatch'ей, нет missing required. */
  passed: boolean;
}

async function evalFixture(
  golden: GoldenSet,
  fixture: Fixture,
  goldenSetDir: string,
): Promise<FixtureResult> {
  const filePath = resolve(goldenSetDir, fixture.file);
  await stat(filePath); // explicit ENOENT с понятным сообщением

  const t0 = performance.now();
  const jobId = await postJob(golden, fixture, filePath);
  const job = await pollJob(golden, jobId);
  const totalMs = Math.round(performance.now() - t0);

  // 1. Classification check
  const expectedType = fixture.expected.document_type ?? null;
  const classificationMatch =
    expectedType === null ? null : job.document_type === expectedType;

  // 2. Status check
  const expectedTerminal = fixture.expected.terminal_status;
  const statusMatch =
    expectedTerminal === undefined ? null : job.status === expectedTerminal;

  // 3. Field-by-field comparison
  const fieldComps: FieldComparison[] = fixture.expected.fields.map((f) => {
    const kind: ComparatorKind = f.kind ?? inferKind(f.path);
    const actual = getByPath(job.extracted, f.path);
    const verdict = compareByKind(kind, f.expected, actual);
    return { path: f.path, kind, expected: f.expected, actual, verdict };
  });

  // 4. Validation issues
  const noIssuesExpected = fixture.expected.no_issues === true;
  const validationOk = noIssuesExpected ? job.validation_issues.length === 0 : null;

  // 5. SLA check
  const sla = fixture.expected.max_total_duration_ms;
  const slaOk = sla === undefined ? null : totalMs <= sla;

  // 6. Overall "passed"
  const anyMismatch = fieldComps.some((c) => c.verdict === 'mismatch');
  const anyMissing = fieldComps.some((c) => c.verdict === 'missing');
  const passed =
    job.status !== 'failed' &&
    (classificationMatch ?? true) &&
    (statusMatch ?? true) &&
    !anyMismatch &&
    !anyMissing &&
    (validationOk ?? true) &&
    (slaOk ?? true);

  return {
    id: fixture.id,
    file: fixture.file,
    document_type_expected: expectedType,
    document_type_actual: job.document_type,
    classification_match: classificationMatch,
    status: job.status,
    status_match: statusMatch,
    fields: fieldComps,
    validation_issues: job.validation_issues,
    validation_issues_acceptable: validationOk,
    total_duration_ms: totalMs,
    sla_ok: slaOk,
    llm: job.last_llm_call,
    error: job.error,
    passed,
  };
}

// ---------------------- Aggregation ----------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[Math.max(0, idx)]!;
}

interface AggregateMetrics {
  total_fixtures: number;
  passed: number;
  failed: number;
  classification_accuracy: number | null; // null если ни в одной не указан expected.document_type
  field_total: number;
  field_match: number;
  field_mismatch: number;
  field_missing: number;
  field_coverage: number; // (match + mismatch) / total
  field_exact_match: number; // match / total
  needs_review_rate: number;
  failed_rate: number;
  validation_issue_rate: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  tokens_p95_in: number | null;
  tokens_p95_out: number | null;
  llm_fallback_rate: number;
}

function aggregate(results: FixtureResult[]): AggregateMetrics {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const classificationDecided = results.filter((r) => r.classification_match !== null);
  const classificationAccuracy =
    classificationDecided.length === 0
      ? null
      : classificationDecided.filter((r) => r.classification_match === true).length /
        classificationDecided.length;

  let fieldTotal = 0;
  let fieldMatch = 0;
  let fieldMismatch = 0;
  let fieldMissing = 0;
  for (const r of results) {
    for (const f of r.fields) {
      fieldTotal += 1;
      if (f.verdict === 'match') fieldMatch += 1;
      else if (f.verdict === 'mismatch') fieldMismatch += 1;
      else fieldMissing += 1;
    }
  }

  const latencies = results.map((r) => r.total_duration_ms).sort((a, b) => a - b);

  const inTokens = results
    .map((r) => r.llm?.prompt_tokens)
    .filter((x): x is number => typeof x === 'number')
    .sort((a, b) => a - b);
  const outTokens = results
    .map((r) => r.llm?.output_tokens)
    .filter((x): x is number => typeof x === 'number')
    .sort((a, b) => a - b);

  return {
    total_fixtures: total,
    passed,
    failed: total - passed,
    classification_accuracy: classificationAccuracy,
    field_total: fieldTotal,
    field_match: fieldMatch,
    field_mismatch: fieldMismatch,
    field_missing: fieldMissing,
    field_coverage: fieldTotal === 0 ? 0 : (fieldMatch + fieldMismatch) / fieldTotal,
    field_exact_match: fieldTotal === 0 ? 0 : fieldMatch / fieldTotal,
    needs_review_rate:
      total === 0 ? 0 : results.filter((r) => r.status === 'needs_review').length / total,
    failed_rate: total === 0 ? 0 : results.filter((r) => r.status === 'failed').length / total,
    validation_issue_rate:
      total === 0 ? 0 : results.filter((r) => r.validation_issues.length > 0).length / total,
    latency_p50_ms: percentile(latencies, 0.5),
    latency_p95_ms: percentile(latencies, 0.95),
    tokens_p95_in: inTokens.length === 0 ? null : percentile(inTokens, 0.95),
    tokens_p95_out: outTokens.length === 0 ? null : percentile(outTokens, 0.95),
    llm_fallback_rate: total === 0 ? 0 : results.filter((r) => r.llm !== null).length / total,
  };
}

// ---------------------- Report rendering ----------------------

function pct(n: number | null): string {
  if (n === null) return '   n/a';
  return `${(n * 100).toFixed(1).padStart(5, ' ')}%`;
}

function renderReport(
  results: FixtureResult[],
  metrics: AggregateMetrics,
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('='.repeat(78));
  lines.push('Eval report');
  lines.push('='.repeat(78));
  lines.push('');
  lines.push('Per-fixture:');
  lines.push(
    '  ' +
      ['id'.padEnd(28), 'status'.padEnd(14), 'fields'.padEnd(14), 'lat ms'.padEnd(10), 'verdict'].join(' '),
  );
  for (const r of results) {
    const fields = `${r.fields.filter((f) => f.verdict === 'match').length}/${r.fields.length} ✓`;
    const verdict = r.passed ? 'PASS' : 'FAIL';
    lines.push(
      '  ' +
        [
          r.id.padEnd(28).slice(0, 28),
          r.status.padEnd(14),
          fields.padEnd(14),
          String(r.total_duration_ms).padEnd(10),
          verdict,
        ].join(' '),
    );
    if (!r.passed) {
      for (const f of r.fields) {
        if (f.verdict === 'match') continue;
        lines.push(
          `      · ${f.path} (${f.kind}) ${f.verdict}: expected=${
            JSON.stringify(f.expected)
          } actual=${JSON.stringify(f.actual)}`,
        );
      }
      if (r.error) lines.push(`      · pipeline error: ${r.error}`);
      if (r.sla_ok === false) {
        lines.push(`      · SLA breach: ${r.total_duration_ms}ms`);
      }
      if (r.validation_issues_acceptable === false) {
        lines.push(`      · validation_issues present: ${r.validation_issues.join('; ')}`);
      }
      if (r.classification_match === false) {
        lines.push(
          `      · classification: expected=${r.document_type_expected} actual=${r.document_type_actual}`,
        );
      }
    }
  }
  lines.push('');
  lines.push('Aggregate:');
  lines.push(`  total fixtures           ${metrics.total_fixtures}`);
  lines.push(`  passed                   ${metrics.passed} (${pct(metrics.passed / Math.max(1, metrics.total_fixtures))})`);
  lines.push(`  classification accuracy  ${pct(metrics.classification_accuracy)}`);
  lines.push(`  field coverage           ${pct(metrics.field_coverage)}  (extracted non-null)`);
  lines.push(`  field exact-match        ${pct(metrics.field_exact_match)}  (correct value)`);
  lines.push(
    `    match / mismatch / miss  ${metrics.field_match} / ${metrics.field_mismatch} / ${metrics.field_missing}`,
  );
  lines.push(`  needs_review rate        ${pct(metrics.needs_review_rate)}`);
  lines.push(`  failed rate              ${pct(metrics.failed_rate)}`);
  lines.push(`  validation issue rate    ${pct(metrics.validation_issue_rate)}`);
  lines.push(`  latency P50 / P95 ms     ${metrics.latency_p50_ms} / ${metrics.latency_p95_ms}`);
  if (metrics.tokens_p95_in !== null) {
    lines.push(
      `  LLM tokens P95 in/out    ${metrics.tokens_p95_in} / ${metrics.tokens_p95_out}`,
    );
  }
  lines.push(`  LLM-fallback rate        ${pct(metrics.llm_fallback_rate)}`);
  lines.push('');
  return lines.join('\n');
}

// ---------------------- Main ----------------------

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!, idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const goldenAbsPath = resolve(args.goldenSet);
  const goldenSetDir = dirname(goldenAbsPath);
  const raw = JSON.parse(await readFile(goldenAbsPath, 'utf8'));
  const golden = GoldenSetSchema.parse(raw);

  // eslint-disable-next-line no-console
  console.error(
    `eval: ${golden.fixtures.length} fixtures against ${golden.instance} (concurrency=${args.maxParallel})`,
  );

  const results = await runWithConcurrency(golden.fixtures, args.maxParallel, async (f, idx) => {
    // eslint-disable-next-line no-console
    console.error(`  [${idx + 1}/${golden.fixtures.length}] ${f.id} …`);
    try {
      const r = await evalFixture(golden, f, goldenSetDir);
      // eslint-disable-next-line no-console
      console.error(`      ${r.passed ? 'PASS' : 'FAIL'} (${r.total_duration_ms}ms)`);
      return r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // eslint-disable-next-line no-console
      console.error(`      ERROR: ${msg}`);
      // Превращаем падение в «failed» fixture, чтобы агрегация шла дальше.
      const stub: FixtureResult = {
        id: f.id,
        file: f.file,
        document_type_expected: f.expected.document_type ?? null,
        document_type_actual: null,
        classification_match: f.expected.document_type ? false : null,
        status: 'failed',
        status_match: null,
        fields: f.expected.fields.map((fe) => ({
          path: fe.path,
          kind: fe.kind ?? inferKind(fe.path),
          expected: fe.expected,
          actual: undefined,
          verdict: 'missing' as const,
        })),
        validation_issues: [],
        validation_issues_acceptable: null,
        total_duration_ms: 0,
        sla_ok: null,
        llm: null,
        error: msg,
        passed: false,
      };
      return stub;
    }
  });

  const metrics = aggregate(results);
  const report = renderReport(results, metrics);
  process.stdout.write(report);

  if (args.outPath) {
    const json = {
      generated_at: new Date().toISOString(),
      instance: golden.instance,
      results,
      metrics,
    };
    await writeFile(resolve(args.outPath), JSON.stringify(json, null, 2), 'utf8');
    // eslint-disable-next-line no-console
    console.error(`wrote ${args.outPath}`);
  }

  if (args.failOnMismatch && metrics.failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(2);
});
