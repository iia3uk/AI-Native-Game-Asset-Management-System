import { posix } from 'node:path'
import { analyzeAsset } from '../../../analysis/asset-analysis.mjs'
import { fileInfo, readBoundedText } from '../../../files/asset-files.mjs'

const MiB = 1024 ** 2

export async function viewerModel(root, path, signal) {
  const file = await fileInfo(root, path)
  if (!file?.info.size || file.info.size > 16 * MiB) return null
  const text = await readBoundedText(root, path, 16 * MiB)
  let document
  try { document = JSON.parse(text) } catch { return null }
  const [buffer] = Array.isArray(document?.buffers) ? document.buffers : []
  const bin = posix.basename(path, '.gltf') + '.bin'
  if (document?.asset?.version !== '2.0' || document.buffers?.length !== 1 || buffer?.uri !== bin ||
      !Number.isInteger(buffer.byteLength) || buffer.byteLength <= 0 || buffer.byteLength > 512 * MiB ||
      !Array.isArray(document.bufferViews)) return null
  const bufferFile = await fileInfo(root, posix.join(posix.dirname(path), bin))
  if (!bufferFile || bufferFile.info.size !== buffer.byteLength ||
      !document.bufferViews.every(view => view?.buffer === 0 && Number.isInteger(view.byteLength) &&
        view.byteLength > 0 && Number.isInteger(view.byteOffset ?? 0) && (view.byteOffset ?? 0) >= 0 &&
        (view.byteOffset ?? 0) + view.byteLength <= buffer.byteLength)) return null
  const { status, metrics, dependencies, dependenciesTruncated } = await analyzeAsset(root,
    { absolute: file.path, path, info: file.info, ext: 'gltf' }, signal)
  if (status !== 'analyzed' || !(metrics.triangles > 0) || dependenciesTruncated ||
      dependencies.some(ref => ref.role !== 'buffer' && ref.location !== 'embedded')) return null
  return { file, buffer: bufferFile, bin, metrics }
}
