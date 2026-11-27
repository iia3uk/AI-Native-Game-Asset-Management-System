import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeUnityMaterial } from '../core/materials/unity/describe.mjs'
import { parseUnityMaterial } from '../core/materials/unity/yaml.mjs'

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
