/**
 * Сопоставление текстов validation-issue с ключами полей extracted —
 * единый источник. Раньше эвристика жила приватно внутри
 * ExtractedDataPanel (локальный `issueKeys`) и больше нигде; теперь ею
 * пользуется и ValidationBanner, чтобы клик по проблеме прокручивал к
 * соответствующему полю (§9 polish).
 *
 * Эвристика осознанно грубая (поиск ключевых слов в тексте): issues
 * приходят свободным текстом от валидаторов, строгой привязки issue→поле
 * в контракте нет. Возвращаем МНОЖЕСТВО ключей — одно сообщение (напр.
 * про ИНН) может относиться сразу к продавцу и покупателю.
 */
export function issueFieldKeys(issue: string): string[] {
  const keys: string[] = [];
  if (/НДС|vat/i.test(issue)) keys.push('vat');
  if (/totals?|итог/i.test(issue)) keys.push('total_with_vat');
  if (/ИНН|inn/i.test(issue)) {
    keys.push('seller.inn');
    keys.push('buyer.inn');
  }
  return keys;
}

/**
 * DOM id поля по его ключу — общий контракт между ExtractedDataPanel
 * (который проставляет id на обёртку поля) и ValidationBanner (который
 * по нему находит элемент для scrollIntoView). Точки в ключах
 * (`seller.inn`) заменяем на дефис — валидный id-селектор.
 */
export function fieldAnchorId(key: string): string {
  return `field-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}
