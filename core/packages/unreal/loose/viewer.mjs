import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ExportArtifacts } from '../../../conversion/artifacts.mjs'
import { publishTexturedViewerModels } from '../../../conversion/unreal/viewer/bind-materials.mjs'
import { publishViewerMaterials } from '../../../conversion/unreal/viewer/materials.mjs'
import { publishViewerOutputs } from '../../../conversion/unreal/viewer/publish.mjs'
import { stageViewerInputs } from '../../../engines/unreal/viewer/inputs.mjs'
import { runUnrealViewer } from '../../../engines/unreal/viewer/run.mjs'

export async function decodeLooseWithViewer({ viewer, records, output, workspace, source, signal }) {
  const directory = join(workspace, 'ue-viewer')
  await mkdir(directory)
  const input = join(directory, 'input')
  const { targets, issue } = await stageViewerInputs(records, output, input, signal)
  const store = new ExportArtifacts(output, signal)
  const base = { converterVersion: viewer.version }
  if (issue) return { models: [], store, summary: { ...base, status: 'skipped', issue } }
  const decoded = join(directory, 'decoded')
  await mkdir(decoded)
  const version = /^4\.\d{1,2}/.exec(source.association ?? '')?.[0]
  const parameters = { input, output: decoded, workspace: directory, version, signal }
  const meshes = await runUnrealViewer(viewer, parameters)
  const animations = await runUnrealViewer(viewer, { ...parameters, type: 'animations' })
  const errors = { ...(meshes && { meshes }), ...(animations && { animations }) }
  const error = meshes || animations
  const { counts, models } = await publishViewerOutputs({ targets, decoded, viewer, store, signal })
  return { models, store, parameters, targets, summary: { ...base, status: error ? 'partial' : counts.gltf || counts.psa ? 'completed' :
    'no-compatible-inputs', ...counts, ...(error && { issue: error, errors }) } }
}

export async function recoverLooseViewerMaterials({ decoded, viewer, records, output, workspace, signal }) {
  if (!decoded?.parameters) return
  const { targets, parameters, store, summary, models } = decoded
  const { counts, material } = await publishViewerMaterials({ targets, parameters, store, records, version: viewer.version, signal })
  await publishTexturedViewerModels({ models, material, counts, records, output, workspace, store, signal })
  summary.materials = counts
  if (summary.status === 'no-compatible-inputs' && (counts.materialJson || counts.texturePng)) {
    summary.status = 'completed'
  }
}
