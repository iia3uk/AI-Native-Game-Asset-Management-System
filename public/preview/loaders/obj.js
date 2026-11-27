import * as THREE from 'three'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js'

export async function loadObj(file, manager, findResource) {
  const loader = new OBJLoader(manager)
  const source = await new THREE.FileLoader(manager).loadAsync(file.preview)
  const base = new URL(file.preview, location.origin)
  const references = [...source.matchAll(/^[ \t]*mtllib[ \t]+([^\r\n]+)/gm)].map(([, value]) => value.trim())
  const materialFiles = new Set()
  const findMaterial = name => {
    const resource = findResource(name.replace(/^["']|["']$/g, ''), base)
    if (resource?.ext === 'mtl') materialFiles.add(resource.url)
    return resource?.ext === 'mtl'
  }
  for (const name of references) {
    if (findMaterial(name)) continue
    for (const part of name.match(/"[^"]+"|'[^']+'|\S+/g) ?? []) findMaterial(part)
  }
  if (!materialFiles.size) findMaterial(file.name.replace(/\.obj$/i, '.mtl'))
  const loaded = await Promise.allSettled([...materialFiles].map(url => new MTLLoader(manager).loadAsync(url)))
  const creators = loaded.filter(result => result.status === 'fulfilled').map(result => result.value)
  if (creators.length) loader.setMaterials({
    create: name => creators.find(creator => Object.hasOwn(creator.materialsInfo, name))?.create(name),
  })
  return loader.parse(source)
}
