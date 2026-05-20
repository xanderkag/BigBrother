import { db } from '../db.js';
import { encryptSecret, decryptSecret } from './secrets.js';

/**
 * Organization Settings — repository over the `organization_settings` table
 * (1:1 с organizations, миграция 0026, multi-tenancy CP7 фаза 2).
 *
 * Хранит per-org consumer profile: как потребитель хочет, чтобы пайплайн
 * себя вёл (`mode`), куда выгружать результат (`output` + `webhook_url`),
 * и переопределение порога авто-аппрува (`auto_approve_threshold`).
 *
 * Семантика полей (enforce'ится в Phase 3 — здесь только data + API):
 *   - mode='classify_only' → пайплайн пропустит extract-стадию (дешевле;
 *     для потребителей, которым нужен только тип документа).
 *   - mode='extract' (default) → полный прогон.
 *   - output='webhook' → финализированные job'ы POST'ятся на `webhook_url`
 *     с HMAC из `webhook_hmac_secret`. output='pull' → без push, UI
 *     потребителя сам зовёт GET /jobs/:id.
 *   - auto_approve_threshold → переопределяет config.thresholds.needsReview
 *     для job'ов этой орг. NULL = глобальный default.
 *
 * Секрет webhook_hmac_secret НИКОГДА не покидает БД в открытом виде:
 *   - на write — шифруется через encryptSecret (envelope v1:);
 *   - на read через `get`/`toApi` — маскируется в `has_webhook_secret`;
 *   - расшифровать его (для подписи вебхуков в Phase 3) можно ТОЛЬКО через
 *     отдельный `getDecryptedWebhookSecret` — не через публичный профиль.
 *
 * Отсутствие строки = "все defaults": `get` возвращает дефолт-профиль,
 * а не null. Так пайплайн/роуты не плодят null-проверки.
 */

export type ProcessingMode = 'extract' | 'classify_only';
export type OutputMode = 'webhook' | 'pull';

/** Raw DB shape. NUMERIC → string|null; webhook_hmac_secret — encrypted envelope. */
export type OrganizationSettingsRow = {
  organization_id: string;
  mode: ProcessingMode;
  output: OutputMode;
  webhook_url: string | null;
  webhook_hmac_secret: string | null; // encrypted envelope (or NULL)
  auto_approve_threshold: string | null; // NUMERIC → string
  created_at: Date;
  updated_at: Date;
};

/**
 * API shape — secret-aware но без самого секрета. `has_webhook_secret`
 * сигналит наличие, не значение. `auto_approve_threshold` как number|null.
 */
export type OrganizationProfile = {
  organization_id: string | null; // null у синтетического дефолт-профиля
  mode: ProcessingMode;
  output: OutputMode;
  webhook_url: string | null;
  has_webhook_secret: boolean;
  auto_approve_threshold: number | null;
  created_at: string | null; // null у дефолт-профиля (строки в БД нет)
  updated_at: string | null;
};

/**
 * Patch для upsert. Поля `undefined` оставляют колонку как есть.
 * webhook_hmac_secret: undefined ⇒ не трогать; null ⇒ очистить;
 * string ⇒ заменить (зашифруется перед записью).
 */
export type OrganizationSettingsPatch = {
  mode?: ProcessingMode;
  output?: OutputMode;
  webhook_url?: string | null;
  webhook_hmac_secret?: string | null;
  auto_approve_threshold?: number | null;
};

/** Дефолт-профиль для орг без строки в БД: extract / pull / без секрета. */
function defaultProfile(orgId: string): OrganizationProfile {
  return {
    organization_id: orgId,
    mode: 'extract',
    output: 'pull',
    webhook_url: null,
    has_webhook_secret: false,
    auto_approve_threshold: null,
    created_at: null,
    updated_at: null,
  };
}

class OrganizationSettingsRepo {
  /** Сырая строка по orgId, или null если её нет. Internal — не отдаёт секрет наружу. */
  private async findRow(orgId: string): Promise<OrganizationSettingsRow | null> {
    const { rows } = await db.query<OrganizationSettingsRow>(
      `SELECT * FROM organization_settings WHERE organization_id = $1`,
      [orgId],
    );
    return rows[0] ?? null;
  }

