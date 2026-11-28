import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileInfo } from '../../../files/asset-files.mjs'
import { readPngRgb } from '../../../files/png-rgb.mjs'
import { readVerifiedFile } from '../../../files/read-verified.mjs'
import { invertNormalGreen } from '../viewer/normal-pixels.mjs'

export const cookedNormalMethod = 'unreal-cooked-normal-map'
const maxInput = 64 * 1024 ** 2

export async function publishCookedNormal(bindings, { cache, resolve, store, workspace, version, signal, counts }) {
  const normals = bindings.filter(binding => binding.role === 'normal')
  const [binding] = normals
  if (!binding) return null
  const { sourcePath, textureId, path } = binding
  if (normals.some(normal => normal.sourcePath !== sourcePath)) return { issue: 'unreal-cooked-normal-ambiguous' }
  if (!binding.corroborated) return { issue: 'unreal-cooked-normal-unconfirmed' }
  const texture = resolve(sourcePath)
  const original = path && texture?.exports?.find(item => item.path === path && item.role === 'texture' && item.format === 'png')
  if (!original) return { issue: 'unreal-cooked-normal-missing' }
  if (original.srgb !== false || original.pixelFormat !== 'PF_BC5' || original.normalZReconstructed !== true ||
      original.size > maxInput) return { issue: 'unreal-cooked-normal-format' }

  if (!cache.has(textureId)) cache.set(textureId, await prepare())
  return { sourcePath, textureId, sourceImage: path, ...cache.get(textureId) }

  async function prepare() {
    const changed = () => new Error('Staged Unreal cooked normal changed during conversion')
    const file = await fileInfo(store.root, path)
    if (file?.info.size !== original.size) throw changed()
    const { prefix, hash } = await readVerifiedFile(store.root, file, { capture: original.size, changed, signal })
    if (hash !== original.sha256) throw changed()
    const image = readPngRgb(prefix, signal)
    if (!image || image.width !== original.width || image.height !== original.height) return { issue: 'unreal-cooked-normal-format' }
    // Cooked pixels already contain Unreal's import-time channel adjustments.
    const png = invertNormalGreen(image, signal)
    const issue = await store.preflight(png.length)
    if (issue) return { issue }
    const scratch = join(workspace, 'normal-' + textureId + '.png')
    await writeFile(scratch, png, { flag: 'wx', signal })
    const artifact = await store.save('Textures/' + textureId + '/normal-opengl.png', { path: scratch, info: { size: png.length } }, {
      from: path, status: 'converted', format: 'png', role: 'preview-texture', method: cookedNormalMethod,
      converterVersion: version, width: image.width, height: image.height, colorSpace: 'linear', convention: 'opengl',
    })
    if (!artifact.path) return { issue: artifact.issue }
    texture.exports.push(artifact)
    counts.normalDerivatives++
    return { path: artifact.path, texCoord: 0, colorSpace: 'linear', convention: 'opengl', greenInverted: true }
  }
}
