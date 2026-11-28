import { posix } from 'node:path'
import { audioFormats, imageFormats, modelFormats } from '../../files/formats.mjs'

const sourceFormats = new Set([...modelFormats, ...imageFormats, ...audioFormats, 'bin', 'mtl', 'psa'])

function included(path) {
  return typeof path === 'string' && (!path.startsWith('Source/') ||
    sourceFormats.has(posix.extname(path).slice(1).toLowerCase()))
}

export function processedAssets(assets) {
  return assets.map(asset => {
    const row = { ...asset }
    if (row.output && !included(row.output)) row.output = null
    if (row.metadata && !included(row.metadata)) {
      row.metadata = null
      row.metadataHash = null
    }
    if (row.artifact?.path && !included(row.artifact.path)) row.artifact = null
    if (row.exports) row.exports = row.exports.filter(item => !item.path || included(item.path))
    return row
  })
}