  /**
   * Профиль организации в API-форме. Если строки нет — возвращает
   * дефолт-профиль (extract/pull/has_webhook_secret=false), а не null.
   * Секрет НИКОГДА не возвращается — только `has_webhook_secret`.
   */
  async get(orgId: string): Promise<OrganizationProfile> {
    const row = await this.findRow(orgId);
    if (!row) return defaultProfile(orgId);
    return this.toApi(row);
  }

  /**
   * Расшифрованный webhook-секрет для Phase 3 (подпись исходящих вебхуков).
   * Держится ОТДЕЛЬНО от публичного `get`, чтобы случайно не утечь в API.
   * Возвращает null если строки нет или секрет не задан.
   */
  async getDecryptedWebhookSecret(orgId: string): Promise<string | null> {
    const row = await this.findRow(orgId);
    if (!row || row.webhook_hmac_secret === null) return null;
    const plain = decryptSecret(row.webhook_hmac_secret);
    return plain === '' ? null : plain;
  }

  /**
   * INSERT ... ON CONFLICT (organization_id) DO UPDATE. Шифрует
   * webhook_hmac_secret через encryptSecret перед записью.
   *
   * Семантика webhook_hmac_secret в patch:
   *   - undefined → не трогать существующий (COALESCE на UPDATE-ветке);
   *   - null      → очистить (NULL в колонку);
   *   - string    → заменить (зашифровать).
   *
   * Возвращает обновлённый профиль (API-форма, секрет замаскирован).
   */
  async upsert(orgId: string, patch: OrganizationSettingsPatch): Promise<OrganizationProfile> {
    // Шифруем секрет до записи. undefined остаётся undefined (sentinel "не трогать").
    const encryptedSecret =
      patch.webhook_hmac_secret === undefined
        ? undefined
        : encryptSecret(patch.webhook_hmac_secret);

    // INSERT-значения: для отсутствующих в patch полей используем дефолты
    // таблицы. На COALESCE($n, existing) UPDATE-ветке undefined = NULL =
    // "оставить как есть".
    const { rows } = await db.query<OrganizationSettingsRow>(
      `INSERT INTO organization_settings (
         organization_id, mode, output, webhook_url, webhook_hmac_secret, auto_approve_threshold, updated_at
       ) VALUES (
         $1,
         COALESCE($2, 'extract'),
         COALESCE($3, 'pull'),
         $4, $5, $6, now()
       )
       ON CONFLICT (organization_id) DO UPDATE SET
         mode = COALESCE($2, organization_settings.mode),
         output = COALESCE($3, organization_settings.output),
         webhook_url = CASE WHEN $7 THEN $4 ELSE organization_settings.webhook_url END,
         webhook_hmac_secret = CASE WHEN $8 THEN $5 ELSE organization_settings.webhook_hmac_secret END,
         auto_approve_threshold = CASE WHEN $9 THEN $6 ELSE organization_settings.auto_approve_threshold END,
         updated_at = now()
       RETURNING *`,
      [
        orgId,
        patch.mode ?? null,
        patch.output ?? null,
        patch.webhook_url ?? null,
        encryptedSecret ?? null,
        patch.auto_approve_threshold ?? null,
        // CASE-гварды: было ли поле в patch'е (отличаем "очистить null" от "не трогать").
        patch.webhook_url !== undefined,
        patch.webhook_hmac_secret !== undefined,
        patch.auto_approve_threshold !== undefined,
      ],
    );
    return this.toApi(rows[0]!);
  }

  /**
   * Map raw row → API shape. Маскирует секрет в `has_webhook_secret`,
   * NUMERIC → number, dates → ISO. Сам секрет НЕ покидает этот слой.
   */
  toApi(row: OrganizationSettingsRow): OrganizationProfile {
    return {
      organization_id: row.organization_id,
      mode: row.mode,
      output: row.output,
      webhook_url: row.webhook_url,
      has_webhook_secret: row.webhook_hmac_secret !== null && row.webhook_hmac_secret !== '',
      auto_approve_threshold:
        row.auto_approve_threshold === null ? null : Number(row.auto_approve_threshold),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    };
  }
}

export const organizationSettingsRepo = new OrganizationSettingsRepo();
