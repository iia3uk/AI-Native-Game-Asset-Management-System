import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileInfo } from '../../files/asset-files.mjs'
import { encodePngScanlines } from '../../files/png.mjs'

export async function saveBundleTexture(asset, stage, store, converterVersion, signal) {
  const { file: staged, ...entry } = asset
  const { width, height, member, pathId } = entry
  const source = await fileInfo(stage, staged)
  const pixelBytes = width * height * 4
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
  const id = createHash('sha256').update(member + ':' + pathId).digest('hex').slice(0, 32)
  const name = Array.from(asset.name.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f]/g, '_'))
    .slice(0, 72).join('').replace(/^[. ]+|[. ]+$/g, '')
  const target = join(stage, id + '.png')
  await writeFile(target, png, { signal, flag: 'wx' })
  const filename = name ? 'Texture-' + name + '.png' : 'Texture.png'
  const artifact = await store.save('Textures/' + id + '/' + filename, await fileInfo(stage, target), {
    status: 'converted', format: 'png', method: 'assetstools-unityfs-rgba32', converterVersion,
  })
  return { ...entry, id, status: artifact.status, artifact }
}
