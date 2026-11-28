import { posix } from 'node:path'

const key = path => path.normalize('NFC').toLowerCase()

export function unrealGameAssetResolver(assets, root) {
  const byPath = new Map(assets.filter(asset => asset.output && asset.type === 'uasset')
    .map(asset => [key(asset.sourcePath), asset]))
  const selected = key(root.replaceAll('\\', '/').replace(/\/$/, ''))
  return path => {
    if (typeof path !== 'string' || !path.startsWith('/Game/')) return null
    const parts = path.slice(6).split('/')
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) return null
    if (parts.length === 1 && posix.basename(selected) !== 'content') return null
    for (let skip = 0; skip < parts.length; skip++) {
      if (skip && !selected.endsWith('/' + key(parts.slice(0, skip).join('/')))) continue
      const asset = byPath.get(key(parts.slice(skip).join('/') + '.uasset'))
      if (asset) return asset
    }
    return null
  }
}
