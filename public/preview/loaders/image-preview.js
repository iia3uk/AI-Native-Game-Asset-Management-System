import * as THREE from 'three'
import { TGALoader } from 'three/addons/loaders/TGALoader.js'
import { TIFFLoader } from 'three/addons/loaders/TIFFLoader.js'
import { compressedImageUrl, compressedImages } from './compressed-preview.js'

export const convertedImages = new Set(['tga', 'tif', 'tiff'])
export const decodedImages = new Set([...convertedImages, ...compressedImages, 'hdr', 'exr'])

export async function decodedImageUrl(file) {
  if (compressedImages.has(file.ext)) return compressedImageUrl(file)
  let loader
  if (file.ext === 'hdr') {
    const { HDRLoader } = await import('three/addons/loaders/HDRLoader.js')
    loader = new HDRLoader().setDataType(THREE.FloatType)
  } else if (file.ext === 'exr') {
    const { EXRLoader } = await import('three/addons/loaders/EXRLoader.js')
    loader = new EXRLoader().setDataType(THREE.FloatType)
  } else {
    loader = file.ext === 'tga' ? new TGALoader() : new TIFFLoader()
  }
  const texture = await loader.loadAsync(file.url)
  try {
    const { data, width, height } = texture.image
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    let pixels
    if (data instanceof Float32Array) {
      pixels = new Uint8ClampedArray(width * height * 4)
      const channels = data.length / (width * height)
      const srgb = value => {
        const linear = Number.isFinite(value) ? Math.max(0, value) : 0
        const tone = linear / (1 + linear)
        return 255 * (tone <= .0031308 ? 12.92 * tone : 1.055 * tone ** (1 / 2.4) - .055)
      }
      for (let index = 0; index < width * height; index++) {
        const row = Math.floor(index / width)
        const sourceRow = texture.flipY ? row : height - row - 1
        const source = (sourceRow * width + index % width) * channels
        const target = index * 4
        for (let chan = 0; chan < 3; chan++) pixels[target + chan] = srgb(data[source + (channels < 3 ? 0 : chan)])
        pixels[target + 3] = channels === 4 ? data[source + 3] * 255 : 255
      }
    } else {
      pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
    }
    canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0)
    const image = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!image) throw new Error('Не удалось подготовить изображение')
    return URL.createObjectURL(image)
  } finally {
    texture.dispose()
  }
}
