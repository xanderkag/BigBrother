import { issueFieldKeys, fieldAnchorId } from '@/lib/issue-fields';

/**
 * Sticky banner со списком validation issues. Показывается сверху над
 * extracted data — устраняет дубль из старого UI (раньше issues были
 * И в банере, И повторно во вкладке Form).
 *
 * §9 polish: если issue по эвристике сопоставляется с полем (НДС, итог,
 * ИНН — см. lib/issue-fields), показываем его кликабельной ссылкой —
 * клик прокручивает к полю и подсвечивает его кольцом на ~1.4 c. Issue
 * без привязки к полю остаётся обычным текстом.
 */
interface Props {
  issues: string[];
}

/**
 * Найти поле по ключам issue и привлечь к нему внимание: прокрутить в
 * центр, дать фокус (a11y) и кратко подсветить кольцом. Берём первый
 * ключ, для которого элемент реально есть в DOM (поле могло быть в
 * JSON-вьюхе/не отрендерено — тогда мягко ничего не делаем).
 */
function flashField(issue: string) {
  for (const key of issueFieldKeys(issue)) {
    const el = document.getElementById(fieldAnchorId(key));
    if (!el) continue;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus({ preventScroll: true });
    el.classList.add('ring-2', 'ring-amber-400', 'rounded');
    window.setTimeout(
      () => el.classList.remove('ring-2', 'ring-amber-400', 'rounded'),
      1400,
    );
    return;
  }
}

export default function ValidationBanner({ issues }: Props) {
  if (!issues || issues.length === 0) return null;
  return (
    <div className="warning-banner sticky top-0 z-10">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        className="h-5 w-5 shrink-0 text-amber-600"
      >
        <path
          fillRule="evenodd"
          d="M12 2.25a.75.75 0 0 1 .671.41l9.875 19.5a.75.75 0 0 1-.671 1.09H2.125a.75.75 0 0 1-.671-1.09l9.875-19.5A.75.75 0 0 1 12 2.25Zm0 6a.75.75 0 0 1 .75.75v5a.75.75 0 0 1-1.5 0v-5a.75.75 0 0 1 .75-.75Zm0 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
          clipRule="evenodd"
        />
      </svg>
      <div className="flex-1">
        <div className="font-semibold">Validation issues ({issues.length})</div>
        <ul className="mt-1 space-y-0.5 text-sm">
          {issues.map((issue, i) => {
            const hasField = issueFieldKeys(issue).length > 0;
            return (
              <li key={i}>
                •{' '}
                {hasField ? (
                  <button
                    type="button"
                    onClick={() => flashField(issue)}
                    className="text-left underline decoration-dotted underline-offset-2 hover:decoration-solid"
                    title="Перейти к полю"
                  >
                    {issue}
                  </button>
                ) : (
                  issue
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
