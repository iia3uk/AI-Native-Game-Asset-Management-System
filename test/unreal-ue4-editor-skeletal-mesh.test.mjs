import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { encodeEditorSkeletalMesh } from '../core/conversion/unreal/skeletal-mesh/gltf.mjs'
import { editorPackage } from '../core/engines/unreal/editor-package/tables.mjs'
import { readUe4EditorSkeletalMesh, ue4EditorSkeletalMesh } from '../core/engines/unreal/skeletal-mesh/ue4-514.mjs'
import { planPackageCleanup } from '../core/packages/cleanup/plan.mjs'
import { readFbxGeometry } from './fixtures/blender-model.mjs'
import { editorSkeletalMeshFixture as fixture } from './fixtures/unreal-editor-skeletal-mesh.mjs'
import { unrealSkeletonFixture } from './fixtures/unreal-skeleton.mjs'
import { testDirectory } from './server-fixture.mjs'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
const readJson = file => readFile(file).then(JSON.parse)

function decode(bytes) {
  const table = editorPackage(bytes, 514)
  const object = ue4EditorSkeletalMesh(bytes, 514, table)
  assert.ok(object)
  return readUe4EditorSkeletalMesh(bytes, table, object)
}

function values(document, bytes, accessor) {
  const field = document.accessors[accessor]
  const { byteOffset } = document.bufferViews[field.bufferView]
  const format = { 5121: ['readUInt8', 1], 5123: ['readUInt16LE', 2], 5125: ['readUInt32LE', 4], 5126: ['readFloatLE', 4] }
  const [reader, width] = format[field.componentType]
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }
  return Array.from({ length: field.count * components[field.type] }, (_, index) => bytes[reader](byteOffset + index * width))
}

test('UE4 editor skeletal meshes preserve section palettes, all weights, tangent orientation and inverse bind matrices', () => {
  for (const indexWidth of [2, 4]) {
    const mesh = decode(fixture({ indexWidth }))
    const { document, buffer, materialPaths } = encodeEditorSkeletalMesh(mesh, 'test.bin')
    assert.equal(mesh.influences, 5)
    assert.deepEqual(materialPaths, ['/Game/Characters/MI_Paint'])
    assert.deepEqual(document.materials[0].extras, { unrealMaterialSlot: 0, unrealImportedMaterialSlot: 'ImportedPaint',
      unrealMaterial: '/Game/Characters/MI_Paint' })
    const [paint, second] = document.meshes[0].primitives
    for (const section of [paint, second]) {
      assert.deepEqual(values(document, buffer, section.indices), [0, 1, 2])
      assert.deepEqual(values(document, buffer, section.attributes.WEIGHTS_0).slice(0, 4), [100, 60, 45, 35])
      assert.deepEqual(values(document, buffer, section.attributes.WEIGHTS_1).slice(0, 4), [15, 0, 0, 0])
      assert.deepEqual(values(document, buffer, section.attributes.COLOR_0).slice(0, 4), [12, 34, 56, 255])
      assert.deepEqual(values(document, buffer, section.attributes.TEXCOORD_1).slice(0, 2), [0.25, 0.75])
      const [, normalY] = values(document, buffer, section.attributes.NORMAL)
      const [tangentX, , , sign] = values(document, buffer, section.attributes.TANGENT)
      assert.ok(normalY > 0.99 && tangentX > 0.99)
      assert.equal(sign, -1)
    }
    assert.deepEqual(values(document, buffer, paint.attributes.POSITION).slice(0, 9), [0, 0, 0, 0, 0, 1, 1, 0, 0])
    assert.deepEqual(values(document, buffer, paint.attributes.JOINTS_1).slice(0, 4), [4, 0, 0, 0])
    assert.deepEqual(values(document, buffer, second.attributes.JOINTS_0).slice(0, 4), [4, 3, 2, 1])
    assert.deepEqual(values(document, buffer, second.attributes.JOINTS_1).slice(0, 4), [0, 0, 0, 0])
    const { inverseBindMatrices, joints } = document.skins[0]
    assert.deepEqual(joints, [1, 2, 3, 4, 5])
    const inverse = values(document, buffer, inverseBindMatrices)
    const world = new Matrix4()
    for (const [index, joint] of joints.entries()) {
      const { translation, rotation, scale } = document.nodes[joint]
      world.multiply(new Matrix4().compose(new Vector3(...translation), new Quaternion(...rotation), new Vector3(...scale)))
      const identity = world.clone().multiply(new Matrix4().fromArray(inverse, index * 16))
      assert.ok(identity.elements.every((value, component) => Math.abs(value - Number(component % 5 === 0)) < 1e-6))
    }
  }
  for (const corrupt of ['weight', 'joint', 'index']) assert.throws(() => decode(fixture({ corrupt })), RangeError)
  assert.deepEqual(decode(fixture({ lods: 2 })), { issue: 'unreal-source-skeletal-mesh-lod-layout' })
})

