const formats = {
  unitypackage: 'Возможный Unity Package',
  unityfs: 'UnityFS',
  'unity-serialized': 'Бинарный файл Unity',
  'unity-project': 'Проект Unity',
  'unity-upm': 'Пакет UPM',
  'unreal-pak': 'Unreal Pak',
}

export const formatLabel = format => Object.hasOwn(formats, format) ? formats[format] : format
export const isUnityBinary = format => format === 'unityfs' || format === 'unity-serialized'
export const isUnityFolder = format => format === 'unity-project' || format === 'unity-upm'
