const channels = {
  baseColor: 'базовый цвет',
  metallicRoughness: 'металличность и шероховатость',
  occlusion: 'затенение',
  normal: 'нормали',
  emissive: 'свечение',
}

const issues = {
  'material-reference-missing': 'Материал отсутствует в импорте',
  'unsupported-shader-or-alpha': 'Шейдер или режим прозрачности не поддерживается',
  'unsupported-alpha': 'Режим смешивания не восстановлен',
  'inactive-smoothness-source': 'Источник гладкости из настроек не активирован в шейдере',
  'material-keywords': 'Вариант шейдера не подтверждён',
  'unsupported-material-feature': 'Часть свойств шейдера не восстановлена',
  'smoothness-source-unsupported': 'Исходный альфа-канал гладкости недоступен',
  'smoothness-sampling-mismatch': 'Карты гладкости и металличности используют разные параметры выборки',
  'normal-tangent-missing': 'Для карты нормалей нужны тангенты меша',
  'texture-reference-missing': 'Текстура отсутствует в импорте',
  'mesh-uv-missing': 'У меша нет UV-координат для привязки текстуры',
  'texture-format-unsupported': 'Формат или цветовое пространство карты не поддерживается',
  'texture-image-unavailable': 'Данные изображения недоступны',
  'texture-budget': 'Достигнут лимит текстур GLB',
  'texture-wrap-unsupported': 'Режим повторения текстуры не поддерживается в GLB',
  'texture-anisotropy': 'Анизотропная фильтрация текстуры не перенесена',
}

export function unityMaterialDetails(asset) {
  const maps = (asset.materialChannels ?? []).map(channel => channels[channel]).filter(Boolean)
  const notes = (asset.materialIssues ?? []).map(issue => issues[issue]).filter(Boolean)
  return [maps.length && 'Карты GLB · ' + maps.join(', '), notes.join(' · ')].filter(Boolean)
}
