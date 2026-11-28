import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Vector3 } from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { looseMeshResult, looseMeshRevision, meshProduct } from '../core/engines/unreal/decoder/mesh-protocol.mjs'
import { cookedMaterial } from './fixtures/unreal-cooked-material.mjs'
import { cookedSkeletalMeshFixture } from './fixtures/unreal-cooked-skeletal-mesh.mjs'
import { cookedTexture } from './fixtures/unreal-cooked-texture.mjs'
import { makeModernPak } from './fixtures/unreal-pak.mjs'
import { unrealSkeletonFixture } from './fixtures/unreal-skeleton.mjs'
import { testDirectory } from './server-fixture.mjs'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
const readJson = path => readFile(path).then(JSON.parse)
const files = (name, parts) => Object.entries(parts).map(([ext, content]) => ({ path: 'Characters/' + name + '.' + ext, content }))
const withDecoder = { skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 85_000 }

function queryIn(root) {
  return async (...args) => JSON.parse((await run(process.execPath, [cli, ...args, '--json'], { windowsHide: true,
    env: { ...process.env, ASSET_VIEWER_DATA_DIR: join(root, 'data'), ASSET_VIEWER_UE_VIEWER: '' } })).stdout)
}

function glbDocument(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF')
  const length = bytes.readUInt32LE(12)
  return JSON.parse(bytes.toString('utf8', 20, 20 + length))
}

test('cooked skeletal worker contract rejects invalid skin ranges and remains disallowed in the static Zen contract', () => {
  const section = { slot: 0, firstIndex: 0, triangles: 1, name: null, material: null, collision: false, vertexCount: 3 }
  const lod = { lod: 0, vertices: 6, uvs: 1, colors: false, indices: 6, size: 456, tangentsQuantized: true, influences: 8,
    sections: [section, { ...section, firstIndex: 3, baseVertex: 3 }] }
  const value = { lods: [lod], missing: [], boneCount: 8 }
  const report = mesh => ({ protocol: 1, status: 'completed', meshDecoder: looseMeshRevision, entries: [{ index: 0, mesh, issue: null }] })
  assert.equal(meshProduct(value, '00000'), null)
  assert.equal(looseMeshResult(report(value), 1).entries[0].lods[0].sections[1].baseVertex, 3)
  for (const change of [{ influences: 12 }, { size: 457 }, { sections: [section, { ...lod.sections[1], baseVertex: 2 }] }]) {
    assert.equal(looseMeshResult(report({ ...value, lods: [{ ...lod, ...change }] }), 1), null)
  }
  assert.equal(looseMeshResult(report({ ...value, boneCount: 2049 }), 1), null)
})

test('loose cooked UE4.27 import keeps material links and both skinned LODs, with corrupt LODs isolated', withDecoder, async t => {
  const root = await testDirectory(t)
  const source = join(root, 'Content')
  await mkdir(join(source, 'Characters'), { recursive: true })
  const fixtures = [
    ...files('SK_Test', cookedSkeletalMeshFixture({ external: true })),
    ...files('SK_BadWeights', cookedSkeletalMeshFixture({ name: 'SK_BadWeights', split: false, corrupt: 'weight' })),
    ...files('SK_CrossSection', cookedSkeletalMeshFixture({ name: 'SK_CrossSection', corrupt: 'index' })),
    ...files('Character_Skeleton', unrealSkeletonFixture({ cooked: true, split: false })),
    ...cookedMaterial({ name: 'M_Base', split: false }).map(file => ({ ...file, path: 'Characters/' + file.path })),
    ...cookedMaterial({ name: 'MI_Paint', parent: ['/Game/Characters/M_Base'],
      textures: [{ parameter: 'BaseColor', value: '/Game/Characters/T_Paint' }], streaming: [{ path: '/Game/Characters/T_Paint' }] })
      .map(file => ({ ...file, path: 'Characters/' + file.path })),
    ...cookedTexture({ name: 'T_Paint', format: 'PF_G8', width: 1, height: 1, pixels: Buffer.from([90]) })
      .map(file => ({ ...file, path: 'Characters/' + file.path })),
  ]
  await Promise.all(fixtures.map(file => writeFile(join(source, file.path), file.content)))
  const query = queryIn(root)
  const nativeBlender = process.env.ASSET_VIEWER_TEST_NATIVE_BLENDER === '1'
  const load = () => query('package-import', source, '--export', nativeBlender ? 'fbx,glb' : 'glb')
  const { job, scan } = await load()
  assert.equal(scan.status, 'completed')
  const { directory, report } = job.result
  assert.equal(report.unrealCooked.meshes.skeletalMeshes, 3)
  assert.equal(report.unrealCooked.meshes.missingLods, 2)
  assert.equal(report.unrealCooked.meshes.derivatives.glb, 4)
  assert.equal(report.unrealSkeletons.linked, 3)
  const manifestPath = join(directory, 'manifest.json')
  const { assets } = await readJson(manifestPath)
  const [model, damaged, crossSection] = ['SK_Test', 'SK_BadWeights', 'SK_CrossSection'].map(name =>
    assets.find(row => row.sourcePath.endsWith(name + '.uasset')))
  const previews = row => row.exports.filter(item => item.role === 'skeletal-model' && item.format === 'glb')
  assert.deepEqual(previews(model).map(item => [item.lod, item.metrics.triangles, item.metrics.bones, item.metrics.textures]),
    [[0, 2, 8, 1], [1, 1, 8, 1]])
  for (const row of [damaged, crossSection]) {
    assert.deepEqual(previews(row).map(item => item.lod), [1])
    assert.ok(row.issues.includes('unreal-cooked-mesh-lods-incomplete'))
  }
  const preview = previews(model)[0]
  const bytes = await readFile(join(directory, preview.path))
  const document = glbDocument(bytes)
  assert.equal(document.images[0].mimeType, 'image/png')
  assert.equal(document.materials[0].extras.unrealMaterial, '/Game/Characters/MI_Paint')
  assert.equal(document.materials[0].pbrMetallicRoughness.baseColorTexture.index, 0)
  const selected = String(assets.indexOf(model))
  const destination = join(root, 'selective')
  await mkdir(destination)
  const plan = await query('package-export', job.id, destination, '--asset', selected)
  assert.equal(plan.unresolved, 0)
  const exported = await query('package-export', job.id, destination, '--asset', selected, '--plan-key', plan.key)
  assert.deepEqual(await readFile(join(exported.directory, preview.path)), bytes)
  const exportedAssets = (await readJson(join(exported.directory, 'manifest.json'))).assets
  assert.ok(exportedAssets.some(asset => asset.sourcePath === 'Characters/T_Paint.uasset'))
  assert.ok(exportedAssets.some(asset => asset.sourcePath === 'Characters/SK_Test.ubulk'))
  assert.ok(exportedAssets.some(asset => asset.sourcePath === 'Characters/Character_Skeleton.uasset'))
  if (nativeBlender) {
    assert.equal(report.unrealCooked.meshes.derivatives.fbx, 4)
    const fbx = model.exports.find(item => item.format === 'fbx' && item.lod === 0)
    const fbxScene = new FBXLoader().parse(Uint8Array.from(await readFile(join(directory, fbx.path))).buffer, '')
    const mesh = fbxScene.getObjectByProperty('isSkinnedMesh', true)
    assert.ok(mesh?.hasExtraSkinWeights)
    assert.equal(mesh.skeleton.bones.length, 8)
    const weights = ['skinWeight', 'weights_1'].flatMap(name =>
      [0, 1, 2, 3].map(slot => mesh.geometry.attributes[name].getComponent(0, slot)))
    assert.ok(weights.every(weight => weight > 0) && Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-6)
  }
  assert.equal((await load()).job.result.reused, true)
  for (const file of fixtures) assert.deepEqual(await readFile(join(source, file.path)), file.content)
  await writeFile(manifestPath, JSON.stringify({ ...await readJson(manifestPath),
    assets: assets.map(row => row === model ? { ...row, exports: row.exports.filter(item => item.format !== 'bin') } : row) }))
  await assert.rejects(load, error => /Сохранённый импорт Unreal повреждён/.test(JSON.parse(error.stdout).job.error))
})

