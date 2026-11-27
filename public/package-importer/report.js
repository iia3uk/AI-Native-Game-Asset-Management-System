const artifactStatus = {
  ready: 'Оригинал', converted: 'Сконвертирован', extracted: 'Извлечён',
  'requires-tool': 'Требуется Blender', 'missing-dependencies': 'Отсутствуют зависимости',
  unsupported: 'Не поддерживается', failed: 'Ошибка',
}

const unityIssues = {
  'unity-version-unavailable': 'Запрошенная версия Unity недоступна',
  'unity-editor-unavailable': 'Подходящий Unity Editor не найден',
  'unity-editor-timeout': 'Истекло время ожидания Unity Editor',
  'unity-editor-failed': 'Ошибка запуска или работы Unity Editor',
  'unity-serialization-excluded': 'Формат или компоненты файла исключены из импорта в Unity',
  'unity-texture-png-unavailable': 'Unity не смогла сохранить эту текстуру в PNG',
  'unity-animation-requires-target-rig': 'Для анимации требуется исходный риг',
  'unity-synthetic-animation-hierarchy': 'Иерархия анимации восстановлена по путям объектов',
}

const artifactRoles = {
  prefab: 'Префаб', component: 'Компонент', mesh: 'Меш',
  animation: 'Анимация', texture: 'Текстура', material: 'Материал',
}

export const describeIssue = issue => unityIssues[issue] ?? issue

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
        const issues = (asset.issues ?? []).filter(issue => issue.startsWith('unity-'))
        if (issues.length) row.append(element('p', issues.map(describeIssue).join(' · ')))
        const artifacts = (asset.exports ?? []).filter(item => item.format !== 'meta')
        if (artifacts.length) {
          const results = element('ul')
          for (const item of artifacts) {
            const label = artifactRoles[item.role] && [artifactRoles[item.role], item.name].filter(Boolean).join(' ')
            results.append(element('li', [
              item.format.toUpperCase(), label, artifactStatus[item.status] ?? item.status, item.path,
              ...[item.issue, ...(item.issues ?? [])].filter(Boolean).map(describeIssue),
            ].filter(Boolean).join(' · ')))
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
