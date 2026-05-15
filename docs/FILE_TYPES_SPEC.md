# Спецификация поддержки входящих файлов

Рабочий технический документ. Для обзорного материала «что и зачем» см.
[`INTEGRATION_TZ.md`](INTEGRATION_TZ.md). Здесь — детальные требования
по каждому формату: как детектируем, что делаем, что отвечаем на ошибку,
какие тестовые файлы нужны.

## Принципы

1. **Не доверяем `Content-Type` от клиента** — детектим по magic-bytes
   через `file-type` пакет (уже работает в `src/storage/files.ts`).
2. **Каждый формат → "канонический вид"** до основного pipeline:
   массив изображений страниц (PNG) + опционально извлечённый текст-слой.
3. **Один входной файл может породить N jobs** (split, архивы, email с
   несколькими вложениями). Сохраняем `parent_job_id` для трассировки.
4. **Ошибки — структурные коды**, не только текст. Клиенту проще
   маршрутизировать (`UNSUPPORTED_FORMAT`, `PASSWORD_REQUIRED`,
   `CORRUPTED`, `TOO_LARGE`, …).
5. **Лимиты** настраиваются через env, дефолты — для типичного потока.

## Текущее покрытие (на 2026-05-15)

Принимаем (whitelist в `ACCEPTED_DOCUMENT_MIMES`):

```
application/pdf
image/jpeg
image/png
image/bmp
image/tiff
image/webp
```

Всё что не определилось magic-bytes → `415 Unsupported Media Type`.

Не принимаем (но из реального потока надо): HEIC, DOCX, XLSX, EML, MSG,
ZIP, RAR, 7Z, encrypted PDF, multi-doc PDF.

---

## Формат-за-форматом

### PDF (native, vector text)

**Magic:** `25 50 44 46 2D` (`%PDF-`)
**MIME:** `application/pdf`
**Что делаем:**
1. `pdf-parse` пробует извлечь text-layer
2. Если есть текст и confidence ≥ `PDF_TEXT_ACCEPT_THRESHOLD` (0.9) →
   используем напрямую, OCR не нужен
3. Иначе → fallback на pdftoppm + Tesseract
**Edge cases:**
- **Encrypted (с паролем)** — `pdf-parse` бросает `PasswordException` →
  job → `failed`, `error_code=PASSWORD_REQUIRED`, в UI можно показать
  поле «введите пароль и повторите»
- **Protected (запрет extract)** — `pdf-parse` отдаёт пустую строку →
  fallback на pdftoppm (OCR на картинке обойдёт защиту)
- **Битый PDF** — `pdf-parse` падает с `InvalidPDFException` →
  `error_code=CORRUPTED`, понятный текст оператору
- **Multi-page** — обрабатывается как набор страниц, items со всех
  страниц объединяются
- **>50 МБ** — `error_code=TOO_LARGE` на этапе upload

**Текущий статус:** ✓ работает (кроме encrypted и corrupted error handling)

---

### JPG / JPEG

**Magic:** `FF D8 FF`
**MIME:** `image/jpeg`
**Что делаем:** Tesseract OCR напрямую. Auto-rotate через OSD.
**Edge cases:**
- **HEIF в JPG-обёртке** (некоторые камеры) — distinguish через EXIF, иначе
  файл откроется но Tesseract увидит белый лист
- **EXIF Orientation tag** — поворот через imagemagick перед OCR (сейчас не делаем!)
- **Прогрессивный JPEG** — Tesseract нормально читает
- **Низкое DPI** (<150) — confidence будет низкая, warning оператору

**Текущий статус:** ✓ работает базово, EXIF rotation не учитывается

---

### PNG

**Magic:** `89 50 4E 47 0D 0A 1A 0A`
**MIME:** `image/png`
**Что делаем:** Tesseract OCR.
**Edge cases:**
- **Прозрачный фон** — Tesseract может видеть текст плохо, нужен flatten
  на белый перед OCR
- **Скриншоты экрана с подсветкой** — auto-binarize помогает

**Текущий статус:** ✓ работает, прозрачность не обрабатываем

---

### BMP / TIFF / WebP

