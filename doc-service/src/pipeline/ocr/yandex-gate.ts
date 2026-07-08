/**
 * Рубильник и счётчик облачного OCR (коннектор `yandex_vision`).
 *
 * Делает две вещи, обе — про внешний платный сервис, куда уходят ИЗОБРАЖЕНИЯ
 * документов клиента:
 *   1. `isYandexVisionAllowed()` — можно ли сейчас слать страницы в Яндекс
 *      (тумблер в «Интеграциях» + суточный лимит);
 *   2. `recordYandexVisionPages()` — учёт реально отправленных страниц.
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
import { checkConsumerQuota } from '../../storage/gateway-connectors.js';
import { llmGatewayUsageRepo } from '../../storage/llm-usage.js';

/** gateway_connectors.slug облачного OCR. */
export const YANDEX_VISION_CONNECTOR = 'yandex_vision';

/**
 * `caller` для внутреннего (не-gateway) расхода. Строки usage пишутся от имени
 * самой платформы: у OCR нет внешнего клиента с named key.
 */
export const INTERNAL_CONSUMER = 'parsdocs';

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
