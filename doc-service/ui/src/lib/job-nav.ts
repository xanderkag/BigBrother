/**
 * F8 — навигация по соседям на JobDetail. Из Review/Jobs в деталку
 * прокидываем «контекст выборки»: упорядоченный список id, человекочитаемую
 * метку и адрес возврата. Кладём в `location.state.jobNav` (history state),
 * а не в query — список может быть длинным, и в URL ему не место. При
 * прямом заходе/перезагрузке state теряется → деталка просто прячет
 * стрелки соседей (graceful degradation, см. критерии F8).
 */
export interface JobNavContext {
  /** Упорядоченный список id выборки (в порядке, как показан в списке). */
  ids: string[];
  /** Человеческая метка источника — для подписи «← в очередь проверки». */
  label: string;
  /** Куда вернуться: pathname + search источника (без router basename). */
  backTo: string;
}

/** Ключ в history state, под которым лежит контекст. */
export interface JobNavState {
  jobNav: JobNavContext;
}

/** Безопасно достаёт контекст из `location.state` (любой формы). */
export function readJobNav(state: unknown): JobNavContext | null {
  if (!state || typeof state !== 'object') return null;
  const nav = (state as { jobNav?: unknown }).jobNav;
  if (!nav || typeof nav !== 'object') return null;
  const { ids, label, backTo } = nav as Record<string, unknown>;
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return null;
  return {
    ids: ids as string[],
    label: typeof label === 'string' ? label : 'список',
    backTo: typeof backTo === 'string' ? backTo : '',
  };
}

/** Позиция текущего job в выборке + соседи. index === -1, если не найден. */
export function neighborsOf(
  ctx: JobNavContext | null,
  currentId: string,
): { index: number; total: number; prevId: string | null; nextId: string | null } {
  if (!ctx) return { index: -1, total: 0, prevId: null, nextId: null };
  const index = ctx.ids.indexOf(currentId);
  return {
    index,
    total: ctx.ids.length,
    prevId: index > 0 ? ctx.ids[index - 1] : null,
    nextId: index >= 0 && index < ctx.ids.length - 1 ? ctx.ids[index + 1] : null,
  };
}