test('compressed Pak skeletal preview maps all eight weights through the owning section palette', withDecoder, async t => {
  const root = await testDirectory(t)
  const source = join(root, 'Skeletal.pak')
  const fixtures = [
    ...files('SK_Test', cookedSkeletalMeshFixture()),
    ...files('Character_Skeleton', unrealSkeletonFixture({ cooked: true, split: false })),
  ]
  const pak = makeModernPak(fixtures.map(file => ({ ...file, compressed: true })))
  await writeFile(source, pak)
  const query = queryIn(root)
  const { job, scan } = await query('package-import', source)
  assert.equal(scan.status, 'completed')
  const { directory, report } = job.result
  assert.equal(report.meshes.skeletalMeshes, 1)
  assert.equal(report.meshes.derivatives.glb, 2)
  const { entries } = await readJson(join(directory, 'manifest.json'))
  const asset = entries.find(row => row.path.endsWith('/SK_Test.uasset'))
  const preview = asset.exports.find(item => item.format === 'glb' && item.lod === 0)
  assert.deepEqual([preview.role, preview.metrics.triangles, preview.metrics.bones], ['skeletal-model', 2, 8])
  const bytes = await readFile(join(directory, preview.path))
  const { scene } = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, '')
  const sections = []
  scene.traverse(node => { if (node.isSkinnedMesh) sections.push(node) })
  assert.equal(sections.length, 2)
  const [first, second] = sections
  assert.ok(first.hasExtraSkinWeights && second.hasExtraSkinWeights)
  assert.deepEqual(Array.from(first.geometry.index.array), [0, 2, 1])
  assert.deepEqual(Array.from(second.geometry.attributes.skinIndex.array.slice(0, 4)), [7, 6, 5, 4])
  assert.deepEqual(Array.from(second.geometry.attributes.joints_1.array.slice(0, 4)), [3, 2, 1, 0])
  assert.deepEqual(Array.from(first.geometry.attributes.weights_1.array.slice(0, 4)), [20, 15, 10, 10])
  assert.deepEqual(Array.from(first.geometry.attributes.color.array.slice(0, 4)), [20, 40, 60, 255])
  assert.ok(first.geometry.attributes.normal.getY(0) > 0.99)
  assert.equal(first.geometry.attributes.tangent.getW(0), -1)
  scene.updateMatrixWorld(true)
  const rest = first.getVertexPosition(0, new Vector3())
  first.skeleton.bones[7].position.x += 25.5
  scene.updateMatrixWorld(true)
  assert.ok(Math.abs(first.getVertexPosition(0, new Vector3()).x - rest.x - 1) < 1e-6)
  const indexed = await query('search', 'SK_Test', '--library', job.result.library.id)
  assert.ok(indexed.assets?.some(item => item.path === preview.path))
  assert.equal((await query('package-import', source)).job.result.reused, true)
  assert.deepEqual(await readFile(source), pak)
})
