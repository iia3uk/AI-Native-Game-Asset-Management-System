import { extname } from 'node:path'
import { modelFormats, imageFormats, audioFormats, unityDataFormats as unityData } from '../../files/formats.mjs'

export function classification(path, folder) {
  if (folder) return { kind: 'folder', status: 'ready' }
  const ext = extname(path).slice(1).toLowerCase()
  if (modelFormats.has(ext)) return { kind: 'model', status: 'extracted' }
  if (imageFormats.has(ext) && ext !== 'svg') return { kind: 'texture', status: 'extracted' }
  if (audioFormats.has(ext)) return { kind: 'audio', status: 'extracted' }
  if (unityData.has(ext)) {
    const kind = ({ mat: 'material', anim: 'animation', prefab: 'prefab', unity: 'scene' })[ext] ?? 'unity-data'
    return { kind, status: ['mat', 'anim'].includes(ext) ? 'extracted' : 'requires-engine' }
  }
  if (['bin', 'mtl', 'txt', 'md', 'pdf'].includes(ext)) return { kind: 'support', status: 'extracted' }
  return { kind: 'unsupported', status: 'unsupported' }
}

export function unitySummary({ assets, ...source }) {
  return { ...source, total: assets.length,
    assets: assets.slice(0, 500).map(({ payload, meta, preview, ...publicFields }) => publicFields) }
}
