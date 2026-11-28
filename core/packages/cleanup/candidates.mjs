import { basename, dirname } from 'node:path'
import { containerFileFolders } from '../../conversion/unreal/container-files.mjs'
import { unityDataFormats } from '../../files/formats.mjs'
import { editorSkeletalMeshMethod } from '../../engines/unreal/source-mesh/run.mjs'
import { unrealFileType } from '../unreal/source.mjs'
import { isUnrealLoose, unrealLooseSource } from '../unreal/loose/source.mjs'
import { unityFolderLayout } from '../unity/folder/layout.mjs'
import { watchedPackageRecipe } from '../watch-formats.mjs'
import { relativeSourcePath } from './files.mjs'
import { unityBinaryReadyForCleanup } from './unity-binary.mjs'

const derivatives = new Set(['fbx', 'glb', 'png', 'tga', 'tiff', 'exr', 'wav', 'ogg', 'flac'])
const unityFolder = format => format === 'unity-project' || format === 'unity-upm'
const published = item => item?.path && ['converted', 'extracted', 'ready'].includes(item.status)
const original = asset => asset.output && { path: asset.output, size: asset.size, sha256: asset.hash }
const exportsOf = asset => [asset.artifact, ...(asset.exports ?? [])].filter(published)

function unrealModelBackups(exports) {
  const methods = new Set(['ue-viewer', 'unreal-source-mesh'])
  const buffers = new Map(exports.filter(item => methods.has(item.method) && item.format === 'bin')
    .map(item => [item.path, item]))
  const backups = []
  for (const item of exports) {
    if (!methods.has(item.method)) continue
    if (item.method === 'ue-viewer' && item.format === 'psa') {
      const config = item.settingsPath && exports.find(row => row.path === item.settingsPath &&
        row.role === 'actorx-settings' && row.method === item.method)
      if (!item.settingsPath || config) backups.push(item, ...(config ? [config] : []))
    }
    if (item.format === 'gltf' && item.path.endsWith('.gltf')) {
      const buffer = buffers.get(item.path.slice(0, -5) + '.bin')
      if (buffer?.method === item.method) backups.push(item, buffer)
    }
  }
  return backups
}

function unrealCollisionBackups(exports) {
  const description = exports.find(item => item.method === 'unreal-source-collision' && item.role === 'collision-shapes')
  const preview = exports.find(item => item.method === 'unreal-source-collision' && item.role === 'collision-preview')
  if (preview) return description && preview.settingsPath === description.path ? [description, preview] : null
  if (description) return description.shapes === 0 ? [description] : null
  return []
}

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
      if (unreal ? type !== 'uasset' || asset.storage === 'cooked' : !unityDataFormats.has(type)) continue
      const exports = exportsOf(asset)
      if (unreal && exports.some(item => item.method === editorSkeletalMeshMethod)) continue
      const rendered = exports.filter(item => derivatives.has(item.format) && item.role !== 'collision-preview')
      if (unreal) rendered.push(...unrealModelBackups(exports))
      if (!rendered.length) continue
      const collision = unreal ? unrealCollisionBackups(exports) : []
      if (!collision || (unreal && asset.collisionIssue)) continue
      const mount = !unreal && layout.mounts.find(item => path.startsWith(item.logical + '/'))
      const root = unreal ? loose.root : mount?.path
      if (!root || (format === 'unreal-asset' && path !== basename(source))) continue
      const relative = unreal ? path : path.slice(mount.logical.length + 1)
      const nativeCopy = original(asset)
      yield { root, path: relative, sha256: asset.hash, size: asset.size, backups: [nativeCopy, ...rendered, ...collision], nativeCopy }
    }
    return
  }

  const name = basename(source)
  if (!watchedPackageRecipe(format)?.extensions.includes(unrealFileType(name))) return
  if (format === 'unreal-pak' && !assets.every(asset => asset.status === 'extracted' &&
    Object.hasOwn(containerFileFolders, asset.format) && published(asset.artifact) && !asset.artifact.path.startsWith('Source/'))) return
  if (['unityfs', 'unity-serialized'].includes(format) && !unityBinaryReadyForCleanup(assets)) return
  const backups = assets.flatMap(asset => [original(asset), ...exportsOf(asset)].filter(Boolean))
  if (backups.length) yield { root: dirname(source), path: name, size: manifest.source.size,
    sha256: manifest.source.contentsSha256 ?? manifest.source.sha256, backups }
}
