/**
 * Унифицированный stub для страниц-черновиков. Показывает что страница
 * запланирована. (Раньше вёл в legacy-UI — тот отключён 2026-05-21.)
 */
export default function PageStub({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
      <div className="card">
        <div className="card-body space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-400">{description}</p>
        </div>
      </div>
    </div>
  );
}
