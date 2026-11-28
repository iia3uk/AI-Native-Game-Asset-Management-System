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
  'unity-bundle-sprite-atlas': 'Атлас спрайта недоступен в этом разделе Unity',
  'unity-bundle-sprite-atlas-key': 'В атласе отсутствует однозначная запись для спрайта',
  'unity-bundle-sprite-atlas-variant': 'Варианты атласов и спрайты с изменённым масштабом не поддерживаются',
  'unity-bundle-sprite-atlas-container': 'Атлас хранит разметку, отдельные спрайты и текстура обрабатываются в своих строках',
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
  'unreal-viewer-unavailable': 'UE Viewer не настроен',
  'unreal-source-mesh-time-budget': 'Достигнут лимит времени извлечения исходных мешей UE4',
  'unreal-source-mesh-timeout': 'Истекло время чтения исходного меша UE4',
  'unreal-source-mesh-worker-failed': 'Не удалось завершить декодирование исходного меша UE4',
  'unreal-source-mesh-layout': 'Структура исходного меша UE4 не поддерживается',
  'unreal-source-mesh-invalid-model': 'Геометрия исходного меша UE4 не прошла проверку',
  'unreal-source-mesh-lods-need-build': 'В пакете отсутствует геометрия некоторых LOD',
  'unreal-source-mesh-material-graphs-not-extracted': 'Из исходного меша получены слоты и ссылки на материалы',
  'unreal-source-mesh-editor-build-not-applied': 'Восстановлена исходная геометрия UE4. Сборка меша редактором не выполнялась.',
  'unreal-source-collision-layout': 'Данные коллизии UE4 имеют неподдерживаемую структуру',
  'unreal-source-collision-partial': 'Некоторые формы коллизии не удалось восстановить',
  'unreal-source-collision-preview': 'GLB коллизии не прошёл проверку',
  'unreal-source-material-time-budget': 'Достигнут лимит времени чтения материалов UE4',
  'unreal-sound-cue-time-budget': 'Достигнут лимит времени чтения SoundCue',
  'unreal-sound-cue-layout': 'Структура графа SoundCue повреждена или не поддерживается',
  'unreal-sound-cue-unsupported-node': 'Часть узлов SoundCue сохранена без настроек',
  'unreal-sound-cue-no-root': 'В SoundCue отсутствует выходной узел',
  'unreal-sound-cue-external-settings': 'Внешние настройки звука и затухания требуют Unreal',
  'unreal-sound-cue-wave-reference': 'Ссылка SoundCue на SoundWave не подтверждена',
  'unreal-sound-cue-wave-missing': 'Связанный SoundWave отсутствует в выбранной папке',
  'unreal-sound-cue-wave-unavailable': 'Связанный SoundWave найден, но WAV недоступен',
  'unreal-sound-cue-no-waves': 'В графе SoundCue нет доступных ссылок на звук',
  'unreal-viewer-no-versioned-ue4-inputs': 'Нет пакетов с поддерживаемой версией UE4',
  'unreal-viewer-space-limit': 'Недостаточно места для декодирования UE4',
  'unreal-viewer-failed': 'UE Viewer завершился с ошибкой',
  'unreal-viewer-timeout': 'Истекло время декодирования UE4',
  'unreal-viewer-invalid-model': 'Модель UE Viewer не прошла проверку',
  'unreal-viewer-invalid-animation': 'Анимация UE Viewer не прошла проверку',
  'actorx-animation-requires-compatible-skeleton': 'Для использования PSA нужен совместимый скелет',
  'actorx-sampled-bone-tracks-only': 'Восстановлены ключи костей из PSA',
  'unreal-actorx-no-compatible-skeleton': 'В пакете не найден скелет с подходящей позой привязки',
  'unreal-actorx-ambiguous-skeleton': 'Клип подходит нескольким моделям с одинаковой позой привязки',
  'unreal-actorx-unsupported-tracks': 'Ключи или настройки PSA нельзя безопасно привязать к скелету',
  'unreal-actorx-duplicate-clip': 'Имя клипа уже используется в этой модели',
  'unreal-actorx-animation-limit': 'Достигнут лимит ключей или клипов анимации',
  'unreal-animation-model-size-limit': 'Модель с анимациями превышает лимит glTF',
  'unreal-animated-derivative-fallback': 'Анимации сохранились в glTF. Blender экспортировал вариант без добавленных клипов.',
  'unreal-viewer-original-gltf-has-no-material-maps': 'Исходный glTF содержит только геометрию и данные меша',
  'unreal-viewer-texture-exported-from-decoded-mip': 'PNG восстановлен из доступного мип-уровня Unreal',
  'unreal-material-preview-approximate': 'Текстуры восстановлены по параметрам. Отображение может отличаться от Unreal.',
  'unreal-material-model-size-limit': 'Модель с описанием материалов превышает лимит glTF',
  'unreal-material-conversion-fallback': 'Blender конвертировал модель без восстановленных текстур',
  'unreal-packed-material-ambiguous': 'Указано несколько карт или схем упаковки каналов',
  'unreal-packed-material-unconfirmed': 'Карта каналов не подтверждена параметрами Unreal',
  'unreal-packed-material-missing': 'Карта каналов не найдена',
  'unreal-packed-material-image-unsupported': 'Формат PNG карты каналов не поддерживается',
  'shader-graph-not-reconstructed': 'Граф шейдера не восстановлен',
  'texture-color-space-from-parameter-role': 'Цветовое пространство определено по роли параметра',
  'normal-orientation-and-packed-channels-unverified': 'Ориентация нормалей и упаковка каналов требуют проверки',
  'normal-orientation-unverified': 'Ориентация карты нормалей требует проверки',
  'unreal-opacity-mask-neutral-color': 'Маска прозрачности восстановлена с нейтральным цветом',
  'unreal-opacity-mask-unresolved': 'Вход маски прозрачности не удалось связать с текстурой',
  'unreal-packed-shader-operations-unverified': 'Операции шейдера над каналами карты не восстановлены',
  'unreal-version-unavailable': 'Запрошенная версия Unreal недоступна',
  'unreal-editor-version-unsupported': 'Версия Unreal Editor не поддерживается',
  'unreal-companion-orphan': 'Отсутствует связанный пакет Unreal',
  'unreal-package-companion-ambiguous': 'Несколько исходных пакетов для одних файлов данных',
  'unreal-use-container-import': 'Контейнер можно проанализировать отдельно',
}

