import { basename, dirname } from 'node:path'
import { unityDataFormats } from '../../files/formats.mjs'
import { unrealFileType } from '../unreal/source.mjs'
import { isUnrealLoose, unrealLooseSource } from '../unreal/loose/source.mjs'
import { unityFolderLayout } from '../unity/folder/layout.mjs'
import { watchedPackageRecipe } from '../watch-formats.mjs'
import { relativeSourcePath } from './files.mjs'

const derivatives = new Set(['fbx', 'glb', 'png', 'tga', 'tiff', 'exr', 'wav', 'ogg', 'flac'])
const unityFolder = format => format === 'unity-project' || format === 'unity-upm'
const published = item => item?.path && ['converted', 'extracted', 'ready'].includes(item.status)
const original = asset => asset.output && { path: asset.output, size: asset.size, sha256: asset.hash }
const exportsOf = asset => [asset.artifact, ...(asset.exports ?? [])].filter(published)

export function cleanupEngine(format) {
  if (isUnrealLoose(format) || format === 'unreal-pak') return 'unreal'
  if (unityFolder(format) || ['unitypackage', 'unityfs', 'unity-serialized'].includes(format)) return 'unity'
  return null
}

export async function* cleanupCandidates(format, source, manifest, assets, selectedDirectory, signal) {
  if (isUnrealLoose(format) || unityFolder(format)) {
    const unreal = isUnrealLoose(format)
    const directory = format === 'unreal-content' || unityFolder(format) || selectedDirectory === true
    const input = { root: directory ? source : dirname(source), path: source, directory }
    const loose = unreal && await unrealLooseSource(input, signal)
    if (unreal && loose?.format !== format) return
    const layout = !unreal && await unityFolderLayout(source, signal)
    if (!unreal && layout.format !== format) return
    for (const asset of assets) {
      signal.throwIfAborted()
      const path = asset.sourcePath
      if (!relativeSourcePath(path) || !asset.output) continue
      const type = unrealFileType(path)
      if (unreal ? type !== 'uasset' : !unityDataFormats.has(type)) continue
      const rendered = exportsOf(asset).filter(item => derivatives.has(item.format))
      if (!rendered.length) continue
      const mount = !unreal && layout.mounts.find(item => path.startsWith(item.logical + '/'))
      const root = unreal ? loose.root : mount?.path
      if (!root || (format === 'unreal-asset' && path !== basename(source))) continue
      const relative = unreal ? path : path.slice(mount.logical.length + 1)
      yield { root, path: relative, sha256: asset.hash, size: asset.size, backups: [original(asset), ...rendered] }
    }
    return
  }

  const name = basename(source)
  if (!watchedPackageRecipe(format)?.extensions.includes(unrealFileType(name))) return
  const backups = assets.flatMap(asset => [original(asset), ...exportsOf(asset)].filter(Boolean))
  if (backups.length) yield { root: dirname(source), path: name, size: manifest.source.size,
    sha256: manifest.source.contentsSha256 ?? manifest.source.sha256, backups }
}
