const artifactStatus = {
  ready: 'Оригинал', converted: 'Сконвертирован', extracted: 'Извлечён',
  'requires-tool': 'Требуется Blender', 'missing-dependencies': 'Отсутствуют зависимости',
  unsupported: 'Не поддерживается', failed: 'Ошибка',
}

export function appendManifest({ details, record, json, element, button, assetStatus }) {
  const list = element('ul')
  const more = button('Показать файлы', () => void load())
  let offset = 0
  let loading = false
  async function load() {
    if (loading) return
    loading = more.disabled = true
    try {
      const page = await json('/api/index/jobs/' + record.id + '/manifest?offset=' + offset)
      for (const asset of page.assets) {
        const row = element('li', asset.sourcePath + ' · ' + (assetStatus[asset.status] ?? asset.status))
        const artifacts = (asset.exports ?? []).filter(item => item.format !== 'meta')
        if (artifacts.length) {
          const results = element('ul')
          for (const item of artifacts) {
            results.append(element('li', item.format.toUpperCase() + ' · ' + (artifactStatus[item.status] ?? item.status) +
              (item.path ? ' · ' + item.path : '') + (item.issue ? ' · ' + item.issue : '')))
          }
          row.append(results)
        }
        list.append(row)
      }
      if (page.nextOffset === null) more.remove()
      else {
        offset = page.nextOffset
        more.textContent = 'Показать ещё'
      }
    } catch (error) {
      more.textContent = 'Повторить загрузку файлов'
      more.title = error.message
    } finally {
      loading = more.disabled = false
    }
  }
  details.append(list, more)
}
