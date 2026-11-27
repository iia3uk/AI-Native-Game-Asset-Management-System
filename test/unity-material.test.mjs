import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { scanFolder } from '../core/library/local-folders.mjs'
import { describeUnityMaterial } from '../core/materials/unity/describe.mjs'
import { unityPreviewBinding } from '../core/materials/unity/preview-bindings.mjs'
import { parseUnityMaterial } from '../core/materials/unity/yaml.mjs'
import { writeUnityPreviewFixture } from './fixtures/unity-preview.mjs'
import { testDirectory } from './server-fixture.mjs'

test('Unity material channels depend on the shader and its authored settings', () => {
  function material(guid, properties) {
    const source = [
      '%YAML 1.1', '--- !u!21 &2100000', 'Material:', '  m_Name: Multi-profile material',
      '  m_Shader: {guid: ' + guid + ', fileID: 4800000, type: 3}', '  m_SavedProperties:',
      '    m_TexEnvs:', ...properties.flatMap(property => ['    - ' + property + ':', '        m_Texture: {fileID: 0}']),
      '    m_Floats:', '    - _SmoothnessTextureChannel: 1', '',
      '--- !u!21 &2100001', 'Material:', '  m_Name: Other material', '',
    ].join('\r\n')
    return describeUnityMaterial(parseUnityMaterial(source), { path: 'Fixture.mat' }, () => assert.fail('Unassigned texture'))
  }

  const unknown = material('a'.repeat(32), ['_MaskMap'])
  assert.equal(unknown.shader.profile, null)
  assert.deepEqual(unknown.textures.map(binding => binding.roles), [[]])
  assert.equal(unknown.textures[0].status, 'unassigned')

  const hd = material('6e4ae4064600d784cac1e41a9e6f2e59', ['_MaskMap'])
  assert.equal(hd.shader.profile, 'hdrp-lit')
  assert.deepEqual(hd.textures[0].roles.map(({ role, channels }) => [role, channels]), [
    ['metallic', 'r'], ['ambientOcclusion', 'g'], ['detailMask', 'b'], ['roughness', 'a'],
  ])

  const urp = material('933532a4fcc9baf4fa0491de14d08ed7', ['_MetallicGlossMap', '_BaseMap', '_OcclusionMap'])
  assert.equal(urp.shader.profile, 'urp-lit')
  assert.deepEqual(urp.textures.map(binding => binding.roles.map(role => role.channels)), [['r'], ['rgb', 'a'], ['g']])
  assert.equal(urp.textures[1].roles[1].operation, 'one-minus-smoothness')
})

test('Standard and URP previews follow the selected metallic and smoothness inputs', () => {
  const standard = { guid: '0000000000000000f000000000000000', fileID: '46' }
  const urp = { guid: '933532a4fcc9baf4fa0491de14d08ed7', fileID: '4800000' }
  const resolve = reference => ({ status: 'file-resolved', url: reference.guid })
  const slot = property => ({ property, reference: { fileID: '2800000', guid: property }, scale: [2, 3], offset: [0, 0] })
  const material = {
    shader: standard, colors: {}, numbers: { _GlossMapScale: .7, _Smoothness: .4, _SmoothnessTextureChannel: 1 },
    keywords: ['_METALLICGLOSSMAP'], textures: ['_MainTex', '_BaseMap', '_MetallicGlossMap', '_BumpMap'].map(slot),
  }
  const builtIn = unityPreviewBinding(material, resolve)
  const universal = unityPreviewBinding({ ...material, shader: urp, keywords: ['_METALLICSPECGLOSSMAP'] }, resolve)
  assert.equal(builtIn.maps.roughness.url, '_MainTex')
  assert.deepEqual(builtIn.maps.roughness.range, [0, .7])
  assert.equal(universal.maps.roughness.url, '_BaseMap')
  assert.deepEqual(universal.maps.roughness.range, [0, .4])
  for (const { maps } of [builtIn, universal]) {
    assert.equal(maps.roughness.channels, 'a')
    assert.equal(maps.metallic.url, '_MetallicGlossMap')
    assert.equal(maps.normal, undefined)
  }
  assert.equal(unityPreviewBinding({ ...material, shader: urp, keywords: ['_SPECULAR_SETUP'] }, resolve), null)
})

test('Unity preview requires the referenced material file ID before applying PBR maps', async t => {
  const root = await writeUnityPreviewFixture(await testDirectory(t))
  const modelFile = folder => folder.files.get('Assets/Panel.fbx').materialTextures.fixtureslot
  assert.ok(modelFile(await scanFolder(root)).pbr)
  const meta = join(root, 'Assets', 'Panel.fbx.meta')
  await writeFile(meta, (await readFile(meta, 'utf8')).replace('fileID: 2100000', 'fileID: 2100001'))
  const fallback = modelFile(await scanFolder(root))
  assert.equal(fallback.pbr, undefined)
  assert.ok(fallback.url)
})
