import { writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { dependencyLocation } from '../../../analysis/asset-analysis.mjs'
import { fileInfo } from '../../../files/asset-files.mjs'
import { readVerifiedFile } from '../../../files/read-verified.mjs'
import { modelArtifact } from '../../artifacts.mjs'
import { encodeGlb } from '../../glb.mjs'

const MiB = 1024 ** 2
const pngMagic = Buffer.from('89504e470d0a1a0a', 'hex')
const changed = () => new Error('Staged Unreal model dependency changed during GLB packaging')

async function readPart(root, file, signal, artifact) {
  const { hash, prefix } = await readVerifiedFile(root, file, { capture: file.info.size, changed, signal })
  if (artifact && hash !== artifact.sha256) throw changed()
  return prefix
}

export async function publishRawMeshPreview({ asset, artifact, input, output, workspace, store, signal, textureFallback }) {
  const source = await fileInfo(output, input.path)
  const binPath = artifact.path.replace(/\.gltf$/, '.bin')
  const parallel = asset.exports.find(item => item.role === 'model-buffer' && item.path === binPath)
  const bin = parallel && await fileInfo(output, binPath)
  if (!source?.info.size || source.info.size > 16 * MiB || !bin?.info.size || bin.info.size > 96 * MiB ||
      bin.info.size % 4 !== 0) return null
  const document = JSON.parse(await readPart(output, source, signal, input))
  const [buffer] = document.buffers
  if (document.buffers.length !== 1 || buffer.uri !== posix.basename(binPath) || buffer.byteLength !== bin.info.size) return null

  const images = []
  let size = bin.info.size
  for (const image of document.images ?? []) {
    const location = dependencyLocation(input.path, image.uri, { uri: true })
    if (location.location !== 'local' || !location.path.startsWith('Textures/') || !location.path.endsWith('.png')) return null
    const file = await fileInfo(output, location.path)
    if (!file?.info.size || file.info.size > 48 * MiB) return null
    images.push({ image, file })
    size += Math.ceil(file.info.size / 4) * 4
    if (size > 160 * MiB) return null
  }
  if (await store.preflight(size + source.info.size + 64 * 1024)) return null

  const parts = [await readPart(output, bin, signal, parallel)]
  let offset = bin.info.size
  for (const { image, file } of images) {
    const bytes = await readPart(output, file, signal)
    if (!bytes.subarray(0, pngMagic.length).equals(pngMagic)) return null
    const bufferView = document.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length }) - 1
    delete image.uri
    Object.assign(image, { bufferView, mimeType: 'image/png' })
    parts.push(bytes)
    const padding = (4 - bytes.length % 4) % 4
    if (padding) parts.push(Buffer.alloc(padding))
    offset += bytes.length + padding
  }
  document.buffers = [{ byteLength: size }]
  const temporary = 'raw-mesh-preview.glb'
  await writeFile(join(workspace, temporary), encodeGlb(document, parts, size), { signal })
  const file = await modelArtifact(workspace, temporary, 'glb', signal)
  if (!file) return null
  const target = ['Previews', asset.id, 'unreal-source', posix.basename(artifact.path, '.gltf') + '.glb'].join('/')
  return store.save(target, file, { format: 'glb', role: artifact.role, lod: artifact.lod,
    method: 'unreal-source-mesh', converterVersion: artifact.converterVersion, status: 'converted', from: input.path,
    metrics: { ...artifact.metrics, textures: document.textures?.length ?? 0 },
    issues: [...new Set([...artifact.issues, ...input.issues]),
      ...(textureFallback ? ['unreal-material-conversion-fallback'] : [])] })
}