**Magic:**
- BMP: `42 4D`
- TIFF: `49 49 2A 00` (little-endian) или `4D 4D 00 2A` (big-endian)
- WebP: `52 49 46 46 .. .. .. .. 57 45 42 50` (RIFF...WEBP)
**MIME:** `image/bmp`, `image/tiff`, `image/webp`
**Что делаем:** Tesseract OCR.
**Edge cases:**
- **TIFF многостраничный** (корпоративные сканеры) — раскладываем через
  `convert` или `tiffsplit` на отдельные PNG
- **TIFF compression Group4 (fax)** — Tesseract может не поддерживать,
  конвертация через ImageMagick
- **WebP** — Tesseract 5.x читает, на 4.x нужна конвертация в PNG

**Текущий статус:** ⚠ TIFF multipage не разбивается на страницы (один tiff = одна страница в нашей логике), нужна доработка

---

### HEIC (iPhone)

**Magic:** `00 00 00 .. 66 74 79 70 68 65 69 63` (`....ftypheic`)
**MIME:** `image/heic`
**Что делаем:** Конвертация в JPG через `heif-convert` (libheif-tools)
до подачи в pipeline.
**Edge cases:**
- **HDR / Live Photo** — выбираем основной кадр, остальные игнорируем
- **HEIC vs HEIF** (subtype) — оба обрабатываем одинаково
- **Депенденс:** `apt install libheif-examples` (~5 МБ к image)

**Текущий статус:** ❌ **не принимаем**, нужно добавить

**Реализация:**
1. Расширить `ACCEPTED_DOCUMENT_MIMES` на `image/heic`
2. В `preprocess/convert.ts` новый шаг: HEIC → JPG через spawn `heif-convert`
3. Подменить `OcrInput.filePath` на путь к новому JPG, дальше обычный pipeline

---

### DOCX

**Magic:** `50 4B 03 04` (это zip), но внутри `[Content_Types].xml`
**MIME:** `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
**Что делаем:** Конвертация → PDF через `libreoffice --headless`, дальше как PDF.
**Edge cases:**
- **Защищённый DOCX** (password protect) → LibreOffice не откроет →
  `error_code=PASSWORD_REQUIRED`
- **DOCX с macros** — игнорируем, читаем только контент
- **Старый DOC (бинарный)** — `application/msword`, тоже через LibreOffice
- **Депенденс:** `apt install libreoffice` (~600 МБ к docker image — это БОЛЬНО)

**Альтернативы LibreOffice:**
- Отдельный sidecar контейнер `unoserver` — поднять рядом, дёргать через HTTP
- Отказывать и просить «сохраните как PDF из Word» — UX-фейл но 0 МБ к образу

**Текущий статус:** ❌ **не принимаем**, нужно решение по архитектуре

---

### XLSX

**Magic:** `50 4B 03 04` (zip), внутри `xl/workbook.xml`
**MIME:** `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
**Что делаем:** Аналогично DOCX — конвертация в PDF через LibreOffice.
**Edge cases:**
- **Большие листы** (10000+ строк) — конвертация в PDF может породить
  сотни страниц. Лимит N страниц после конвертации.
- **Старый XLS** — `application/vnd.ms-excel`
- **Формулы** — LibreOffice сам пересчитывает, мы видим результат

**Текущий статус:** ❌ **не принимаем**

---

### EML / MSG (email)

**Magic:**
- EML: `52 65 63 65 69 76 65 64 3A` (`Received:`) или `46 72 6F 6D 3A` (`From:`)
- MSG: `D0 CF 11 E0 A1 B1 1A E1` (OLE2 compound document)
**MIME:** `message/rfc822`, `application/vnd.ms-outlook`
**Что делаем:**
1. Парсим email через `mailparser` (Node.js, npm package)
2. Извлекаем все вложения с MIME из whitelist
3. Создаём отдельный job на каждое вложение
4. Метаданные письма (from, to, subject) пишем в `metadata` каждого job
**Edge cases:**
- **Вложения внутри вложения** (forward письма с пересылкой) — рекурсия с
  лимитом глубины (3 уровня)
- **inline images** — обычно подпись, игнорируем
- **MIME-кодированные имена файлов** (=?UTF-8?B?...?=) — декодируем
- **PGP/S-MIME подписанные** — `multipart/signed`, обрабатываем нормально

