# Heads-up SLAI: 2 новых типа документов (2026-07-16) + полный расширенный каталог

Дата: 2026-07-16. Автор: dev-сессия парсдокс (Тайпит).
Статус: типы **уже в проде** (tier=beta), ловятся вживую. Это **аддитивно**,
действий-блокеров с вашей стороны нет — просим добавить рус. ярлыки у себя и
подтвердить, что приём не ломается (по Q-CLSF-ONTO-1 вы устойчивы к незнакомым
типам). `schema_version` остаётся **1.4** (новые значения `document_type` версию
не бампают — прецедент 2026-07-02).

---

## 1. Два новых типа (по анализу боевого прогона)

| slug | Ярлык (предлагаем) | Что это | Ключевые поля |
|---|---|---|---|
| `empty_container_return` | Инструкция по возврату порожнего контейнера | Указание по сдаче порожнего контейнера после выгрузки: терминал/депо возврата, срок, номера порожних, линия. **НЕ** транспортная накладная и **НЕ** booking. | container_numbers[], return_terminal, return_address, return_deadline, shipping_line, order_ref, instructions |
| `document_request` | Запрос документов | Запрос на предоставление/досыл документов: перечень, кто/кому, срок, ссылка на заказ. Короткое письмо-обращение, **НЕ** сам документ из перечня. | requested_documents[], order_ref, requester, recipient, deadline, subject |

Оба — `tier=beta`, `parser_kind=llm_extract`, глобальные (org=NULL). Slug'и
стабильны (не переименуем).

## 2. Полный расширенный каталог на 2026-07-16 — 51 активный тип

Свежий хвост с прошлой полной сверки (то, что стоит добавить в ваш словарь ярлыков):

- **6 ВЭД-типов** (ваш GO 2026-07-12, в проде с 2026-07-15):
  `excise_ead` (акцизный e-AD), `vehicle_registration` (СТС),
  `driver_passport` (паспорт водителя — ПДн-гейт, только `{doc_kind,country,present}`),
  `transport_permit` (дозвол), `certificate_register` (реестр сертификатов),
  `delivery_note` (расходная накладная).
- **2 новых** (2026-07-16): `empty_container_return`, `document_request` (см. §1).

Остальные 43 типа — без изменений.

<details><summary>Полный список 51 slug (для сверки словаря)</summary>

`AKT, CMR, TTN, UPD, factInvoice, invoice, bill_of_lading, cash_receipt,
commercial_invoice, customs_declaration, packing_list, payment_order, contract,
contract_addendum, contract_specification, waybill, transport_invoice,
transport_request, cert_of_origin, eac_conformity_certificate, price_list,
proforma_invoice, weighing_act, wire_transfer_application, UKD, transfer_note,
material_requisition, power_of_attorney, warehouse_receipt, warehouse_return,
booking_request, special_permit, awb, manifest, phytosanitary_certificate,
veterinary_certificate, cim, smgs, export_declaration, insurance_policy,
quality_certificate, safety_data_sheet, customs_export_ead, certificate_register,
delivery_note, driver_passport, excise_ead, transport_permit, vehicle_registration,
document_request, empty_container_return`

</details>

## 3. Что просим

1. Добавить 2 новых ярлыка в ваш словарь типов (как обычно — русские названия у вас).
2. Подтвердить, что приём v1 не ломается на этих `document_type` (по идее — да,
   вы устойчивы к незнакомым типам, но просим галочку).
3. Ничего срочного: типы уже идут в потоке, при незнакомом slug у вас карточка
   «как есть» — данные не теряются.

Ответ — как обычно, файлом `SLAI_ANSWERS_YYYY-MM-DD.md`.

— parsdocs (Тайпит)
