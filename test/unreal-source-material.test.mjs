import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bindViewerMaterials } from '../core/conversion/unreal/viewer/bind-materials.mjs'
import { readSourceMaterial } from '../core/engines/unreal/source-material/properties.mjs'
import { describeUnrealMaterial } from '../core/materials/unreal/describe.mjs'
import { sourceMaterialParameters } from '../core/materials/unreal/source-parameters.mjs'
import { sourceMaterialFixture } from './fixtures/unreal-source-material.mjs'

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
