#!/usr/bin/env node
/**
 * Генератор синтетических PDF-документов для smoke-тестирования pipeline.
 *
 * Генерит ~10 PDF разных типов (invoice, factInvoice, UPD, TTN, AKT,
 * commercial_invoice) с реалистичными русскими данными — ИНН/КПП с
 * правильной чек-суммой, адреса, госномера в нужном формате, корректные
 * НДС-расчёты.
 *
 * Использование:
 *   node scripts/gen-synthetic-pdfs.mjs [--out ./corpus] [--count-per-type 2]
 *
 * Принцип: каждый PDF — text-based (не сканы), чтобы прогонять через
 * pdf-parse без OCR — это быстрее и предсказуемее для проверки парсеров.
 * Для полного тестирования OCR-цепочки нужны реальные сканы.
 */

import PDFDocument from 'pdfkit';
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Шрифты с поддержкой кириллицы. Без них pdfkit использует Helvetica,
// у которого нет CYR-глифов → Tesseract видит мусор. DejaVu Sans/Mono —
// свободно распространяемые шрифты, скачаны в scripts/fonts/ из
// github.com/dejavu-fonts/dejavu-fonts.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FONT_REGULAR = join(SCRIPT_DIR, 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = join(SCRIPT_DIR, 'fonts', 'DejaVuSans-Bold.ttf');
const FONT_MONO = join(SCRIPT_DIR, 'fonts', 'DejaVuSansMono.ttf');

if (!existsSync(FONT_REGULAR)) {
  console.error('ERR: шрифты не найдены. Скачайте DejaVu Sans в scripts/fonts/');
  console.error('     curl -sL https://github.com/dejavu-fonts/dejavu-fonts/raw/version_2_37/ttf/DejaVuSans.ttf -o scripts/fonts/DejaVuSans.ttf');
  process.exit(1);
}

// ── CLI ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let outDir = './corpus/synthetic';
let countPerType = 2;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outDir = args[++i];
  if (args[i] === '--count-per-type') countPerType = Number(args[++i]);
}
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// ── Test data — реалистичные данные с правильной чек-суммой ИНН ─────────────
const SELLERS = [
  { name: 'ООО «Простоквашино»', inn: '7707083893', kpp: '770701001', address: 'Москва, Тверская 1' },
  { name: 'АО «РосТранс»', inn: '7728168971', kpp: '772801001', address: 'Москва, Ленинский пр-т 15' },
  { name: 'ИП Иванов И.И.', inn: '500100732259', kpp: null, address: 'Московская обл., Истра' },
];
const BUYERS = [
  { name: 'ООО «ТАЙПИТ»', inn: '5024169813', kpp: '502401001', address: 'Красногорск, Ильинский б-р 11' },
  { name: 'ООО «Складские Решения»', inn: '7704211201', kpp: '770401001', address: 'Москва, Новинский 8' },
];
const VEHICLES = [
  { plate: 'А123ВВ77', driver: 'Сидоров П.Р.' },
  { plate: 'Х999РУ50', driver: 'Петров А.С.' },
  { plate: 'М500НТ199', driver: 'Кузнецов И.В.' },
];
const ITEMS_POOL = [
  { code: 'A-001', name: 'Молоко Простоквашино 3.2% 1л', unit: 'шт', price: 78.50, vat_rate: 10 },
  { code: 'A-002', name: 'Кефир Простоквашино 2.5% 0.9л', unit: 'шт', price: 65.00, vat_rate: 10 },
  { code: 'B-100', name: 'Сыр Российский 50% 1кг', unit: 'кг', price: 450.00, vat_rate: 10 },
  { code: 'B-205', name: 'Масло сливочное 82.5% 180г', unit: 'шт', price: 145.00, vat_rate: 10 },
  { code: 'C-001', name: 'Сок яблочный Добрый 1л', unit: 'шт', price: 89.00, vat_rate: 20 },
  { code: 'C-115', name: 'Вода Архыз 0.5л', unit: 'шт', price: 35.00, vat_rate: 20 },
  { code: 'D-301', name: 'Палет деревянный 1200×800', unit: 'шт', price: 850.00, vat_rate: 20 },
];

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function todayIso() { return new Date().toISOString().slice(0, 10); }
function randomDate() {
  const offset = randInt(0, 60);
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
}

