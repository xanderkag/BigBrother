/**
 * Юнит-тесты резолвинга подписи поля. Запуск без отдельного раннера:
 *   node --test --experimental-strip-types src/lib/schema-fields.test.ts
 * (Node 22+/24 умеет стрипать типы и имеет встроенный node:test.)
 *
 * Файл не попадает в vite-бандл (не достижим из entry), но проходит
 * type-check вместе с остальным `src`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  humanizeKey,
  labelFor,
  FIELD_LABELS,
  itemFieldsFromArray,
  mergeSchemaWithValue,
  parseSchemaFields,
  type FieldSpec,
} from './schema-fields.ts';

test('humanizeKey: snake_case → Sentence case', () => {
  assert.equal(humanizeKey('beneficiary_bank_swift'), 'Beneficiary bank swift');
  assert.equal(humanizeKey('sender_account'), 'Sender account');
  assert.equal(humanizeKey('amount_words'), 'Amount words');
});

test('humanizeKey: одиночное слово', () => {
  assert.equal(humanizeKey('purpose'), 'Purpose');
});

test('humanizeKey: ведущие подчёркивания отброшены', () => {
  assert.equal(humanizeKey('_field_confidence'), 'Field confidence');
});

test('humanizeKey: camelCase разбивается по регистру', () => {
  assert.equal(humanizeKey('fullName'), 'Full name');
});

test('humanizeKey: подчёркивания никогда не утекают в подпись', () => {
  for (const key of ['a_b_c', 'x__y', 'contract_ref', 'beneficiary_iban']) {
    assert.ok(!humanizeKey(key).includes('_'), `«${key}» → не должно быть _`);
  }
});

test('labelFor: курируемая карта имеет приоритет над гуманизатором', () => {
  assert.equal(labelFor('beneficiary_bank_swift'), 'SWIFT банка получателя');
  assert.equal(labelFor('amount_words'), 'Сумма прописью');
  assert.equal(labelFor('sender_account'), 'Счёт отправителя');
  assert.equal(labelFor('contract_ref'), 'Договор');
});

test('labelFor: неизвестный ключ → fallback humanizeKey', () => {
  assert.equal(labelFor('some_unknown_field'), 'Some unknown field');
});

test('FIELD_LABELS: ни одна подпись не содержит сырого snake_case', () => {
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    assert.ok(
      !/^[a-z]+(_[a-z]+)+$/.test(label),
      `подпись для «${key}» выглядит как сырой ключ: «${label}»`,
    );
  }
});

test('itemFieldsFromArray: колонки = объединение ключей строк', () => {
  const arr = [
    { name: 'A', qty: 1 },
    { name: 'B', price: 10 },
  ];
  const cols = itemFieldsFromArray(arr).map((c) => c.key);
  assert.deepEqual(cols.sort(), ['name', 'price', 'qty']);
});

test('itemFieldsFromArray: служебные _* отброшены', () => {
  const cols = itemFieldsFromArray([{ name: 'A', _slai_category_id: 7 }]).map(
    (c) => c.key,
  );
  assert.deepEqual(cols, ['name']);
});

test('mergeSchemaWithValue: array-strings со значением-объектами → таблица', () => {
  // Схема ошибочно объявила items как массив строк, а данные — массив объектов.
  const schemaFields: FieldSpec[] = [
    { key: 'items', label: 'Позиции', kind: 'array-strings' },
  ];
  const merged = mergeSchemaWithValue(schemaFields, {
    items: [{ name: 'Товар', qty: 2 }],
  });
  const items = merged.find((f) => f.key === 'items');
  assert.equal(items?.kind, 'array-objects');
  assert.deepEqual(items?.itemFields?.map((c) => c.key).sort(), ['name', 'qty']);
});

test('parseSchemaFields: array-objects → itemFields с русскими подписями', () => {
  const fields = parseSchemaFields({
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            qty: { type: 'number' },
            beneficiary_bank_swift: { type: 'string' },
          },
        },
      },
    },
  });
  const items = fields.find((f) => f.key === 'items');
  assert.equal(items?.kind, 'array-objects');
  const byKey = Object.fromEntries(
    (items?.itemFields ?? []).map((c) => [c.key, c.label]),
  );
  assert.equal(byKey.name, 'Наименование');
  assert.equal(byKey.qty, 'Кол-во');
  // Поле вне карты → гуманизировано, без подчёркиваний.
  assert.equal(byKey.beneficiary_bank_swift, 'SWIFT банка получателя');
});
