import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { unrealGameAssetResolver } from '../../../engines/unreal/editor-package/game-path.mjs'
import { ExportArtifacts } from '../../artifacts.mjs'
import { publishCookedMeshes } from '../cooked-mesh/publish.mjs'
import { publishCookedMaterials } from '../cooked-material/publish.mjs'
import { readCookedMaterials } from '../cooked-material/read.mjs'
import { publishLooseCookedAudio } from './audio.mjs'
import { looseCookedInputs } from './inputs.mjs'
import { publishLooseCookedTextures } from './textures.mjs'

export async function publishLooseCooked({ records, source, decoder, output, workspace, signal }) {
  const inputs = await looseCookedInputs(records.assets, output, signal)
  if (!inputs.length) return null
  const store = new ExportArtifacts(output, signal)
  const settings = { decoder, output, workspace, store, signal }
  const textures = await publishLooseCookedTextures(inputs, settings)
  const audio = decoder ? await publishLooseCookedAudio(inputs, settings) : null
  const staged = await readCookedMaterials(inputs, output, signal)
  const assets = new Map(records.assets.filter(asset => asset.output).map(asset => [asset.id, {
    id: asset.id, path: asset.sourcePath, format: asset.type, artifact: { path: asset.output, sha256: asset.hash }, exports: asset.exports,
  }]))
  const fromPath = new Map(inputs.map(({ path, asset }) => [path, asset]))
  const resolve = unrealGameAssetResolver(records.assets, source.root)
  const resolveAsset = (from, path) => assets.get(resolve(path, fromPath.get(from))?.id) ?? null
  const scratch = join(workspace, 'loose-materials')
  await mkdir(scratch)
  const { materials, dependencies } = await publishCookedMaterials([...assets.values()], staged, scratch, store, resolveAsset, signal)
  for (const dependency of dependencies) records.dependencies.push(dependency)
  const meshes = await publishCookedMeshes(inputs, { records, decoder, output, workspace, resolve, store, signal })
  for (const { asset } of inputs) {
    if (asset.exports.some(item => item.status === 'converted')) asset.status = 'converted'
  }
  const textureRetry = textures.issue && !['unreal-loose-textures-unavailable', 'unreal-loose-textures-budget'].includes(textures.issue)
  const audioRetry = audio?.issue && audio.issue !== 'unreal-loose-audio-budget' ||
    inputs.some(({ asset }) => asset.exports.some(product => ['unreal-cooked-audio-io', 'unreal-cooked-audio-limit'].includes(product.issue)))
  const meshRetry = meshes?.summary.issue && !['unreal-loose-meshes-unavailable', 'unreal-loose-meshes-budget'].includes(meshes.summary.issue)
  const partial = Boolean(textureRetry || textures.failed || audioRetry || audio?.failed || materials.failed || materials.issue ||
    meshRetry || meshes?.summary.failed)
  return { report: { textures, materials, partial, ...(audio && Object.values(audio).some(Boolean) && { audio }),
    ...(meshes && { meshes: meshes.summary }) }, meshes }
}
