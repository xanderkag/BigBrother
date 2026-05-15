/**
 * HandlerRegistry — базовый flow: register / dispatch / error-paths.
 */

import { describe, expect, it } from 'vitest';
import { HandlerRegistry } from '../src/pipeline/preprocess/registry.js';
import type { FormatHandler, PreprocessInput } from '../src/pipeline/preprocess/types.js';

function makeInput(overrides: Partial<PreprocessInput> = {}): PreprocessInput {
  return {
    filePath: '/tmp/test',
    fileName: 'test.bin',
    detectedMime: 'application/octet-stream',
    sizeBytes: 100,
    ...overrides,
  };
}

describe('HandlerRegistry', () => {
  it('возвращает UNSUPPORTED_FORMAT когда нет matching handler', async () => {
    const reg = new HandlerRegistry();
    const res = await reg.dispatch(makeInput());
    expect(res.kind).toBe('error');
    if (res.kind === 'error') {
      expect(res.code).toBe('UNSUPPORTED_FORMAT');
    }
  });

  it('возвращает EMPTY_FILE для размера 0 без вызова handler-ов', async () => {
    const reg = new HandlerRegistry();
    let detectCalls = 0;
    reg.register({
      name: 'spy',
      detect() { detectCalls++; return true; },
      async process() { return { kind: 'pages', pages: [], meta: {} }; },
    });
    const res = await reg.dispatch(makeInput({ sizeBytes: 0 }));
    expect(res.kind).toBe('error');
    if (res.kind === 'error') {
      expect(res.code).toBe('EMPTY_FILE');
    }
    expect(detectCalls).toBe(0);
  });

  it('берёт первый matching handler в порядке регистрации', async () => {
    const reg = new HandlerRegistry();
    const calls: string[] = [];
    const makeHandler = (name: string, matches: boolean): FormatHandler => ({
      name,
      detect() { calls.push(`${name}:detect`); return matches; },
      async process() {
        calls.push(`${name}:process`);
        return { kind: 'pages', pages: [], meta: { handler: name } };
      },
    });
    reg.register(makeHandler('first', false));
    reg.register(makeHandler('second', true));
    reg.register(makeHandler('third', true)); // не должен вызваться

    const res = await reg.dispatch(makeInput());
    expect(res.kind).toBe('pages');
    if (res.kind === 'pages') {
      expect(res.meta.handler).toBe('second');
    }
    expect(calls).toEqual(['first:detect', 'second:detect', 'second:process']);
  });

  it('list() возвращает имена в порядке регистрации', () => {
    const reg = new HandlerRegistry();
    reg.register({ name: 'a', detect: () => false, process: async () => ({ kind: 'pages', pages: [], meta: {} }) });
    reg.register({ name: 'b', detect: () => false, process: async () => ({ kind: 'pages', pages: [], meta: {} }) });
    expect(reg.list().map((h) => h.name)).toEqual(['a', 'b']);
  });

  it('детали ошибки UNSUPPORTED включают detected_mime и file_name', async () => {
    const reg = new HandlerRegistry();
    const res = await reg.dispatch(makeInput({
      detectedMime: 'image/jpeg',
      fileName: 'mystery.jpg',
    }));
    expect(res.kind).toBe('error');
    if (res.kind === 'error') {
      expect(res.details?.detected_mime).toBe('image/jpeg');
      expect(res.details?.file_name).toBe('mystery.jpg');
    }
  });
});
