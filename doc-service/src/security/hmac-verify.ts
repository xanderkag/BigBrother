/**
 * HMAC SHA-256 verify для inbound webhook'ов.
 *
 * F13 (SLAI ТЗ): SLAI шлёт нам category sync events с header
 * `X-SLAI-Signature: sha256=<hex>`. Мы должны проверить что body
 * подписан нашим shared secret `SLAI_TO_PARSDOCS_HMAC_SECRET`.
 *
 * **КРИТИЧНО — используем `crypto.timingSafeEqual`**:
 * Обычное `===` или `Buffer.compare` уязвимы к timing attack
 * (можно посимвольно подобрать HMAC через измерение времени
 * неудачных попыток). SLAI у себя так и сделали (см. их commit
 * `parsdocs-integration.service.ts:50`) — повторяем best practice.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Парсит header вида `sha256=<hex>` и сравнивает с computed HMAC от body.
 *
 * @param body - точное raw body запроса (важно: без пересериализации!)
 * @param header - значение `X-SLAI-Signature` либо `X-DocService-Signature`
 * @param secret - shared HMAC secret
 * @returns true если подпись валидна
 */
export function verifyHmacSignature(
  body: Buffer | string,
  header: string | undefined | null,
  secret: string,
): boolean {
  if (!header || !secret) return false;

  // Header формат: `sha256=<hex>` или просто `<hex>` (legacy). Поддерживаем оба.
  const expectedHex = header.startsWith('sha256=')
    ? header.slice('sha256='.length)
    : header;

  if (!expectedHex || !/^[0-9a-f]+$/i.test(expectedHex)) return false;

  // Вычисляем фактическую подпись на нашей стороне
  const bodyBuf = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body;
  const computedHex = createHmac('sha256', secret).update(bodyBuf).digest('hex');

  // Длины должны совпадать (иначе timingSafeEqual бросает RangeError).
  // sha256 → 32 bytes → 64 hex chars. Если ≠ — точно невалидно.
  if (expectedHex.length !== computedHex.length) return false;

  // Constant-time compare
  try {
    return timingSafeEqual(
      Buffer.from(expectedHex.toLowerCase(), 'hex'),
      Buffer.from(computedHex, 'hex'),
    );
  } catch {
    // Невалидный hex / etc — false без подсветки причины
    return false;
  }
}

/**
 * Высокоуровневая обёртка: проверяет header и возвращает либо null
 * (всё ок), либо строку с причиной отказа (для лога и response body).
 *
 * Использовать в Fastify hook'е:
 * ```
 * const err = verifySlaiSignature(req.rawBody, req.headers, env.SLAI_HMAC_SECRET);
 * if (err) { reply.code(401); return { error: err }; }
 * ```
 */
export function verifySlaiSignature(
  body: Buffer | string | undefined,
  headers: Record<string, string | string[] | undefined>,
  secret: string | undefined,
): string | null {
  if (!secret) {
    // Если у нас не настроен секрет — отказываем (fail-closed).
    // На staging без секрета endpoint просто не работает.
    return 'SLAI_TO_PARSDOCS_HMAC_SECRET not configured on server';
  }
  if (body === undefined) return 'request body missing';

  const sigHeader = headers['x-slai-signature'] ?? headers['X-SLAI-Signature'];
  const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
  if (!sig) return 'X-SLAI-Signature header missing';

  const versionHeader = headers['x-slai-version'] ?? headers['X-SLAI-Version'];
  const version = Array.isArray(versionHeader) ? versionHeader[0] : versionHeader;
  if (!version) return 'X-SLAI-Version header missing';
  if (version !== 'v1') return `unsupported SLAI version: ${version} (we support v1)`;

  if (!verifyHmacSignature(body, sig, secret)) {
    return 'HMAC signature mismatch';
  }
  return null;
}
