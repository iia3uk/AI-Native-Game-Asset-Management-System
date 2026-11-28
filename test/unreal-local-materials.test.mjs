import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { scanFolder } from '../core/library/local-folders.mjs'
import { createClassification } from '../public/catalog/classification.js'
import { fileReviewKey } from '../public/catalog/viewer-storage.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const seed = (id, sourcePath, hash = sha(sourcePath)) => ({ id: id.repeat(32), type: 'uasset', sourcePath, hash, exports: [] })
const prefix = 'Batch-Export/AssetViewer-Forest-ABC123/Package'
const materials = 'Materials/MI_Mushroom.uasset'
const texture = '/Game/Textures/T_Mushroom'
const image = 'Textures/T_Mushroom.png'

async function put(root, path, data) {
  const file = join(root, path)
  const content = typeof data === 'string' ? data : JSON.stringify(data)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
  return { sha256: sha(content), size: Buffer.byteLength(content) }
}

test('Unreal catalog links a sibling texture only when its original package identity matches', async t => {
  const root = await mkdtemp(join(tmpdir(), 'asset-viewer-unreal-catalog-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const model = seed('a', 'Meshes/SM_Mushroom.uasset')
  const material = seed('b', materials)
  const color = seed('c', 'Textures/T_Mushroom.uasset')
  const from = 'Models/SM_Mushroom.gltf'
  const preview = 'Previews/SM_Mushroom.glb'
  model.exports.push({ path: from, role: 'model', format: 'gltf', lod: 0, status: 'converted',
    ...await put(root, prefix + '/' + from, { materials: [{ name: 'Material_001', extras: { unrealMaterial: '/Game/Materials/MI_Mushroom' } }] }) })
  model.exports.push({ path: preview, role: 'model', format: 'glb', lod: 0, status: 'converted', from,
    ...await put(root, prefix + '/' + preview, 'GLB placeholder for catalog scan') })
  const binding = 'Materials/' + material.id + '/bindings.json'
  material.exports.push({ path: binding, role: 'material', format: 'json', status: 'converted',
    ...await put(root, prefix + '/' + binding, { source: { engine: 'unreal', path: materials, sha256: material.hash },
      surface: { blend: 'BLEND_Opaque' }, normalMap: { sourcePath: texture + '_Normal' },
      textureStreaming: [{ path: texture, uvChannel: 0 }] }) })
  const nativeTexture = await put(root, 'Forest/' + image, 'local PNG placeholder')
  color.exports.push({ path: image, role: 'texture', format: 'png', status: 'converted', size: nativeTexture.size + 10,
    sampling: { srgb: true, compression: 'TC_Default' } })
  const dependencies = await put(root, prefix + '/dependencies.json', { dependencies: [
    { type: 'unreal-model-material', source: model.id, target: material.id, status: 'resolved', path: materials, lod: 0 },
    { type: 'unreal-material-texture', source: material.id, target: color.id, status: 'resolved', path: texture },
  ] })
  const source = { format: 'unreal-content', sha256: sha('manifest source') }
  await put(root, prefix + '/manifest.json', { source, assets: [model, material, color], dependenciesSha256: dependencies.sha256 })
  const sibling = { ...color, exports: [{ ...color.exports[0], ...nativeTexture }] }
  const scan = async () => {
    const result = await scanFolder(root)
    const group = [...result.packs.values()].find(pack => pack.summary.title === 'Forest · Экспорт')
    return { group, mesh: group.files.find(file => file.ext === 'glb') }
  }

  await put(root, 'Forest/manifest.json', { source, assets: [sibling] })
  const { group, mesh } = await scan()
  const related = group.files.find(file => file.id === mesh.relatedTextures[0])
  assert.equal(related.path, 'Forest/' + image)
  assert.equal(mesh.materialTextures.material_001.url, related.url)
  const pack = { ...group.summary, originalFiles: new Set(group.summary.originalFiles) }
  const key = pack.originalGroup + ':' + mesh.id
  assert.equal(fileReviewKey(pack, mesh.id), key)
  const classification = createClassification({ getItem: () => JSON.stringify({ models: { [key]: 'Nature' } }) })
  assert.equal(classification.modelCategory(pack, mesh), 'Nature')
  assert.equal(classification.modelsInCategory(pack, 'Nature'), 1)

  await put(root, 'Forest/manifest.json', { source, assets: [{ ...sibling, hash: sha('different native texture') }] })
  assert.equal((await scan()).mesh.materialTextures, undefined)

  await put(root, 'Forest/manifest.json', { source, assets: [sibling] })
  await put(root, prefix + '/' + binding, { source: { engine: 'unreal', path: materials, sha256: material.hash } })
  assert.equal((await scan()).mesh.materialTextures, undefined)
})

test('legacy UE Viewer material selects Diffuse inside its own package', async t => {
  const root = await mkdtemp(join(tmpdir(), 'asset-viewer-unreal-viewer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dump = 'Craft/UEViewer/Materials/MI_Flower_A.mat'
  await put(root, 'Craft/UEViewer/Meshes/Flowers.gltf', { materials: [{ name: 'MI_Flower_A' }] })
  await put(root, dump, 'Diffuse=T_Flowers_A_D\nNormal=T_Flowers_N\nOther[0]=T_Flowers_C_D\n')
  for (const name of ['T_Flowers_A_D', 'T_Flowers_C_D', 'T_Flowers_N']) {
    await put(root, 'Craft/Textures/' + name + '.png', 'PNG placeholder')
  }
  await put(root, 'Other/Textures/T_Flowers_A_D.png', 'unrelated PNG placeholder')
  const scan = async () => [...(await scanFolder(root)).packs.values()].find(pack => pack.summary.title === 'Craft')
  const group = await scan()
  const model = group.files.find(file => file.ext === 'gltf')
  assert.ok(model.materialTextures.mi_flower_a.url.endsWith('/Craft/Textures/T_Flowers_A_D.png'))
  assert.deepEqual(model.relatedTextures.map(id => group.files.find(file => file.id === id)?.name), ['T_Flowers_A_D.png', 'T_Flowers_N.png'])
  await put(root, 'Craft/Textures/Alternate/T_Flowers_A_D.png', 'ambiguous PNG placeholder')
  assert.equal((await scan()).files.find(file => file.ext === 'gltf').materialTextures, undefined)
})
