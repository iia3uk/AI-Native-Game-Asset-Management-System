import { analyzeAsset } from '../../analysis/asset-analysis.mjs'
import { isWaveArtifact, modelArtifact } from '../artifacts.mjs'

export const containerFileFolders = { png: 'Textures', wav: 'Audio', fbx: 'Models', glb: 'Previews' }

export async function pngMetrics(root, file, name, signal) {
  const { metrics } = await analyzeAsset(root, { absolute: file.path, path: name, info: file.info, ext: 'png' }, signal)
  return metrics
}

export async function validateContainerFile(root, entry, file, signal) {
  if (entry.format === 'fbx' || entry.format === 'glb') {
    return Boolean(await modelArtifact(root, entry.file, entry.format, signal))
  }
  if (entry.format === 'png') {
    const metrics = await pngMetrics(root, file, entry.path, signal)
    return metrics.width > 0 && metrics.height > 0
  }
  return entry.format === 'wav' && await isWaveArtifact(file)
}
