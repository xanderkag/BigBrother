/**
 * audit #4: SSRF-гвард для webhook_url. Раньше webhook_url валидировался только
 * как http(s) — аутентифицированный клиент мог указать внутренний адрес
 * (http://169.254.169.254/ облачная метадата, loopback админ-эндпоинты) и
 * использовать parsdocs как SSRF-релей внутрь сети (статус + до 500 байт тела
 * внутреннего ответа читаемы через webhook_attempts).
 *
 * Политика (в отличие от file_url, где блок ВСЕХ приватных): по умолчанию
 * блокируем ТОЛЬКО никогда-не-легитимные цели — loopback, link-local/метадату,
 * unspecified. RFC1918 (10/172.16/192.168) НЕ блокируем: SLAI и корп-приёмники
 * вебхуков могут быть на внутренней сети asha. Строгий режим (блок всех
 * приватных) — за флагом WEBHOOK_BLOCK_ALL_PRIVATE.
 */
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isPrivateIp } from '../pipeline/ingest/url-fetch.js';

export class WebhookSsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookSsrfError';
  }
}

/**
 * Никогда не легитимная цель вебхука: loopback (127/8, ::1), link-local +
 * облачная метадата (169.254/16, fe80), unspecified (0/8, ::). RFC1918 — НЕ тут
 * (может быть корп-приёмник).
 */
export function isNeverWebhookTarget(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) {
    const p = ip.split('.').map((n) => Number(n));
    const [a, b] = p as [number, number, number, number];
    if (a === 127) return true; // loopback
    if (a === 0) return true; // unspecified/this-host
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    return false;
  }
  if (fam === 6) {
    const ip6 = ip.toLowerCase().split('%')[0]!;
    if (ip6 === '::1' || ip6 === '::') return true;
    if (ip6.startsWith('fe80')) return true; // link-local
    const mapped = ip6.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isNeverWebhookTarget(mapped[1]!);
    return false;
  }
  return false; // не IP — решается по резолву выше
}

export interface WebhookSsrfOptions {
  /** true → блокировать ВСЕ приватные (RFC1918/ULA/CGNAT), не только loopback/metadata. */
  blockAllPrivate: boolean;
  /** Инъекция для тестов. */
  lookupFn?: (host: string, opts: { all: true }) => Promise<Array<{ address: string }>>;
}

/** Заблокирован ли адрес по текущей политике. */
function blocked(ip: string, blockAllPrivate: boolean): boolean {
  if (isNeverWebhookTarget(ip)) return true;
  if (blockAllPrivate && isPrivateIp(ip)) return true;
  return false;
}

/**
 * Проверить, что webhook_url не указывает на внутренний адрес. Бросает
 * WebhookSsrfError. Литеральные IP проверяются напрямую; хосты резолвятся.
 * Нерезолвящийся хост на accept-time НЕ блокируем (best-effort, транзиентный
 * DNS не должен рушить регистрацию вебхука) — основной вектор это literal-IP.
 */
export async function assertWebhookUrlSafe(rawUrl: string, opts: WebhookSsrfOptions): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookSsrfError('malformed webhook_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebhookSsrfError('webhook_url scheme not allowed');
  }
  const host = url.hostname.toLowerCase();
  if (isIP(host) !== 0) {
    if (blocked(host, opts.blockAllPrivate)) {
      throw new WebhookSsrfError('webhook target is a private/internal address');
    }
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await (opts.lookupFn ?? dnsLookup)(host, { all: true });
  } catch {
    return; // не резолвится сейчас — best-effort, не блокируем
  }
  for (const a of addrs) {
    if (blocked(a.address, opts.blockAllPrivate)) {
      throw new WebhookSsrfError('webhook target resolves to a private/internal address');
    }
  }
}
