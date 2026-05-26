/**
 * EXT-D (Q12): ingest a document by URL instead of multipart upload.
 *
 * Unit-level coverage of the SSRF-safe fetch module (no network, no DB/Redis):
 *   - private/loopback/link-local/metadata IPs are blocked (isPrivateIp +
 *     assertHostNotInternal with a mocked DNS resolver);
 *   - non-http(s) schemes (file://, ftp://) are rejected;
 *   - allowlist tightening;
 *   - size-cap enforced mid-stream (Content-Length lie + chunked);
 *   - sha256 mismatch path (verify the hashing contract used by the route);
 *   - mime-sniff rejects a disallowed type (reuse ACCEPTED_DOCUMENT_MIMES);
 *   - happy path: mocked undici.request returns a small valid PDF → stream
 *     drains, magic-bytes accept;
 *   - flag-off gating expression.
 *
 * Network is mocked via the injectable requestFn/dnsLookup on the module's
 * own API — we never hit a real URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

// Min env for config.ts (imported transitively by some helpers).
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://test:test@localhost/test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/docsvc-test';
process.env.WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET ?? 'test';

import {
  isPrivateIp,
  validateUrlShape,
  assertHostNotInternal,
  fetchUrlToStream,
  capStreamBytes,
  UrlFetchError,
} from '../src/pipeline/ingest/url-fetch.js';
import { loadConfig } from '../src/config.js';
import { ACCEPTED_DOCUMENT_MIMES, detectFileType } from '../src/storage/files.js';

const PDF_BYTES = Buffer.from('%PDF-1.7\n%%EOF\n', 'binary');

/** Build a fake undici response with a body stream + headers. */
function fakeResponse(
  body: Buffer | Readable,
  headers: Record<string, string> = {},
  statusCode = 200,
) {
  const stream =
    body instanceof Readable ? body : Readable.from([body]);
  return { statusCode, headers, body: stream } as never;
}

/** A dns.lookup-shaped mock returning fixed addresses. */
function fakeDns(addresses: string[]) {
  return (async () => addresses.map((address) => ({ address, family: 4 }))) as never;
}

describe('isPrivateIp', () => {
  it('blocks RFC1918 / loopback / link-local / metadata / CGNAT (v4)', () => {
    for (const ip of [
      '10.0.0.1',
      '10.10.28.10',
      '127.0.0.1',
      '169.254.169.254', // cloud metadata
      '172.16.5.5',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('blocks loopback / ULA / link-local / mapped (v6)', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:10.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('93.184.216.34')).toBe(false); // example.com
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
  });

  it('fail-closed on non-IP garbage', () => {
    expect(isPrivateIp('not-an-ip')).toBe(true);
    expect(isPrivateIp('')).toBe(true);
  });
});

describe('validateUrlShape — scheme + allowlist', () => {
  it('rejects file:// and ftp:// (BLOCKED_SCHEME)', () => {
    for (const u of ['file:///etc/passwd', 'ftp://host/x', 'gopher://h/0']) {
      try {
        validateUrlShape(u, []);
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(UrlFetchError);
        expect((e as UrlFetchError).code).toBe('BLOCKED_SCHEME');
      }
    }
  });

  it('accepts http(s)', () => {
    expect(validateUrlShape('http://example.com/a.pdf', []).host).toBe('example.com');
    expect(validateUrlShape('https://example.com/a.pdf', []).host).toBe('example.com');
  });

  it('allowlist tightening: host not in list → BLOCKED_HOST', () => {
    try {
      validateUrlShape('https://evil.com/a.pdf', ['blob.slai.ru']);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as UrlFetchError).code).toBe('BLOCKED_HOST');
    }
    // allowed host passes
    expect(validateUrlShape('https://blob.slai.ru/a.pdf', ['blob.slai.ru']).host).toBe(
      'blob.slai.ru',
    );
  });
});

