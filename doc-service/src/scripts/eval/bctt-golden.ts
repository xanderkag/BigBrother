/**
 * §9 (CLASSIFIER-PACKET-V2): golden-набор приёмки корпуса БКТ.
 *
 * Источник — TZ §9 (кейсы A1–D1) + BCTT_GROUNDTRUTH.md §2 (51/51 прочитано
 * глазами). Каждый кейс — ожидаемый НАБОР типов документов по сегментам
 * файла (порядок не важен, дедуп). `flagship` — входит в M2 (100% обязателен).
 *
 * Замечания:
 *  - `also_*`/secondary-роли (двойные доки) — НЕ сегменты, отдельным полем
 *    `secondary` (см. B4). В набор типов для M1 они не входят.
 *  - PII-кейсы (C2) проверяются отдельно (M4: extract/raw_text/webhook пусты).
 */
export interface GoldenCase {
  /** Метка кейса из TZ §9 (A1…D1). */
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

export const BCTT_GOLDEN: GoldenCase[] = [
  { id: 'A1', fileMatch: 'SKMBT', flagship: true,
    types: ['customs_export_ead', 'cmr', 'commercial_invoice', 'vehicle_registration'] },
  { id: 'A2', fileMatch: 'SARASA',
    types: ['customs_export_ead', 'commercial_invoice', 'packing_list', 'cmr', 'vehicle_registration'] },
  { id: 'A4a', fileMatch: 'LAROCHE',
    types: ['customs_export_ead', 'excise_ead', 'commercial_invoice', 'packing_list', 'cmr', 'vehicle_registration'] },
  { id: 'A4b', fileMatch: 'SUMEIRE',
    types: ['customs_export_ead', 'excise_ead', 'commercial_invoice', 'packing_list', 'cmr', 'vehicle_registration'] },
  { id: 'A5', fileMatch: 'SICHEL',
    types: ['customs_export_ead', 'excise_ead', 'commercial_invoice', 'packing_list', 'cmr', 'driver_passport', 'vehicle_registration'] },
  { id: 'A6a', fileMatch: '123042',
    types: ['customs_export_ead', 'packing_list', 'commercial_invoice', 'contract_specification'] },
  { id: 'A6b', fileMatch: '123324',
    types: ['customs_export_ead', 'packing_list', 'commercial_invoice', 'contract_specification'] },
  { id: 'A6c', fileMatch: '123719',
    types: ['customs_export_ead', 'packing_list', 'commercial_invoice', 'contract_specification'] },
  { id: 'A6d', fileMatch: '123810',
    types: ['customs_export_ead', 'packing_list', 'commercial_invoice', 'contract_specification'] },
  { id: 'A7', fileMatch: 'noreply', flagship: true,
    types: ['driver_passport', 'cmr', 'vehicle_registration'], piiEmpty: true },
  { id: 'B1a', fileMatch: '16-448', flagship: true, types: ['contract_specification'] },
  { id: 'B1b', fileMatch: '58-259', types: ['contract_specification'] },
  { id: 'B2', fileMatch: '16-526', types: ['commercial_invoice'] },
  { id: 'B3', fileMatch: '632', flagship: true, types: ['certificate_register'] },
  { id: 'B4', fileMatch: '125452', types: ['commercial_invoice'], secondary: ['packing_list'] },
  { id: 'B5', fileMatch: '125423', types: ['delivery_note'] },
  { id: 'C1a', fileMatch: '104005', types: ['vehicle_registration'] },
  { id: 'C1b', fileMatch: '104137', types: ['vehicle_registration'] }, // standalone TIR → vehicle_registration
  { id: 'C2a', fileMatch: '104051', types: ['driver_passport'], piiEmpty: true },
  { id: 'C2b', fileMatch: '54-173', types: ['driver_passport'], piiEmpty: true },
  { id: 'C3a', fileMatch: '115954', types: ['transport_permit'] },
  { id: 'C3b', fileMatch: '54-251', types: ['transport_permit'], secondary: ['vehicle_registration'] },
  { id: 'C3c', fileMatch: '54-319', types: ['transport_permit'], secondary: ['vehicle_registration'] },
  { id: 'D1', fileMatch: 'CMR.jpeg', types: ['cmr'] }, // p01-paper single-doc, без регрессии формы
];
