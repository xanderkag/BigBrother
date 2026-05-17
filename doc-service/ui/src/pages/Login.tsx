import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { setToken } from '@/lib/auth';
import { api, ApiError } from '@/lib/api';

/**
 * Простой login-screen. Пользователь вводит API token, мы делаем
 * один проверочный запрос (GET /api/v1/whoami) — если OK, сохраняем
 * токен и переходим к app.
 *
 * NOTE: backend whoami возвращает org_id + project_id; берём из
 * последнего job-history. Если /whoami недоступен — fallback на
 * /api/v1/jobs?limit=1 (любой 200 = валидный токен).
 */
export default function LoginPage() {
  const navigate = useNavigate();
  const [token, setTokenInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // Сохраняем токен до запроса — api клиент возьмёт его из localStorage
      setToken(token);
      // Проверочный запрос
      await api.get('/api/v1/jobs?limit=1');
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Неверный токен. Попробуйте ещё раз.');
      } else {
        setError(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-slate-50 p-6">
      <div className="card w-full max-w-md">
        <div className="card-body space-y-5">
          <div className="text-center">
            <div className="mb-2 inline-flex items-center gap-2 text-2xl font-semibold text-slate-900">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="h-7 w-7 text-brand-600"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              </svg>
              parsedocs
            </div>
            <p className="text-sm text-slate-500">Введите API-токен для входа</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="token" className="form-label">
                API token
              </label>
              <input
                id="token"
                type="password"
                autoComplete="current-password"
                value={token}
                onChange={(e) => setTokenInput(e.target.value)}
                className="form-input font-mono"
                placeholder="sk-..."
                required
              />
            </div>

            {error && <div className="error-banner">{error}</div>}

            <button type="submit" className="btn-primary w-full" disabled={submitting || !token}>
              {submitting ? 'Проверка...' : 'Войти'}
            </button>
          </form>

          <div className="text-center text-xs text-slate-500">
            <a href="/ui/" className="hover:underline">
              Открыть старый UI →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
