/**
 * §9 (CLASSIFIER-PACKET-V2): CLI приёмочного eval'а корпуса БКТ.
 *
 * Запуск (на asha, где есть корпус и прогнанные результаты):
 *   tsx src/scripts/eval-bctt.ts [path/to/bctt-results.json]
 *
 * Формат results.json:
 *   { "results": [ { "file": "…207C SICHEL.pdf",
 *                    "types": ["customs_export_ead","excise_ead", …],
 *                    "piiClean": true }, … ] }
 *
 * `types` — набор типов сегментов из payload.documents[] (или из
 * single-doc document_type). `piiClean` — для ID-кейсов: true, если в
 * extracted/raw_text/webhook нет персональных полей (M4).
 *
 * Exit code 0 — приёмка прошла (M1≥85% && M2 && M4), иначе 1.
 */
import { readFileSync } from 'node:fs';
import { evalCorpus, formatReport, type ActualResult } from './eval/bctt-eval.js';

function main(): void {
  const path = process.argv[2] ?? 'bctt-results.json';
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.error(`eval-bctt: не удалось прочитать ${path}. Ожидается JSON {results:[…]}.`);
    process.exit(2);
  }
  let results: ActualResult[];
  try {
    const parsed = JSON.parse(raw) as { results?: ActualResult[] };
    results = Array.isArray(parsed.results) ? parsed.results : [];
  } catch {
    console.error(`eval-bctt: ${path} — невалидный JSON.`);
    process.exit(2);
    return;
  }

  const ev = evalCorpus(results);
  console.log(formatReport(ev));
  process.exit(ev.ok ? 0 : 1);
}

main();
