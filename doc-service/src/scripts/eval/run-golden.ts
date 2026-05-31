/**
 * SLAI golden-set runner (EXT-LINE AC §B.4).
 *
 * Walks `doc-service/test-fixtures/slai-golden/` категориям, прогоняет каждый
 * PDF через локальный (или удалённый) parsdocs `POST /jobs`, ждёт `done`,
 * сравнивает с парным `.gt.json` и считает per-AC метрики:
 *
 *   maritime/        : container_no recall ≥80%, bl_no ≥70%
 *   international-auto/ : cmr_no recall ≥70%
 *   customs-broker/  : declaration_no recall ≥80%
 *   domestic-auto/   : ttn_no recall ≥70%
 *   ALL              : vehicle_plate ≥90%, trip_date ≥80% (regression)
 *
 * Запуск:
 *   npm run eval:golden -- \
 *       [--base-url http://localhost:3000] \
 *       [--token <PAT>]                       # для prod/sandbox \
 *       [--fixtures-dir doc-service/test-fixtures/slai-golden] \
 *       [--out eval/golden-report.json] \
 *       [--max-parallel 2] \
 *       [--fail-on-ac-miss]                   # exit 1 если хоть один AC не прошёл
 *
 * Skeleton-level v0.1: реализована скелетная инфраструктура (walk → upload →
 * poll → diff per-field → aggregate). Точное определение «matched» (string-
 * normalize, fuzzy, numeric tolerance) — будет уточнено по факту первого
 * batch'а от SLAI 2026-06-02..04. Сейчас exact-match с trim+casefold для
 * строк и numeric-equality для чисел.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join, basename, extname } from 'node:path';
import { performance } from 'node:perf_hooks';

// ── Args ───────────────────────────────────────────────────────────────

type Args = {
  baseUrl: string;
  token: string | null;
  fixturesDir: string;
  outPath: string | null;
  maxParallel: number;
  failOnAcMiss: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    baseUrl: get('base-url') ?? 'http://localhost:3000',
    token: get('token') ?? null,
    fixturesDir: get('fixtures-dir') ?? 'doc-service/test-fixtures/slai-golden',
    outPath: get('out') ?? null,
    maxParallel: Number.parseInt(get('max-parallel') ?? '2', 10),
    failOnAcMiss: argv.includes('--fail-on-ac-miss'),
  };
}

// ── AC matrix (EXT-LINE §B.4) ──────────────────────────────────────────

type AcRule = { field: string; minRecall: number };
type CategoryConfig = { dir: string; primaryAc: AcRule[] };

const CATEGORIES: readonly CategoryConfig[] = [
  {
    dir: 'maritime',
    primaryAc: [
      { field: 'items[].container_no', minRecall: 0.8 },
      { field: 'items[].bl_no',        minRecall: 0.7 },
    ],
  },
  {
    dir: 'international-auto',
    primaryAc: [{ field: 'items[].cmr_no', minRecall: 0.7 }],
  },
  {
    dir: 'customs-broker',
    primaryAc: [{ field: 'items[].declaration_no', minRecall: 0.8 }],
  },
  {
    dir: 'domestic-auto',
    primaryAc: [{ field: 'items[].ttn_no', minRecall: 0.7 }],
  },
];

// Regression AC — на ВСЕХ категориях, не должно проседать после нового кода.
const REGRESSION_AC: readonly AcRule[] = [
  { field: 'items[].vehicle_plate', minRecall: 0.9 },
  { field: 'items[].trip_date',     minRecall: 0.8 },
];

// ── Fixture discovery ──────────────────────────────────────────────────

type Fixture = {
  category: string;
  pdfPath: string;
  gtPath: string;
  gt: Record<string, unknown>;
};

async function discoverFixtures(root: string): Promise<Fixture[]> {
  const out: Fixture[] = [];
  for (const cat of CATEGORIES) {
    const dir = resolve(root, cat.dir);
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      // Категория ещё не пришла от SLAI — нормально, пропускаем.
      continue;
    }
    for (const f of entries) {
      if (extname(f).toLowerCase() !== '.pdf') continue;
      const pdfPath = join(dir, f);
      const gtPath = pdfPath.replace(/\.pdf$/i, '.gt.json');
      try {
        await stat(gtPath);
      } catch {
        // eslint-disable-next-line no-console
        console.warn(`[skip] ${basename(pdfPath)} — нет ${basename(gtPath)}`);
        continue;
      }
      const gt = JSON.parse(await readFile(gtPath, 'utf8')) as Record<string, unknown>;
      out.push({ category: cat.dir, pdfPath, gtPath, gt });
    }
  }
  return out;
}

// ── HTTP upload + poll ─────────────────────────────────────────────────

type JobResult = {
  id: string;
  status: string;
  extracted: Record<string, unknown> | null;
  duration_ms: number;
};

async function uploadAndWait(args: Args, fx: Fixture): Promise<JobResult> {
  const t0 = performance.now();
  const buf = await readFile(fx.pdfPath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'application/pdf' }), basename(fx.pdfPath));

  const headers: Record<string, string> = {};
  if (args.token) headers['authorization'] = `Bearer ${args.token}`;

  const up = await fetch(`${args.baseUrl}/api/v1/jobs`, { method: 'POST', body: form, headers });
  if (!up.ok) throw new Error(`upload failed: ${up.status} ${await up.text()}`);
  const { job_id: jobId } = (await up.json()) as { job_id: string };

  // Polling — backoff 1s → 5s, timeout 5min.
  let delay = 1000;
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 5000);
    const r = await fetch(`${args.baseUrl}/api/v1/jobs/${jobId}`, { headers });
    if (!r.ok) continue;
    const j = (await r.json()) as { status: string; extracted: Record<string, unknown> | null };
    if (['done', 'needs_review', 'failed'].includes(j.status)) {
      return {
        id: jobId,
        status: j.status,
        extracted: j.extracted ?? null,
        duration_ms: Math.round(performance.now() - t0),
      };
    }
  }
  throw new Error(`timeout waiting for job ${jobId}`);
}

// ── Compare ─────────────────────────────────────────────────────────────

function normalize(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.trim().toLowerCase().replace(/\s+/g, ' ');
  return JSON.stringify(v);
}

/**
 * Возвращает `true` если в `extracted` нашлось значение, эквивалентное
 * ground-truth значению, по `path`. Для `items[].field` ищет хотя бы одно
 * соответствие в массиве `items[]`.
 */
