import { sizeLabel } from '../catalog/format.js'

export function cleanupMessage(result) {
  const skippedExports = result?.skippedExports
    ? ' · Экспорт не подтверждён для пакетов: ' + result.skippedExports : ''
  switch (result?.status) {
    case 'completed':
      return 'В корзине · ' + result.moved + ' · ' + sizeLabel(result.bytes) +
        (result.skipped ? ' · Не удалось перенести ' + result.skipped : '') +
        (result.retired ? ' · Удалено служебных копий ' + result.retired + ' · ' + sizeLabel(result.retiredBytes) : '') +
        (result.skippedRetirement ? ' · Служебных копий оставлено ' + result.skippedRetirement : '') +
        (!result.preferenceSaved ? ' · Настройка подтверждения не сохранилась' : '') + skippedExports
    case 'cancelled': return 'Исходники оставлены.' + skippedExports
    case 'empty': return 'Нет исходников с проверенными результатами для очистки.' + skippedExports
    case 'busy': return 'Уже выполняется проверка исходников.'
    default: return 'Не удалось проверить или перенести исходники.'
  }
}

export async function requestPackageCleanup(bridge, ids, status) {
  status.textContent = 'Проверка исходников и результатов импорта…'
  try {
    status.textContent = cleanupMessage(await bridge.cleanupSource(ids))
  } catch (error) {
    status.textContent = error.message
  }
}
