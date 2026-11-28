import { fileInfo } from '../../../files/asset-files.mjs'
import { createViewerDerivatives } from '../viewer/derivatives.mjs'
import { publishCookedMeshes } from './publish.mjs'

const key = path => path.normalize('NFC').toLowerCase()
const companionTypes = ['uexp', 'ubulk', 'uptnl']

export async function publishPakMeshes(entries, eligible, { decoder, workspace, store, blender, formats, resolve, dependencies, signal }) {
  const output = store.root
  const published = new Map(entries.filter(entry => entry.artifact?.path).map(entry => [key(entry.path), entry]))
  const inputs = []
  for (const entry of eligible) {
    signal?.throwIfAborted()
    if (!entry.artifact?.path) continue
    const stem = key(entry.path).slice(0, -7)
    const header = await verifiedFile(output, entry.artifact)
    const files = new Map([['uasset', header]])
    if (!published.has(stem + '.umap')) for (const type of companionTypes) {
      const sidecar = published.get(stem + '.' + type)
      if (sidecar) files.set(type, await verifiedFile(output, sidecar.artifact))
    }
    const asset = { id: entry.id, sourcePath: entry.path, output: entry.artifact.path,
      exports: entry.exports ?? [], issues: [] }
    inputs.push({ asset, entry, header, files })
  }
  const records = { assets: entries, dependencies }
  const stage = await publishCookedMeshes(inputs, { records, decoder, output, workspace, store, signal,
    resolve: (path, asset) => resolve(asset.sourcePath, path) })
  if (!stage) return null
  stage.summary.derivatives = await createViewerDerivatives({ ...stage, output, workspace, blender, formats, signal })
  for (const { asset, entry } of inputs) {
    if (asset.exports.length) entry.exports = asset.exports
    if (asset.issues.length) entry.issues = asset.issues
  }
  return stage.summary
}

async function verifiedFile(output, artifact) {
  const file = await fileInfo(output, artifact.path)
  if (!file || file.info.size !== artifact.size) throw new Error('Published Pak package changed')
  return file
}
