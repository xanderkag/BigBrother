import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { setToken } from '@/lib/auth';
import { api, ApiError } from '@/lib/api';

/**
 * UX-AUTH: вход по email + password.
 *
 * Бекенд POST /api/v1/auth/login принимает {email, password}, возвращает
 * долгоживущий personal access token (90 дней). Кладём в localStorage,
 * дальше api-клиент сам подставляет его в Bearer-заголовок.
 *
 * Fallback на ввод токена напрямую — сохранён через ссылку "Вход по
 * токену" для совместимости с CI/curl-юзкейсами и для случая, когда
 * пользователь получил pdpat_ от админа.
 */

type LoginMode = 'password' | 'token';

type LoginResponse = {
  token: string;
  user: { id: string; email: string | null; display_name: string; role: string };
  expires_at: string | null;
};

export default function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<LoginMode>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [token, setTokenInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handlePasswordLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.post<LoginResponse>('/api/v1/auth/login', { email, password });
      setToken(res.token);
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Неверный email или пароль.');
      } else {
        setError(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTokenLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      setToken(token);
      await api.get('/api/v1/jobs?limit=1');
      navigate('/');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Неверный токен.');
      } else {
        setError(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-slate-50 dark:bg-slate-900/40 p-6">
      <div className="card w-full max-w-md">
        <div className="card-body space-y-5">
          <div className="text-center">
            <div className="mb-2 inline-flex items-center gap-2 text-2xl font-semibold text-slate-900 dark:text-slate-100">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="h-7 w-7 text-brand-600 dark:text-brand-400"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              </svg>
              parsedocs
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {mode === 'password' ? 'Введите email и пароль' : 'Введите API-токен'}
            </p>
          </div>

          {mode === 'password' ? (
            <form onSubmit={handlePasswordLogin} className="space-y-4">
              <div>
                <label htmlFor="email" className="form-label">Email</label>
                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="form-input"
                  placeholder="operator@vanga.local"
                  required
                />
              </div>
              <div>
                <label htmlFor="password" className="form-label">Пароль</label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="form-input"
                  required
                />
              </div>

              {error && <div className="error-banner">{error}</div>}

              <button
                type="submit"
                className="btn-primary w-full"
                disabled={submitting || !email || !password}
              >
                {submitting ? 'Проверка...' : 'Войти'}
              </button>

              <div className="text-center text-xs text-slate-500 dark:text-slate-400">
                <button
                  type="button"
                  className="underline hover:text-slate-700 dark:hover:text-slate-300"
                  onClick={() => { setMode('token'); setError(null); }}
                >
                  Войти по API-токену
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleTokenLogin} className="space-y-4">
              <div>
                <label htmlFor="token" className="form-label">API token</label>
                <input
                  id="token"
                  type="password"
                  autoComplete="current-password"
                  value={token}
                  onChange={(e) => setTokenInput(e.target.value)}
                  className="form-input font-mono"
                  placeholder="pdpat_..."
                  required
                />
              </div>

              {error && <div className="error-banner">{error}</div>}

              <button
                type="submit"
                className="btn-primary w-full"
                disabled={submitting || !token}
              >
                {submitting ? 'Проверка...' : 'Войти'}
              </button>

              <div className="text-center text-xs text-slate-500 dark:text-slate-400">
                <button
                  type="button"
                  className="underline hover:text-slate-700 dark:hover:text-slate-300"
                  onClick={() => { setMode('password'); setError(null); }}
                >
                  Войти по email/паролю
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
