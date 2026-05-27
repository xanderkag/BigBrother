import { lookup } from 'node:dns/promises';
import { lookup as lookupCb, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { Agent, request } from 'undici';

/**
 * EXT-D (Q12): server-side fetch of a consumer-supplied document URL.
 *
 * Downloading an arbitrary user-supplied URL server-side is an SSRF vector:
 * a consumer (SLAI) could otherwise make parsdocs fetch internal services
 * (`http://10.10.28.10`, cloud metadata at 169.254.169.254, localhost admin
 * panels, …). Defences here, all fail-closed:
 *
 *   - схема только http(s) (file://, ftp://, gopher://, data: — reject);
 *   - host резолвится в IP и блокируется если private/loopback/link-local/
 *     metadata/ULA (RFC1918, 127.x, 169.254.x, ::1, fc00::/7, …);
 *   - опциональный allowlist хостов (для ужесточения);
 *   - redirects запрещены (maxRedirections=0) — иначе публичный 302 → internal;
 *   - connect-time re-validation: соединение идёт через одноразовый undici
 *     Agent, чей connect.lookup ПОВТОРНО прогоняет каждый резолвнутый адрес
 *     через isPrivateIp. Это закрывает DNS-rebind/TOCTOU-окно: даже если
 *     резолвер вернул публичный IP на pre-check, а на connect — приватный
 *     (атакующий контролирует DNS с TTL=0), connect отобьётся;
 *   - download time + byte-ceiling enforced mid-stream (Content-Length не
 *     доверяем: сервер может соврать или вообще его не прислать).
 *
 * Ошибки не утекают наружу деталями: вызывающий route маппит UrlFetchError.code
 * в стабильный API error_code, message в ответ клиента НЕ кладём.
 */

export type UrlFetchErrorCode =
  | 'BLOCKED_SCHEME'
  | 'BLOCKED_HOST'
  | 'TOO_LARGE'
  | 'FETCH_FAILED';

export class UrlFetchError extends Error {
  constructor(
    readonly code: UrlFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UrlFetchError';
  }
}

/**
 * Является ли строковый IP (v4 или v6) приватным / internal / non-routable.
 * Покрывает SSRF-релевантные диапазоны. Возвращает true → блокируем.
 */
export function isPrivateIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isPrivateIpv4(ip);
  if (fam === 6) return isPrivateIpv6(ip);
  // Не распознан как IP — считаем небезопасным (fail-closed).
  return true;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240/4 reserved
  return false;
}

function isPrivateIpv6(ipRaw: string): boolean {
  let ip = ipRaw.toLowerCase();
  // Zone id (fe80::1%eth0) — отрезаем перед классификацией.
  const pct = ip.indexOf('%');
  if (pct >= 0) ip = ip.slice(0, pct);
  if (ip === '::1' || ip === '::') return true; // loopback / unspecified
  // IPv4-mapped (::ffff:10.0.0.1) — классифицируем по встроенному v4.
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  if (ip.startsWith('fe80')) return true; // link-local
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 ULA
  if (ip.startsWith('ff')) return true; // ff00::/8 multicast
  return false;
}

export type ParsedTarget = { url: URL; host: string };

/**
 * Валидация схемы + (опционально) allowlist хоста. НЕ резолвит DNS —
 * это синхронная часть, отделённая для unit-теста. Бросает UrlFetchError.
 */
export function validateUrlShape(raw: string, allowedHosts: readonly string[]): ParsedTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlFetchError('FETCH_FAILED', 'malformed url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlFetchError('BLOCKED_SCHEME', `scheme ${url.protocol} not allowed`);
  }
  const host = url.hostname.toLowerCase();
  if (host.length === 0) {
    throw new UrlFetchError('BLOCKED_HOST', 'empty host');
  }
  if (allowedHosts.length > 0 && !allowedHosts.includes(host)) {
    throw new UrlFetchError('BLOCKED_HOST', 'host not in allowlist');
  }
  return { url, host };
}

/**
 * Резолвит host → IP(ы) и блокирует если ХОТЬ ОДИН резолвится в private/
 * internal. Если host — литеральный IP, проверяем напрямую (DNS не нужен).
 * Все адреса должны быть публичными — иначе SSRF через multi-A-record.
 * Это pre-check; connect-time re-validation (pinnedLookup ниже) закрывает
 * DNS-rebind-окно между этим резолвом и фактическим соединением.
 */
export async function assertHostNotInternal(
  host: string,
  dnsLookup: typeof lookup = lookup,
): Promise<void> {
  if (isIP(host) !== 0) {
    if (isPrivateIp(host)) {
      throw new UrlFetchError('BLOCKED_HOST', 'target resolves to a private/internal address');
    }
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch {
    throw new UrlFetchError('BLOCKED_HOST', 'host did not resolve');
  }
  if (addrs.length === 0) {
    throw new UrlFetchError('BLOCKED_HOST', 'host did not resolve');
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new UrlFetchError('BLOCKED_HOST', 'target resolves to a private/internal address');
    }
  }
}

export type FetchUrlOptions = {
  allowedHosts: readonly string[];
  maxBytes: number;
  timeoutMs: number;
  /** Инъекция для тестов (мок undici.request / dns.lookup). */
  requestFn?: typeof request;
  dnsLookup?: typeof lookup;
};

export type FetchedFile = {
  stream: Readable;
  contentType: string | undefined;
};

/**
 * Скачивает URL в безопасном режиме и возвращает Readable + объявленный
 * Content-Type. Поток оборачивает hard byte-ceiling: при превышении
 * maxBytes стрим эмитит ошибку (route ловит и удаляет частичный файл).
 *
 * Сам storage.saveStream дописывает байты на диск; мы НЕ буферизуем весь
 * файл в память (важно для больших freight-доков).
 */