test('loose UE4 import indexes the skinned GLB, preserves native inputs and verifies the cached model and buffer', async t => {
  const root = await testDirectory(t)
  const source = join(root, 'Content')
  const character = join(source, 'Characters')
  const data = join(root, 'data')
  await mkdir(character, { recursive: true })
  await Promise.all([
    writeFile(join(character, 'SK_Test.uasset'), fixture()),
    writeFile(join(character, 'Character_Skeleton.uasset'), unrealSkeletonFixture()),
  ])
  const query = async (...args) => JSON.parse((await run(process.execPath, [cli, ...args, '--json'], { windowsHide: true,
    env: { ...process.env, ASSET_VIEWER_DATA_DIR: data, ASSET_VIEWER_UE_VIEWER: '' } })).stdout)
  const nativeBlender = process.env.ASSET_VIEWER_TEST_NATIVE_BLENDER === '1'
  const importPackage = () => query('package-import', source, '--export', nativeBlender ? 'fbx,glb' : 'glb')
  const { job, scan } = await importPackage()
  assert.equal(scan.status, 'completed')
  const { directory, report } = job.result
  assert.equal(report.unrealSourceMeshes.skeletalMeshes, 1)
  assert.equal(report.unrealSourceMeshes.derivatives.glb, 1)
  assert.equal(report.unrealSkeletons.linked, 1)
  const manifestPath = join(directory, 'manifest.json')
  const manifest = await readJson(manifestPath)
  const asset = manifest.assets.find(item => item.sourcePath.endsWith('SK_Test.uasset'))
  const preview = asset.exports.find(item => item.format === 'glb')
  assert.equal(preview.role, 'skeletal-model')
  assert.deepEqual([preview.metrics.triangles, preview.metrics.vertices, preview.metrics.bones], [2, 6, 5])
  const bytes = await readFile(join(directory, preview.path))
  const length = bytes.readUInt32LE(12)
  const document = JSON.parse(bytes.toString('utf8', 20, 20 + length))
  const [section] = document.meshes[0].primitives
  assert.equal(values(document, bytes.subarray(28 + length), section.attributes.WEIGHTS_1)[0], 15)
  const { scene } = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, '')
  const meshes = []
  scene.traverse(node => { if (node.isSkinnedMesh) meshes.push(node) })
  assert.equal(meshes.length, 2)
  const [first] = meshes
  assert.ok(meshes.every(mesh => mesh.hasExtraSkinWeights))
  assert.equal(first.geometry.attributes.skinWeight.getX(0), 100 / 255)
  assert.equal(first.geometry.attributes.weights_1.getX(0), 15 / 255)
  scene.updateMatrixWorld(true)
  const rest = first.getVertexPosition(0, new Vector3())
  first.skeleton.bones[4].position.x += 34
  scene.updateMatrixWorld(true)
  assert.ok(Math.abs(first.getVertexPosition(0, new Vector3()).x - rest.x - 1) < 1e-6)
  first.computeBoundingBox()
  assert.ok(Math.abs(first.boundingBox.min.x - rest.x - 1) < 1e-6)
  if (nativeBlender) {
    assert.equal(report.unrealSourceMeshes.derivatives.fbx, 1)
    const fbx = asset.exports.find(item => item.format === 'fbx')
    const shortPath = join(root, 'SK_Test.fbx')
    await copyFile(join(directory, fbx.path), shortPath)
    const [[triangles, uvChannels, colors]] = await readFbxGeometry([shortPath])
    assert.deepEqual([triangles, uvChannels, colors], [2, 2, 1])
    const fbxScene = new FBXLoader().parse(Uint8Array.from(await readFile(shortPath)).buffer, '')
    const fbxMesh = fbxScene.getObjectByProperty('isSkinnedMesh', true)
    assert.ok(fbxMesh.hasExtraSkinWeights)
    const fbxWeights = fbxMesh.geometry.attributes
    for (let i = 0; i < 6; i++) {
      const weights = ['skinWeight', 'weights_1'].flatMap(name =>
        [0, 1, 2, 3].map(slot => fbxWeights[name].getComponent(i, slot))).filter(weight => weight > 0)
      assert.equal(weights.length, 5)
      assert.ok(Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-6)
    }
  }
  const { files } = await planPackageCleanup({ imports: join(data, 'imports'), protectedRoots: [data], job, source,
    signal: AbortSignal.timeout(15_000) })
  assert.deepEqual(files, [])
  const selected = String(manifest.assets.indexOf(asset))
  const plan = await query('package-export', job.id, root, '--asset', selected)
  const exported = await query('package-export', job.id, root, '--asset', selected, '--plan-key', plan.key)
  const skeleton = manifest.assets.find(item => item.skeleton?.role === 'skeleton')
  assert.deepEqual(await readFile(join(exported.directory, preview.path)), bytes)
  assert.deepEqual(await readFile(join(exported.directory, skeleton.skeleton.path)), await readFile(join(directory, skeleton.skeleton.path)))
  const repeat = await importPackage()
  assert.equal(repeat.job.result.reused, true)
  asset.exports = asset.exports.filter(item => item.format !== 'bin')
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(importPackage)
})
