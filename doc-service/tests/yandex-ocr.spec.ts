import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from 'undici';
import { YandexVisionEngine } from '../src/pipeline/ocr/yandex.js';

vi.mock('undici', () => ({
  request: vi.fn(),
}));

const requestMock = vi.mocked(request);

type MockReply = { statusCode: number; json?: unknown; text?: string };

function reply({ statusCode, json, text }: MockReply) {
  return {
    statusCode,
    body: {
      json: async () => json,
      text: async () => text ?? '',
    },
  } as unknown as Awaited<ReturnType<typeof request>>;
}

const OK_RESPONSE = {
  result: {
    textAnnotation: {
      fullText: 'ИНН 7707083893\nИтого 1200.00',
      blocks: [
        {
          lines: [
            { text: 'ИНН 7707083893', words: [{ text: 'ИНН', confidence: 0.9 }, { text: '7707083893', confidence: 0.8 }] },
          ],
        },
      ],
    },
    page: '1',
  },
};

let workDir: string;

beforeEach(async () => {
  requestMock.mockReset();
  workDir = await mkdtemp(join(tmpdir(), 'yandex-spec-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function makePng(name: string): Promise<string> {
  const p = join(workDir, name);
  await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return p;
}

const engine = () =>
  new YandexVisionEngine({ apiKey: 'key-123', folderId: 'folder-xyz', timeoutMs: 30000, model: 'page' });

describe('YandexVisionEngine — recognizeText contract', () => {
  it('single image: hits endpoint with correct headers and flat body', async () => {
    requestMock.mockResolvedValue(reply({ statusCode: 200, json: OK_RESPONSE }));
    const filePath = await makePng('img.png');

    const res = await engine().run({ filePath, mimeType: 'image/png' });

    expect(requestMock).toHaveBeenCalledTimes(1);
    const [url, opts] = requestMock.mock.calls[0]!;
    expect(url).toBe('https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText');
    expect(opts!.method).toBe('POST');
    const headers = opts!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Api-Key key-123');
    expect(headers['x-folder-id']).toBe('folder-xyz');
    expect(headers['x-data-logging-enabled']).toBe('false');
    expect(headers['content-type']).toBe('application/json');

    const body = JSON.parse(opts!.body as string);
    expect(body.mimeType).toBe('image/png');
    expect(body.model).toBe('page');
    expect(body.languageCodes).toEqual(['ru', 'en']);
    expect(typeof body.content).toBe('string');

    expect(res.engine).toBe('yandex');
    expect(res.text).toBe('ИНН 7707083893\nИтого 1200.00');
  });

  it('uses fullText and averages word confidence', async () => {
    requestMock.mockResolvedValue(reply({ statusCode: 200, json: OK_RESPONSE }));
    const filePath = await makePng('img.png');

    const res = await engine().run({ filePath, mimeType: 'image/png' });

    expect(res.text).toBe('ИНН 7707083893\nИтого 1200.00');
    expect(res.confidence).toBeCloseTo((0.9 + 0.8) / 2, 5);
  });

  it('falls back to blocks/lines walk when fullText is absent', async () => {
    requestMock.mockResolvedValue(
      reply({
        statusCode: 200,
        json: {
          result: {
            textAnnotation: {
              blocks: [
                { lines: [{ text: 'Строка 1' }, { words: [{ text: 'Строка' }, { text: '2' }] }] },
              ],
            },
          },
        },
      }),
    );
    const filePath = await makePng('img.png');

    const res = await engine().run({ filePath, mimeType: 'image/png' });

    expect(res.text).toBe('Строка 1\nСтрока 2');
    expect(res.confidence).toBe(0.7); // no word confidence → default
  });

  it('multi-page via rasterizedPages: one call per page, joined text, pages[]', async () => {
    requestMock
      .mockResolvedValueOnce(
        reply({ statusCode: 200, json: { result: { textAnnotation: { fullText: 'PAGE ONE' } } } }),
      )
      .mockResolvedValueOnce(
        reply({ statusCode: 200, json: { result: { textAnnotation: { fullText: 'PAGE TWO' } } } }),
      );

    const p1 = await makePng('page-1.png');
    const p2 = await makePng('page-2.png');

    const res = await engine().run({
      filePath: 'unused.pdf',
      mimeType: 'application/pdf',
      rasterizedPages: [p1, p2],
    });

    expect(requestMock).toHaveBeenCalledTimes(2);
    // both calls were image/png
    for (const call of requestMock.mock.calls) {
      const body = JSON.parse(call[1]!.body as string);
      expect(body.mimeType).toBe('image/png');
    }
    expect(res.text).toBe('PAGE ONE\n\nPAGE TWO');
    expect(res.pages).toHaveLength(2);
    expect(res.pages![0]!.text).toBe('PAGE ONE');
    expect(res.pages![1]!.text).toBe('PAGE TWO');
  });

  it('HTTP 400 throws with status and body snippet', async () => {
    requestMock.mockResolvedValue(
      reply({ statusCode: 400, text: 'invalid folder id' }),
    );
    const filePath = await makePng('img.png');

    await expect(engine().run({ filePath, mimeType: 'image/png' })).rejects.toThrow(
      /Yandex OCR 400: invalid folder id/,
    );
  });

  it('isAvailable() false when key or folder missing', () => {
    expect(new YandexVisionEngine({ timeoutMs: 30000, model: 'page' }).isAvailable()).toBe(false);
    expect(
      new YandexVisionEngine({ apiKey: 'k', timeoutMs: 30000, model: 'page' }).isAvailable(),
    ).toBe(false);
    expect(
      new YandexVisionEngine({ folderId: 'f', timeoutMs: 30000, model: 'page' }).isAvailable(),
    ).toBe(false);
    expect(
      new YandexVisionEngine({ apiKey: 'k', folderId: 'f', timeoutMs: 30000, model: 'page' }).isAvailable(),
    ).toBe(true);
  });
});

describe('YandexVisionEngine — model selection', () => {
  async function modelForRun(
    cfg: ConstructorParameters<typeof YandexVisionEngine>[0],
    extra: { documentType?: string; yandexModelOverride?: string },
  ): Promise<string> {
    requestMock.mockResolvedValue(reply({ statusCode: 200, json: OK_RESPONSE }));
    const filePath = await makePng('img.png');
    await new YandexVisionEngine(cfg).run({ filePath, mimeType: 'image/png', ...extra });
    const body = JSON.parse(requestMock.mock.calls[0]![1]!.body as string);
    return body.model;
  }

  it('uses default model when no overrides', async () => {
    const model = await modelForRun(
      { apiKey: 'k', folderId: 'f', timeoutMs: 30000, model: 'page' },
      {},
    );
    expect(model).toBe('page');
  });

  it('uses tableModel for a documentType in tableModelTypes (case-insensitive)', async () => {
    const model = await modelForRun(
      {
        apiKey: 'k',
        folderId: 'f',
        timeoutMs: 30000,
        model: 'page',
        tableModel: 'table',
        tableModelTypes: ['INVOICE', 'TAX_INVOICE'],
      },
      { documentType: 'invoice' },
    );
    expect(model).toBe('table');
  });

  it('keeps default model for a documentType NOT in tableModelTypes', async () => {
    const model = await modelForRun(
      {
        apiKey: 'k',
        folderId: 'f',
        timeoutMs: 30000,
        model: 'page',
        tableModel: 'table',
        tableModelTypes: ['INVOICE'],
      },
      { documentType: 'TTN' },
    );
    expect(model).toBe('page');
  });

  it('per-job yandexModelOverride beats env default and per-type tableModel', async () => {
    const model = await modelForRun(
      {
        apiKey: 'k',
        folderId: 'f',
        timeoutMs: 30000,
        model: 'page',
        tableModel: 'table',
        tableModelTypes: ['INVOICE'],
      },
      { documentType: 'invoice', yandexModelOverride: 'handwritten' },
    );
    expect(model).toBe('handwritten');
  });

  it('applies resolved model to every page of a multi-page run', async () => {
    requestMock
      .mockResolvedValueOnce(reply({ statusCode: 200, json: { result: { textAnnotation: { fullText: 'P1' } } } }))
      .mockResolvedValueOnce(reply({ statusCode: 200, json: { result: { textAnnotation: { fullText: 'P2' } } } }));
    const p1 = await makePng('page-1.png');
    const p2 = await makePng('page-2.png');

    await new YandexVisionEngine({
      apiKey: 'k',
      folderId: 'f',
      timeoutMs: 30000,
      model: 'page',
      tableModel: 'table',
      tableModelTypes: ['INVOICE'],
    }).run({
      filePath: 'unused.pdf',
      mimeType: 'application/pdf',
      rasterizedPages: [p1, p2],
      documentType: 'invoice',
    });

    expect(requestMock).toHaveBeenCalledTimes(2);
    for (const call of requestMock.mock.calls) {
      expect(JSON.parse(call[1]!.body as string).model).toBe('table');
    }
  });
});