**Текущий статус:** ❌ **не принимаем**, нужно добавить
**Депенденс:** `npm install mailparser` (или `node-msgreader` для .msg)

---

### ZIP / RAR / 7Z

**Magic:**
- ZIP: `50 4B 03 04`
- RAR: `52 61 72 21 1A 07 00` (RAR4) или `52 61 72 21 1A 07 01 00` (RAR5)
- 7Z: `37 7A BC AF 27 1C`
**MIME:** `application/zip`, `application/x-rar-compressed`, `application/x-7z-compressed`
**Что делаем:**
1. Распаковываем во временную папку
2. Рекурсивно обходим, для каждого файла из whitelist создаём отдельный job
3. Метаданные архива (имя архива, путь файла в архиве) — в `metadata`
4. Если есть `manifest.json` — читаем оттуда `document_hint` и `external_id` для каждого
**Edge cases:**
- **Бомба-архив** (1 МБ → 100 ГБ после распаковки) — лимит на распакованный
  размер `MAX_UNPACKED_BYTES=500 MB`
- **Запароленный** → `error_code=PASSWORD_REQUIRED`
- **Битый архив** → `error_code=CORRUPTED`
- **Глубокая вложенность** (zip в zip в zip) — лимит глубины 3
- **Не-Windows кодировка имён файлов** в zip (CP866 от старых WinRAR) →
  принудительно UTF-8 через `unzip -O CP866` или transcoded после
- **Депенденс:** `unrar` (~1 МБ), `7z` (~3 МБ); `unzip` стандартный

**Текущий статус:** ❌ **не принимаем**

---

## Сводная таблица состояний

| Состояние | Признак | Текущая реакция | Должна быть |
|-----------|---------|------------------|-------------|
| OK PDF native | text-layer есть | ✓ | ✓ |
| OK PDF scan | text-layer пуст / cyrillic | ✓ через Tesseract | ✓ |
| Encrypted PDF | pdf-parse → exception | 💥 краш job (fail) | `error_code=PASSWORD_REQUIRED` |
| Protected PDF | pdf-parse → пустая строка | ✓ через Tesseract fallback | ✓ |
| Corrupted PDF | invalid header | 💥 краш job | `error_code=CORRUPTED` |
| HEIC | magic `....ftypheic` | 415 reject | конвертация → JPG → OCR |
| DOCX | zip с `[Content_Types].xml` | 415 reject | LibreOffice → PDF |
| EML | header `Received:` или `From:` | 415 reject | mailparser → N jobs из вложений |
| ZIP | magic `PK\x03\x04` | 415 reject (?) | unzip → N jobs |
| Empty file | size=0 | 💥 | `error_code=EMPTY_FILE` |
| Too large | >50 MB | ✓ 413 на upload | ✓ |
| Unknown | magic не найден | ✓ 415 | ✓ |

---

## Канонический интерфейс preprocess-модуля

Цель: один входной файл → массив страниц-картинок + опциональный текст-слой.

```typescript
// src/pipeline/preprocess/types.ts
export type PreprocessInput = {
  filePath: string;       // абсолютный путь к исходнику
  fileName: string;       // оригинальное имя (для логов и трассировки)
  detectedMime: string;   // от magic-bytes
};

export type PreprocessedPage = {
  index: number;          // 0-based порядковый номер
  imagePath: string;      // путь к PNG страницы (на диске)
  textLayer?: string;     // если уже есть (PDF native, OCR'd earlier)
  pageNumber?: number;    // если из multipage — оригинальный номер
};

export type PreprocessResult =
  | { kind: 'pages'; pages: PreprocessedPage[]; meta: Record<string, unknown> }
  | { kind: 'split'; childJobs: PreprocessInput[]; meta: Record<string, unknown> }
  | { kind: 'error'; code: PreprocessErrorCode; message: string };

export type PreprocessErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'PASSWORD_REQUIRED'
  | 'CORRUPTED'
  | 'EMPTY_FILE'
  | 'TOO_LARGE'
  | 'TOO_MANY_PAGES'
  | 'CONVERSION_FAILED'
  | 'BOMB_ARCHIVE';
```

Каждый формат-конвертер реализует:

