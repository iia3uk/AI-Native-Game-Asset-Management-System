import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ExportArtifacts, exportFolders } from '../../../conversion/artifacts.mjs'
import { publishUnrealArtifacts } from '../../../conversion/unreal/editor.mjs'
import { unrealPreview } from '../../../conversion/unreal/preview.mjs'
import { unrealMountName } from '../../../engines/unreal/bridge/inputs.mjs'
import { prepareUnrealExports } from '../../../engines/unreal/bridge/run.mjs'

const builtin = path => /^\/(?:Engine|Script)(?:[/.]|$)/i.test(path)

export async function convertLoosePackages({ records, selection, workspace, output, blender, formats, signal, onProgress }) {
  const source = { root: join(output, 'Source', 'Content') }
  const editorProject = join(workspace, 'editor')
  await mkdir(editorProject)
  const bridge = await prepareUnrealExports({ workspace: editorProject, source, selection, signal })
  const issues = new Map(bridge.issues.map(row => [row.sourcePath, row.issue]))
  const targets = new Map(bridge.targets.map(row => [row.sourcePath, row]))
  const gamePackages = new Map(records.assets.map(row => [unrealMountName(row.sourcePath)?.toLowerCase(), row]))
  const store = new ExportArtifacts(output, signal)
  if (bridge.summary.status === 'completed') {
    await Promise.all(exportFolders.map(folder => mkdir(join(output, folder), { recursive: true })))
  }
  let converted = 0
  for (const [index, asset] of records.assets.entries()) {
    signal?.throwIfAborted()
    const target = targets.get(asset.sourcePath)
    const result = target && bridge.results.get(target.id)
    const issue = issues.get(asset.sourcePath) ?? result?.issue ??
      (asset.output && asset.type === 'uasset' && asset.storage === 'editor' ? bridge.summary.issue : undefined)
    if (issue && !asset.issues.includes(issue)) asset.issues.push(issue)
    if (!result) continue
    const editorArtifacts = await publishUnrealArtifacts(target.id, result, bridge, store, signal)
    asset.exports.push(...editorArtifacts)
    if (formats.includes('glb')) {
      for (const artifact of editorArtifacts) {
        const preview = await unrealPreview(artifact, { blender, output, scratch: workspace, id: target.id, store, signal })
        if (preview) asset.exports.push(preview)
      }
    }
    if (asset.exports.some(artifact => artifact.status === 'converted')) {
      asset.status = 'converted'
      converted++
    }
    const linked = new Map(result.blockedDependencies.map(path => [path, 'excluded']))
    for (const { package: path, status } of result.dependencies) linked.set(path, status)
    for (const [path, editorStatus] of linked) {
      const dependency = gamePackages.get(path.toLowerCase())
      const status = builtin(path) ? 'builtin' : dependency?.output ? 'resolved' : 'missing'
      records.dependencies.push({ source: asset.id, target: dependency?.id ?? null, path, status, editorStatus,
        type: 'unreal-editor-reference' })
    }
    onProgress?.(63 + Math.floor(32 * (index + 1) / records.assets.length))
  }
  return { converted, unreal: bridge.summary }
}
