import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readCookedTables } from '../../../engines/unreal/cooked-package/file.mjs'
import { boundedCookedBatch } from '../../../engines/unreal/decoder/budget.mjs'
import { looseMeshResult, looseMeshRevision } from '../../../engines/unreal/decoder/mesh-protocol.mjs'
import { cue4parseVersion, runUnrealDecoder, stageUnrealInputs } from '../../../engines/unreal/decoder/run.mjs'
import { readBoundedText } from '../../../files/asset-files.mjs'
import { publishTexturedViewerModels } from '../viewer/bind-materials.mjs'
import { cookedMeshMethod, publishCookedLod } from './geometry.mjs'

const format = 'loose-meshes'
const converterVersion = cue4parseVersion + '-mesh-' + looseMeshRevision
const classes = new Set(['StaticMesh'])
const modelMethod = 'unreal-cooked-mesh-material-binding'

async function candidates(inputs, output, signal) {
  const found = []
  for (const input of inputs) {
    signal?.throwIfAborted()
    if (input.asset.exports.some(item => item.role === 'model' && item.path && item.lod === 0)) continue
    try {
      const table = await readCookedTables(output, input.header, signal)
      if (table?.topLevel(classes)) found.push(input)
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
    }
  }
  return found
}

function recordSkip(asset, issue, summary) {
  asset.issues.push(issue)
  asset.exports.push({ method: cookedMeshMethod, converterVersion, from: asset.output, role: 'model', format: 'gltf', status: 'skipped', issue })
  summary.skipped++
}

async function materialDescriptions(records, output, resolve, models, signal) {
  const ids = new Set(records.dependencies.filter(row => row.type === 'unreal-model-material' && row.target).map(row => row.target))
  const descriptions = new Map()
  if (!models.length) return () => null
  for (const asset of records.assets) {
    signal?.throwIfAborted()
    if (!ids.has(asset.id)) continue
    const artifact = asset.exports.find(item => item.method === 'unreal-cooked-material-properties' && item.path)
    const text = artifact && await readBoundedText(output, artifact.path, 4 * 1024 ** 2)
    if (text) descriptions.set(asset.id, { asset, description: JSON.parse(text) })
  }
  return (path, asset) => descriptions.get(resolve(path, asset)?.id)
}

export async function publishCookedMeshes(inputs, { records, decoder, output, workspace, resolve, store, signal }) {
  const found = await candidates(inputs, output, signal)
  if (!found.length) return null
  const summary = { meshes: 0, gltf: 0, texturedGltf: 0, missingLods: 0, skipped: 0, failed: 0 }
  const models = []
  const resultStage = { models, summary, store }
  if (!decoder) {
    summary.issue = 'unreal-loose-meshes-unavailable'
    return resultStage
  }
  const { selected, size, files, limited } = boundedCookedBatch(found, 128)
  if (limited) summary.issue = 'unreal-loose-meshes-budget'
  const count = selected.length
  if (!count) return resultStage
  const scratch = join(workspace, format)
  await mkdir(scratch)
  try {
    const issue = await stageUnrealInputs({ root: output, size, files, count }, format, scratch, false, signal)
    const result = !issue && looseMeshResult(await runUnrealDecoder(decoder, scratch, signal), count)
    if (result?.status !== 'completed') {
      summary.issue = issue ?? result?.issue ?? 'unreal-loose-meshes-protocol'
      return resultStage
    }
    for (const [index, row] of result.entries.entries()) {
      signal?.throwIfAborted()
      const { asset } = selected[index]
      if (!row.lods) {
        recordSkip(asset, row.issue ?? 'unreal-cooked-mesh-layout', summary)
        continue
      }
      if (row.limited) summary.issue = 'unreal-cooked-mesh-limit'
      summary.missingLods += row.missing.length
      if (row.missing.length) asset.issues.push('unreal-cooked-mesh-lods-incomplete')
      const prior = models.length
      for (const product of row.lods) {
        const { artifact, issue, materialPaths } = await publishCookedLod(asset, product, {
          root: join(scratch, 'output'), scratch, store, folder: 'unreal-cooked', converterVersion, signal,
        })
        if (!artifact?.path) {
          asset.issues.push(issue ?? artifact.issue)
          summary.failed++
          continue
        }
        models.push({ asset, artifact })
        summary.gltf++
        for (const path of materialPaths) {
          const target = resolve(path, asset)
          records.dependencies.push({ source: asset.id, target: target?.id ?? null, path,
            type: 'unreal-model-material', status: target ? 'resolved' : 'missing', lod: product.lod })
        }
      }
      if (models.length > prior) summary.meshes++
    }
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 })
  }
  const materialByPath = await materialDescriptions(records, output, resolve, models, signal)
  await publishTexturedViewerModels({ models, counts: summary, records, output, workspace, store, signal,
    method: modelMethod, materialByPath })
  return resultStage
}
