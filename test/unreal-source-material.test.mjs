import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bindViewerMaterials } from '../core/conversion/unreal/viewer/bind-materials.mjs'
import { unrealGameAssetResolver } from '../core/engines/unreal/editor-package/game-path.mjs'
import { readSourceMaterial } from '../core/engines/unreal/source-material/properties.mjs'
import { sourceTextureSettings } from '../core/engines/unreal/source-material/texture-properties.mjs'
import { describeUnrealMaterial } from '../core/materials/unreal/describe.mjs'
import { sourceMaterialParameters } from '../core/materials/unreal/source-parameters.mjs'
import { sourceMaterialFixture, sourceNormalTexture } from './fixtures/unreal-source-material.mjs'

const texture = '/Game/Example/T_Colors'
const asset = { id: 'example', sourcePath: 'Example/MI_Example.uasset', hash: 'abc' }
const parent = { id: 'parent', sourcePath: 'Example/M_Master.uasset' }
const png = 'Textures/Example/T_Colors.png'
const resolve = path => path === '/Game/Example/M_Master' ? parent : path === texture ? {
  id: 'color', exports: [{ path: png, format: 'png', role: 'texture' }],
} : null

test('stock UE4 material properties require typed imports and bounded tagged arrays', () => {
  const material = readSourceMaterial(sourceMaterialFixture())
  assert.equal(material.type, 'MaterialInstanceConstant')
  assert.equal(material.parent, '/Game/Example/M_Master')
  assert.deepEqual(material.textures, [{ name: 'BaseColor', association: 'GlobalParameter', index: -1,
    path: texture, status: 'reference' }])
  assert.deepEqual(material.streaming, [{ path: texture, uvChannel: 0, samplingScale: null }])
  assert.equal(readSourceMaterial(sourceMaterialFixture({ badObject: true })).textures[0].status, 'unsupported-reference')
  assert.throws(() => readSourceMaterial(sourceMaterialFixture({ entries: 257 })), RangeError)
  assert.throws(() => readSourceMaterial(sourceMaterialFixture({ entries: 2 })), RangeError)
})

test('UE4 514 material and texture layouts retain the legacy parameter name and import settings', () => {
  const options = { legacy: true }
  const bytes = sourceMaterialFixture(options)
  assert.equal(readSourceMaterial(bytes), null)
  assert.deepEqual(readSourceMaterial(bytes, 514), readSourceMaterial(sourceMaterialFixture()))
  assert.equal(readSourceMaterial(sourceMaterialFixture({ ...options, badObject: true }), 514).textures[0].status,
    'unsupported-reference')
  assert.throws(() => readSourceMaterial(sourceMaterialFixture({ ...options, modernParameter: true }), 514), RangeError)
  bytes.writeInt32LE(40, 40)
  assert.equal(readSourceMaterial(bytes, 514), null)
  assert.deepEqual(sourceTextureSettings(sourceNormalTexture({ flip: true, png: Buffer.alloc(0), legacy: true }), 514), {
    compression: 'TC_Normalmap', srgb: false, flipGreenOnImport: true, discardAlpha: false, legacyGamma: false, repeat: true,
  })
})

test('a nested Unreal project resolves /Game only inside its own Content tree', () => {
  const packageAt = sourcePath => ({ type: 'uasset', sourcePath, output: 'Source/Content/' + sourcePath })
  const projects = ['Export/First', 'Other/Second'].map(path => ({ type: 'uproject', sourcePath: path + '/Project.uproject' }))
  const from = packageAt('Export/First/Content/Example/MI_Example.uasset')
  const first = packageAt('Export/First/Content/Example/T_Colors.uasset')
  const second = packageAt('Other/Second/Content/Example/T_Colors.uasset')
  const foreign = packageAt('Other/Second/Content/Example/T_Foreign.uasset')
  const loose = packageAt('Example/T_Colors.uasset')
  const nested = [from, first, second, foreign, loose]
  const resolve = unrealGameAssetResolver([...projects, ...nested], 'F:\\Assets')
  assert.equal(resolve(texture, from), first)
  assert.equal(resolve(texture, foreign), second)
  assert.equal(resolve(texture, loose), loose)
  assert.equal(resolve('/Game/Example/T_Foreign', from), null)
  assert.equal(resolve('/Game/../Other/Second/Content/Example/T_Foreign', from), null)
  assert.equal(resolve('/Game/Other/Second/Content/Example/T_Foreign', loose), null)
})

test('UE4 material previews require a known parameter and exact matching UV0 texture metadata', () => {
  for (const uv of [0, 1]) {
    const material = readSourceMaterial(sourceMaterialFixture({ uv }))
    const parsed = new Map([[asset.id, material]])
    const { textures, scalars, corroborate } = sourceMaterialParameters(asset, parsed, resolve)
    const description = describeUnrealMaterial({ asset, properties: { textures, scalars }, resolve, version: 1, corroborate })
    assert.equal(corroborate('/Game/Other/T_Colors'), false)
    assert.equal(description.bindings[0].corroborated, uv === 0)
    const gltf = { materials: [{ name: 'MI_Example', extras: { unrealMaterial: '/Game/Example/MI_Example' },
      pbrMetallicRoughness: {} }], meshes: [{ primitives: [{ material: 0, attributes: { TEXCOORD_0: 1 } }] }] }
    const result = bindViewerMaterials(gltf, null, 'Models/mesh/A.gltf', path =>
      path === '/Game/Example/MI_Example' ? { asset, description } : null)
    assert.equal(result.images, uv === 0 ? 1 : 0)
    assert.equal(gltf.images?.[0].uri, uv === 0 ? '../../' + png : undefined)
  }
})

test('UE4 instance inheritance respects local overrides, duplicate names, and invalid lineage', () => {
  const defaults = readSourceMaterial(sourceMaterialFixture())
  const child = { ...defaults, textures: [], scalars: [], vectors: [] }
  const base = { ...defaults, parent: null, parentStatus: 'base' }
  const parsed = new Map([[asset.id, child], [parent.id, base]])
  const effective = () => sourceMaterialParameters(asset, parsed, resolve)
  assert.equal(effective().textures[0].definedIn, parent.sourcePath)
  assert.equal(effective().parentStatus, 'resolved')
  child.textures.push({ ...base.textures[0], status: 'empty', path: null })
  assert.equal(effective().textures[0].path, null)
  child.textures.push({ ...base.textures[0], name: 'basecolor' })
  assert.deepEqual(effective().textures, [])
  child.textures.length = 0
  base.parent = child.parent
  base.parentStatus = 'reference'
  assert.equal(effective().parentStatus, 'invalid-lineage')
  assert.deepEqual(effective().textures, [])
})
