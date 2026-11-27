import { analyzeAsset } from '../../analysis/asset-analysis.mjs'
import { fileInfo, readBoundedText } from '../../files/asset-files.mjs'
import { isWaveArtifact, modelArtifact } from '../artifacts.mjs'

const folders = { model: 'Models', 'skeletal-model': 'Models', animation: 'Animations',
  texture: 'Textures', audio: 'Audio', skeleton: 'Metadata', material: 'Materials' }

async function verifyOutput(root, path, product, signal) {
  if (product.format === 'fbx') return modelArtifact(root, path, 'fbx', signal)
  const file = await fileInfo(root, path)
  if (!file?.info.size || file.info.size > 512 * 1024 ** 2) return null
  if (product.format === 'png') {
    const { metrics } = await analyzeAsset(root, { absolute: file.path, path, info: file.info, ext: 'png' }, signal)
    return metrics.width > 0 && metrics.height > 0 &&
      metrics.width === product.width && metrics.height === product.height ? file : null
  }
  if (product.format === 'wav') return await isWaveArtifact(file) ? file : null
  try {
    const metadata = JSON.parse(await readBoundedText(root, path, 1024 ** 2))
    return metadata?.objectPath === product.objectPath && metadata?.className === product.className &&
      (product.role !== 'material' || Array.isArray(metadata.textures)) ? file : null
  } catch {
    return null
  }
}

export async function publishUnrealArtifacts(id, result, bridge, store, signal) {
  const artifacts = []
  for (const { number, issue, ...product } of result.products) {
    signal?.throwIfAborted()
    const identity = { ...product, method: 'unreal-editor', editorVersion: bridge.summary.engineVersion }
    const name = number + '.' + product.format
    const file = !issue && await verifyOutput(bridge.outputRoot, id + '/' + name, product, signal)
    const path = [folders[product.role], id, product.role + '-' + name].join('/')
    artifacts.push(file
      ? await store.save(path, file, { ...identity, status: 'converted' })
      : { ...identity, status: 'failed', issue: issue || 'unreal-output-invalid' })
  }
  return artifacts
}
