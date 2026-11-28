import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { collisionPreview } from '../core/conversion/unreal/collision/gltf.mjs'
import { sourceMeshCollision } from '../core/engines/unreal/source-mesh/collision.mjs'
import { staticMeshHeader } from '../core/engines/unreal/source-mesh/package.mjs'
import { cleanupCandidates } from '../core/packages/cleanup/candidates.mjs'
import { testDirectory } from './server-fixture.mjs'

function words(values, setter = 'writeInt32LE') {
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => bytes[setter](value, index * 4))
  return bytes
}

function sample({ badIndex = false, wrongOwner = false, withUnsupported = false, legacy = false, flat = false } = {}) {
  const names = ['None']
  const ref = name => {
    if (!names.includes(name)) names.push(name)
    return words([names.indexOf(name), 0])
  }
  const tag = (name, type, data, extra = Buffer.alloc(0)) =>
    Buffer.concat([ref(name), ref(type), words([data.length, 0]), extra, Buffer.alloc(1), data])
  const bag = (...fields) => Buffer.concat([...fields, ref('None')])
  const struct = (name, type, data) => tag(name, 'StructProperty', data, Buffer.concat([ref(type), Buffer.alloc(16)]))
  const vector = (name, type, values) => struct(name, type, words(values, 'writeFloatLE'))
  const scalar = (name, value) => tag(name, 'FloatProperty', words([value], 'writeFloatLE'))
  const array = (name, type, count, rows) => tag(name, 'ArrayProperty',
    Buffer.concat([words([count]), struct(name, type, rows)]), ref('StructProperty'))

  const box = bag(vector('Center', 'Vector', [100, 200, 300]), vector('Rotation', 'Rotator', [0, 90, 0]),
    scalar('X', 200), scalar('Y', 400), scalar('Z', 600))
  const sphere = bag(vector('Center', 'Vector', [0, 100, 0]), scalar('Radius', 50))
  const capsule = bag(vector('Rotation', 'Rotator', [90, 0, 0]), scalar('Radius', 50), scalar('Length', 200))
  const faceIndices = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, badIndex ? 4 : 3, 0, 0, 1]
  const hull = bag(array('VertexData', 'Vector', 4, words(
    [0, 0, 0, 100, 0, 0, 0, 100, 0, flat ? 50 : 0, flat ? 50 : 0, flat ? 0 : 100], 'writeFloatLE')),
    ...(legacy && !badIndex ? [] : [tag('IndexData', 'ArrayProperty', words([faceIndices.length, ...faceIndices]), ref('IntProperty'))]),
    struct('Transform', 'Transform', bag(vector('Translation', 'Vector', [300, 0, 0]), vector('Scale3D', 'Vector', [-1, 1, 1]))))
  const aggregate = struct('AggGeom', 'KAggregateGeom', bag(array('BoxElems', 'KBoxElem', 1, box),
    array('SphereElems', 'KSphereElem', 1, sphere), array('SphylElems', 'KSphylElem', 1, capsule),
    array('ConvexElems', 'KConvexElem', 1, hull),
    ...(withUnsupported ? [array('TaperedCapsuleElems', 'KTaperedCapsuleElem', 1, bag())] : [])))
  const body = bag(aggregate, tag('CollisionTraceFlag', 'ByteProperty', ref('CTF_UseSimpleAndComplex'), ref('ECollisionTraceFlag')))
  const header = Buffer.alloc(18)
  header.writeInt32LE(2, 10)
  const meshBytes = Buffer.concat([bag(), header])
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