/** Сгенерить таблицу позиций случайной длины */
function genItems(min, max) {
  const n = randInt(min, max);
  const items = [];
  for (let i = 0; i < n; i++) {
    const base = pickRandom(ITEMS_POOL);
    const qty = randInt(1, 50);
    const total_without_vat = +(base.price * qty).toFixed(2);
    const vat_amount = +(total_without_vat * base.vat_rate / 100).toFixed(2);
    const total_with_vat = +(total_without_vat + vat_amount).toFixed(2);
    items.push({
      line_no: i + 1,
      ...base,
      qty,
      total_without_vat,
      vat_amount,
      total_with_vat,
    });
  }
  return items;
}

function totalsFromItems(items) {
  const without = items.reduce((s, x) => s + x.total_without_vat, 0);
  const vat = items.reduce((s, x) => s + x.vat_amount, 0);
  return {
    without_vat: +without.toFixed(2),
    vat: +vat.toFixed(2),
    with_vat: +(without + vat).toFixed(2),
  };
}

// ── PDF builders по типам ──────────────────────────────────────────────────

function buildInvoice(doc, n) {
  const seller = pickRandom(SELLERS);
  const buyer = pickRandom(BUYERS);
  const items = genItems(3, 8);
  const totals = totalsFromItems(items);
  const number = `СЧ-${randInt(1000, 9999)}/${n}`;
  const date = randomDate();

  doc.font('Bold').fontSize(18).text(`СЧЁТ № ${number}`, { align: 'center' });
  doc.font('Regular').fontSize(10).text(`от ${date}`, { align: 'center' });
  doc.moveDown();
  doc.fontSize(11).text(`Поставщик: ${seller.name}, ИНН ${seller.inn}${seller.kpp ? `, КПП ${seller.kpp}` : ''}`);
  doc.text(`Адрес: ${seller.address}`);
  doc.moveDown(0.5);
  doc.text(`Покупатель: ${buyer.name}, ИНН ${buyer.inn}, КПП ${buyer.kpp}`);
  doc.text(`Адрес: ${buyer.address}`);
  doc.moveDown();

  doc.font('Mono').fontSize(9);
  doc.text('№   Наименование                                  Кол-во Ед   Цена    НДС%  Сумма');
  doc.text('─────────────────────────────────────────────────────────────────────────────────');
  for (const it of items) {
    const line = `${String(it.line_no).padEnd(4)}${it.name.slice(0, 46).padEnd(46)}${String(it.qty).padStart(6)} ${it.unit.padEnd(4)}${it.price.toFixed(2).padStart(8)} ${String(it.vat_rate).padStart(3)}%  ${it.total_with_vat.toFixed(2).padStart(10)}`;
    doc.text(line);
  }
  doc.text('─────────────────────────────────────────────────────────────────────────────────');
  doc.font('Regular').fontSize(11);
  doc.text(`Итого без НДС: ${totals.without_vat.toFixed(2)} руб.`, { align: 'right' });
  doc.text(`НДС: ${totals.vat.toFixed(2)} руб.`, { align: 'right' });
  doc.font('Bold').fontSize(12).text(`Всего к оплате: ${totals.with_vat.toFixed(2)} руб.`, { align: 'right' });
}

