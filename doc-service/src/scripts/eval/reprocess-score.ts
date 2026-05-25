/**
 * One-off: reprocess existing prod jobs (bypasses SHA-256 upload dedup),
 * read fresh `extracted`, score against golden-set.v1.json using the same
 * compare.ts the harness uses. Post-envelope-fix re-bench (phi4, 9 real docs).
 *
 *   tsx src/scripts/eval/reprocess-score.ts \
 *     --golden ./eval/real/golden-set.v1.json \
 *     --map ./eval/real/jobmap.json \
 *     --out ./eval/real/qwenvl-real-v1-postfix-2026-05-25.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  compareByKind,
  getByPath,
  inferKind,
  type ComparatorKind,
  type FieldComparison,
} from './compare.js';

interface Args {
  golden: string;
  map: string;
  out: string;
  instance: string;
  token: string;
}
function parseArgs(argv: string[]): Args {
  let golden = '',
    map = '',
    out = '',
    instance = 'http://10.10.13.10:8085',
    token = 'pdpat_eval_v1_dummy';
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--golden') golden = argv[++i]!;
    else if (a === '--map') map = argv[++i]!;
    else if (a === '--out') out = argv[++i]!;
    else if (a === '--instance') instance = argv[++i]!;
    else if (a === '--token') token = argv[++i]!;
  }
  if (!golden || !map || !out) throw new Error('--golden --map --out required');
  return { golden, map, out, instance, token };
}

interface JobApi {
  job_id: string;
  status: string;
  document_type: string | null;
  confidence: number | null;
  extracted: Record<string, unknown> | null;
  validation_issues?: string[];
  last_llm_call: {
    backend?: string;
    model?: string;
    duration_ms?: number;
    prompt_tokens?: number;
    output_tokens?: number;
    raw_response?: string;
  } | null;
  error: string | null;
}

async function reprocess(instance: string, token: string, jobId: string): Promise<JobApi> {
  const res = await fetch(`${instance}/api/v1/jobs/${jobId}/reprocess`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`reprocess ${jobId} -> ${res.status} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as JobApi;
}

async function getJob(instance: string, token: string, jobId: string): Promise<JobApi> {
  const res = await fetch(`${instance}/api/v1/jobs/${jobId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`get ${jobId} -> ${res.status}`);
  return (await res.json()) as JobApi;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const golden = JSON.parse(await readFile(resolve(args.golden), 'utf8'));
  const jobmap: Record<string, string> = JSON.parse(await readFile(resolve(args.map), 'utf8'));

  const results: any[] = [];
  for (const fx of golden.fixtures) {
    const jobId = jobmap[fx.id];
    if (!jobId) {
      console.error(`  ${fx.id}: NO JOB ID — skipping`);
      continue;
    }
    process.stderr.write(`  ${fx.id} (${jobId}) reprocess … `);
    const t0 = Date.now();
    let job: JobApi;
    try {
      job = await reprocess(args.instance, args.token, jobId);
    } catch (e) {
      console.error(`ERROR ${(e as Error).message}`);
      // fall back to current state so we can still record it
      job = await getJob(args.instance, args.token, jobId);
    }
    const wallMs = Date.now() - t0;
    const llmMs = job.last_llm_call?.duration_ms;
    process.stderr.write(`done status=${job.status} wall=${wallMs}ms llm=${llmMs ?? 'n/a'}ms\n`);

    const expectedType = fx.expected.document_type ?? null;
    const fields: FieldComparison[] = fx.expected.fields.map((f: any) => {
      const kind: ComparatorKind = f.kind ?? inferKind(f.path);
      const actual = getByPath(job.extracted, f.path);
      const verdict = compareByKind(kind, f.expected, actual);
      return { path: f.path, kind, expected: f.expected, actual, verdict };
    });

    results.push({
      id: fx.id,
      file: fx.file,
      job_id: jobId,
      document_type_expected: expectedType,
      document_type_actual: job.document_type,
      classification_match: expectedType === null ? null : job.document_type === expectedType,
      status: job.status,
      fields,
      validation_issues: job.validation_issues ?? [],
      wall_duration_ms: wallMs,
      llm: job.last_llm_call
        ? {
            backend: job.last_llm_call.backend,
            model: job.last_llm_call.model,
            duration_ms: job.last_llm_call.duration_ms,
            prompt_tokens: job.last_llm_call.prompt_tokens,
            output_tokens: job.last_llm_call.output_tokens,
            raw_response_len: job.last_llm_call.raw_response?.length ?? 0,
            raw_response_empty: !job.last_llm_call.raw_response,
          }
        : null,
      error: job.error,
    });
  }

  // aggregate
  let fm = 0,
    fx_ = 0,
    fmiss = 0,
    ftotal = 0;
  for (const r of results)
    for (const f of r.fields) {
      ftotal += 1;
      if (f.verdict === 'match') fm += 1;
      else if (f.verdict === 'mismatch') fx_ += 1;
      else fmiss += 1;
    }
  const classDecided = results.filter((r) => r.classification_match !== null);
  const metrics = {
    total_fixtures: results.length,
    classification_accuracy:
      classDecided.length === 0
        ? null
        : classDecided.filter((r) => r.classification_match).length / classDecided.length,
    field_total: ftotal,
    field_match: fm,
    field_mismatch: fx_,
    field_missing: fmiss,
    field_coverage: ftotal === 0 ? 0 : (fm + fx_) / ftotal,
    field_exact_match: ftotal === 0 ? 0 : fm / ftotal,
  };

  const out = {
    generated_at: new Date().toISOString(),
    instance: args.instance,
    mechanism: 'POST /jobs/:id/reprocess (re-run classify+extract on stored raw_text, no re-OCR)',
    results,
    metrics,
  };
  await writeFile(resolve(args.out), JSON.stringify(out, null, 2), 'utf8');
  console.error(`\nwrote ${args.out}`);
  console.error(JSON.stringify(metrics, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : String(e));
  process.exit(2);
});
