/**
 * Контракт между gateway-admin (бэкенд) и queries/gateway.ts (UI).
 *
 * Баг, который это ловит (был живым с 771be62): эндпоинты `/gateway/connectors`
 * и `/gateway/budgets` отдают `{items: [...]}`, а `api.get` возвращает
 * `res.json()` ВЕРБАТИМ — без разворачивания. UI типизировал ответ как голый
 * массив, поэтому `connectors.map(...)` падал с «map is not a function» и ронял
 * весь раздел «Коннекторы»/«Бюджеты» целиком.
 *
 * Тест статический (без React/сети): читаем оба файла и проверяем, что для
 * каждого envelope-эндпоинта UI действительно достаёт `.items`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const routes = readFileSync(
  resolve(__dirname, '..', 'src', 'routes', 'gateway-admin.ts'), 'utf8',
);
const queries = readFileSync(
  resolve(__dirname, '..', 'ui', 'src', 'queries', 'gateway.ts'), 'utf8',
);
const api = readFileSync(
  resolve(__dirname, '..', 'ui', 'src', 'lib', 'api.ts'), 'utf8',
);

describe('gateway API ↔ UI query contract', () => {
  it('api.get does NOT unwrap an envelope (returns res.json() verbatim)', () => {
    // Если это когда-нибудь изменится — разворачивание в хуках станет двойным.
    expect(api).toMatch(/return \(await res\.json\(\)\) as T;/);
  });

  it('connectors endpoint returns an {items} envelope', () => {
    expect(routes).toMatch(/const ConnectorsResponse = z\.object\(\{\s*items:/);
  });

  it('budgets endpoint returns an {items} envelope', () => {
    expect(routes).toMatch(/const BudgetsResponse = z\.object\(\{\s*items:/);
  });

  it('useConnectors unwraps .items (else connectors.map throws)', () => {
    const fn = queries.slice(
      queries.indexOf('export function useConnectors'),
      queries.indexOf('export interface PatchConnectorInput'),
    );
    expect(fn).toContain('/api/v1/gateway/connectors');
    expect(fn, 'must unwrap the {items} envelope').toContain('.items');
  });

  it('useBudgets unwraps .items', () => {
    const fn = queries.slice(
      queries.indexOf('export function useBudgets'),
      queries.indexOf('export function usePatchBudget'),
    );
    expect(fn).toContain('/api/v1/gateway/budgets');
    expect(fn, 'must unwrap the {items} envelope').toContain('.items');
  });

  it('usage endpoint is NOT an items-envelope, so it must not be unwrapped', () => {
    // UsageResponse = {from, to, groups} — объект, а не конверт со списком.
    expect(routes).toMatch(/const UsageResponse = z\.object\(\{[\s\S]*?groups:/);
    const fn = queries.slice(queries.indexOf('export function useGatewayUsage'));
    expect(fn).not.toMatch(/gateway\/usage[\s\S]{0,120}\)\)\.items/);
  });
});
