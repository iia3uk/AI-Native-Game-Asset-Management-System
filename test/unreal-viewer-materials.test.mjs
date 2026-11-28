import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { dependencyLocation } from '../core/analysis/asset-analysis.mjs'
import { ExportArtifacts } from '../core/conversion/artifacts.mjs'
import { verifyExports } from '../core/conversion/cache.mjs'
import { bindViewerMaterials, publishTexturedViewerModels } from '../core/conversion/unreal/viewer/bind-materials.mjs'
import { publishViewerMaterials } from '../core/conversion/unreal/viewer/materials.mjs'
import { publishPackedMap } from '../core/conversion/unreal/viewer/packed-maps.mjs'
import { encodePngScanlines } from '../core/files/png.mjs'
import { readPngRgb } from '../core/files/png-rgb.mjs'
import { selectPackageAssets } from '../core/packages/export/dependencies.mjs'
import { sourcePng } from './fixtures/unreal-source-media.mjs'
import { testDirectory } from './server-fixture.mjs'

function textureProperties(entries) {
  const rows = entries.map(([name, value], index) =>
    '    TextureParameterValues[' + index + "] =\n    {\n        ParameterInfo = { Name=None }\n" +
    "        ParameterValue = Texture2D'" + value + "'\n        ParameterName = " + name + '\n    }')
  return 'TextureParameterValues[' + rows.length + '] =\n{\n' + rows.join('\n') + '\n}\n' +
    'CollectedScalarParameters[1] =\n{\n    CollectedScalarParameters[0] = { Value=.8, Name=Roughness, Group=None }\n}\n'
}

test('Unreal materials bind matching owned textures and export the mesh, materials and texture dependencies together', async t => {
  const root = await testDirectory(t)
  const output = join(root, 'output')
  const decoded = join(root, 'decoded')
  const signal = AbortSignal.timeout(10_000)
  const store = new ExportArtifacts(output, signal)
  const modelPath = 'Models/mesh/ue-viewer/Fixture.gltf'
  const gltf = {
    asset: { version: '2.0' }, meshes: [{ primitives: [{ material: 0, attributes: { TEXCOORD_0: 2 } }] }],
    materials: [{ name: 'FixtureMaterial', pbrMetallicRoughness: { baseColorFactor: [.3, .3, .3, 1] } }],
  }
  const gltfBytes = JSON.stringify(gltf)
  const materialProps = textureProperties([
    ['BaseColor', 'Textures/My Albedo.My Albedo'],
    ['Emissive', 'Textures/Missing.Missing'],
    ['Normal', 'Textures/My Albedo.My Albedo'],
    ['Displacement', '../Outside.Outside'],
    ['RMA', 'Textures/Surface.Surface'],
  ])
  const mask = encodePngScanlines(2, 2, Buffer.from([
    1, 11, 21, 31, 41, 3, 4, 5, 6,
    4, 4, 4, 4, 4, 7, 8, 9, 10,
  ]), { alpha: true })
  for (const [directory, path, bytes] of [
    [output, modelPath, gltfBytes],
    [decoded, 'Materials/FixtureMaterial.mat', 'Diffuse=My Albedo\nNormal=My Albedo\nEmissive=Missing\nOther[0]=Surface\n'],
    [decoded, 'Materials/FixtureMaterial.props.txt', materialProps],
    [decoded, 'Textures/My Albedo.png', sourcePng],
    [decoded, 'Other/My Albedo.png', Buffer.from('invalid PNG')],
    [decoded, 'Textures/Surface.png', mask],
  ]) {
    const file = join(directory, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, bytes)
  }
  const asset = (id, sourcePath) => ({ id, sourcePath, hash: 'a'.repeat(64), exports: [], issues: [] })
  const mesh = asset('mesh', 'Meshes/Fixture.uasset')
  const shader = asset('material', 'Materials/FixtureMaterial.uasset')
  const texture = asset('texture', 'Textures/My Albedo.uasset')
  const wrongTexture = asset('unrelated', 'Other/My Albedo.uasset')
  const surface = asset('surface', 'Textures/Surface.uasset')
  const records = { assets: [mesh, shader, texture, wrongTexture, surface], dependencies: [] }
  const artifact = { path: modelPath, lod: 0, format: 'gltf', role: 'model', status: 'converted' }
  const viewer = await publishViewerMaterials({ records, targets: records.assets, store, version: '1590', signal,
    parameters: { output: decoded, workspace: root } })
  await publishTexturedViewerModels({ ...viewer, models: [{ asset: mesh, artifact }], records, output,
    workspace: root, store, signal })
  assert.deepEqual(viewer.counts, { materialJson: 1, texturePng: 2, texturedGltf: 1, packedMaterials: 1, repackedMaps: 1 })
  const textured = mesh.exports.at(-1)
  const bound = JSON.parse(await readFile(join(output, textured.path), 'utf8'))
  assert.deepEqual(bound.materials[0].pbrMetallicRoughness,
    { baseColorFactor: [1, 1, 1, 1], baseColorTexture: { index: 0 },
      metallicRoughnessTexture: { index: 1 }, metallicFactor: 1, roughnessFactor: 1 })
  assert.deepEqual(bound.materials[0].occlusionTexture, { index: 1 })
  assert.equal(bound.materials[0].normalTexture, undefined)
  assert.equal(bound.materials[0].emissiveTexture, undefined)
  assert.equal(bound.images[0].uri, '../../../Textures/Textures/My%20Albedo.png')
  assert.equal(dependencyLocation(textured.path, bound.images[0].uri, { uri: true }).path, texture.exports[0].path)
  assert.equal(await readFile(join(output, artifact.path), 'utf8'), gltfBytes)
  const description = JSON.parse(await readFile(join(output, shader.exports[0].path), 'utf8'))
  assert.deepEqual(description.bindings.map(item => [item.role, item.status]),
    [['baseColor', 'resolved'], ['emissive', 'missing'], ['normal', 'resolved'], ['packed', 'resolved']])
  assert.deepEqual(description.packedMap.channels, { ambientOcclusion: 'red', roughness: 'green', metallic: 'blue' })
  const artifactMap = surface.exports.find(item => item.role === 'preview-texture')
  assert.equal(dependencyLocation(textured.path, bound.images[1].uri, { uri: true }).path, artifactMap.path)
  const buffer = await readFile(join(output, artifactMap.path))
  assert.deepEqual(readPngRgb(buffer).rows, Buffer.from([0, 31, 11, 21, 36, 14, 25, 0, 35, 15, 25, 45, 22, 33]))
  assert.deepEqual(await readFile(join(output, description.packedMap.sourceImage)), mask)
  const exported = await selectPackageAssets({ assets: records.assets, directory: output }, records, mesh, signal)
  assert.deepEqual(exported.assets.map(item => item.id), ['mesh', 'material', 'texture', 'surface'])
  assert.equal(exported.unresolved, 1)
  assert.ok(await verifyExports(output, records.assets, signal))
  assert.deepEqual(bindViewerMaterials(gltf, () => null, modelPath), { sources: new Set(), images: 0 })
  const sourceModel = structuredClone(gltf)
  const materialPath = '/Game/Fixture/Materials/FixtureMaterial'
  sourceModel.materials[0].name = 'Original authoring slot'
  sourceModel.materials[0].extras = { unrealMaterial: materialPath }
  const sourceBound = bindViewerMaterials(sourceModel, () => assert.fail('Source meshes must use package references'),
    modelPath, path => path === materialPath ? viewer.lookupBySourcePath(shader.sourcePath) : null)
  assert.deepEqual(sourceBound, { sources: new Set([shader]), images: 2 })
  assert.equal(sourceModel.images[0].uri, '../../../Textures/Textures/My%20Albedo.png')
})