const artifactRoles = {
  prefab: 'Префаб', component: 'Компонент', mesh: 'Меш',
  animation: 'Анимация', texture: 'Текстура', material: 'Материал', audio: 'Аудио',
  model: 'Модель', 'skeletal-model': 'Модель со скелетом', skeleton: 'Скелет', 'material-source': 'Свойства материала',
  'preview-texture': 'Карта каналов для предпросмотра',
  'actorx-settings': 'Настройки PSA', 'animation-buffer': 'Ключи анимации',
  'collision-shapes': 'Данные коллизии', 'collision-preview': 'Предпросмотр коллизии',
  'sound-cue': 'Граф SoundCue',
}

export const describeIssue = issue => packageIssues[issue] ?? issue

export function assetLabel(asset) {
  const atlas = asset.sprite?.packed && `, атлас #${asset.sprite.packed.atlasPathId}`
  const sprite = asset.sprite && `Спрайт ${asset.width} × ${asset.height} (текстура #${asset.sprite.texturePathId}${atlas || ''})`
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
        if (asset.sourceRetired) row.append(element('p', 'Служебная копия исходника удалена.'))
        const issues = [...new Set([asset.issue, ...(asset.issues ?? [])])].filter(issue => /^(unity|unreal)-/.test(issue))
        if (issues.length) row.append(element('p', issues.map(describeIssue).join(' · ')))
        if (asset.materialDescription) {
          const { path, shader } = asset.materialDescription
          row.append(element('p', ['Привязки материала', shader, path].filter(Boolean).join(' · ')))
        }
        if (asset.soundCue) row.append(element('p', 'Связанных WAV · ' + asset.soundCue.linkedWaves))
        const artifacts = [asset.artifact, ...(asset.exports ?? [])].filter(item => item && item.format !== 'meta')
        if (artifacts.length) {
          const results = element('ul')
          for (const item of artifacts) {
            const role = item.method === 'unreal-normal-map' ? 'Карта нормалей OpenGL' :
              item.method === 'unreal-opacity-mask' ? 'Текстура с маской прозрачности' : artifactRoles[item.role]
            const label = role && [role, item.name].filter(Boolean).join(' ')
            results.append(element('li', [
              item.format.toUpperCase(), label, artifactStatus[item.status] ?? item.status, item.path,
              item.width && item.height && `${item.width} × ${item.height}`,
              item.audio?.bits && `PCM ${item.audio.bits} бит, ${item.audio.sampleRate} Гц, ${item.audio.channels} кан.`,
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
