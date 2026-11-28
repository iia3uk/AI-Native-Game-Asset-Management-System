import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { collisionPreview } from '../core/conversion/unreal/collision/gltf.mjs'
import { sourceMeshCollision } from '../core/engines/unreal/source-mesh/collision.mjs'
import { staticMeshHeader } from '../core/engines/unreal/source-mesh/package.mjs'
import { cleanupCandidates } from '../core/packages/cleanup/candidates.mjs'
import { unrealBodySetup } from './fixtures/unreal-body-setup.mjs'
import { testDirectory } from './server-fixture.mjs'

function words(values) {
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => bytes.writeInt32LE(value, index * 4))
  return bytes
}

function sample({ badIndex = false, wrongOwner = false, withUnsupported = false, legacy = false, flat = false } = {}) {
  const names = ['None']
  const ref = name => {
    if (!names.includes(name)) names.push(name)
    return words([names.indexOf(name), 0])
  }
  const body = unrealBodySetup(ref, { badIndex, withUnsupported, pointOnly: legacy, flat })
  const header = Buffer.alloc(18)
  header.writeInt32LE(2, 10)
  const meshBytes = Buffer.concat([ref('None'), header])
  const bytes = Buffer.concat([meshBytes, body])
  const mesh = { start: 0, end: meshBytes.length, index: 1, layout: { fileVersionUE4: legacy ? 514 : 522 },
    nameAt: at => names[bytes.readInt32LE(at)],
    exported: index => index === 2 && { type: 'BodySetup', outer: wrongOwner ? 3 : 1, name: 'FixtureBody',
      start: meshBytes.length, end: bytes.length } }
  return { bytes, mesh }
}

function readCollision(input) {
  const { bytes, mesh } = input
  const header = staticMeshHeader(bytes, mesh)
  return sourceMeshCollision(bytes, mesh, header.bodyIndex)
}

test('UE4 static-mesh collision uses the exact BodySetup export and writes oriented, meter-scale GLB geometry', () => {
  const source = readCollision(sample())
  assert.equal(source.traceMode, 'CTF_UseSimpleAndComplex')
  assert.deepEqual(source.shapes.map(shape => shape.type), ['box', 'sphere', 'capsule', 'convex'])
  assert.deepEqual(source.shapes[0].dimensions, [200, 400, 600])
  const { buffer, omitted, degenerateTriangles } = collisionPreview(source.shapes)
  assert.deepEqual(omitted, [])
  assert.equal(degenerateTriangles, 1)
  assert.equal(source.shapes[3].indices.length, 15)
  assert.equal(buffer.toString('ascii', 0, 4), 'glTF')
  assert.equal(buffer.readUInt32LE(8), buffer.length)
  const jsonEnd = 20 + buffer.readUInt32LE(12)
  const document = JSON.parse(buffer.toString('utf8', 20, jsonEnd))
  assert.deepEqual(document.nodes.map(node => node.extras.collisionShape), ['box', 'sphere', 'capsule', 'convex'])
  const primitive = index => document.meshes[index].primitives[0]
  const position = index => document.accessors[primitive(index).attributes.POSITION]
  assert.deepEqual(position(0).min.map(Math.round), [-1, 0, 1])
  assert.deepEqual(position(0).max, [3, 6, 3])
  assert.deepEqual(position(1).max, [0.5, 0.5, 1.5])
  assert.ok(Math.abs(position(2).min[0] + 1.5) < 1e-6)
  assert.ok(Math.abs(position(2).max[0] - 1.5) < 1e-6)
  assert.deepEqual(position(3).min, [2, 0, 0])
  assert.deepEqual(position(3).max, [3, 1, 1])
  const indices = document.bufferViews[document.accessors[primitive(3).indices].bufferView]
  assert.deepEqual([0, 1, 2].map(index => buffer.readUInt16LE(jsonEnd + 8 + indices.byteOffset + index * 2)), [0, 2, 1])
})

test('UE4 collision keeps valid shapes when another shape is damaged or unsupported', () => {
  assert.throws(() => readCollision(sample({ wrongOwner: true })), RangeError)
  const source = readCollision(sample({ badIndex: true, withUnsupported: true }))
  assert.deepEqual(source.shapes.map(shape => shape.type), ['box', 'sphere', 'capsule'])
  assert.deepEqual(source.omitted, [{ field: 'ConvexElems', index: 0 }, { field: 'TaperedCapsuleElems' }])
})

test('UE4 514 point-only convex collision reconstructs a closed hull and rejects planar or invalid indexed input', () => {
  const { shapes, omitted } = readCollision(sample({ legacy: true }))
  assert.deepEqual(omitted, [])
  const hull = shapes.at(-1)
  assert.equal(hull.indexSource, 'convex-hull')
  assert.equal(hull.indices.length, 12)
  assert.deepEqual([...new Set(hull.indices)].sort(), [0, 1, 2, 3])
  assert.deepEqual(collisionPreview(shapes).omitted, [])
  for (const options of [{ flat: true }, { badIndex: true }]) {
    const rejected = readCollision(sample({ legacy: true, ...options }))
    assert.deepEqual(rejected.omitted, [{ field: 'ConvexElems', index: 0 }])
    assert.equal(rejected.shapes.length, 3)
  }
})

test('Unreal source cleanup requires render geometry and both collision artifacts', async t => {
  const root = await testDirectory(t)
  const sourcePath = 'Fixture.uasset'
  const output = 'Source/Content/' + sourcePath
  await writeFile(join(root, sourcePath), 'fixture')
  const description = { path: 'Metadata/fixture/collision.json', shapes: 1, method: 'unreal-source-collision',
    role: 'collision-shapes', format: 'json', status: 'converted' }
  const preview = { path: 'Previews/fixture/Fixture-Collision.glb', method: description.method, role: 'collision-preview',
    format: 'glb', status: 'converted', settingsPath: description.path }
  const mesh = { path: 'Models/fixture/Fixture.fbx', format: 'fbx', status: 'converted' }
  const asset = { sourcePath, output, exports: [description, preview] }
  const backups = () => Array.fromAsync(cleanupCandidates('unreal-content', root, {}, [asset], true,
    new AbortController().signal))
  assert.deepEqual(await backups(), [])
  asset.exports.push(mesh)
  assert.deepEqual((await backups())[0].backups.map(item => item.path), [output, mesh.path, description.path, preview.path])
  asset.exports = [description, mesh]
  assert.deepEqual(await backups(), [])
  asset.exports.push(preview)
  asset.collisionIssue = 'unreal-source-collision-partial'
  assert.deepEqual(await backups(), [])
})
