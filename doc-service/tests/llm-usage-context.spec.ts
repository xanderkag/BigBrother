/**
 * Учёт токенов за джобу.
 *
 * Защищаемое свойство: счётчик ЗНАЕТ, ЧЕГО ОН НЕ ЗНАЕТ. Вызов без `usage`
 * (stub / qwen_vl / старый inference) попадает в `calls_without_usage`, а не
 * считается нулевым. Иначе ₽/док выглядели бы точными, будучи заниженными —
 * ровно та ошибка, из-за которой multipass-чанки были невидимы.
 */
import { describe, it, expect } from 'vitest';
import {
  withJobLlmUsage,
  addLlmUsage,
  currentJobLlmUsage,
  isUsageComplete,
} from '../src/pipeline/llm/usage-context.js';

describe('withJobLlmUsage — накопление по всем вызовам джобы', () => {
  it('складывает токены всех вызовов (шапка + N чанков multipass)', async () => {
    const { usage } = await withJobLlmUsage(async () => {
      addLlmUsage({ prompt_tokens: 1000, output_tokens: 120 }); // classify
      addLlmUsage({ prompt_tokens: 4000, output_tokens: 300 }); // extract pass 1 (шапка)
      addLlmUsage({ prompt_tokens: 3500, output_tokens: 800 }); // chunk 1 — раньше невидим
      addLlmUsage({ prompt_tokens: 3600, output_tokens: 900 }); // chunk 2 — раньше невидим
    });
    expect(usage.calls).toBe(4);
    expect(usage.prompt_tokens).toBe(12100);
    expect(usage.output_tokens).toBe(2120);
    expect(usage.calls_without_usage).toBe(0);
    expect(isUsageComplete(usage)).toBe(true);
  });

  // ── Ключевое свойство ───────────────────────────────────────────────
  it('вызов без usage помечается НЕИЗМЕРЕННЫМ, а не нулевым', async () => {
    const { usage } = await withJobLlmUsage(async () => {
      addLlmUsage({ prompt_tokens: 500, output_tokens: 50 });
      addLlmUsage(undefined); // stub-backend
      addLlmUsage(null); // старый inference
      addLlmUsage({}); // usage есть, но пустой
    });
    expect(usage.calls).toBe(4);
    expect(usage.calls_without_usage).toBe(3);
    expect(usage.prompt_tokens).toBe(500); // не «0 + 0 + 0», а честная частичная сумма
    expect(isUsageComplete(usage)).toBe(false);
  });

  it('частичный usage (только вход) учитывается и не помечается неизмеренным', async () => {
    const { usage } = await withJobLlmUsage(async () => {
      addLlmUsage({ prompt_tokens: 700, output_tokens: null });
    });
    expect(usage.prompt_tokens).toBe(700);
    expect(usage.output_tokens).toBe(0);
    expect(usage.calls_without_usage).toBe(0);
  });

  it('нет вызовов → не «полный», а пустой', async () => {
    const { usage } = await withJobLlmUsage(async () => {});
    expect(usage.calls).toBe(0);
    expect(isUsageComplete(usage)).toBe(false);
  });

  it('пробрасывает результат функции', async () => {
    const { result } = await withJobLlmUsage(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('копит и при выбросе — расход уже понесён', async () => {
    const acc = { calls: 0 };
    await expect(
      withJobLlmUsage(async () => {
        addLlmUsage({ prompt_tokens: 900, output_tokens: 10 });
        acc.calls = currentJobLlmUsage()!.calls;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(acc.calls).toBe(1);
  });
});

describe('вне контекста джобы', () => {
  it('addLlmUsage — no-op, currentJobLlmUsage — null (smoke-CLI, gateway)', () => {
    expect(() => addLlmUsage({ prompt_tokens: 1, output_tokens: 1 })).not.toThrow();
    expect(currentJobLlmUsage()).toBeNull();
  });

  it('контексты изолированы друг от друга', async () => {
    const [a, b] = await Promise.all([
      withJobLlmUsage(async () => {
        addLlmUsage({ prompt_tokens: 10, output_tokens: 1 });
        await new Promise((r) => setTimeout(r, 5));
        addLlmUsage({ prompt_tokens: 10, output_tokens: 1 });
      }),
      withJobLlmUsage(async () => {
        addLlmUsage({ prompt_tokens: 999, output_tokens: 99 });
      }),
    ]);
    expect(a.usage.prompt_tokens).toBe(20);
    expect(b.usage.prompt_tokens).toBe(999);
  });
});
