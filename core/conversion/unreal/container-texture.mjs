import { posix } from 'node:path'
import { fileInfo } from '../../files/asset-files.mjs'
import { pngMetrics } from './container-files.mjs'

export async function publishContainerTexture(root, store, { texture, textureIssue, path }, artifact, id,
  { method, converterVersion, outputIssue }, signal) {
  const details = { role: 'texture', format: 'png', method, converterVersion, from: artifact.path }
  if (textureIssue) return { ...details, status: 'skipped', issue: textureIssue }
  const { file: input, size, ...image } = texture
  const file = await fileInfo(root, input)
  const destination = 'Textures/' + id + '/' + posix.basename(path).slice(0, -7) + '.png'
  if (file?.info.size === size) {
    const metrics = await pngMetrics(root, file, destination, signal)
    if (metrics.width === image.width && metrics.height === image.height) {
      return store.save(destination, file, { ...details, ...image, status: 'converted' })
    }
  }
  return { ...details, status: 'failed', issue: outputIssue }
}
