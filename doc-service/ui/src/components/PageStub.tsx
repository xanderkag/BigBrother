/**
 * Унифицированный stub для страниц-черновиков. Показывает что страница
 * запланирована и ведёт пользователя в legacy-UI на тот же раздел —
 * чтобы admin'у был аварийный путь пока React-страница не дописана.
 */
export default function PageStub({
  title,
  description,
  legacyHash,
}: {
  title: string;
  description: string;
  legacyHash?: string;
}) {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{title}</h1>
      <div className="card">
        <div className="card-body space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-400">{description}</p>
          {legacyHash && (
            <p className="text-sm">
              <span className="text-slate-500 dark:text-slate-400">
                Пока экран не переписан на React, используй legacy-UI:
              </span>{' '}
              <a
                href={`/ui-legacy/#${legacyHash}`}
                className="font-medium text-brand-600 dark:text-brand-400 hover:underline"
              >
                открыть в старом UI →
              </a>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
