/**
 * §9 (CLASSIFIER-PACKET-V2): ядро приёмочного eval'а корпуса БКТ.
 *
 * Чистые функции над РЕЗУЛЬТАТАМИ прогона (наборы типов сегментов по файлам)
 * и golden'ом. Прогон пайплайна (OCR→classify→segment) делается отдельно на
 * asha (нужен корпус /root/bctt-docs), результат подаётся сюда как
 * `ActualResult[]`. Так ядро тестируется юнит-тестом без корпуса.
 *
 * Метрики (TZ §2):
 *  - M1: доля файлов с КОРРЕКТНЫМ набором типов по сегментам (порог ≥0.85).
 *  - M2: 100% флагманов (SKMBT, noreply, viber 448, viber 632).
 *  - M4: ПДн — для piiEmpty-кейсов extract/raw_text/webhook по ID пусты.
 */
import { BCTT_GOLDEN, type GoldenCase } from './bctt-golden.js';

export interface ActualResult {
  /** Имя (или путь) файла из прогона. */
  file: string;
  /** Набор типов сегментов, которые выдал пайплайн. */
  types: string[];
  /** M4: true, если по ID-содержимому extract/raw_text/webhook чисты. */
  piiClean?: boolean;
}

export interface CaseEval {
  id: string;
  fileMatch: string;
  matched: boolean; // нашёлся ли файл в результатах
  pass: boolean; // M1: набор типов корректен
  flagship: boolean;
  missing: string[]; // ожидались, но не найдены
  extra: string[]; // найдены сверх ожидаемого
  piiPass: boolean | null; // M4 (null если не ID-кейс)
}

export interface CorpusEval {
  cases: CaseEval[];
  m1Pass: number;
  m1Total: number;
  m1Rate: number;
  m2Pass: number;
  m2Total: number;
  m2Ok: boolean;
  m4Pass: number;
  m4Total: number;
  m4Ok: boolean;
  ok: boolean; // M1≥0.85 && M2 && M4
}

const M1_THRESHOLD = 0.85;

const norm = (t: string) => t.trim().toLowerCase();
const uniq = (a: string[]) => Array.from(new Set(a.map(norm)));

/** Набор типов совпал с ожидаемым (дедуп, порядок не важен). */
export function typeSetMatches(actual: string[], expected: string[]): boolean {
  const a = uniq(actual);
  const e = uniq(expected);
  if (a.length !== e.length) return false;
  const es = new Set(e);
  return a.every((t) => es.has(t));
}

/** Разница наборов: {missing, extra}. */
export function typeSetDiff(actual: string[], expected: string[]): { missing: string[]; extra: string[] } {
  const a = new Set(uniq(actual));
  const e = new Set(uniq(expected));
  return {
    missing: [...e].filter((t) => !a.has(t)),
    extra: [...a].filter((t) => !e.has(t)),
  };
}

/** Найти результат для golden-кейса по подстроке имени файла. */
function findResult(golden: GoldenCase, results: ActualResult[]): ActualResult | undefined {
  const needle = norm(golden.fileMatch);
  return results.find((r) => norm(r.file).includes(needle));
}

export function evalCorpus(
  results: ActualResult[],
  golden: GoldenCase[] = BCTT_GOLDEN,
): CorpusEval {
  const cases: CaseEval[] = golden.map((g) => {
    const res = findResult(g, results);
    const flagship = g.flagship === true;
    if (!res) {
      return {
        id: g.id, fileMatch: g.fileMatch, matched: false, pass: false, flagship,
        missing: g.types.slice(), extra: [], piiPass: g.piiEmpty ? false : null,
      };
    }
    const pass = typeSetMatches(res.types, g.types);
    const { missing, extra } = typeSetDiff(res.types, g.types);
    const piiPass = g.piiEmpty ? res.piiClean === true : null;
    return { id: g.id, fileMatch: g.fileMatch, matched: true, pass, flagship, missing, extra, piiPass };
  });

  const m1Total = cases.length;
  const m1Pass = cases.filter((c) => c.pass).length;
  const m1Rate = m1Total > 0 ? m1Pass / m1Total : 0;

  const flagCases = cases.filter((c) => c.flagship);
  const m2Total = flagCases.length;
  const m2Pass = flagCases.filter((c) => c.pass).length;
  const m2Ok = m2Total > 0 && m2Pass === m2Total;

  const piiCases = cases.filter((c) => c.piiPass !== null);
  const m4Total = piiCases.length;
  const m4Pass = piiCases.filter((c) => c.piiPass === true).length;
  const m4Ok = m4Pass === m4Total;

  return {
    cases,
    m1Pass, m1Total, m1Rate,
    m2Pass, m2Total, m2Ok,
    m4Pass, m4Total, m4Ok,
    ok: m1Rate >= M1_THRESHOLD && m2Ok && m4Ok,
  };
}

/** Человекочитаемый отчёт. */
export function formatReport(ev: CorpusEval): string {
  const lines: string[] = [];
  lines.push('=== BCTT eval (CLASSIFIER-PACKET-V2 §9) ===');
  for (const c of ev.cases) {
    const mark = c.pass ? '✅' : c.matched ? '❌' : '∅';
    const flag = c.flagship ? ' [M2]' : '';
    const detail = c.pass
      ? ''
      : c.matched
        ? ` (missing: ${c.missing.join(',') || '-'}; extra: ${c.extra.join(',') || '-'})`
        : ' (файл не найден в результатах)';
    const pii = c.piiPass === null ? '' : c.piiPass ? ' ПДн✅' : ' ПДн❌';
    lines.push(`  ${mark} ${c.id}${flag} ${c.fileMatch}${detail}${pii}`);
  }
  lines.push(
    `M1: ${ev.m1Pass}/${ev.m1Total} = ${(ev.m1Rate * 100).toFixed(1)}% (порог 85%) ${ev.m1Rate >= 0.85 ? '✅' : '❌'}`,
  );
  lines.push(`M2 (флагманы): ${ev.m2Pass}/${ev.m2Total} ${ev.m2Ok ? '✅' : '❌'}`);
  lines.push(`M4 (ПДн): ${ev.m4Pass}/${ev.m4Total} ${ev.m4Ok ? '✅' : '❌'}`);
  lines.push(`ИТОГО: ${ev.ok ? 'ПРИЁМКА ✅' : 'НЕ ПРОШЛА ❌'}`);
  return lines.join('\n');
}
