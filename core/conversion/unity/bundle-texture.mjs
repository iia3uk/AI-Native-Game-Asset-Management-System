import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileInfo } from '../../files/asset-files.mjs'
import { encodePngScanlines } from '../../files/png.mjs'
import { bundleIdentity } from './bundle-names.mjs'

export async function saveBundleTexture(asset, stage, store, { method, converterVersion }, signal) {
  const { file: staged, size: pixelBytes, ...entry } = asset
  const { width, height } = entry
  const source = await fileInfo(stage, staged)
  if (!source || source.info.size !== pixelBytes) return { ...entry, status: 'failed', issue: 'unity-bundle-texture-size' }
  const pixels = await readFile(source.path, { signal })
  if (pixels.length !== pixelBytes) return { ...entry, status: 'failed', issue: 'unity-bundle-texture-size' }
  const stride = width * 4
  const scanlines = Buffer.alloc((stride + 1) * height)
  for (let row = 0; row < height; row++) {
    const from = (height - 1 - row) * stride
    pixels.copy(scanlines, row * (stride + 1) + 1, from, from + stride)
  }
  const png = encodePngScanlines(width, height, scanlines, { alpha: true })
  const { id, label } = bundleIdentity(entry)
  const target = join(stage, id + '.png')
  await writeFile(target, png, { signal, flag: 'wx' })
  const kind = entry.sprite ? 'Sprite' : 'Texture'
  const filename = kind + (label ? '-' + label : '') + '.png'
  const artifact = await store.save('Textures/' + id + '/' + filename, await fileInfo(stage, target), {
    status: 'converted', format: 'png', method: method + '-' +
      (entry.sprite ? 'sprite-' : '') + entry.textureEncoding, converterVersion,
  })
  return { ...entry, id, status: artifact.status, artifact }
}