```typescript
export interface FormatHandler {
  detect(input: PreprocessInput): boolean;     // matches by MIME / magic
  process(input: PreprocessInput): Promise<PreprocessResult>;
}
```

Орестратор регистрирует handlers в порядке приоритета (более специфичные
первые), на входе пайплайна находит первый matching и вызывает.

---

## Test corpus — что должно быть в репо

В `tests/fixtures/file-types/`:

```
pdf/
  native-vector.pdf        — нормальный счёт от 1С
  scanned-only.pdf         — отсканированный документ без text-layer
  mixed.pdf                — векторный с подписанной картинкой
  encrypted.pdf            — запароленный, password=test
  protected.pdf            — disable copy/print, текст видим
  multipage-3.pdf          — 3 страницы одного документа
  multidoc.pdf             — склейка 3 разных документов
  corrupted.pdf            — truncated halfway
  big.pdf                  — 30 МБ для лимит-теста (не в git, генерим на CI)

images/
  invoice.jpg              — обычный JPEG счёт
  rotated-90.jpg           — нужен auto-rotate
  iphone.heic              — iPhone-фото счёта
  scan.tiff                — одностраничный TIFF от МФУ
  scan-multi.tiff          — многостраничный TIFF
  fax.tiff                 — Group4 compression

office/
  invoice.docx             — счёт в Word
  spec.xlsx                — спецификация в Excel
  old.doc                  — бинарный DOC

emails/
  forward.eml              — переслан счёт с вложением
  multi-attachments.eml    — 3 PDF в одном письме
  outlook.msg              — Outlook .msg
  base64-attach.eml        — вложение в base64

archives/
  simple.zip               — 5 PDF в архиве
  nested.zip               — zip с zip внутри
  password.zip             — запароленный
  bomb.zip                 — 1 МБ → 50 ГБ при распаковке (для теста защиты)
  cp866.zip                — старая кодировка имён
  manifest.zip             — с manifest.json
  archive.rar              — RAR5
  archive.7z

malformed/
  fake.pdf                 — это JPG переименован в .pdf
  empty.pdf                — 0 байт
  truncated.pdf            — обрезан на середине
  executable.pdf           — .exe переименован
```

Скрипт `scripts/build-test-corpus.mjs` создаёт синтетический набор когда
он отсутствует. Для каждого формата — минимум 1 файл happy-path + 1 файл
edge-case. Под git — только маленькие (<100 КБ). Большие — генерим в CI.

---

## Дорожная карта — порядок реализации

### Спринт 1 (этой недели, P0)

| Задача | Размер | Зависимости |
|---|---|---|
| 1.1 Каркас `src/pipeline/preprocess/` + интерфейсы | 0.5 дня | — |
| 1.2 PDF handler: encrypted + corrupted error codes | 0.5 дня | 1.1 |
| 1.3 HEIC handler (heif-convert) | 0.5 дня | 1.1 |
| 1.4 Multipage TIFF разбиение | 0.5 дня | 1.1 |
| 1.5 EML/MSG handler (mailparser) | 1 день | 1.1 |
| 1.6 ZIP handler с manifest.json | 1 день | 1.1 |
| 1.7 EXIF orientation auto-rotate для JPG | 0.5 дня | — |
| 1.8 Test fixtures + corpus builder | 0.5 дня | — |
| 1.9 Интеграция preprocess в orchestrator.ts | 1 день | 1.1-1.6 |

**Итого: ~6 дней.** К концу недели: HEIC и архивы принимаем,
шифрованный PDF понятно отклоняем, email распаковывается.

### Спринт 2 (следующая неделя, P0 продолжение)

| Задача | Размер |
|---|---|
| 2.1 DOCX/XLSX handler (решение: LibreOffice vs sidecar vs deny) | 2 дня |
| 2.2 Multi-doc PDF splitter (по маркерам OCR-текста) | 2 дня |
| 2.3 Auto-rotate + deskew для скан-страниц | 1.5 дня |
| 2.4 Blank page detection | 0.5 дня |
| 2.5 Page-level quality scoring | 1 день |

**Итого: ~7 дней.**

### Спринт 3 (P1)

