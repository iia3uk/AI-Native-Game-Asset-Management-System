import { basename } from 'node:path'
import { pathKey } from '../../files/asset-files.mjs'
import { unityFolderFormat } from '../unity/folder/layout.mjs'
import { unrealFileType } from '../unreal/source.mjs'

export class PackageFolders {
  #folders = []

  async visit(path, parent) {
    const unity = await unityFolderFormat(path)
    const node = { path, parent, unity, children: [], loose: [], descriptors: [] }
    this.#folders.push(node)
    parent?.children.push(node)
    return node
  }

  recordFile(folder, file, format) {
    if (format === 'unreal-asset') folder.loose.push(file)
    if (unrealFileType(file) === 'uproject') folder.descriptors.push(file)
  }

  scopes() {
    const candidates = []
    // Resolve project boundaries before choosing a common root for loose assets.
    for (const node of this.#folders.slice().reverse()) {
      if (node.unity) {
        candidates.push({ path: node.path, format: node.unity })
        node.claimed = true
        continue
      }
      const looseChildren = node.children.filter(child => child.looseTree)
      const hasLoose = node.loose.length || looseChildren.length
      const content = basename(node.path).toLowerCase() === 'content'
      const split = node.excluded || node.children.some(child => child.claimed)
      if (hasLoose && content && !split) {
        const parent = node.parent
        const descriptor = parent?.descriptors.length === 1 && pathKey(basename(node.path)) === pathKey('Content') &&
          !parent.excluded && parent.descriptors[0]
        candidates.push(descriptor ? { path: descriptor, format: 'unreal-project' } : scope(node))
        node.claimed = true
      } else if (split || node.descriptors.length) {
        // A wider directory import would include a separately claimed project or managed folder.
        candidates.push(...looseChildren.map(scope))
        candidates.push(...node.loose.map(path => ({ path, format: 'unreal-asset' })))
        node.claimed = true
      } else if (hasLoose) {
        if (node.parent) node.looseTree = true
        else candidates.push(scope(node))
      }
    }
    return candidates
  }
}

function scope({ path }) {
  return { path, format: 'unreal-content' }
}
