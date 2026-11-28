import { posix } from 'node:path'
import { packageHashPattern } from '../../packages/source.mjs'
import { catalogArtifactPath } from './documents.mjs'

export function convertedArtifacts(asset) {
  const items = asset?.exports
  return Array.isArray(items) && items.length <= 256
    ? items.filter(item => item?.status === 'converted' && catalogArtifactPath(item.path))
    : []
}

function identity(asset) {
  if (asset?.type !== 'uasset' || !packageHashPattern.test(asset.hash) ||
      !catalogArtifactPath(asset.sourcePath) || !/\.uasset$/i.test(asset.sourcePath)) return null
  return JSON.stringify([asset.hash, posix.basename(asset.sourcePath).normalize('NFC').toLowerCase()])
}

export function textureFile(file, item) {
  return file?.kind === 'image' && file.preview && file.size === item.size ? file : null
}

export function siblingTextureLookup(groups, folders, files) {
  const products = new Map()
  for (const prefix of groups.keys()) {
    const owner = folders.get(prefix)
    if (!owner) continue
    for (const asset of owner.manifest.assets) {
      const key = identity(asset)
      if (!key) continue
      for (const item of convertedArtifacts(asset)) {
        if (item.role !== 'texture') continue
        const file = textureFile(files.get(posix.join(prefix, item.path)), item)
        if (!file) continue
        if (!products.has(key)) products.set(key, new Map())
        products.get(key).set(file.id, { prefix, file })
      }
    }
  }
  return (asset, prefix) => {
    const matches = products.get(identity(asset))
    if (matches?.size !== 1) return null
    const entry = matches.values().next().value
    return entry.prefix === prefix ? null : entry.file
  }
}