test('packed Unreal material selection preserves ORM, remaps MRA, and rejects conflicting or unconfirmed layouts', async t => {
  const root = await testDirectory(t)
  const path = 'Texture.png'
  const data = encodePngScanlines(1, 1, Buffer.from([0, 12, 34, 56]))
  const scratch = join(root, 'staged.png')
  await writeFile(scratch, data)
  const store = new ExportArtifacts(root)
  const original = await store.save(path, { path: scratch, info: { size: data.length } }, { role: 'texture', format: 'png' })
  const texture = { exports: [original] }
  const counts = { repackedMaps: 0 }
  const context = { cache: new Map(), resolve: () => texture, store, workspace: root, counts }
  const binding = layout => ({ layout, sourcePath: 'Mask.uasset', textureId: 'mask', path, corroborated: true })
  const select = (...bindings) => publishPackedMap({ bindings }, context)
  assert.equal((await select(binding('ORM'))).path, path)
  const mra = await select(binding('MRA'))
  assert.deepEqual(readPngRgb(await readFile(join(root, mra.path))).rows, Buffer.from([0, 56, 34, 12]))
  assert.deepEqual(await select(binding('MRA')), mra)
  assert.equal(counts.repackedMaps, 1)
  assert.equal((await select(binding('ORM'), binding('RMA'))).issue, 'unreal-packed-material-ambiguous')
  assert.equal((await select({ ...binding('ORM'), corroborated: false })).issue, 'unreal-packed-material-unconfirmed')
  assert.equal((await select({ ...binding('ORM'), path: null })).issue, 'unreal-packed-material-missing')
  assert.equal(await select({ path: 'File_RMA.png' }), null)
  assert.deepEqual(await readFile(join(root, path)), data)
  await writeFile(join(root, path), Buffer.alloc(original.size))
  await assert.rejects(select(binding('RMA')), /Staged Unreal packed image changed/)
})
