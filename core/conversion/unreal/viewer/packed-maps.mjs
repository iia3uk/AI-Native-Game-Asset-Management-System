import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileInfo } from '../../../files/asset-files.mjs'
import { encodePngScanlines } from '../../../files/png.mjs'
import { readPngRgb } from '../../../files/png-rgb.mjs'
import { embeddedPng } from '../../../files/png-structure.mjs'
import { choosePackedMap, ormChannels, ormSources } from '../../../materials/unreal/packed-layout.mjs'

const maxInput = 64 * 1024 ** 2

function ormPng(image, order, signal) {
  const { width, height, channels, rows, rowBytes } = image
  const outputStride = width * 3 + 1
  const scanlines = Buffer.alloc(outputStride * height)
  for (let y = 0; y < height; y++) {
    signal?.throwIfAborted()
    let from = y * rowBytes + 1
    let to = y * outputStride + 1
    for (let x = 0; x < width; x++) {
      scanlines[to] = rows[from + order[0]]
      scanlines[to + 1] = rows[from + order[1]]
      scanlines[to + 2] = rows[from + order[2]]
      from += channels
      to += 3
    }
  }
  return encodePngScanlines(width, height, scanlines)
}

export async function publishPackedMap(description, { cache, resolve, store, workspace, version, signal, counts }) {
  const selected = choosePackedMap(description.bindings)
  if (!selected) return null
  if (!selected.binding) return { status: 'unresolved', issue: selected.issue }
  const { layout, sourcePath, path, textureId } = selected.binding
  const source = { sourcePath, sourceLayout: layout, sourceImage: path }
  const key = textureId + ':' + layout
  if (cache.has(key)) return cache.get(key)

  const failed = issue => ({ ...source, status: 'unresolved', issue })
  const ready = path => ({ ...source, status: 'resolved', path, layout: 'ORM', channels: ormChannels, colorSpace: 'linear' })
  const result = await prepare()
  cache.set(key, result)
  return result

  async function prepare() {
    const file = await fileInfo(store.root, path)
    if (!file || file.info.size > maxInput) return failed('unreal-packed-material-image-unsupported')
    const bytes = await readFile(file.path, { signal })
    if (layout === 'ORM') {
      if (![2, 6].includes(bytes[25]) || embeddedPng(bytes, 0)?.end !== bytes.length) {
        return failed('unreal-packed-material-image-unsupported')
      }
      return ready(path)
    }
    const image = readPngRgb(bytes, signal)
    if (!image) return failed('unreal-packed-material-image-unsupported')
    const data = ormPng(image, ormSources[layout], signal)
    const issue = await store.preflight(data.length)
    if (issue) return failed(issue)
    const scratch = join(workspace, 'packed-' + textureId + '-' + layout + '.png')
    await writeFile(scratch, data, { flag: 'wx', signal })
    const target = 'Textures/' + textureId + '/orm-from-' + layout.toLowerCase() + '.png'
    const artifact = await store.save(target, { path: scratch, info: { size: data.length } }, {
      status: 'converted', method: 'unreal-packed-texture', converterVersion: version, format: 'png',
      role: 'preview-texture', width: image.width, height: image.height, from: path, sourceLayout: layout,
      layout: 'ORM', colorSpace: 'linear', channels: ormChannels,
    })
    const texture = resolve(sourcePath)
    texture.exports.push(artifact)
    if (!artifact.path) return failed(artifact.issue)
    counts.repackedMaps++
    return ready(artifact.path)
  }
}