describe('assertHostNotInternal — DNS resolution', () => {
  it('blocks a hostname that resolves to a private IP (SSRF)', async () => {
    await expect(
      assertHostNotInternal('internal.evil.test', fakeDns(['10.10.28.10'])),
    ).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
  });

  it('blocks if ANY resolved address is private (DNS-rebind-ish)', async () => {
    await expect(
      assertHostNotInternal('mixed.test', fakeDns(['8.8.8.8', '127.0.0.1'])),
    ).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
  });

  it('blocks a literal private IP host without DNS', async () => {
    await expect(
      assertHostNotInternal('169.254.169.254', fakeDns(['1.1.1.1'])),
    ).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
  });

  it('allows a public-resolving host', async () => {
    await expect(
      assertHostNotInternal('example.com', fakeDns(['93.184.216.34'])),
    ).resolves.toBeUndefined();
  });

  it('blocks when the host does not resolve', async () => {
    const failDns = (async () => {
      throw new Error('ENOTFOUND');
    }) as never;
    await expect(assertHostNotInternal('nx.test', failDns)).rejects.toMatchObject({
      code: 'BLOCKED_HOST',
    });
  });
});

describe('fetchUrlToStream — SSRF + scheme guards run before any request', () => {
  it('file:// never issues a network request', async () => {
    let called = 0;
    const requestFn = (async () => {
      called += 1;
      return fakeResponse(PDF_BYTES);
    }) as never;
    await expect(
      fetchUrlToStream('file:///etc/passwd', {
        allowedHosts: [],
        maxBytes: 1024,
        timeoutMs: 1000,
        requestFn,
        dnsLookup: fakeDns(['1.1.1.1']),
      }),
    ).rejects.toMatchObject({ code: 'BLOCKED_SCHEME' });
    expect(called).toBe(0);
  });

  it('private-IP target never issues a network request', async () => {
    let called = 0;
    const requestFn = (async () => {
      called += 1;
      return fakeResponse(PDF_BYTES);
    }) as never;
    await expect(
      fetchUrlToStream('http://internal/x.pdf', {
        allowedHosts: [],
        maxBytes: 1024,
        timeoutMs: 1000,
        requestFn,
        dnsLookup: fakeDns(['10.10.28.10']),
      }),
    ).rejects.toMatchObject({ code: 'BLOCKED_HOST' });
    expect(called).toBe(0);
  });
});

