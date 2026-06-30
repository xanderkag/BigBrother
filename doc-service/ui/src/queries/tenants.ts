/**
 * Tenants — organizations / projects / users CRUD.
 * Endpoints — см. routes/tenants.ts.
 *
 * Все ручки требуют bearer-auth; super_admin'у видно всё, обычным
 * юзерам — только их организация (enforce будет позже вместе с PAT).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type OrgType = 'taipit' | 'external_company' | 'system';
export type UserRole = 'super_admin' | 'admin' | 'manager' | 'viewer';

export interface Organization {
  id: string;
  name: string;
  type: OrgType;
  created_at: string;
  updated_at?: string;
}

export interface Project {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface UserEntry {
  id: string;
  display_name: string;
  email: string | null;
  role: UserRole;
  kind: 'human' | 'service';
  organization_id: string | null;
  has_token: boolean;
  token_last_used_at: string | null;
  created_at: string;
}

interface ListResponse<T> {
  items: T[];
}

export function useOrganizations() {
  return useQuery({
    queryKey: ['organizations'],
    queryFn: () => api.get<ListResponse<Organization>>('/api/v1/organizations'),
  });
}

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<ListResponse<Project>>('/api/v1/projects'),
  });
}

export function useUsers() {
  return useQuery({
    queryKey: ['users', 'human'],
    queryFn: () => api.get<ListResponse<UserEntry>>('/api/v1/users?kind=human'),
  });
}

export function useSystems() {
  return useQuery({
    queryKey: ['users', 'service'],
    queryFn: () => api.get<ListResponse<UserEntry>>('/api/v1/users?kind=service'),
  });
}

export function useCreateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; type: OrgType }) =>
      api.post<Organization>('/api/v1/organizations', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['organizations'] });
    },
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      organization_id: string;
      name: string;
      description?: string | null;
    }) => api.post<Project>('/api/v1/projects', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      display_name: string;
      email?: string;
      role: UserRole;
      organization_id: string | null;
    }) => api.post<UserEntry>('/api/v1/users', data),
    onSuccess: () => {
      // ['users'] — префикс: инвалидирует и людей, и системы.
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

export function useCreateSystem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      display_name: string;
      role: UserRole;
      organization_id: string | null;
    }) => api.post<UserEntry>('/api/v1/users', { ...data, kind: 'service' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

export interface NewTokenResponse {
  plaintext: string;
  token_last_used_at: null;
}

export interface ProvisionInstanceInput {
  name: string;
  type?: string;
  webhook_url?: string | null;
  expires_in_days?: number | null;
  llm_budget?: number | null;
  dadata_budget?: number | null;
}

export interface ProvisionInstanceResult {
  organization_id: string;
  user_id: string;
  project_id: string;
  plaintext_token: string;
  webhook_secret: string | null;
}

export function useGenerateToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api.post<NewTokenResponse>(`/api/v1/users/${encodeURIComponent(userId)}/token`),
    onSuccess: () => {
      // префикс ['users'] обновляет и людей, и системы.
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

export function useRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api.delete<void>(`/api/v1/users/${encodeURIComponent(userId)}/token`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

export function useProvisionInstance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ProvisionInstanceInput) =>
      api.post<ProvisionInstanceResult>('/api/v1/admin/provision-instance', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['organizations'] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
}
