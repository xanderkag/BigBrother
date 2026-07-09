/**
 * Рубильник и счётчик облачного OCR (коннектор `yandex_vision`).
 *
 * Делает три вещи, все — про внешний платный сервис, куда уходят ИЗОБРАЖЕНИЯ
 * документов клиента:
 *   1. `isYandexVisionAllowed()` — можно ли сейчас слать страницы в Яндекс
 *      (тумблер в «Интеграциях» + суточный лимит);
 *   2. `recordYandexVisionPages()` — учёт реально отправленных страниц;
 *   3. `resolveYandexVisionCredentials()` — откуда взять ключ+folder (провайдер в UI → env).
 *
 * ── Границы ответственности (не перепутать) ────────────────────────────
 * Этот гейт — операционный/costовый контроль. Гарантия по персональным данным
 * (ТТН/CMR) остаётся за `YANDEX_DISABLE_FOR_PII` (env) и per-job
 * `_disable_external_ocr`. Они не зависят от БД. Все фильтры каскада
 * соединены через AND (см. `selectOcrChain`), поэтому этот гейт может ТОЛЬКО
 * убрать Яндекс из цепочки — никогда не добавить его обратно.
 *
 * ── Fail-closed ────────────────────────────────────────────────────────
 * При ЛЮБОЙ неопределённости мы НЕ отправляем документы третьей стороне:
 *   - строки коннектора нет (миграция не применена) → запрещено;
 *   - БД недоступна / запрос упал                   → запрещено.
 * Деградация безопасна: каскад просто уходит на локальный tesseract.
 * Это осознанное отличие от `checkConsumerQuota`, который для неизвестного
 * коннектора отвечает fail-open (там речь про биллинг, а не про egress ПДн).
 *
 * Кэша нет намеренно: один запрос на джобу — пренебрежимо мало на фоне OCR,
 * зато тумблер срабатывает мгновенно, как и обещает интерфейс.
 */
import type { Logger } from 'pino';
import { config } from '../../config.js';
import { checkConsumerQuota } from '../../storage/gateway-connectors.js';
import { llmGatewayUsageRepo } from '../../storage/llm-usage.js';
import { providerSettingsRepo } from '../../storage/provider-settings.js';

/** gateway_connectors.slug облачного OCR. */
export const YANDEX_VISION_CONNECTOR = 'yandex_vision';

/**
 * provider_settings.id строки-носителя ключа Yandex Vision (kind='ocr').
 * Сидируется миграцией 20260513000004; редактируется в «Провайдерах».
 */
export const YANDEX_VISION_PROVIDER_ID = 'yandex-vision';

/**
 * `caller` для внутреннего (не-gateway) расхода. Строки usage пишутся от имени
 * самой платформы: у OCR нет внешнего клиента с named key.
 */
export const INTERNAL_CONSUMER = 'parsdocs';

/** Ключ + folder Yandex Vision, откуда бы они ни резолвились. */
export type YandexVisionCredentials = { apiKey?: string; folderId?: string };

