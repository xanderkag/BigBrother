/**
 * Current user — кто залогинен (id, role, organization).
 *
 * Backend: GET /api/v1/users/me. Кэшируем агрессивно (10 мин) — UI часто
 * показывает имя/роль в шапке, дёргать query при каждом render'е не имеет
 * смысла. Инвалидация — только при logout.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface CurrentUser {
  id: string;
  role: 'super_admin' | 'admin' | 'manager' | 'viewer' | string;
  organization_id: string | null;
  is_super_admin: boolean;
}

export function useCurrentUser() {
  return useQuery({
    queryKey: ['users', 'me'],
    queryFn: () => api.get<CurrentUser>('/api/v1/users/me'),
    staleTime: 10 * 60_000,
  });
}
