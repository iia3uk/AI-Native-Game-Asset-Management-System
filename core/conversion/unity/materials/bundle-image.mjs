import { fileInfo } from '../../../files/asset-files.mjs'
import { readVerifiedFile } from '../../../files/read-verified.mjs'

const maxPng = 18 * 1024 ** 2
const maxModelMaps = 32 * 1024 ** 2
const maxModelPixels = 16 * 1024 ** 2
const wrapping = [10497, 33071, 33648]

export async function bundleImage(output, texture, signal) {
  const artifact = texture.artifact
  const file = await fileInfo(output, artifact.path)
  if (!file || file.info.size !== artifact.size || file.info.size > maxPng) return null
  const changed = () => new Error('Staged Unity material image changed.')
  const { prefix, hash } = await readVerifiedFile(output, file, { capture: file.info.size, changed, signal })
  if (hash !== artifact.sha256) throw changed()
  return prefix
}

export function comparableSampling(first, second) {
  if (first.id === second.id) return true
  const a = first.sampler
  const b = second.sampler
  return a && b && first.width === second.width && first.height === second.height && a.filter === b.filter &&
    a.wrapU === b.wrapU && a.wrapV === b.wrapV && a.mipmaps === b.mipmaps && a.anisotropy === b.anisotropy
}

function samplerSettings(sampling) {
  const { filter, wrapU, wrapV, mipmaps } = sampling
  if (wrapU === 3 || wrapV === 3) return null
  return {
    wrapS: wrapping[wrapU], wrapT: wrapping[wrapV],
    magFilter: filter === 0 ? 9728 : 9729,
    minFilter: mipmaps ? [9984, 9985, 9987][filter] : filter === 0 ? 9728 : 9729,
  }
}

export function bundleImages(document, data, budget) {
  const images = new Map()
  const samplers = new Map()
  const gltfImages = []
  const gltfTextures = []
  const gltfSamplers = []
  const buffers = [data]
  let binarySize = data.length
  let mapsBytes = 0
  let pixels = maxModelPixels
  return {
    buffers,
    add(key, texture, name, product, issues) {
      const sampling = texture.sampler
      if (sampling?.anisotropy > 1) issues.add('texture-anisotropy')
      if (images.has(key)) return images.get(key)
      const remaining = Math.min(maxModelMaps, budget.remaining) - mapsBytes
      if (remaining <= 0 || gltfImages.length >= 512) {
        issues.add('texture-budget')
        return undefined
      }
      let png = product
      if (typeof product === 'function') {
        const count = texture.width * texture.height
        if (count > Math.min(pixels, budget.remainingPixels)) {
          issues.add('texture-budget')
          return undefined
        }
        pixels -= count
        budget.remainingPixels -= count
        png = product()
      }
      if (png.length > remaining) {
        issues.add('texture-budget')
        return undefined
      }
      const settings = sampling && samplerSettings(sampling)
      if (sampling && !settings) {
        issues.add('texture-wrap-unsupported')
        return undefined
      }
      const samplerKey = settings && JSON.stringify(settings)
      if (samplerKey && !samplers.has(samplerKey)) {
        samplers.set(samplerKey, gltfSamplers.length)
        gltfSamplers.push(settings)
      }
      const padding = (4 - png.length % 4) % 4
      const bufferView = document.bufferViews.length
      document.bufferViews.push({ buffer: 0, byteOffset: binarySize, byteLength: png.length })
      const index = gltfImages.length
      gltfImages.push({ name, bufferView, mimeType: 'image/png' })
      gltfTextures.push({ source: index, ...(samplerKey && { sampler: samplers.get(samplerKey) }) })
      buffers.push(png, Buffer.alloc(padding))
      binarySize += png.length + padding
      mapsBytes += png.length
      images.set(key, index)
      return index
    },
    finish() {
      if (gltfImages.length) {
        document.images = gltfImages
        document.textures = gltfTextures
      }
      if (gltfSamplers.length) document.samplers = gltfSamplers
      document.buffers[0].byteLength = binarySize
      return { binarySize, mapsBytes }
    },
  }
}
