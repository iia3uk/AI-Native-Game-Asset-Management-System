import * as THREE from 'three'
import { TGALoader } from 'three/addons/loaders/TGALoader.js'
import { FbxTgaLoader, FbxTiffLoader, ViewerTiffLoader } from './fbx-images.js'
import { closest } from '../resource-proximity.js'

export function resolveResources(file, files) {
  const manager = new THREE.LoadingManager()
  const objectUrls = new Set()
  let pending, finish
  manager.onStart = () => { pending ??= new Promise(resolve => { finish = resolve }) }
  manager.onLoad = () => { finish?.(); pending = finish = null }
  const tga = file.ext === 'fbx' ? new FbxTgaLoader(manager) : new TGALoader(manager)
  manager.addHandler(/\.tga(?:$|\?)/i, tga)
  const tiff = file.ext === 'fbx' ? new FbxTiffLoader(manager) : new ViewerTiffLoader(manager)
  manager.addHandler(/\.tiff?(?:$|\?)/i, tiff)
  const resources = new Map(files.map(item => [item.url, item]))
  const lowerUrls = new Map()
  const names = new Map()
  for (const item of files) {
    const key = item.url.toLowerCase()
    lowerUrls.set(key, lowerUrls.has(key) ? null : item)
    const name = item.name.toLowerCase()
    if (!names.has(name)) names.set(name, [])
    names.get(name).push(item)
  }
  const filePath = file.path.toLowerCase().split('/')
  const rank = candidate => {
    const path = candidate.path.toLowerCase().split('/')
    let score = 0
    while (score < filePath.length && filePath[score] === path[score]) score++
    return score
  }
  const findResource = (reference, base = location.origin) => {
    const input = reference.replaceAll('\\', '/')
    let url
    try { url = new URL(input, base) } catch { return undefined }
    if (url.origin === location.origin) {
      const exact = resources.get(url.pathname) ?? lowerUrls.get(url.pathname.toLowerCase())
      if (exact) return exact
    }
    const basename = input.split('/').at(-1)
    for (const key of [basename, url.pathname.split('/').at(-1)]) {
      let name = key ?? ''
      try { name = decodeURIComponent(key) } catch { /* filenames may contain a literal percent sign */ }
      const candidates = names.get(name.toLowerCase())
      if (candidates?.length) return file.url.startsWith('/local-files/') ? closest(candidates, file) :
        [...candidates].sort((a, b) => rank(b) - rank(a))[0]
    }
  }
  manager.setURLModifier(input => {
    if (input.startsWith('blob:')) objectUrls.add(input)
    if (input.startsWith('data:') || input.startsWith('blob:')) return input
    try {
      const url = new URL(input.replaceAll('\\', '/'), location.origin)
      if (url.origin === location.origin && (url.pathname === file.preview ||
          url.pathname.startsWith('/vendor/three/') || url.pathname.startsWith('/vendor/rhino3dm/'))) {
        return url.pathname + url.search
      }
      return findResource(input)?.url ?? '/missing-resource'
    } catch { return '/missing-resource' }
  })
  const release = async () => {
    await pending
    for (const url of objectUrls) URL.revokeObjectURL(url)
    objectUrls.clear()
  }
  return { manager, findResource, settled: () => pending, release }
}
