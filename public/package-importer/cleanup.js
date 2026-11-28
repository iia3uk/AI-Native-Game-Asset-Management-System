import { sizeLabel } from '../catalog/format.js'

export async function requestPackageCleanup(bridge, ids, status) {
  status.textContent = 'Проверка исходников и результатов импорта…'
  try {
    const result = await bridge.cleanupSource(ids)
    switch (result.status) {
      case 'completed':
        status.textContent = 'В корзине · ' + result.moved + ' · ' + sizeLabel(result.bytes) +
          (result.skipped ? ' · Не удалось перенести ' + result.skipped : '') +
          (!result.preferenceSaved ? ' · Настройка подтверждения не сохранилась' : '')
        break
      case 'cancelled': status.textContent = 'Исходники оставлены.'; break
      case 'empty': status.textContent = 'Нет исходников с проверенными результатами для очистки.'; break
      case 'busy': status.textContent = 'Уже выполняется проверка исходников.'; break
      default: status.textContent = 'Не удалось проверить или перенести исходники.'
    }
  } catch (error) {
    status.textContent = error.message
  }
}
