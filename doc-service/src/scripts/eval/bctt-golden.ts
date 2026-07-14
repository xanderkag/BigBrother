/**
 * §9 (CLASSIFIER-PACKET-V2): golden-набор приёмки корпуса БКТ.
 *
 * Источник — BCTT_GROUNDTRUTH.md §2 (51/51 прочитано глазами) + TZ §9 (кейсы
 * A1–D1). Каждый кейс — ожидаемый НАБОР типов документов по сегментам файла
 * (порядок не важен, дедуп). `flagship` — входит в M2 (100% обязателен).
 *
 * fileMatch — подстрока имени файла для матчинга с результатами прогона. Это
 * коды из §2 (SKMBT / 104051 / 57-16-448 …); если реальные имена в корпусе
 * отличаются, первый прогон runner'а покажет «файл не найден» — тогда fileMatch
 * правится под фактические имена (5-минутная правка).
 *
 * Замечания:
 *  - `also_*`/secondary-роли (двойные доки) — НЕ сегменты, в `secondary`.
 *  - `piiEmpty` (ID-кейсы) проверяются в M4: extract/raw_text/webhook по ПДн пусты.
 *  - 13 AUMA-композитов p04-ltk с неизвестными точными именами не закодированы
 *    пофайлово (все шаблон EAD+packing+invoice+spec) — прогон покажет их отдельно.
 */
export interface GoldenCase {
  /** Метка кейса (A1…D1 из TZ §9, либо пакет-код). */
  id: string;
  /** Подстрока имени файла (для матчинга с результатами прогона). */
  fileMatch: string;
  /** Ожидаемый набор типов сегментов (дедуп, порядок не важен). */
  types: string[];
  /** M2-флагман: 100% обязателен. */
  flagship?: boolean;
  /** Вторичные роли (двойные доки), не входят в M1-набор. */
  secondary?: string[];
  /** M4: для ID-кейса extract/raw_text/webhook по ПДн должны быть пусты. */
  piiEmpty?: boolean;
}

const VED = 'customs_export_ead';
const INV = 'commercial_invoice';
const PAC = 'packing_list';
const SPEC = 'contract_specification';
const VEH = 'vehicle_registration';

export const BCTT_GOLDEN: GoldenCase[] = [
  // ── root (956MRD) — композиты, шаблон EAD[+акциз]+инвойс+packing+CMR+СТС[+паспорт]
  { id: 'root-SKMBT', fileMatch: 'SKMBT', flagship: true, types: [VED, 'cmr', INV, VEH] },
  { id: 'root-SARASA', fileMatch: 'SARASA', types: [VED, INV, PAC, 'cmr', VEH] },
  { id: 'root-KARINA', fileMatch: 'KARINA', types: [VED, INV, PAC, 'cmr', VEH] },
  { id: 'root-LAROCHE', fileMatch: 'LAROCHE', types: [VED, 'excise_ead', INV, PAC, 'cmr', VEH] },
  { id: 'root-SUMEIRE', fileMatch: 'SUMEIRE', types: [VED, 'excise_ead', INV, PAC, 'cmr', VEH] },
  { id: 'root-SICHEL', fileMatch: 'SICHEL', types: [VED, 'excise_ead', INV, PAC, 'cmr', 'driver_passport', VEH] },

  // ── p01-paper — чистые single-doc (дизайнерская бумага)
  { id: 'p01-CMR', fileMatch: 'CMR.jpeg', types: ['cmr'] },
  { id: 'p01-inv1', fileMatch: 'inv 1', types: [INV] },
  { id: 'p01-inv2', fileMatch: 'inv 2', types: [INV] },
  { id: 'p01-inv3', fileMatch: 'inv 3', types: [INV] },
  { id: 'p01-pac1', fileMatch: 'pac 1', types: [PAC] },
  { id: 'p01-pac2', fileMatch: 'pac 2', types: [PAC] },
  { id: 'p01-pac3', fileMatch: 'pac 3', types: [PAC] },

  // ── p02-oskar — фото папки (грузовик 9096BC)
  { id: 'oskar-104005', fileMatch: '104005', types: [VEH] },
  { id: 'oskar-104017', fileMatch: '104017', types: [VEH] },
  { id: 'oskar-104051', fileMatch: '104051', types: ['driver_passport'], piiEmpty: true },
  { id: 'oskar-104137', fileMatch: '104137', types: [VEH] }, // standalone TIR → vehicle_registration
  { id: 'oskar-115954', fileMatch: '115954', types: ['transport_permit'] },
  { id: 'oskar-125231', fileMatch: '125231', types: ['cmr'] },
  { id: 'oskar-125300', fileMatch: '125300', types: [VED] },
  { id: 'oskar-125337', fileMatch: '125337', types: [VED] }, // EAD — список позиций
  { id: 'oskar-125423', fileMatch: '125423', types: ['delivery_note'] },
  { id: 'oskar-125452', fileMatch: '125452', types: [INV], secondary: [PAC] }, // Invoice Packing List

  // ── p03-mnj — фото папки (грузовик MNJ126, NIVEA)
  { id: 'mnj-632', fileMatch: '57-632', flagship: true, types: ['certificate_register'] },
  { id: 'mnj-259', fileMatch: '58-259', types: [SPEC] },
  { id: 'mnj-448', fileMatch: '16-448', flagship: true, types: [SPEC] },
  { id: 'mnj-526', fileMatch: '16-526', types: [INV] },
  { id: 'mnj-593', fileMatch: '16-593', types: ['cmr'] },
  { id: 'mnj-100', fileMatch: '54-100', types: [VEH] }, // СТС + TIR
  { id: 'mnj-173', fileMatch: '54-173', types: ['driver_passport'], piiEmpty: true },
  { id: 'mnj-251', fileMatch: '54-251', types: ['transport_permit'], secondary: [VEH] },
  { id: 'mnj-319', fileMatch: '54-319', types: ['transport_permit'], secondary: [VEH] },

  // ── p04-ltk — композиты AUMA (PDF). Named 5 + noreply; +13 AUMA-шаблон не по имени.
  { id: 'ltk-122952', fileMatch: '122952', types: [VED, PAC, INV] }, // без спецификации
  { id: 'ltk-123042', fileMatch: '123042', types: [VED, PAC, INV, SPEC] },
  { id: 'ltk-123324', fileMatch: '123324', types: [VED, PAC, INV, SPEC] },
  { id: 'ltk-123719', fileMatch: '123719', types: [VED, PAC, INV, SPEC] },
  { id: 'ltk-123810', fileMatch: '123810', types: [VED, PAC, INV, SPEC] },
  { id: 'ltk-noreply', fileMatch: 'noreply', flagship: true, types: ['driver_passport', 'cmr', VEH], piiEmpty: true },
];

/** Шаблон AUMA-композита p04-ltk (для 13 файлов без точных имён в §2). */
export const AUMA_TEMPLATE_TYPES: string[] = [VED, PAC, INV, SPEC];