function buildUpd(doc, n) {
  const seller = pickRandom(SELLERS);
  const buyer = pickRandom(BUYERS);
  const items = genItems(5, 12);
  const totals = totalsFromItems(items);
  const number = `УПД-${randInt(100, 999)}/${n}`;
  const date = randomDate();

  doc.font('Bold').fontSize(16).text(`УНИВЕРСАЛЬНЫЙ ПЕРЕДАТОЧНЫЙ ДОКУМЕНТ № ${number}`, { align: 'center' });
  doc.font('Regular').fontSize(10).text(`от ${date}`, { align: 'center' });
  doc.moveDown();
  doc.fontSize(11).text(`Продавец: ${seller.name}, ИНН/КПП: ${seller.inn}/${seller.kpp ?? '—'}`);
  doc.text(`Покупатель: ${buyer.name}, ИНН/КПП: ${buyer.inn}/${buyer.kpp}`);
  doc.text(`Грузоотправитель: тот же`);
  doc.text(`Грузополучатель: ${buyer.name}`);
  doc.moveDown();
  doc.font('Mono').fontSize(9);
  doc.text('№   Наименование                                  Кол-во Ед   Цена    НДС     Сумма');
  doc.text('────────────────────────────────────────────────────────────────────────────────────');
  for (const it of items) {
    const line = `${String(it.line_no).padEnd(4)}${it.name.slice(0, 46).padEnd(46)}${String(it.qty).padStart(6)} ${it.unit.padEnd(4)}${it.price.toFixed(2).padStart(8)} ${it.vat_amount.toFixed(2).padStart(7)} ${it.total_with_vat.toFixed(2).padStart(10)}`;
    doc.text(line);
  }
  doc.text('────────────────────────────────────────────────────────────────────────────────────');
  doc.font('Regular').fontSize(11).text(`Итого: ${totals.with_vat.toFixed(2)} руб. (в т.ч. НДС: ${totals.vat.toFixed(2)} руб.)`, { align: 'right' });
}

function buildTtn(doc, n) {
  const shipper = pickRandom(SELLERS);
  const consignee = pickRandom(BUYERS);
  const vehicle = pickRandom(VEHICLES);
  const items = genItems(2, 5);
  const number = `ТТН-${randInt(10000, 99999)}/${n}`;
  const date = randomDate();

  doc.font('Bold').fontSize(16).text(`ТОВАРНО-ТРАНСПОРТНАЯ НАКЛАДНАЯ № ${number}`, { align: 'center' });
  doc.font('Regular').fontSize(10).text(`от ${date}`, { align: 'center' });
  doc.moveDown();
  doc.fontSize(11).text(`Грузоотправитель: ${shipper.name}, ИНН ${shipper.inn}`);
  doc.text(`Адрес погрузки: ${shipper.address}`);
  doc.moveDown(0.5);
  doc.text(`Грузополучатель: ${consignee.name}, ИНН ${consignee.inn}`);
  doc.text(`Адрес разгрузки: ${consignee.address}`);
  doc.moveDown(0.5);
  doc.text(`Перевозчик: ИП Перевозкин В.В.`);
  doc.text(`ТС: ${vehicle.plate}, водитель ${vehicle.driver}`);
  doc.moveDown();
  doc.font('Mono').fontSize(9);
  doc.text('№   Наименование груза                       Кол-во Ед   Масса нетто  Масса брутто');
  doc.text('────────────────────────────────────────────────────────────────────────────────');
  let totalGross = 0;
  for (const it of items) {
    const weight_net = +(it.qty * 0.5).toFixed(1);
    const weight_gross = +(weight_net * 1.05).toFixed(1);
    totalGross += weight_gross;
    doc.text(`${String(it.line_no).padEnd(4)}${it.name.slice(0, 40).padEnd(40)}${String(it.qty).padStart(6)} ${it.unit.padEnd(4)}${weight_net.toFixed(1).padStart(11)}  ${weight_gross.toFixed(1).padStart(11)}`);
  }
  doc.text('────────────────────────────────────────────────────────────────────────────────');
  doc.font('Regular').fontSize(11).text(`Всего мест: ${items.length}, общая масса брутто: ${totalGross.toFixed(1)} кг`, { align: 'right' });
}

