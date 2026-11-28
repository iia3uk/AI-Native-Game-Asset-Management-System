import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileInfo } from '../../../files/asset-files.mjs'
import { readVerifiedFile } from '../../../files/read-verified.mjs'
import { readPngRgb } from '../../../files/png-rgb.mjs'
import { invertNormalGreen } from '../viewer/normal-pixels.mjs'

const maxInput = 64 * 1024 ** 2

export async function publishSourceNormal(normal, { store, resolve, workspace, cache, version, signal, summary }) {
  if (!normal) return null
  const texture = resolve(normal.path)
  const original = texture?.exports.find(item => item.path && item.format === 'png' && item.role === 'texture' &&
    item.method === 'unreal-editor-source-media' && item.normalSettings && item.size <= maxInput)
  if (!original) return null
  const { normalSettings } = original
  if (!cache.has(texture.id)) cache.set(texture.id, await prepare())
  const output = cache.get(texture.id)
  return output && { ...output, sourcePath: normal.path, textureId: texture.id, definedIn: normal.definedIn,
    ...(normal.parameter && { parameter: normal.parameter }), importSettings: normalSettings, sourceImage: original.path,
    colorSpace: 'linear', texCoord: 0, convention: 'opengl' }

  async function prepare() {
    const changed = () => new Error('Staged Unreal normal image changed during conversion')
    const file = await fileInfo(store.root, original.path)
    if (!file || file.info.size !== original.size) throw changed()
    const { prefix, hash } = await readVerifiedFile(store.root, file, { capture: original.size, changed, signal })
    if (hash !== original.sha256) throw changed()
    const image = readPngRgb(prefix, signal)
    if (!image) return null
    const { width, height } = image
    if (normalSettings.flipGreenOnImport) return { path: original.path, greenInverted: false }
    // The import flag and the Unreal-to-glTF convention change each invert green once.
    const png = invertNormalGreen(image, signal)
    const issue = await store.preflight(png.length)
    if (issue) return null
    const temporary = join(workspace, texture.id + '-normal.png')
    await writeFile(temporary, png, { flag: 'wx', signal })
    const artifact = await store.save('Textures/' + texture.id + '/normal-opengl.png', {
      path: temporary, info: { size: png.length },
    }, { from: original.path, status: 'converted', format: 'png', role: 'preview-texture',
      method: 'unreal-normal-map', converterVersion: version, width, height, colorSpace: 'linear', convention: 'opengl' })
    texture.exports.push(artifact)
    if (!artifact.path) return null
    summary.normalDerivatives++
    return { path: artifact.path, greenInverted: true }
  }
}
