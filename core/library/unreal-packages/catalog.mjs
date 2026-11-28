import { basename, posix } from 'node:path'
import { packageHashPattern } from '../../packages/source.mjs'
import { catalogArtifactPath, catalogJson } from './documents.mjs'
import { attachExportMaterials } from './export-materials.mjs'
import { siblingTextureLookup } from './texture-products.mjs'
import { attachViewerMaterials } from './viewer-materials.mjs'

const bundlePattern = /^(?:.*\/)?AssetViewer-(.+)-[a-z\d]{6}\/Package$/i
const wrapperPattern = /^AssetViewer-(.+)-[a-z\d]{6}$/i
const outputFolders = new Set(['Animations', 'Audio', 'Materials', 'Metadata', 'Models', 'Previews', 'Source', 'Textures', 'UEViewer'])
const formats = new Set(['unreal-asset', 'unreal-content', 'unreal-project'])
const fallbackGroup = path => path.includes('/') ? path.split('/')[0] : ''

function candidate(path) {
  const parts = path.split('/')
  if (parts.length > 1 && outputFolders.has(parts[0])) return ''
  if (parts.length > 2 && outputFolders.has(parts[1])) return parts[0]
  for (const [index, part] of parts.entries()) {
    if (part === 'Package' && wrapperPattern.test(parts[index - 1] ?? '') && outputFolders.has(parts[index + 1])) {
      return parts.slice(0, index + 1).join('/')
    }
  }
  return null
}

export async function groupLocalPackages(root, files) {
  const folders = new Map()
  for (const file of files.values()) {
    const folder = candidate(file.path)
    if (folder !== null) folders.set(folder, null)
  }
  for (const prefix of [...folders.keys()].slice(0, 128)) {
    if (prefix && !catalogArtifactPath(prefix)) continue
    const manifest = await catalogJson(root, posix.join(prefix, 'manifest.json'), 16 * 1024 ** 2)
    if (!formats.has(manifest?.source?.format) || !packageHashPattern.test(manifest.source.sha256) ||
        !Array.isArray(manifest.assets) || manifest.assets.length > 10_000) continue
    const exportedName = bundlePattern.exec(prefix)?.[1] ||
      (prefix === 'Package' && wrapperPattern.exec(basename(root))?.[1])
    folders.set(prefix, { prefix, manifest, title: exportedName ? exportedName + ' · Экспорт' : null })
  }

  const groups = new Map()
  for (const file of files.values()) {
    let prefix = posix.dirname(file.path)
    let owner
    while (prefix !== '.') {
      owner = folders.get(prefix)
      if (owner) break
      prefix = posix.dirname(prefix)
    }
    owner ??= folders.get('')
    const key = owner?.prefix ?? fallbackGroup(file.path)
    if (!groups.has(key)) groups.set(key, { files: [], title: owner?.title })
    groups.get(key).files.push(file)
  }
  const siblingTexture = siblingTextureLookup(groups, folders, files)
  for (const [prefix, group] of groups) {
    await attachViewerMaterials(root, prefix, group.files)
    const owner = folders.get(prefix)
    if (owner) await attachExportMaterials(root, owner, group.files, siblingTexture)
  }
  return groups
}
