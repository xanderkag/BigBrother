/**
 * Detection синтетических документов в UI.
 *
 * Сейчас определяется чисто по имени файла — `scripts/gen-synthetic-pdfs.mjs`
 * генерит файлы по шаблону `${type}-synth-NN.pdf` (см. line 277 в скрипте).
 * Реальные клиентские файлы могут содержать «synth» как часть бизнес-слова
 * (например `Synthetic-Materials-Invoice.pdf` от конкретного поставщика?),
 * поэтому проверяем строгий разделитель `-synth-`.
 *
 * Это compromise — самый чистый путь был бы `metadata.synthetic: true`,
 * но он требует синхронной правки скрипта генерации и backend'а. Имя
 * файла даёт мгновенный результат на всех уже сгенерированных корпусах.
 *
 * Если когда-то convention изменится — поменяем здесь. UI везде ходит
 * через эту функцию (см. JobsList и ReviewQueue), точечно обновится.
 */
export function isSynthetic(fileName: string | null | undefined): boolean {
  if (!fileName) return false;
  return /-synth-\d/i.test(fileName);
}

/**
 * Тип «происхождения» документа — для UI-фильтра.
 *   - real:  пришёл из боя (real upload / SLAI client / batch import)
 *   - synth: сгенерирован gen-synthetic-pdfs.mjs для тестов и demo
 *   - all:   обе категории (default)
 *
 * Используется в filter-strip над таблицей и URL `?origin=synth`.
 */
export type DocOrigin = 'all' | 'real' | 'synth';

export function matchesOrigin(fileName: string, origin: DocOrigin): boolean {
  if (origin === 'all') return true;
  const synth = isSynthetic(fileName);
  return origin === 'synth' ? synth : !synth;
}
