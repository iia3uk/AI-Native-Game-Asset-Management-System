import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { artifactHash, ExportArtifacts } from '../core/conversion/artifacts.mjs'
import { bindViewerMaterials } from '../core/conversion/unreal/viewer/bind-materials.mjs'
import { createViewerDerivatives } from '../core/conversion/unreal/viewer/derivatives.mjs'
import { parseRawMesh } from '../core/engines/unreal/source-mesh/raw-mesh/geometry.mjs'
import { decodeSourceMesh } from '../core/engines/unreal/source-mesh/run.mjs'
import { rawMeshFixture, rawMeshPackageFixture } from './fixtures/unreal-raw-mesh.mjs'
import { sourcePng } from './fixtures/unreal-source-media.mjs'
import { testDirectory } from './server-fixture.mjs'

const decode = options => decodeSourceMesh(Uint8Array.from(rawMeshPackageFixture(options)), 'Fixture',
  { timeout: 2000, version: 514 })

test('UE4 514 raw static mesh reads inline and end-of-file LODs and keeps geometry and numeric material slots', async () => {
  for (const inline of [false, true]) {
    const result = await decode({ inline })
    assert.equal(result.issue, undefined)
    assert.deepEqual(result.missing, [1])
    const [{ lod, document, buffer, materialPaths }] = result.meshes
    assert.equal(lod, 0)
    assert.deepEqual(materialPaths, ['/Game/Example/MI_Bottom', '/Game/Example/M_Top'])
    const [mesh] = document.meshes
    const { tangentAxes, ...metadata } = mesh.extras.unrealRawMesh
    assert.deepEqual(metadata, { format: 'FRawMesh', version: 1,
      settings: { scale: [2, -3, 0.5], bGenerateLightmapUVs: true }, uvChannels: [0, 1] })
    assert.deepEqual(document.materials.map(row => [row.name, row.extras.unrealMaterialSlot, row.extras.unrealImportMaterialIndex]),
      [['Shared', 1, 5], ['Shared', 0, 3]])
    const [first, second] = mesh.primitives
    const access = index => document.accessors[index]
    const offset = index => document.bufferViews[access(index).bufferView].byteOffset
    const data = Buffer.from(buffer)
    assert.equal(tangentAxes.componentType, 5126)
    assert.equal(data.readFloatLE(document.bufferViews[tangentAxes.x].byteOffset), 1)
    assert.equal(data.readFloatLE(document.bufferViews[tangentAxes.y].byteOffset + 4), -1)
    const vertex = (semantic, at) => data.readFloatLE(offset(first.attributes[semantic]) + at * 4)
    assert.deepEqual(access(first.attributes.POSITION).min, [0, 0, -3])
    assert.deepEqual(access(first.attributes.POSITION).max, [2, 0, 0])
    assert.equal(vertex('NORMAL', 1), -1)
    assert.deepEqual([vertex('TANGENT', 0), vertex('TANGENT', 3)], [1, 1])
    assert.equal(vertex('TEXCOORD_0', 2), 1)
    assert.deepEqual([vertex('TEXCOORD_1', 0), vertex('TEXCOORD_1', 1)], [0.25, 0.75])
    assert.deepEqual(Array.from({ length: 4 }, (_, index) => vertex('COLOR_0', index)),
      [255, 99, 72, 181].map(value => Math.fround(value / 255)))
    const indices = row => [0, 1, 2].map(index => data.readUInt16LE(offset(row.indices) + index * 2))
    assert.deepEqual(indices(first), [0, 2, 1])
    assert.deepEqual(indices(second), [3, 5, 4])
    const smoothing = row => data.readUInt32LE(document.bufferViews[row.extras.unrealFaceSmoothingMasks.bufferView].byteOffset)
    assert.deepEqual([smoothing(first), smoothing(second)], [0x81234567, 2])
  }
})

