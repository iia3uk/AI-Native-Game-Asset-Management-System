const formatter = new Intl.NumberFormat('ru-RU')
export const counts = number => formatter.format(number)
const plurals = new Intl.PluralRules('ru-RU')
export const counted = (number, one, few, many) => counts(number) + ' ' + ({ one, few, many }[plurals.select(number)] ?? many)

export const normalize = text => text.toLocaleLowerCase().trim()

export function label(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}
export const sizeLabel = size => {
  if (size >= 1024 ** 3) return (size / 1024 ** 3).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ГиБ'
  if (size >= 1024 ** 2) return (size / 1024 ** 2).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' МиБ'
  return counts(Math.ceil(size / 1024)) + ' КиБ'
}
