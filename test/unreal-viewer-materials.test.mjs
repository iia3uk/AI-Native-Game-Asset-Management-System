import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { dependencyLocation } from '../core/analysis/asset-analysis.mjs'
import { ExportArtifacts } from '../core/conversion/artifacts.mjs'
import { verifyExports } from '../core/conversion/cache.mjs'
import { bindViewerMaterials, publishTexturedViewerModels } from '../core/conversion/unreal/viewer/bind-materials.mjs'
import { publishViewerMaterials } from '../core/conversion/unreal/viewer/materials.mjs'
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
  ])
  for (const [directory, path, bytes] of [
    [output, modelPath, gltfBytes],
    [decoded, 'Materials/FixtureMaterial.mat', 'Diffuse=My Albedo\nNormal=My Albedo\nEmissive=Missing\n'],
    [decoded, 'Materials/FixtureMaterial.props.txt', materialProps],
    [decoded, 'Textures/My Albedo.png', sourcePng],
    [decoded, 'Other/My Albedo.png', Buffer.from('invalid PNG')],
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
  const records = { assets: [mesh, shader, texture, wrongTexture], dependencies: [] }
  const artifact = { path: modelPath, lod: 0, format: 'gltf', role: 'model', status: 'converted' }
  const viewer = await publishViewerMaterials({ records, targets: records.assets, store, version: '1590', signal,
    parameters: { output: decoded, workspace: root } })
  await publishTexturedViewerModels({ ...viewer, models: [{ asset: mesh, artifact }], records, output,
    workspace: root, store, signal })
  assert.deepEqual(viewer.counts, { materialJson: 1, texturePng: 1, texturedGltf: 1 })
  const textured = mesh.exports.at(-1)
  const bound = JSON.parse(await readFile(join(output, textured.path), 'utf8'))
  assert.deepEqual(bound.materials[0].pbrMetallicRoughness,
    { baseColorFactor: [1, 1, 1, 1], baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: .8 })
  assert.equal(bound.materials[0].normalTexture, undefined)
  assert.equal(bound.materials[0].emissiveTexture, undefined)
  assert.equal(bound.images[0].uri, '../../../Textures/Textures/My%20Albedo.png')
  assert.equal(dependencyLocation(textured.path, bound.images[0].uri, { uri: true }).path, texture.exports[0].path)
  assert.equal(await readFile(join(output, artifact.path), 'utf8'), gltfBytes)
  const description = JSON.parse(await readFile(join(output, shader.exports[0].path), 'utf8'))
  assert.deepEqual(description.bindings.map(item => [item.role, item.status]),
    [['baseColor', 'resolved'], ['emissive', 'missing'], ['normal', 'resolved']])
  const exported = await selectPackageAssets({ assets: records.assets, directory: output }, records, mesh, signal)
  assert.deepEqual(exported.assets.map(item => item.id), ['mesh', 'material', 'texture'])
  assert.equal(exported.unresolved, 1)
  assert.ok(await verifyExports(output, records.assets, signal))
  assert.deepEqual(bindViewerMaterials(gltf, () => null, modelPath), { sources: new Set(), images: 0 })
})
