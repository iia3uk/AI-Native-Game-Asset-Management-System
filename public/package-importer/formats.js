const formats = {
  unitypackage: 'Возможный Unity Package',
  unityfs: 'UnityFS',
  'unity-serialized': 'Бинарный файл Unity',
  'unreal-pak': 'Unreal Pak',
}

export const formatLabel = format => Object.hasOwn(formats, format) ? formats[format] : format
export const isUnityBinary = format => format === 'unityfs' || format === 'unity-serialized'