test('UE4 raw static mesh rejects malformed streams and does not bind UV0 materials to a remapped channel', async () => {
  assert.throws(() => parseRawMesh(rawMeshFixture({ badIndex: true })), RangeError)
  assert.throws(() => parseRawMesh(rawMeshFixture().subarray(0, -1)), RangeError)
  const version = rawMeshFixture()
  version.writeInt32LE(9)
  assert.throws(() => parseRawMesh(version), RangeError)
  assert.equal(await decode({ version514: false }), null)
  assert.equal((await decode({ payload: version })).issue, 'unreal-source-mesh-layout')
  const { meshes: [{ document }] } = await decode({ payload: rawMeshFixture({ uv0: false }) })
  assert.deepEqual(document.meshes[0].extras.unrealRawMesh.uvChannels, [1])
  const description = { bindings: [{ role: 'baseColor', corroborated: true, path: 'Textures/color.png' }] }
  assert.equal(bindViewerMaterials(document, () => ({ asset: {}, description }), 'Geometry.gltf').images, 0)
  assert.equal(document.images, undefined)
})

test('UE4 raw-mesh GLB keeps verified geometry and textures and needs no Blender', async t => {
  const root = await testDirectory(t)
  const output = join(root, 'output')
  const workspace = join(root, 'workspace')
  const directory = join(output, 'Models', 'fixture')
  await Promise.all([mkdir(directory, { recursive: true }), mkdir(workspace),
    mkdir(join(output, 'Textures'), { recursive: true })])
  const { meshes: [{ document, buffer, materialPaths }] } = await decode({ payload: rawMeshFixture({ partialTangents: true }) })
  const [mesh] = document.meshes
  assert.equal(mesh.extras.unrealRawMesh.generatedTangentCorners, 1)
  assert.ok(Number.isInteger(mesh.primitives[0].attributes.TANGENT))
  const [material] = materialPaths
  const path = 'Models/fixture/Fixture.gltf'
  const binPath = 'Models/fixture/Fixture.bin'
  const texture = 'Textures/verified map.png'
  const image = sourcePng
  const description = { bindings: [{ role: 'baseColor', corroborated: true, path: texture }], scalars: [] }
  const hit = { asset: {}, description }
  assert.equal(bindViewerMaterials(document, null, path, key => key === material ? hit : null).images, 1)
  await Promise.all([writeFile(join(output, path), JSON.stringify(document)), writeFile(join(output, binPath), buffer),
    writeFile(join(output, texture), image)])
  const artifact = { path, method: 'unreal-source-mesh', lod: 0, role: 'model', sourceFormat: 'FRawMesh',
    converterVersion: 'fixture', metrics: { triangles: 2 }, issues: [], sha256: await artifactHash(join(output, path)) }
  const asset = { id: 'fixture', exports: [artifact,
    { path: binPath, role: 'model-buffer', sha256: await artifactHash(join(output, binPath)) }] }
  const counts = await createViewerDerivatives({ models: [{ asset, artifact }], store: new ExportArtifacts(output),
    output, workspace, formats: ['fbx', 'glb'] })
  assert.deepEqual(counts, { fbx: 0, glb: 1 })
  const preview = asset.exports.find(row => row.format === 'glb')
  assert.equal(preview.method, 'unreal-source-mesh')
  assert.equal(asset.exports.find(row => row.format === 'fbx').issue, 'blender-unavailable')
  const glb = await readFile(join(output, preview.path))
  const end = 20 + glb.readUInt32LE(12)
  const gltf = JSON.parse(glb.subarray(20, end))
  assert.deepEqual(gltf.meshes, document.meshes)
  assert.equal(gltf.images[0].mimeType, 'image/png')
  const stored = gltf.bufferViews[gltf.images[0].bufferView]
  assert.deepEqual(glb.subarray(end + 8 + stored.byteOffset, end + 8 + stored.byteOffset + stored.byteLength), image)
  assert.deepEqual(glb.subarray(end + 8, end + 8 + buffer.length), Buffer.from(buffer))
})
