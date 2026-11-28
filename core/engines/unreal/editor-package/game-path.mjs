import { posix } from 'node:path'

const key = path => path.normalize('NFC').toLowerCase()

export function unrealGameAssetResolver(assets, root) {
  const selected = key(root.replaceAll('\\', '/').replace(/\/$/, ''))
  const selectedContent = posix.basename(selected) === 'content'
  const mounts = new Set(selectedContent ? [] : assets.filter(asset => asset.type === 'uproject')
    .map(asset => posix.join(posix.dirname(key(asset.sourcePath)), 'content') + '/'))
  const scopeByPath = new Map()
  const packages = new Map()
  for (const asset of assets) {
    if (!asset.output || asset.type !== 'uasset') continue
    const path = key(asset.sourcePath)
    let scope = ''
    for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
      const prefix = path.slice(0, at + 1)
      if (mounts.has(prefix)) scope = prefix
    }
    if (!packages.has(scope)) packages.set(scope, new Map())
    packages.get(scope).set(path.slice(scope.length), asset)
    scopeByPath.set(path, scope)
  }

  return (path, from) => {
    if (typeof path !== 'string' || !path.startsWith('/Game/')) return null
    const parts = path.slice(6).split('/')
    if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) return null
    const scope = from ? scopeByPath.get(key(from.sourcePath)) : ''
    const byPath = packages.get(scope)
    if (!byPath) return null
    if (scope) return byPath.get(key(parts.join('/') + '.uasset')) ?? null
    if (parts.length === 1 && !selectedContent) return null
    for (let skip = 0; skip < parts.length; skip++) {
      if (skip && !selected.endsWith('/' + key(parts.slice(0, skip).join('/')))) continue
      const asset = byPath.get(key(parts.slice(skip).join('/') + '.uasset'))
      if (asset) return asset
    }
    return null
  }
}
