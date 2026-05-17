/**
 * Sticky banner со списком validation issues. Показывается сверху над
 * extracted data — устраняет дубль из старого UI (раньше issues были
 * И в банере, И повторно во вкладке Form).
 */
interface Props {
  issues: string[];
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
          {issues.map((issue, i) => (
            <li key={i}>• {issue}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