| Задача | Размер |
|---|---|
| 3.1 Denoise + binarize плохих сканов | 1 день |
| 3.2 Detect duplicate pages | 1 день |
| 3.3 RAR / 7Z handlers | 0.5 дня |
| 3.4 XML-парсер EDI (Диадок) | 2 дня |
| 3.5 Bomb-archive protection (лимит распакованного) | 0.5 дня |

---

## Ошибки — таксономия и UX

При `error_code` UI показывает что-то осмысленное оператору:

| Код | Сообщение оператору | Действие |
|---|---|---|
| `UNSUPPORTED_FORMAT` | «Формат файла не поддерживается. Принимаем: PDF, JPG, PNG, HEIC, DOCX, EML, ZIP» | dismiss |
| `PASSWORD_REQUIRED` | «Файл защищён паролем. Удалите защиту и загрузите снова» | поле «ввести пароль и retry» |
| `CORRUPTED` | «Файл повреждён. Скачайте оригинал заново» | dismiss |
| `EMPTY_FILE` | «Файл пустой» | dismiss |
| `TOO_LARGE` | «Размер {size} МБ, лимит {limit} МБ» | dismiss |
| `TOO_MANY_PAGES` | «Документ слишком большой ({n} страниц, лимит {limit})» | dismiss |
| `CONVERSION_FAILED` | «Не удалось преобразовать {format} в PDF. Попробуйте сохранить как PDF из исходной программы» | dismiss |
| `BOMB_ARCHIVE` | «Архив содержит слишком много данных» | dismiss |

В webhook эти коды летят в поле `error_code` (в дополнение к существующему
`error` с человеческим текстом). Это позволяет интегратору программно
маршрутизировать ошибки.

---

## Решения по открытым вопросам (дефолты от 15 мая 2026)

Принимаются как working defaults — можно пересматривать по запросу бизнеса.

1. **DOCX поддержка → sidecar-контейнер**. LibreOffice +600 МБ к основному
   image — много. Поднимаем отдельный `unoserver` container в compose,
   parsedocs шлёт DOCX через HTTP. Sidecar поднимается опционально (env
   флаг `ENABLE_DOCX_SIDECAR=true`). Если не нужно — отказываем 415 +
   «Сохраните как PDF из Word».

2. **Лимит распакованного архива → 500 МБ** (`MAX_UNPACKED_BYTES=500000000`).
   Хватит на пачку счетов за месяц (≈1000 PDF среднего размера).
   Bomb-detection: проверяем во время распаковки, прерываем при превышении.

3. **Email retention → 30 дней оригинал + после распаковки**. Сохраняем
   `.eml`/`.msg` в `parent_files` volume на тот же срок что обычные
   загруженные файлы. Это даёт оператору возможность вернуться к
   контексту (subject, sender, тело письма) при разборе.

4. **Multi-doc auto-split → авто с порогом уверенности**. Splitter ищет
   маркеры (`«СЧЁТ № »` / `«УПД № »` на странице, blank-page separator).
   Если уверенность маркера ≥0.7 — режем автоматически на N jobs. Иначе
   обрабатываем как один документ + флаг `_split_suspected=true` в
   metadata → UI показывает кнопку «разделить вручную».

5. **Pre-processing старых job'ов → не делаем**. Когда добавим HEIC/EML
   и т.д., старые jobs не трогаем. Оператор перезальёт если нужно.
   Если поломалось критично — есть `POST /jobs/:id/reprocess`.

6. **EXIF stripping → опционально через env**. Дефолт
   `STRIP_EXIF_ON_UPLOAD=true` — снимаем GPS и идентификаторы камеры
   с фото до сохранения оригинала. Для случаев когда EXIF важен
   (forensics, авторство) — выключается флагом. ImageMagick делает за
   секунды через `mogrify -strip`.

7. **Test corpus → синтетика + git**. Маленькие файлы (<100 КБ) — в
   `tests/fixtures/file-types/` под git напрямую. Большие — генерим из
   скрипта `scripts/build-test-corpus.mjs` (PDF, ZIP-бомбы, multi-page
   TIFF) при первом запуске тестов. Реальные образцы клиентов — в
   отдельный приватный репо `parsdocs-fixtures` (если потребуется,
   создадим позже).