export async function fetchUrlToStream(
  raw: string,
  opts: FetchUrlOptions,
): Promise<FetchedFile> {
  const requestFn = opts.requestFn ?? request;
  const dnsLookup = opts.dnsLookup ?? lookup;

  const { url, host } = validateUrlShape(raw, opts.allowedHosts);
  await assertHostNotInternal(host, dnsLookup);

  // DNS-rebind/TOCTOU защита: even though we just validated `host`, undici
  // would re-resolve it at connect time — an attacker controlling DNS (TTL=0)
  // could return a public IP for the pre-check and a private IP for connect.
  // We pin a one-shot Agent whose connect.lookup re-runs isPrivateIp on EVERY
  // address the resolver hands back, fail-closed. Only attached to the real
  // undici path; an injected requestFn (tests) supplies its own transport.
  const dispatcher = opts.requestFn ? undefined : buildPinnedAgent(opts.timeoutMs);

  let res: Awaited<ReturnType<typeof request>>;
  try {
    // undici.request НЕ следует редиректам по умолчанию (нет RedirectHandler
    // в дефолтном dispatcher) — 3xx возвращается как есть и отбивается ниже
    // по statusCode. Это и нужно: follow 302 → internal был бы SSRF-обходом.
    res = await requestFn(url, {
      method: 'GET',
      headersTimeout: opts.timeoutMs,
      bodyTimeout: opts.timeoutMs,
      ...(dispatcher ? { dispatcher } : {}),
    });
  } catch (err) {
    // A pinned-lookup rejection (rebind → private IP at connect) surfaces as
    // a connect error; map to BLOCKED_HOST so it's not confused with a plain
    // network failure, but never echo the underlying message.
    if (err instanceof UrlFetchError) throw err;
    if (isPinnedLookupRejection(err)) {
      throw new UrlFetchError('BLOCKED_HOST', 'target resolves to a private/internal address');
    }
    throw new UrlFetchError('FETCH_FAILED', 'fetch failed');
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    // Drain so the socket can be reused / closed cleanly.
    res.body.resume();
    // 3xx без follow попадает сюда тоже — мы redirects не следуем.
    throw new UrlFetchError('FETCH_FAILED', `upstream status ${res.statusCode}`);
  }

  const headers = res.headers as Record<string, string | string[] | undefined>;
  const contentType = singleHeader(headers['content-type']);

  // Content-Length, если есть и валиден — ранний reject ДО стрима.
  const declaredLen = Number(singleHeader(headers['content-length']));
  if (Number.isFinite(declaredLen) && declaredLen > opts.maxBytes) {
    res.body.resume();
    throw new UrlFetchError('TOO_LARGE', 'content-length exceeds limit');
  }

  // Hard byte-ceiling enforced mid-stream — не верим Content-Length.
  const capped = capStreamBytes(res.body, opts.maxBytes);
  return { stream: capped, contentType };
}

function singleHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/** Sentinel-сообщение, которым pinnedLookup помечает свой reject. */
const PINNED_LOOKUP_REJECT = 'url-fetch: connect-time address is private/internal';

function isPinnedLookupRejection(err: unknown): boolean {
  // undici оборачивает connect-ошибку; ищем наш sentinel в цепочке cause.
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof Error) {
      if (cur.message === PINNED_LOOKUP_REJECT) return true;
      cur = (cur as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}

/**
 * Одноразовый undici Agent, чей connect.lookup ПОВТОРНО валидирует каждый
 * резолвнутый адрес через isPrivateIp перед тем как undici к нему подключится.
 * Это и есть pin-to-validated-IP: connect использует тот же резолв, что мы
 * проверили, и любой rebind на приватный адрес отбивается здесь (fail-closed).
 */
function buildPinnedAgent(timeoutMs: number): Agent {
  return new Agent({
    connectTimeout: timeoutMs,
    connect: {
      lookup(
        hostname: string,
        options: LookupOptions,
        callback: (
          err: NodeJS.ErrnoException | null,
          address: string | LookupAddress[],
          family?: number,
        ) => void,
      ): void {
        // Литеральный IP — провалидировать напрямую, без резолва.
        const litFam = isIP(hostname);
        if (litFam !== 0) {
          if (isPrivateIp(hostname)) {
            callback(new Error(PINNED_LOOKUP_REJECT), '');
            return;
          }
          callback(null, hostname, litFam);
          return;
        }
        lookupCb(hostname, { ...options, all: true }, (err, addresses) => {
          if (err) {
            callback(err, '');
            return;
          }
          const list = addresses as LookupAddress[];
          if (!Array.isArray(list) || list.length === 0) {
            callback(new Error(PINNED_LOOKUP_REJECT), '');
            return;
          }
          for (const a of list) {
            if (isPrivateIp(a.address)) {
              callback(new Error(PINNED_LOOKUP_REJECT), '');
              return;
            }
          }
          callback(null, list);
        });
      },
    },
  });
}

/**
 * Оборачивает source Readable: считает прошедшие байты и destroy'ит поток
 * с UrlFetchError('TOO_LARGE') как только суммарно превышен лимит. Это
 * ловит враньё в Content-Length и chunked-ответы без длины.
 */
export function capStreamBytes(source: Readable, maxBytes: number): Readable {
  let seen = 0;
  const out = new Readable({ read() {} });
  source.on('data', (chunk: Buffer) => {
    seen += chunk.length;
    if (seen > maxBytes) {
      source.destroy();
      out.destroy(new UrlFetchError('TOO_LARGE', 'streamed bytes exceed limit'));
      return;
    }
    out.push(chunk);
  });
  source.on('end', () => out.push(null));
  source.on('error', (err) => out.destroy(err));
  return out;
}
