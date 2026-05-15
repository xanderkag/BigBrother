/**
 * Pre-processing pipeline — types и контракты.
 *
 * Задача слоя: один входной файл (любого поддерживаемого формата) → набор
 * canonical-страниц (PNG-картинки + опц. text-layer) перед основным
 * OCR/parse pipeline. Сюда же относятся декомпозиция архивов и email'ов
 * в N отдельных jobs, а также quality enhancement (rotate/deskew).
 *
 * Архитектура — реестр format handlers. На входе worker'а определяется
 * detected MIME, регистр ищет первый matching handler, вызывает его
 * `process()`. Результат — либо набор страниц для текущего job,
 * либо команда «создать N child-jobs», либо ошибка с кодом.
 *
 * См. docs/FILE_TYPES_SPEC.md для полной спецификации.
 */

/** Минимальные параметры обработчика — путь к файлу + что про него знаем. */
export type PreprocessInput = {
  /** Абсолютный путь к файлу на диске (worker'у должен быть доступен). */
  filePath: string;
  /** Оригинальное имя файла — для логов, трассировки, manifest-парсинга. */
  fileName: string;
  /** MIME из magic-bytes (через `file-type`), либо undefined если не определился. */
  detectedMime: string | undefined;
  /** Размер файла в байтах. */
  sizeBytes: number;
};

/**
 * Каноническая страница после preprocess. Может содержать готовый text-layer
 * (если он был в PDF native), тогда OCR-этап пропускается; иначе OCR прогоняется
 * по `imagePath`.
 */
export type PreprocessedPage = {
  /** 0-based порядок после распаковки/обработки. */
  index: number;
  /** Абсолютный путь к PNG-картинке страницы. */
  imagePath: string;
  /** Опц.: уже извлечённый text-слой (PDF native, OCR на стороне) — OCR пропускаем. */
  textLayer?: string;
  /** Опц.: оригинальный номер страницы в исходном документе (для multipage). */
  pageNumber?: number;
};

/**
 * Спецификация дочернего job (split, архив, email). После создания parent-job
 * пометится `status='split'` и не обрабатывается дальше; каждый child получает
 * `parent_job_id=<parent>` для трассировки.
 */
export type ChildJobSpec = {
  /** Путь к файлу для child-job (вытащенному из архива или email). */
  filePath: string;
  /** Оригинальное имя (логически — `vложение.pdf`, `счёт-001.pdf`). */
  fileName: string;
  /** Опционально: document_hint унаследованный из manifest.json или email subject. */
  documentHint?: string;
  /** Метаданные для child (e.g. {source_archive: '...', email_from: '...'}). */
  metadata?: Record<string, unknown>;
};

/**
 * Стандартные коды ошибок preprocess. Возвращаются в `job.error_code`
 * параллельно с человеческим `job.error`. Клиент-интегратор маршрутизирует
 * по коду, оператор видит описание в UI.
 *
 * См. docs/FILE_TYPES_SPEC.md «Ошибки — таксономия и UX» для UI-сообщений.
 */
export type PreprocessErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'PASSWORD_REQUIRED'
  | 'CORRUPTED'
  | 'EMPTY_FILE'
  | 'TOO_LARGE'
  | 'TOO_MANY_PAGES'
  | 'CONVERSION_FAILED'
  | 'BOMB_ARCHIVE'
  | 'NO_DOCUMENTS_FOUND';

/**
 * Результат работы handler'а. Три ветви:
 *   - `pages`: документ обработан как единое целое, OCR/parse продолжается
 *   - `split`: исходный файл — контейнер (архив/email), создаём N child-jobs
 *   - `error`: structural error с кодом — job → failed, фронт показывает UX
 */
export type PreprocessResult =
  | {
      kind: 'pages';
      pages: PreprocessedPage[];
      /** Дополнительная мета (например originalFormat, page count, conversion engine). */
      meta: Record<string, unknown>;
    }
  | {
      kind: 'split';
      children: ChildJobSpec[];
      meta: Record<string, unknown>;
    }
  | {
      kind: 'error';
      code: PreprocessErrorCode;
      message: string;
      /** Опц.: дополнительный контекст (e.g. `{password_hint: 'try ...'}`). */
      details?: Record<string, unknown>;
    };

/**
 * Контракт format handler'а. Каждый handler реализует:
 *   - `name`: для логов и метрик
 *   - `detect`: проверяет подходит ли он по MIME / расширению / magic
 *   - `process`: выполняет реальную работу — конвертация, decryption, split
 *
 * Регистр выбирает первый matching handler в порядке регистрации.
 * Специфичные handlers (HEIC, EML, ZIP) регистрируются ДО общих
 * (PDF, image) чтобы перехватить файлы которые могут быть и тем и другим
 * (DOCX — это zip, EML — это plaintext, нужны явные detectors).
 */
export interface FormatHandler {
  /** Стабильное имя для логов: 'pdf', 'heic', 'eml', ... */
  readonly name: string;

  /** Возвращает true если этот handler берёт файл на обработку. */
  detect(input: PreprocessInput): boolean;

  /** Реальная работа. Может занимать секунды-минуты для тяжёлых конвертаций. */
  process(input: PreprocessInput): Promise<PreprocessResult>;
}
