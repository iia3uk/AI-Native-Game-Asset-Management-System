import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeSourceMesh } from '../core/conversion/unreal/source-mesh/gltf.mjs'
import { sourceMaterialResolver } from '../core/conversion/unreal/source-mesh/publish.mjs'
import { sourceMeshLods } from '../core/engines/unreal/source-mesh/mesh-description.mjs'
import { staticMeshPackage } from '../core/engines/unreal/source-mesh/package.mjs'
import { sourceMeshHeaders } from './fixtures/unreal-source-mesh.mjs'

test('UE4 source meshes require an Engine StaticMesh export and stay within package and inflate bounds', () => {
  const { bytes, importAt, exportAt, start, bulkAt } = sourceMeshHeaders()
  const mesh = staticMeshPackage(bytes)
  assert.equal(mesh.name, 'Fixture')
  assert.equal(mesh.start, start)
  assert.equal(mesh.end, bulkAt)

  const wrongClass = Buffer.from(bytes)
  wrongClass.writeInt32LE(5, importAt + 20)
  assert.equal(staticMeshPackage(wrongClass), null)

  const outside = Buffer.from(bytes)
  outside.writeBigInt64LE(BigInt(bytes.length), exportAt + 36)
  assert.throws(() => staticMeshPackage(outside), RangeError)

  const sidecar = Buffer.from(bytes)
  sidecar.writeInt32LE(256, start + 95)
  assert.throws(() => sourceMeshLods(sidecar, mesh), RangeError)

  const oversized = Buffer.from(bytes)
  oversized.writeBigInt64LE(49n * 1024n ** 2n, bulkAt + 24)
  assert.throws(() => sourceMeshLods(oversized, mesh), RangeError)
})

const field = (components, values) => ({ components, values: new Float32Array(values) })

test('UE4 geometry export keeps units, face orientation, vertex attributes, and material sections', () => {
  const parsed = {
    validVertexInstanceIds: [0, 2, 3, 4], validTriangleIds: [0, 1], vertexSlots: 4,
    vertexInstanceVertices: new Int32Array([0, -1, 1, 2, 3]),
    triangleVertexInstances: new Int32Array([0, 2, 3, 2, 4, 3]),
    trianglePolygons: new Int32Array([0, 1]), polygonGroups: new Int32Array([0, 1]),
    vertexAttributes: new Map([['Position', field(3, [0, 0, 0, 100, 0, 0, 0, 100, 0, 100, 100, 0])]]),
    vertexInstanceAttributes: new Map([
      ['Normal', field(3, Array(5).fill([0, 0, -1]).flat())],
      ['Tangent', field(3, Array(5).fill([1, 0, 0]).flat())],
      ['BinormalSign', field(1, [1, 1, 1, 1, 1])],
      ['TextureCoordinate', field(2, [0, 0, 0, 0, 1, 0, 0, 1, 1, 1])],
      ['Color', field(4, Array(5).fill([1, 0, 0.5, 1]).flat())],
    ]),
    polygonGroupAttributes: new Map([['ImportedMaterialSlotName', { values: ['Stone', 'Trim'] }]]),
  }
  const path = '/Game/Forest/Materials/MI_Trim'
  const materials = [{ name: 'M_Trim', imported: 'Trim', path }]
  const { document, buffer, materialPaths } = encodeSourceMesh(parsed, { name: 'Fixture', bin: 'Fixture.bin', materials })
  assert.equal(document.buffers[0].byteLength, buffer.length)
  assert.deepEqual(materialPaths, [path])
  assert.deepEqual(document.materials.map(material => material.name), ['Stone', 'Trim'])
  assert.equal(document.materials[1].extras.unrealMaterial, path)
  const [a, b] = document.meshes[0].primitives
  assert.equal(a.material, 0)
  assert.equal(b.material, 1)
  const accessor = id => document.accessors[id]
  const offset = id => document.bufferViews[accessor(id).bufferView].byteOffset
  const read = (id, position) => buffer.readFloatLE(offset(id) + position * 4)
  assert.deepEqual(accessor(a.attributes.POSITION).max, [1, 0, 1])
  assert.equal(read(a.attributes.NORMAL, 1), -1)
  assert.equal(read(a.attributes.TANGENT, 3), -1)
  assert.equal(read(a.attributes.TEXCOORD_0, 5), 1)
  assert.equal(read(a.attributes.COLOR_0, 2), 0.5)
  assert.deepEqual([0, 1, 2].map(index => buffer.readUInt16LE(offset(a.indices) + index * 2)), [0, 1, 2])
  assert.deepEqual([0, 1, 2].map(index => buffer.readUInt16LE(offset(b.indices) + index * 2)), [1, 3, 2])
})

test('UE4 source mesh material paths can omit the selected package root and cannot match another package', () => {
  const trim = { type: 'uasset', sourcePath: 'Materials/MI_Trim.uasset', output: 'Source/Content/Materials/MI_Trim.uasset' }
  const resolve = sourceMaterialResolver([trim], 'F:\\Assets\\Forest')
  assert.equal(resolve('/Game/Forest/Materials/MI_Trim'), trim)
  assert.equal(resolve('/Game/Other/Materials/MI_Trim'), null)
  assert.equal(resolve('/Game/../Materials/MI_Trim'), null)
})
