const artifactStatus = {
  ready: 'Оригинал', converted: 'Сконвертирован', extracted: 'Извлечён',
  'requires-tool': 'Требуется Blender', 'missing-dependencies': 'Отсутствуют зависимости',
  unsupported: 'Не поддерживается', failed: 'Ошибка',
}

const packageIssues = {
  'metadata-guid-invalid': 'Неверный GUID в файле .meta',
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
  'unity-bundle-type-tree': 'Для объекта отсутствует поддерживаемая схема Unity',
  'unity-bundle-texture-format': 'Кодек текстуры Unity не поддерживается',
  'unity-bundle-texture-shape': 'Поддерживаются одиночные двумерные текстуры до 2048 × 2048',
  'unity-bundle-texture-size': 'Данных текстуры недостаточно',
  'unity-bundle-texture-stream-path': 'Текстура ссылается на недопустимый источник данных',
  'unity-bundle-texture-stream-missing': 'Источник данных текстуры отсутствует',
  'unity-bundle-texture-stream-range': 'Данные текстуры выходят за границы источника',
  'unity-bundle-sprite-atlas': 'Для спрайта требуется декодирование SpriteAtlas',
  'unity-bundle-sprite-packing': 'Способ упаковки спрайта не поддерживается',
  'unity-bundle-sprite-alpha': 'Раздельный альфа-канал спрайта не поддерживается',
  'unity-bundle-sprite-texture-reference': 'Текстура спрайта недоступна в этом разделе Unity',
  'unity-bundle-sprite-rect': 'Область спрайта выходит за границы текстуры или задана дробными координатами',
  'unity-bundle-audio-resource': 'В клипе отсутствует ссылка на аудиоданные',
  'unity-bundle-audio-stream-path': 'Клип ссылается на недопустимый источник аудиоданных',
  'unity-bundle-audio-stream-missing': 'Источник аудиоданных отсутствует',
  'unity-bundle-audio-stream-range': 'Аудиоданные выходят за границы источника',
  'unity-bundle-audio-bank-format': 'Версия банка аудиоданных не поддерживается',
  'unity-bundle-audio-codec': 'Для аудио Unity поддерживается PCM 16 бит',
  'unity-bundle-audio-bank-layout': 'Структура банка аудиоданных не поддерживается',
  'unity-bundle-audio-bank-size': 'Данных банка недостаточно или его размер повреждён',
  'unity-bundle-audio-metadata': 'Параметры клипа расходятся с аудиоданными',
  'unity-bundle-audio-size': 'WAV превышает лимит 32 МБ',
  'unity-bundle-audio-output': 'Экспортированный WAV не прошёл проверку',
  'unreal-pak-encrypted-entry': 'Запись зашифрована',
  'unreal-pak-invalid-payload': 'Файл не прошёл проверку формата',
  'unreal-pak-orphan-companion': 'Отсутствует связанный пакет Unreal',
  'unreal-pak-unsupported-compression': 'Тип сжатия не поддерживается',
  'unreal-pak-unsupported-entry': 'Тип файла не поддерживается',
  'unreal-editor-unavailable': 'Подходящий Unreal Editor не найден',
  'unreal-version-unavailable': 'Запрошенная версия Unreal недоступна',
  'unreal-editor-version-unsupported': 'Версия Unreal Editor не поддерживается',
  'unreal-companion-orphan': 'Отсутствует связанный пакет Unreal',
  'unreal-package-companion-ambiguous': 'Несколько исходных пакетов для одних файлов данных',
  'unreal-use-container-import': 'Контейнер можно проанализировать отдельно',
}

const artifactRoles = {
  prefab: 'Префаб', component: 'Компонент', mesh: 'Меш',
  animation: 'Анимация', texture: 'Текстура', material: 'Материал', audio: 'Аудио',
  model: 'Модель', 'skeletal-model': 'Модель со скелетом', skeleton: 'Скелет',
}

export const describeIssue = issue => packageIssues[issue] ?? issue

export function assetLabel(asset) {
  const sprite = asset.sprite && `Спрайт ${asset.width} × ${asset.height} (текстура #${asset.sprite.texturePathId})`
  const audio = asset.audio && `PCM 16 бит, ${asset.audio.sampleRate} Гц, ${asset.audio.channels} кан.`
  return asset.sourcePath ?? asset.path ?? [asset.name, sprite, audio, asset.textureEncoding?.toUpperCase(),
    asset.textureStorage === 'companion' && 'Внешние данные',
    [asset.member, asset.pathId].filter(Boolean).join(' #')].filter(Boolean).join(' · ')
}

export function appendManifest({ details, record, json, element, button, assetStatus, selectAsset }) {
  const list = element('ul')
  const more = button('Показать файлы', () => void load())
  let offset = 0
  let loading = false
  async function load() {
    if (loading) return
    loading = more.disabled = true
    try {
      const page = await json('/api/index/jobs/' + record.id + '/manifest?offset=' + offset)
      for (const [index, asset] of page.assets.entries()) {
        const name = assetLabel(asset)
        const ordinal = offset + index
        const row = element('li', name + ' · ' + (assetStatus[asset.status] ?? asset.status))
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
        if (selectAsset && (asset.output || asset.metadata || asset.preview || asset.materialDescription ||
            asset.artifact?.path || asset.exports?.some(item => item.path))) {
          const actions = element('div')
          actions.className = 'index-toolbar'
          actions.append(button('Выбрать для экспорта', () => selectAsset(ordinal, name)))
          row.append(actions)
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