function matchField(extracted: Record<string, unknown>, gtValue: unknown, path: string): boolean {
  const expected = normalize(gtValue);
  if (expected === null) return false; // gt пустое — не считается обнаружимым.

  const m = path.match(/^items\[\]\.(.+)$/);
  if (m) {
    const field = m[1]!;
    const items = (extracted['items'] as unknown[]) || [];
    return items.some((it) => {
      if (!it || typeof it !== 'object') return false;
      const got = normalize((it as Record<string, unknown>)[field]);
      return got === expected;
    });
  }

  // Document-level — простой dot-path, до одного уровня вложенности.
  const parts = path.split('.');
  let cur: unknown = extracted;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return false;
    cur = (cur as Record<string, unknown>)[p];
  }
  return normalize(cur) === expected;
}

/**
 * Считает recall по конкретному полю на наборе фикстур: сколько из тех,
 * у кого в gt поле задано, parsdocs тоже извлёк.
 */
function computeRecall(results: Array<{ fx: Fixture; job: JobResult | null }>, path: string): {
  recall: number;
  matched: number;
  expected: number;
} {
  let matched = 0;
  let expected = 0;
  for (const { fx, job } of results) {
    // Сколько в gt items[] физически содержат этот field.
    const m = path.match(/^items\[\]\.(.+)$/);
    if (m) {
      const field = m[1]!;
      const gtItems = (fx.gt['items'] as unknown[]) || [];
      for (const it of gtItems) {
        if (!it || typeof it !== 'object') continue;
        const gtVal = (it as Record<string, unknown>)[field];
        if (gtVal === undefined || gtVal === null || gtVal === '') continue;
        expected += 1;
        if (job?.extracted && matchField(job.extracted, gtVal, path)) matched += 1;
      }
    } else {
      const gtVal = path.split('.').reduce<unknown>(
        (a, p) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[p] : undefined),
        fx.gt,
      );
      if (gtVal === undefined || gtVal === null || gtVal === '') continue;
      expected += 1;
      if (job?.extracted && matchField(job.extracted, gtVal, path)) matched += 1;
    }
  }
  return { matched, expected, recall: expected === 0 ? 1 : matched / expected };
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // eslint-disable-next-line no-console
  console.log(`[golden-runner] base=${args.baseUrl} dir=${args.fixturesDir}`);

  const fixtures = await discoverFixtures(resolve(args.fixturesDir));
  if (fixtures.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(`[golden-runner] нет фикстур в ${args.fixturesDir} — ждём batch от SLAI.`);
    process.exit(0);
  }

  // eslint-disable-next-line no-console
  console.log(`[golden-runner] фикстур: ${fixtures.length}`);
  for (const c of CATEGORIES) {
    const n = fixtures.filter((f) => f.category === c.dir).length;
    // eslint-disable-next-line no-console
    console.log(`  ${c.dir}: ${n}`);
  }

  // Runner with limited concurrency.
  const results: Array<{ fx: Fixture; job: JobResult | null }> = [];
  let inFlight = 0;
  let idx = 0;
  await new Promise<void>((done, fail) => {
    const tick = (): void => {
      while (inFlight < args.maxParallel && idx < fixtures.length) {
        const fx = fixtures[idx++]!;
        inFlight += 1;
        uploadAndWait(args, fx)
          .then((job) => {
            results.push({ fx, job });
            // eslint-disable-next-line no-console
            console.log(`  ✓ ${fx.category}/${basename(fx.pdfPath)} → ${job.status} (${job.duration_ms}ms)`);
          })
          .catch((err) => {
            results.push({ fx, job: null });
            // eslint-disable-next-line no-console
            console.error(`  ✗ ${fx.category}/${basename(fx.pdfPath)}: ${(err as Error).message}`);
          })
          .finally(() => {
            inFlight -= 1;
            if (idx >= fixtures.length && inFlight === 0) done();
            else tick();
          });
      }
    };
    try {
      tick();
    } catch (e) {
      fail(e);
    }
  });

  // ── Report ──────────────────────────────────────────────────────────
  // eslint-disable-next-line no-console
  console.log('\n=== AC §B.4 ===\n');
  let acMiss = 0;
  const report: Record<string, unknown> = { categories: {} };

  for (const cat of CATEGORIES) {
    const catRes = results.filter((r) => r.fx.category === cat.dir);
    const block: Record<string, unknown> = { docs: catRes.length, ac: {} };
    // eslint-disable-next-line no-console
    console.log(`[${cat.dir}] docs=${catRes.length}`);
    for (const rule of cat.primaryAc) {
      const m = computeRecall(catRes, rule.field);
      const pass = m.recall >= rule.minRecall;
      if (!pass) acMiss += 1;
      (block['ac'] as Record<string, unknown>)[rule.field] = { ...m, minRecall: rule.minRecall, pass };
      // eslint-disable-next-line no-console
      console.log(
        `  ${pass ? '✅' : '❌'} ${rule.field}: ${m.matched}/${m.expected} = ${(m.recall * 100).toFixed(1)}% (порог ${(rule.minRecall * 100).toFixed(0)}%)`,
      );
    }
    (report['categories'] as Record<string, unknown>)[cat.dir] = block;
  }

  // eslint-disable-next-line no-console
  console.log('\n[regression — на всех категориях]');
  const reg: Record<string, unknown> = {};
  for (const rule of REGRESSION_AC) {
    const m = computeRecall(results, rule.field);
    const pass = m.recall >= rule.minRecall;
    if (!pass) acMiss += 1;
    reg[rule.field] = { ...m, minRecall: rule.minRecall, pass };
    // eslint-disable-next-line no-console
    console.log(
      `  ${pass ? '✅' : '❌'} ${rule.field}: ${m.matched}/${m.expected} = ${(m.recall * 100).toFixed(1)}% (порог ${(rule.minRecall * 100).toFixed(0)}%)`,
    );
  }
  report['regression'] = reg;

  if (args.outPath) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(args.outPath, JSON.stringify(report, null, 2), 'utf8');
    // eslint-disable-next-line no-console
    console.log(`\n[golden-runner] report → ${args.outPath}`);
  }

  if (args.failOnAcMiss && acMiss > 0) {
    // eslint-disable-next-line no-console
    console.error(`\n[golden-runner] ❌ ${acMiss} AC не прошли — exit 1`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('\n[golden-runner] done.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[golden-runner] FAILED:', err);
  process.exit(2);
});