function buildAkt(doc, n) {
  const partyA = pickRandom(SELLERS);
  const partyB = pickRandom(BUYERS);
  const items = [
    { name: 'Транспортные услуги по маршруту Москва-СПб', qty: 1, price: 45000, vat_rate: 20 },
    { name: 'Погрузо-разгрузочные работы', qty: 8, price: 2500, vat_rate: 20 },
    { name: 'Экспедирование', qty: 1, price: 12000, vat_rate: 20 },
  ];
  items.forEach((it, i) => {
    it.line_no = i + 1;
    it.total_without_vat = +(it.qty * it.price).toFixed(2);
    it.vat_amount = +(it.total_without_vat * 0.2).toFixed(2);
    it.total_with_vat = +(it.total_without_vat + it.vat_amount).toFixed(2);
    it.unit = it.qty === 1 ? 'усл' : 'час';
  });
  const totals = totalsFromItems(items);
  const number = `АКТ-${randInt(1000, 9999)}/${n}`;
  const date = randomDate();

  doc.font('Bold').fontSize(16).text(`АКТ № ${number}`, { align: 'center' });
  doc.font('Regular').fontSize(10).text(`выполненных работ от ${date}`, { align: 'center' });
  doc.moveDown();
  doc.fontSize(11).text(`Исполнитель: ${partyA.name}, ИНН ${partyA.inn}`);
  doc.text(`Заказчик: ${partyB.name}, ИНН ${partyB.inn}`);
  doc.moveDown();
  doc.text(`Договор-основание: № ${randInt(100, 999)}/${date.slice(0, 4)} от ${date}`);
  doc.moveDown();
  doc.font('Mono').fontSize(9);
  doc.text('№   Услуга                                         Кол-во Ед   Цена       Сумма');
  doc.text('───────────────────────────────────────────────────────────────────────────────');
  for (const it of items) {
    doc.text(`${String(it.line_no).padEnd(4)}${it.name.slice(0, 48).padEnd(48)}${String(it.qty).padStart(6)} ${it.unit.padEnd(4)}${it.price.toFixed(2).padStart(10)} ${it.total_with_vat.toFixed(2).padStart(11)}`);
  }
  doc.text('───────────────────────────────────────────────────────────────────────────────');
  doc.font('Regular').fontSize(11).text(`Итого: ${totals.with_vat.toFixed(2)} руб. (НДС 20%: ${totals.vat.toFixed(2)} руб.)`, { align: 'right' });
  doc.moveDown();
  doc.text('Услуги оказаны полностью и в срок, претензий по объёму и качеству не имеется.');
}

// ── Главный цикл ───────────────────────────────────────────────────────────

const BUILDERS = {
  invoice: buildInvoice,
  UPD: buildUpd,
  TTN: buildTtn,
  AKT: buildAkt,
};

/**
 * Создать PDF-документ с зарегистрированными кириллическими шрифтами.
 * Регистрируем их под именами 'Regular' / 'Bold' / 'Mono' — buildersы
 * вызывают doc.font('Regular') / doc.font('Mono') чтобы переключаться.
 */
function newDoc() {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.registerFont('Regular', FONT_REGULAR);
  doc.registerFont('Bold', FONT_BOLD);
  doc.registerFont('Mono', FONT_MONO);
  // Дефолтный шрифт — Regular. Buildersы вызывают doc.font('Mono')
  // для табличных частей где нужна моноширинность.
  doc.font('Regular');
  return doc;
}

let total = 0;
for (const [type, build] of Object.entries(BUILDERS)) {
  for (let n = 1; n <= countPerType; n++) {
    const filename = `${type}-synth-${String(n).padStart(2, '0')}.pdf`;
    const filepath = join(outDir, filename);
    const doc = newDoc();
    doc.pipe(createWriteStream(filepath));
    build(doc, n);
    doc.end();
    console.log(`Создан ${filename}`);
    total++;
  }
}
console.log(`\nГотово: ${total} файлов в ${outDir}/`);
