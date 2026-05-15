/**
 * Registry of format handlers. Worker вызывает `dispatch(input)` который
 * находит первый matching handler и возвращает его результат. Если
 * ничего не нашлось — структурная ошибка `UNSUPPORTED_FORMAT`.
 *
 * Порядок регистрации = порядок проверки. Специфичные handlers (HEIC по
 * magic-bytes, EML по `Received:` header) идут ДО общих (image, PDF).
 *
 * Зачем не Map[mime → handler]: один MIME может быть нескольких видов
 * (zip — это и DOCX и обычный архив), нужен contextual detect через
 * чтение первых байт + дополнительные эвристики.
 */

import type { FormatHandler, PreprocessInput, PreprocessResult } from './types.js';

class HandlerRegistry {
  private readonly handlers: FormatHandler[] = [];

  /** Регистрирует handler. Порядок имеет значение — раньше = выше приоритет. */
  register(handler: FormatHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Находит подходящий handler и запускает его. Если ни один не подошёл —
   * возвращает `UNSUPPORTED_FORMAT` без падений (понятная ошибка вместо
   * исключения).
   */
  async dispatch(input: PreprocessInput): Promise<PreprocessResult> {
    if (input.sizeBytes === 0) {
      return {
        kind: 'error',
        code: 'EMPTY_FILE',
        message: 'Файл пустой (0 байт)',
      };
    }

    for (const handler of this.handlers) {
      if (handler.detect(input)) {
        return handler.process(input);
      }
    }

    return {
      kind: 'error',
      code: 'UNSUPPORTED_FORMAT',
      message: `Формат файла не поддерживается: ${input.detectedMime ?? 'неопределён'}`,
      details: { detected_mime: input.detectedMime, file_name: input.fileName },
    };
  }

  /** Для тестов и операционного интроспекта — список зарегистрированных. */
  list(): readonly { name: string }[] {
    return this.handlers.map((h) => ({ name: h.name }));
  }
}

/**
 * Singleton реестр. Handlers регистрируются при модульной загрузке —
 * см. `register-defaults.ts`. Это позволяет тестам сделать свой mini-реестр
 * через `new HandlerRegistry()` и зарегистрировать что хочется.
 */
export const preprocessRegistry = new HandlerRegistry();
export { HandlerRegistry };
