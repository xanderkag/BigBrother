/**
 * Tests for totals recompute (F7) + category keyword-mapper (F6).
 */
import { describe, expect, it } from 'vitest';
import { recomputeTotalsFromItems } from '../src/pipeline/normalize/totals.js';
import { categorizeName, applyCategoryHints } from '../src/pipeline/normalize/categories.js';

describe('recomputeTotalsFromItems', () => {
  it('пересчитывает total_with_vat если LLM ошибся', () => {
    const r = recomputeTotalsFromItems({
      items: [
        { qty: 2, price: 100, vat_rate: 20, total: 240 },
        { qty: 3, price: 50, vat_rate: 20, total: 180 },
      ],
      total_with_vat: 999, // LLM ошибся, на самом деле 240 + 180 = 420
    });
    expect((r as any).total_with_vat).toBe(420);
    expect((r as any)._totals_recomputed.from).toBe('items_sum');
  });

  it('не трогает если LLM попал в пределах 1 рубля', () => {
    const r = recomputeTotalsFromItems({
      items: [
        { qty: 1, price: 100, vat_rate: 20, total: 120 },
      ],
      total_with_vat: 120.3, // в пределах допуска 1 руб
    });
    expect((r as any).total_with_vat).toBe(120.3);
    expect((r as any)._totals_recomputed).toBeUndefined();
  });

  it('заполняет total_with_vat если LLM забыл', () => {
    const r = recomputeTotalsFromItems({
      items: [
        { qty: 2, price: 100, vat_rate: 10, total: 220 },
      ],
      // total_with_vat отсутствует
    });
    expect((r as any).total_with_vat).toBe(220);
  });

  it('читает строковые числа с пробелами и запятой', () => {
    const r = recomputeTotalsFromItems({
      items: [
        { qty: '2', price: '1 000,50', vat_rate: 20, total: '2401,20' },
      ],
      total_with_vat: 0,
    });
    expect((r as any).total_with_vat).toBe(2401.2);
  });

  it('пропускает если items пуст', () => {
    const orig = { total_with_vat: 100 };
    const r = recomputeTotalsFromItems(orig);
    expect(r).toBe(orig);
  });

  it('пересчитывает через price × qty если в строке нет total', () => {
    const r = recomputeTotalsFromItems({
      items: [
        { qty: 5, price: 100, vat_rate: 20 }, // total отсутствует
      ],
      total_with_vat: 0,
    });
    // 5 × 100 × 1.2 = 600
    expect((r as any).total_with_vat).toBe(600);
  });

  it('идемпотентна: повторный вызов на уже пересчитанном не меняет', () => {
    const original = {
      items: [{ qty: 2, price: 100, vat_rate: 20, total: 240 }],
      total_with_vat: 240,
    };
    const r1 = recomputeTotalsFromItems(original);
    const r2 = recomputeTotalsFromItems(r1);
    expect((r2 as any).total_with_vat).toBe(240);
  });
});

describe('categorizeName', () => {
  it('определяет metal по болту', () => {
    expect(categorizeName('Болт М12×60 кл.прочн.8.8 (DIN 933)')).toBe('metal');
  });

  it('определяет electrical для IT-железа', () => {
    expect(categorizeName('Сервер Dell R740 2×Xeon 64GB')).toBe('electrical');
    expect(categorizeName('Картридж HP CF259A совместимый')).toBe('electrical');
    expect(categorizeName('Кабель ВВГнг-LS 3×2.5 ГОСТ 31996')).toBe('electrical');
  });

  it('разделяет food и fuel («масло сливочное» vs «масло моторное»)', () => {
    expect(categorizeName('Масло сливочное 82.5% 180г')).toBe('food');
    expect(categorizeName('Масло моторное 5W-40 синтетика')).toBe('fuel');
  });

  it('packaging для палет и упаковки', () => {
    expect(categorizeName('Паллет деревянный 1200×800')).toBe('packaging');
    expect(categorizeName('Стрейч-плёнка 500мм × 300м')).toBe('packaging');
    expect(categorizeName('Скотч упаковочный 48мм × 66м')).toBe('packaging');
  });

  it('service_transport для логистических услуг', () => {
    expect(categorizeName('Транспортные услуги Москва-СПб')).toBe('service_transport');
    expect(categorizeName('Экспедирование груза')).toBe('service_transport');
  });

  it('service_loading для погрузки', () => {
    expect(categorizeName('Погрузо-разгрузочные работы')).toBe('service_loading');
  });

  it('food для продуктов из pool', () => {
    expect(categorizeName('Молоко Простоквашино 3.2% 1л')).toBe('food');
    expect(categorizeName('Кефир Простоквашино 2.5% 0.9л')).toBe('food');
    expect(categorizeName('Хлеб ржаной 350г')).toBe('food');
    expect(categorizeName('Гречка ядрица 800г')).toBe('food');
  });

  it('beverage для напитков', () => {
    expect(categorizeName('Сок яблочный Добрый 1л')).toBe('beverage');
    expect(categorizeName('Вода Архыз 0.5л')).toBe('beverage');
    expect(categorizeName('Кофе зерновой Lavazza 1кг')).toBe('beverage');
  });

  it('consumer_goods для офисной бумаги', () => {
    expect(categorizeName('Бумага офисная SvetoCopy A4 80г/м²')).toBe('consumer_goods');
  });

  it('other на неизвестных названиях', () => {
    expect(categorizeName('Зюзюбра обыкновенная синяя')).toBe('other');
  });
});

describe('applyCategoryHints', () => {
  it('добавляет category_hint всем items[]', () => {
    const r = applyCategoryHints({
      items: [
        { name: 'Болт М12×60', qty: 100 },
        { name: 'Сок яблочный Добрый 1л', qty: 5 },
      ],
    });
    const items = (r as any).items;
    expect(items[0].category_hint).toBe('metal');
    expect(items[1].category_hint).toBe('beverage');
  });

  it('уважает существующий не-other category_hint от LLM', () => {
    const r = applyCategoryHints({
      items: [
        { name: 'Сервер Dell', category_hint: 'pharma' }, // LLM наврал, но мы доверяем
      ],
    });
    expect((r as any).items[0].category_hint).toBe('pharma');
  });

  it('перетирает «other» от LLM на реальную категорию', () => {
    const r = applyCategoryHints({
      items: [
        { name: 'Кабель ВВГ 3×2.5', category_hint: 'other' },
      ],
    });
    expect((r as any).items[0].category_hint).toBe('electrical');
  });

  it('идемпотентен', () => {
    const original = {
      items: [{ name: 'Болт М12', category_hint: 'metal' }],
    };
    const r1 = applyCategoryHints(original);
    expect(r1).toBe(original); // ничего не изменилось → тот же объект
  });

  it('пропускает item без name', () => {
    const r = applyCategoryHints({
      items: [{ qty: 1 }],
    });
    expect((r as any).items[0].category_hint).toBeUndefined();
  });
});
