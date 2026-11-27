const artifactStatus = {
  ready: 'Оригинал', converted: 'Сконвертирован', extracted: 'Извлечён',
  'requires-tool': 'Требуется Blender', 'missing-dependencies': 'Отсутствуют зависимости',
  unsupported: 'Не поддерживается', failed: 'Ошибка',
}

const packageIssues = {
  'unity-material-yaml-unrecognized': 'Не удалось разобрать описание материала Unity',
  'unity-material-output-limit': 'Достигнут лимит описаний материалов',
  'unity-version-unavailable': 'Запрошенная версия Unity недоступна',
  'unity-editor-unavailable': 'Подходящий Unity Editor не найден',
  'unity-editor-timeout': 'Истекло время ожидания Unity Editor',
  'unity-editor-failed': 'Ошибка запуска или работы Unity Editor',
  'unity-serialization-excluded': 'Формат или компоненты файла исключены из импорта в Unity',
  'unity-texture-png-unavailable': 'Unity не смогла сохранить эту текстуру в PNG',
  'unity-animation-requires-target-rig': 'Для анимации требуется исходный риг',
  'unity-synthetic-animation-hierarchy': 'Иерархия анимации восстановлена по путям объектов',
  'unity-bundle-texture-format': 'Кодек текстуры UnityFS не поддерживается',
  'unity-bundle-texture-shape': 'Поддерживаются одиночные двумерные текстуры до 2048 × 2048',
  'unity-bundle-texture-size': 'Данных текстуры недостаточно',
  'unity-bundle-texture-stream-path': 'Текстура ссылается за пределы своего раздела UnityFS',
  'unity-bundle-texture-stream-missing': 'Раздел с данными текстуры отсутствует',
  'unity-bundle-texture-stream-range': 'Данные текстуры выходят за границы раздела',
  'unity-bundle-sprite-atlas': 'Для спрайта требуется декодирование SpriteAtlas',
  'unity-bundle-sprite-packing': 'Способ упаковки спрайта не поддерживается',
  'unity-bundle-sprite-alpha': 'Раздельный альфа-канал спрайта не поддерживается',
  'unity-bundle-sprite-texture-reference': 'Текстура спрайта недоступна в этом разделе UnityFS',
  'unity-bundle-sprite-rect': 'Область спрайта выходит за границы текстуры или задана дробными координатами',
  'unreal-pak-encrypted-entry': 'Запись зашифрована',
  'unreal-pak-invalid-payload': 'Файл не прошёл проверку формата',
  'unreal-pak-orphan-companion': 'Отсутствует связанный пакет Unreal',
  'unreal-pak-unsupported-compression': 'Тип сжатия не поддерживается',
  'unreal-pak-unsupported-entry': 'Тип файла не поддерживается',
}

const artifactRoles = {
  prefab: 'Префаб', component: 'Компонент', mesh: 'Меш',
  animation: 'Анимация', texture: 'Текстура', material: 'Материал',
}

export const describeIssue = issue => packageIssues[issue] ?? issue

export function assetLabel(asset) {
  const sprite = asset.sprite && `Спрайт ${asset.width} × ${asset.height} (текстура #${asset.sprite.texturePathId})`
  return asset.sourcePath ?? asset.path ?? [asset.name, sprite, asset.textureEncoding?.toUpperCase(),
    [asset.member, asset.pathId].filter(Boolean).join(' #')].filter(Boolean).join(' · ')
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
        const row = element('li', assetLabel(asset) + ' · ' + (assetStatus[asset.status] ?? asset.status))
        const issues = [asset.issue, ...(asset.issues ?? [])].filter(issue => /^(unity|unreal)-/.test(issue))
        if (issues.length) row.append(element('p', issues.map(describeIssue).join(' · ')))
        if (asset.materialDescription) {
          const { path, shader } = asset.materialDescription
          row.append(element('p', ['Привязки материала', shader, path].filter(Boolean).join(' · ')))
        }
        const artifacts = [asset.artifact, ...(asset.exports ?? [])].filter(item => item && item.format !== 'meta')
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