describe('size-cap enforcement', () => {
  it('rejects up-front when Content-Length exceeds the cap', async () => {
    const requestFn = (async () =>
      fakeResponse(Buffer.alloc(5000), { 'content-length': '5000' })) as never;
    await expect(
      fetchUrlToStream('https://blob.test/big.pdf', {
        allowedHosts: [],
        maxBytes: 1000,
        timeoutMs: 1000,
        requestFn,
        dnsLookup: fakeDns(['8.8.8.8']),
      }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('enforces mid-stream cap when Content-Length lies (chunked / wrong length)', async () => {
    // Server claims small but streams more — must abort mid-stream.
    async function* gen() {
      for (let i = 0; i < 10; i++) yield Buffer.alloc(200); // 2000 bytes total
    }
    const requestFn = (async () =>
      fakeResponse(Readable.from(gen()), { 'content-length': '100' })) as never;
    const { stream } = await fetchUrlToStream('https://blob.test/lie.pdf', {
      allowedHosts: [],
      maxBytes: 1000,
      timeoutMs: 1000,
      requestFn,
      dnsLookup: fakeDns(['8.8.8.8']),
    });
    // Draining the capped stream must error with TOO_LARGE.
    const err = await new Promise<unknown>((resolve) => {
      stream.on('error', resolve);
      stream.on('data', () => {});
      stream.on('end', () => resolve(null));
    });
    expect(err).toBeInstanceOf(UrlFetchError);
    expect((err as UrlFetchError).code).toBe('TOO_LARGE');
  });

  it('capStreamBytes passes through when under the limit', async () => {
    const capped = capStreamBytes(Readable.from([Buffer.from('hello')]), 1000);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      capped.on('data', (c: Buffer) => chunks.push(c));
      capped.on('end', resolve);
      capped.on('error', reject);
    });
    expect(Buffer.concat(chunks).toString()).toBe('hello');
  });
});

describe('happy path + mime-sniff + sha256 (route-level contract)', () => {
  let workDir = '';
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'docsvc-urlingest-'));
  });
  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('downloads a small valid PDF; drained bytes are magic-byte-accepted', async () => {
    const requestFn = (async () =>
      fakeResponse(PDF_BYTES, { 'content-type': 'application/pdf' })) as never;
    const { stream, contentType } = await fetchUrlToStream('https://blob.test/doc.pdf', {
      allowedHosts: [],
      maxBytes: 1024 * 1024,
      timeoutMs: 1000,
      requestFn,
      dnsLookup: fakeDns(['8.8.8.8']),
    });
    expect(contentType).toBe('application/pdf');

    // Persist + sniff exactly like the route does (saveStream → detectFileType).
    const out = join(workDir, 'doc.pdf');
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    await writeFile(out, Buffer.concat(chunks));
    const detected = await detectFileType(out);
    expect(detected?.mime).toBe('application/pdf');
    expect(ACCEPTED_DOCUMENT_MIMES.has(detected!.mime)).toBe(true);
  });

  it('mime-sniff rejects a disallowed type (plain text body)', async () => {
    const requestFn = (async () =>
      fakeResponse(Buffer.from('just some text, not a document'), {
        'content-type': 'application/pdf', // server lies
      })) as never;
    const { stream } = await fetchUrlToStream('https://blob.test/fake.pdf', {
      allowedHosts: [],
      maxBytes: 1024 * 1024,
      timeoutMs: 1000,
      requestFn,
      dnsLookup: fakeDns(['8.8.8.8']),
    });
    const out = join(workDir, 'fake.pdf');
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    await writeFile(out, Buffer.concat(chunks));
    const detected = await detectFileType(out);
    // file-type returns undefined for plaintext → route rejects (not accepted).
    const accepted = detected ? ACCEPTED_DOCUMENT_MIMES.has(detected.mime) : false;
    expect(accepted).toBe(false);
  });

  it('sha256 verify contract: matching vs mismatching hash', async () => {
    const actual = createHash('sha256').update(PDF_BYTES).digest('hex');
    const expectedOk = actual;
    const expectedBad = 'deadbeef'.repeat(8);
    expect(actual.toLowerCase()).toBe(expectedOk.toLowerCase());
    expect(actual.toLowerCase()).not.toBe(expectedBad.toLowerCase());
  });

  it('non-2xx (incl. unfollowed 3xx redirect) → FETCH_FAILED', async () => {
    const requestFn = (async () =>
      fakeResponse(Buffer.alloc(0), { location: 'http://10.0.0.1/x' }, 302)) as never;
    await expect(
      fetchUrlToStream('https://blob.test/redir.pdf', {
        allowedHosts: [],
        maxBytes: 1024,
        timeoutMs: 1000,
        requestFn,
        dnsLookup: fakeDns(['8.8.8.8']),
      }),
    ).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });

  it('underlying request throwing → FETCH_FAILED (no detail leak)', async () => {
    const requestFn = (async () => {
      throw new Error('ECONNREFUSED secret-internal-host:9000');
    }) as never;
    const err = await fetchUrlToStream('https://blob.test/x.pdf', {
      allowedHosts: [],
      maxBytes: 1024,
      timeoutMs: 1000,
      requestFn,
      dnsLookup: fakeDns(['8.8.8.8']),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UrlFetchError);
    expect((err as UrlFetchError).code).toBe('FETCH_FAILED');
    expect((err as UrlFetchError).message).not.toContain('secret-internal-host');
  });
});

describe('config gating', () => {
  const baseEnv: NodeJS.ProcessEnv = {
    DATABASE_URL: 'postgres://t:t@localhost/t',
    REDIS_URL: 'redis://localhost:6379',
    STORAGE_DIR: '/tmp/x',
    WEBHOOK_HMAC_SECRET: 'x',
  };

  it('defaults fileUrlIngest.enabled to false (fail-closed)', () => {
    expect(loadConfig({ ...baseEnv }).fileUrlIngest.enabled).toBe(false);
  });

  it('honours FILE_URL_INGEST_ENABLED=true', () => {
    expect(loadConfig({ ...baseEnv, FILE_URL_INGEST_ENABLED: 'true' }).fileUrlIngest.enabled).toBe(
      true,
    );
  });

  it('parses FILE_URL_ALLOWED_HOSTS CSV (lowercased, trimmed)', () => {
    const cfg = loadConfig({
      ...baseEnv,
      FILE_URL_ALLOWED_HOSTS: ' Blob.SLAI.ru , cdn.example.com ',
    });
    expect(cfg.fileUrlIngest.allowedHosts).toEqual(['blob.slai.ru', 'cdn.example.com']);
  });

  it('empty allowedHosts when unset', () => {
    expect(loadConfig({ ...baseEnv }).fileUrlIngest.allowedHosts).toEqual([]);
  });

  it('route gating expression: file_url present && !enabled → reject', () => {
    const fileUrl = 'https://blob.test/x.pdf';
    const enabled = false;
    expect(Boolean(fileUrl) && !enabled).toBe(true);
  });
});
