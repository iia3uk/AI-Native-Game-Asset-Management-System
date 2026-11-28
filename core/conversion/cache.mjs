import { createHash } from 'node:crypto'
import { fileInfo } from '../files/asset-files.mjs'
import { artifactHash } from './artifacts.mjs'
import { packageExportVersion } from './formats.mjs'

const hashPattern = /^[0-9a-f]{64}$/

export function exportRecipe(formats, blender, engine) {
  const recipe = [packageExportVersion, formats, blender?.identity ?? null]
  if (engine) recipe.push(engine)
  if (blender?.fbxRevision && formats.includes('fbx')) recipe.push(['blender-fbx', blender.fbxRevision])
  return createHash('sha256').update(JSON.stringify(recipe))
    .digest('hex').slice(0, 24)
}

export async function verifyExports(root, entries, signal) {
  if (!Array.isArray(entries)) return false
  const matches = async (path, hash, size) => {
    signal?.throwIfAborted()
    if (typeof path !== 'string' || typeof hash !== 'string' || !hashPattern.test(hash)) return false
    const file = await fileInfo(root, path)
    return Boolean(file && (size === undefined || file.info.size === size) && await artifactHash(file.path, signal) === hash)
  }
  for (const entry of entries) {
    if (!Array.isArray(entry.exports)) return false
    if ((entry.output && !await matches(entry.output, entry.hash, entry.size)) ||
        (entry.metadata && !await matches(entry.metadata, entry.metadataHash)) ||
        (entry.preview && !await matches(entry.preview, entry.previewHash))) return false
    for (const artifact of entry.exports) {
      if (artifact.path && !await matches(artifact.path, artifact.sha256, artifact.size)) return false
    }
  }
  return true
}
