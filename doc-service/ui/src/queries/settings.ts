/**
 * Settings + provider status. Read-only snapshot для admin-вью —
 * показывает текущий runtime-конфиг сервиса (пороги OCR, sweeper'ы,
 * лимиты, статус провайдеров) без необходимости лезть в .env на хосте.
 *
 * Backend endpoints — см. routes/settings.ts:
 *   GET /api/v1/settings           — sanitized snapshot (без секретов)
 *   GET /api/v1/providers/status   — проксирует inference-service
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface SettingsSnapshot {
  service: {
    name: 'doc-service';
    version: string;
    port: number;
  };
  auth: {
    api_key_configured: boolean;
  };
  worker: {
    concurrency: number;
  };
  storage: {
    backend: 'local';
    dir: string;
    retention_days: number;
  };
  thresholds: {
    pdf_text: number;
    tesseract: number;
    vision_llm: number;
    needs_review: number;
    regex_fallback: number;
  };
  ocr_engines: {
    tesseract_langs: string;
    vision_llm: {
      enabled: boolean;
      url: string | null;
    };
    yandex_vision: {
      enabled: boolean;
      pii_warning: string;
    };
  };
  webhook: {
    hmac_secret_configured: boolean;
    max_attempts: number;
  };
  sweepers: {
    pending_interval_ms: number;
    pending_grace_seconds: number;
    file_cleanup_interval_ms: number;
    file_retention_days: number;
    audit_log_interval_ms: number;
    audit_log_retention_days: number;
  };
  limits: {
    max_upload_mb: number;
    max_metadata_bytes: number;
  };
  // FX-1: курс USD→RUB для сведения валютных LLM-затрат в ₽.
  fx: {
    usd_rub: number | null; // null → курса нет (стоимость estimate)
    source: string; // 'cbr:YYYY-MM-DD' | 'config:COST_FX_USD_RUB' | 'none'
    cbr_enabled: boolean;
    refresh_hours: number;
  };
}

export interface ProviderInfo {
  configured: boolean;
  model: string | null;
  description: string;
}

export interface ProvidersStatus {
  upstream: 'ok' | 'not_configured' | 'unreachable';
  active: string | null;
  available: Record<string, ProviderInfo>;
  error?: string;
}

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<SettingsSnapshot>('/api/v1/settings'),
    staleTime: 60_000, // конфиг меняется редко
  });
}

export function useProvidersStatus() {
  return useQuery({
    queryKey: ['providers-status'],
    queryFn: () => api.get<ProvidersStatus>('/api/v1/providers/status'),
    staleTime: 30_000,
  });
}
