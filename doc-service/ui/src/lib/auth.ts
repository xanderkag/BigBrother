/**
 * Auth model: bearer token хранится в localStorage под тем же ключом
 * что и старый vanilla UI (`parsdocs.token`) — это позволяет
 * залогиниться в одной UI и переключиться на другую без повторного
 * ввода пароля во время миграции.
 *
 * Никаких сессионных cookies — backend проверяет токен через
 * `Authorization: Bearer <token>` заголовок (см. middlewares/auth.ts).
 */

const TOKEN_KEY = 'parsdocs.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  return !!getToken();
}
