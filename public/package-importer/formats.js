const formats = {
  unitypackage: 'Возможный Unity Package',
  unityfs: 'UnityFS',
  'unity-serialized': 'Бинарный файл Unity',
  'unity-project': 'Проект Unity',
  'unity-upm': 'Пакет UPM',
  'unreal-pak': 'Unreal Pak',
  'unreal-iostore': 'Unreal IoStore',
  'unreal-project': 'Проект Unreal',
  'unreal-content': 'Папка ресурсов Unreal',
  'unreal-asset': 'Ресурс Unreal',
}

export const formatLabel = format => Object.hasOwn(formats, format) ? formats[format] : format
export const isUnityBinary = format => format === 'unityfs' || format === 'unity-serialized'
export const isUnityFolder = format => format === 'unity-project' || format === 'unity-upm'
export const isUnrealLoose = format => ['unreal-project', 'unreal-content', 'unreal-asset'].includes(format)
export const isUnrealArchive = format => format === 'unreal-pak' || format === 'unreal-iostore'
