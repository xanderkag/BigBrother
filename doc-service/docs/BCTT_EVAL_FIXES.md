# БКТ eval классификатора v2 — результаты прогона + список правок (v2.1)

> Прогон задеплоенного классификатора v2 (commit `0999058`) на ПОЛНОМ корпусе БКТ (51 док),
> через **Yandex Vision OCR + AI Studio extract**. Источники: прогон SLAI под `slai-negabarit`
> 2026-07-13 07:45 (51 док, 42 done + 9 needs_review, 0 provалов, 0 webhook) + мои ручные прогоны
> (20 док, `POST /api/v1/jobs` + `_skip_cache`). Сверка — с ground-truth [BCTT_GROUNDTRUTH.md](./BCTT_GROUNDTRUTH.md)
> (все 51 прочитаны вручную). Форензик по каждой ошибке — документ vs полный вывод пайплайна.

## Результат (что и как разбирается)

| Класс | Итог |
|---|---|
| **ltk AUMA композиты ×18** | **18/18 ИДЕАЛЬНО** — каждый → `customs_export_ead + packing_list + commercial_invoice + contract_specification` (порядок/копии не важны) |
| **root вино/еда композиты ×6** | ядро верно (EAD [+excise] + invoice + packing + cmr [+passport]), но у **ВСЕХ 6 теряется хвостовая СТС** `vehicle_registration`; LAROCHE ещё packing |
| **oskar одиночные ×10** | **10/10** ✅ (vehicle_registration, driver_passport, transport_permit, delivery_note, customs_export_ead, cmr, commercial_invoice) |
| **mnj одиночные ×9** | **8/9** — промах viber_259; 251/319 отдали 1 тип из 2 (двойной док, защитимо) |
| **paper одиночные ×7** | **5/7** — промахи pac_2, pac_3 |

Все 6 новых типов подтверждены живьём. ПДн-гейт §8 держит (паспорта → `{doc_kind,country,present}`,
ФИО/MRZ нет). `needs_review`-гейт работает (9 неуверенных удержаны на ручную, не провалы).

## Список правок (по ROI)

### FIX-1 — vehicle_registration (СТС) хвостовой страницей липнет к соседу (P0, системный)
- **Симптом:** во ВСЕХ 6 root-композитах последняя страница (СТС, эст. Transpordiamet / лит. Registracijos)
  не выделяется отдельным сегментом — приклеивается к предыдущему (SKMBT p5→invoice, SARASA/KARINA p7→cmr,
  SICHEL p15→passport, LAROCHE p8→cmr, SUMEIRE p8→cmr).
- **Доказано:** отдельные СТС-фото классятся ВЕРНО (`vehicle_registration`: oskar 104005/104017/104137,
  mnj 100/319) → классификатор тип знает. Проблема — постраничная классификация СТС-страницы ВНУТРИ композита.
  **per-page LLM (`MULTIDOC_LLM_CLASSIFY=true`) НЕ помог** (SKMBT/SICHEL/SARASA без изменений) → OCR-ТЕКСТ
  бледной СТС-страницы слишком скуден даже для LLM-по-тексту.
- **Фикс:** классифицировать такую страницу **по ИЗОБРАЖЕНИЮ (VLM), направив VLM на Yandex** (решение
  владельца «все картинки через Yandex»). Сейчас `classifier/vlm-classify.ts` — локальная qwen3-vl +
  `VLM_CLASSIFY=false`. Нужно: (а) добавить Yandex-vision бэкенд для VLM-classify (не локальную модель);
  (б) триггерить VLM когда `page.text` скуден (< N симв.) И страница не первая (кандидат в хвостовой док);
  (в) при VLM=`vehicle_registration` — открыть новый сегмент (boundary override). Файлы: `vlm-classify.ts`,
  `multidoc/runner.ts`, `config.ts` (VLM_CLASSIFY + провайдер).

### FIX-2 — LAROCHE: packing-страница потеряна при per-page LLM OFF (P1)
- **Симптом:** packing (p6) LAROCHE не выделен на дефолте; при `MULTIDOC_LLM_CLASSIFY=true` — **возвращается**.
- **Фикс:** включать per-page LLM для композитов, но экономно — только для страниц, которые hard-boundary
  НЕ типизировал (keyword-prior gate перед LLM). Файлы: `multidoc/runner.ts`, `config.ts`.

### FIX-3 — спецификация с ссылкой «Invoice no.» → commercial_invoice (P1, дискриминатор)
- **Симптом:** viber_259 (BCS «Specification 1600151851», ЦЕН НЕТ) → `commercial_invoice`. viber_448 (тоже
  спец, без строки «Invoice no.») → `contract_specification` ВЕРНО.
- **Доказано форензиком:** в extract 259 все ценовые поля `null` (`total/currency/unit_price/total_amount`),
  но в шапке «Invoice no. 8906476747» (ссылка на родительский инвойс) перевесила keyword в сторону инвойса.
- **Фикс:** правило дискриминатора §5.3 — если ВСЕ price-поля пусты И в заголовке/первых 500 симв. есть
  `Specification/Спецификация` → демоут `commercial_invoice → contract_specification` (даже при наличии
  `Invoice no.` как ссылки). Файлы: `classifier/price-weight-signal.ts` (или keyword-post), classify-промпт.

### FIX-4 — headerless страницы-продолжения упаковочного → price_list / invoice (P2, нарезка данных)
- **Симптом:** pac_2 → `price_list`, pac_3 → `commercial_invoice` (должно `packing_list`). pac_1 (с шапкой) → верно.
- **Доказано:** pac_2/3 — страницы-продолжения одного упаковочного №25082, поданы РАЗДЕЛЬНЫМИ JPEG; шапка
  («Упаковочный лист» / «Вес нетто/брутто») только на pac_1. На изолированной странице «товар + число без
  единиц» вес неотличим от цены. Числа = кг (по родительскому доку), не цены.
- **Фикс:** в основном это **проблема нарезки данных** (многостраничный док разбит на headerless-страницы).
  (а) предпочтительно — подавать многостраничный документ ОДНИМ файлом (тогда сегментация держит его как
  единый packing_list); (б) слабый сигнал: числовые колонки БЕЗ символа валюты + наличие «паллет/нетто/брутто»
  где-либо в пакете → склонять к weight/packing, а не price_list. Файлы: `classifier` signal. Отметить как
  частично-нерешаемое per-isolated-page.

## Отдельно (не в этом списке)
- **Извлечение ПДн паспорта** (полные ФИО/номер) — гейтится **Q-VANGA-ID-1** (OPEN, ждёт ОК SLAI по
  Yandex-каналу). Флаг `ID_EXTRACT_ENABLED` OFF до подтверждения. Владелец пометил «нужно и для теста».
- **viber_251/319** (СТС+дозвол на одной физ.странице) — двойной док, §5.3 dual-content; отдаётся 1 тип из 2.
  Низкий приоритет.

## Приёмка правок
Перегнать те же 51 через `eval-bctt` (или `POST /jobs` + `_skip_cache`): FIX-1 → у 6 root-композитов
появляется `vehicle_registration` сегмент; FIX-3 → viber_259 = `contract_specification`; FIX-4 → pac_2/3 не
`price_list`/`invoice`. Все прогоны — под тестовым org без webhook (`webhook_url=null`), ПДн-паспорта не
включать до Q-VANGA-ID-1.
