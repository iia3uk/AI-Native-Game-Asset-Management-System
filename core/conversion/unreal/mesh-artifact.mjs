import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { viewerModel } from './viewer/model.mjs'

export async function publishUnrealGeometry({ asset, scratch, store, stem, document, buffer, folder, identity, issues, signal,
  role = 'model' }) {
  const bin = stem + '.bin'
  const name = stem + '.gltf'
  const target = 'Models/' + asset.id + '/' + folder + '/'
  const json = JSON.stringify(document)
  const issue = await store.preflight(Buffer.byteLength(json) + buffer.byteLength)
  if (issue) return { issue }
  await Promise.all([writeFile(join(scratch, name), json, { signal }), writeFile(join(scratch, bin), buffer, { signal })])
  const model = await viewerModel(scratch, name, signal)
  if (!model) return { issue: 'unreal-source-mesh-invalid-model' }
  const savedBuffer = await store.save(target + bin, model.buffer, { ...identity, format: 'bin', role: 'model-buffer' })
  if (!savedBuffer.path) return { issue: savedBuffer.issue }
  const artifact = await store.save(target + name, model.file, { ...identity, format: 'gltf', role,
    metrics: model.metrics, issues })
  asset.exports.push(savedBuffer, artifact)
  return { artifact }
}