/** Строковое значение `extra.folder_id`, если задано непустым. */
function folderIdFromExtra(extra: Record<string, unknown> | null): string | undefined {
  const v = extra?.folder_id;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Учётные данные Yandex Vision: сначала строка provider_settings
 * ('yandex-vision', редактируется в «Провайдерах», `api_key` шифруется at rest),
 * затем env (`YANDEX_VISION_API_KEY` / `YANDEX_FOLDER_ID`). Так секрет вводится
 * через интерфейс, а не правкой .env — без рестарта и без plaintext в конфиге.
 *
 * Значения из БД берутся ТОЛЬКО когда строка активна (`is_active`): тумблер
 * провайдера должен что-то значить. Откат — ПО КАЖДОМУ полю отдельно: активная
 * строка с пустым `api_key` (или без `extra.folder_id`) берёт это поле из env,
 * а не «выключает Yandex» — env есть осознанная конфигурация админа, пустое
 * поле в UI обычно значит «просто не заполнял здесь».
 *
 * ── Граница с egress-гейтом ─────────────────────────────────────────────
 * Это выбор ИСТОЧНИКА учётных данных, а НЕ разрешение слать документы наружу.
 * Поэтому при сбое БД откатываемся на env (fail-open по ключу). Разрешение
 * egress (рубильник/суточный лимит/PII) — отдельно и fail-closed
 * (`isYandexVisionAllowed`). Оба гейта соединяются через AND в оркестраторе:
 * наличие ключа само по себе ничего наружу не отправляет.
 */
export async function resolveYandexVisionCredentials(
  // Только `warn` — сужаем, чтобы принять и pino Logger (воркер), и
  // FastifyBaseLogger (роут /settings) без каста.
  log: Pick<Logger, 'warn'>,
): Promise<YandexVisionCredentials> {
  try {
    const row = await providerSettingsRepo.findById(YANDEX_VISION_PROVIDER_ID);
    if (row?.is_active) {
      return {
        apiKey: row.api_key?.trim() || config.yandex.apiKey,
        folderId: folderIdFromExtra(row.extra) || config.yandex.folderId,
      };
    }
  } catch (err) {
    log.warn(
      { err, id: YANDEX_VISION_PROVIDER_ID },
      'yandex vision credentials lookup failed — falling back to env',
    );
  }
  return { apiKey: config.yandex.apiKey, folderId: config.yandex.folderId };
}

/**
 * Разрешён ли сейчас облачный OCR: тумблер коннектора включён И суточный лимит
 * не исчерпан. Fail-closed (см. шапку).
 *
 * ⚠ Лимит МЯГКИЙ: проверка одна на джобу, без резервирования, а расход
 * списывается после прогона документа. Перерасход ограничен примерно
 * (страниц в документе × параллельных воркеров). Тумблер (`connector_disabled`)
 * при этом срабатывает жёстко — он не зависит от накопленного расхода.
 */
export async function isYandexVisionAllowed(log: Logger): Promise<boolean> {
  try {
    const quota = await checkConsumerQuota(INTERNAL_CONSUMER, YANDEX_VISION_CONNECTOR);

    // checkConsumerQuota для неизвестного коннектора отвечает fail-open
    // (allowed:true). Для egress документов наружу это неприемлемо: отсутствие
    // строки значит «миграция не применена», а не «лимитов нет».
    if (quota.reason === 'unknown_connector') {
      log.warn(
        { connector: YANDEX_VISION_CONNECTOR },
        'yandex_vision connector row missing — cloud OCR disabled (fail-closed)',
      );
      return false;
    }

    if (!quota.allowed) {
      log.info(
        { connector: YANDEX_VISION_CONNECTOR, reason: quota.reason, used: quota.used },
        'cloud OCR skipped: connector disabled or daily cap reached',
      );
    }
    return quota.allowed;
  } catch (err) {
    log.warn(
      { err, connector: YANDEX_VISION_CONNECTOR },
      'yandex_vision gate check failed — cloud OCR disabled (fail-closed)',
    );
    return false;
  }
}

/**
 * Сколько страниц уже улетело в Яндекс к моменту падения движка.
 *
 * `YandexVisionEngine.processPages` шлёт по одному POST на страницу и, упав на
 * N-й, вешает на ошибку `pagesSent = N-1`. Эти страницы распознаны и оплачены —
 * их обязан списать счётчик, иначе суточный лимит не сдвинется, а ретрай
 * отправит и оплатит их повторно. Возвращает 0, если поля нет.
 */
export function pagesSentFrom(err: unknown): number {
  if (typeof err !== 'object' || err === null) return 0;
  const n = (err as { pagesSent?: unknown }).pagesSent;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Учесть страницы, реально отправленные в Яндекс. Никогда не роняет джобу:
 * потеря строки учёта хуже, чем потеря документа, но не настолько.
 */
export async function recordYandexVisionPages(
  input: { pages: number; latencyMs: number; model: string },
  log: Logger,
): Promise<void> {
  if (input.pages <= 0) return;
  try {
    await llmGatewayUsageRepo.record({
      caller: INTERNAL_CONSUMER,
      alias: YANDEX_VISION_CONNECTOR,
      model: input.model,
      latencyMs: input.latencyMs,
      status: 'success',
      connector: YANDEX_VISION_CONNECTOR,
      units: input.pages,
      unitKind: 'pages',
    });
  } catch (err) {
    log.warn({ err }, 'failed to record yandex_vision usage (job unaffected)');
  }
}
