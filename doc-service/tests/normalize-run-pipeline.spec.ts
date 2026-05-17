/**
 * Проверка что runPostExtractNormalization запускает шаги в правильном
 * порядке и не ломает идемпотентность.
 *
 * Шаги (см. normalize/run.ts):
 *   1. F1 normalizeExtractedFields (ИНН/plate)
 *   2. F7 recomputeTotalsFromItems
 *   3. F6 applyCategoryHints
 *   4. F13 enrichItemsWithSlaiCategoryIds (требует БД — skip при ошибке)
 *
 * Так как F13 ходит в БД (slai_category_map), а в unit-тестах БД нет —
 * проверяем что F13 шаг fail-soft (warning лог, не throws).
 */
import { describe, expect, it, vi } from 'vitest';
import { runPostExtractNormalization } from '../src/pipeline/normalize/run.js';

// Minimal mock logger — нужен для F13 step при DB error
const mockLogger = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => mockLogger),
} as never;

describe('runPostExtractNormalization — комбинирует все шаги', () => {
  it('F1: нормализует ИНН в _normalized_fields', async () => {
    const r = await runPostExtractNormalization(
      {
        seller: { inn: '7728168971' }, // валидный
      },
      mockLogger,
    );
    expect((r as any)._normalized_fields).toBeDefined();
    expect((r as any)._normalized_fields['seller.inn']).toBe('7728168971');
  });

  it('F7: пересчитывает total_with_vat из items', async () => {
    const r = await runPostExtractNormalization(
      {
        items: [{ qty: 2, price: 100, vat_rate: 20, total: 240 }],
        total_with_vat: 9999, // LLM ошибся
      },
      mockLogger,
    );
    expect((r as any).total_with_vat).toBe(240);
    expect((r as any)._totals_recomputed).toBeDefined();
  });

  it('F6: добавляет category_hint в items', async () => {
    const r = await runPostExtractNormalization(
      {
        items: [{ name: 'Болт М12×60' }],
      },
      mockLogger,
    );
    expect((r as any).items[0].category_hint).toBe('metal');
  });

  it('F1+F7+F6 совместно: всё работает в один проход', async () => {
    const r = await runPostExtractNormalization(
      {
        seller: { inn: '7728168971' },
        items: [
          { name: 'Молоко Простоквашино', qty: 5, price: 100, vat_rate: 10, total: 550 },
          { name: 'Болт М12', qty: 10, price: 50, vat_rate: 20, total: 600 },
        ],
        total_with_vat: 0, // LLM забыл
      },
      mockLogger,
    );

    // F1 — ИНН в _normalized_fields
    expect((r as any)._normalized_fields['seller.inn']).toBe('7728168971');
    // F7 — total пересчитан (550 + 600 = 1150)
    expect((r as any).total_with_vat).toBe(1150);
    // F6 — категории добавлены
    expect((r as any).items[0].category_hint).toBe('food');
    expect((r as any).items[1].category_hint).toBe('metal');
  });

  it('F13 skip soft при DB error — остальные шаги отрабатывают', async () => {
    // В юнит-тесте slaiCategoriesRepo.loadHintToIdMap() кинет ошибку
    // (нет настроенного pool). Это нормально — мы должны увидеть warning
    // в логе, но F1/F6/F7 должны отработать.
    const r = await runPostExtractNormalization(
      {
        seller: { inn: '7728168971' },
        items: [{ name: 'Молоко' }],
      },
      mockLogger,
    );
    expect((r as any)._normalized_fields['seller.inn']).toBe('7728168971');
    expect((r as any).items[0].category_hint).toBe('food');
    // F13 — _slai_category_id не должно быть (lookup упал, no-op)
    expect((r as any).items[0]._slai_category_id).toBeUndefined();
    // Warning должен быть залогирован
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('null extracted → null', async () => {
    expect(await runPostExtractNormalization(null, mockLogger)).toBeNull();
  });

  it('пустой объект → проходит pipeline без ошибок', async () => {
    const r = await runPostExtractNormalization({}, mockLogger);
    expect(r).toBeDefined();
  });

  // NB: идемпотентность отдельно тестирована в normalize-identifiers /
  // normalize-totals-categories / normalize-field-confidence / normalize-pii-redact.
  // Здесь не дублируем чтобы не тратить DB-coнnect timeouts (slaiCategoriesRepo
  // ходит в реальный pool, в unit-тестах PG нет).
});
