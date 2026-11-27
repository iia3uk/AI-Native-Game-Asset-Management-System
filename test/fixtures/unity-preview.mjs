import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { encodePngScanlines } from '../../core/files/png.mjs'
import { writeUnityFixture } from './unitypackage.mjs'

const ids = {
  model: '1'.repeat(32), material: '2'.repeat(32), albedo: '3'.repeat(32), mask: '4'.repeat(32),
  normal: '5'.repeat(32),
}
const previewFbx = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
}
Objects:  {
\tGeometry: 100, "Geometry::Panel", "Mesh" {
\t\tVertices: *12 {
\t\t\ta: -0.8,-0.8,0,0.8,-0.8,0,0.8,0.8,0,-0.8,0.8,0
\t\t}
\t\tPolygonVertexIndex: *4 {
\t\t\ta: 0,1,2,-4
\t\t}
\t\tLayerElementUV: 0 {
\t\t\tMappingInformationType: "ByPolygonVertex"
\t\t\tReferenceInformationType: "Direct"
\t\t\tUV: *8 {
\t\t\t\ta: 0,0,1,0,1,1,0,1
\t\t\t}
\t\t}
\t}
\tModel: 200, "Model::Preview", "Mesh" {
\t\tVersion: 232
\t}
\tMaterial: 300, "Material::FixtureSlot", "" {
\t\tVersion: 102
\t\tShadingModel: "phong"
\t\tMultiLayer: 0
\t}
}
Connections:  {
\tC: "OO",100,200
\tC: "OO",300,200
\tC: "OO",200,0
}
`

function onePixel(channels) {
  return encodePngScanlines(1, 1, Buffer.from([0, ...channels]), { alpha: channels.length === 4 })
}

function writeTexture(directory, name, guid, channels, linear, extra = '') {
  return Promise.all([
    writeFile(join(directory, name), onePixel(channels)),
    writeFile(join(directory, name + '.meta'), `fileFormatVersion: 2\nguid: ${guid}\nTextureImporter:\n  mipmaps:\n    sRGBTexture: ${linear ? 0 : 1}\n${extra}`),
  ])
}

export async function writeUnityPreviewFixture(root) {
  const directory = join(root, 'Assets')
  await mkdir(directory, { recursive: true })
  const remap = [
    '  externalObjects:', '  - first:', '      type: UnityEngine:Material',
    '      assembly: UnityEngine.CoreModule', '      name: FixtureSlot',
    '    second: {fileID: 2100000, guid: ' + ids.material + ', type: 2}',
  ].join('\n')
  const material = [
    '%YAML 1.1', '--- !u!21 &2100000', 'Material:', '  m_Name: Authored panel',
    '  m_Shader: {fileID: 4800000, guid: 6e4ae4064600d784cac1e41a9e6f2e59, type: 3}',
    '  m_SavedProperties:', '    m_TexEnvs:',
    ...[['_BaseColorMap', ids.albedo], ['_MaskMap', ids.mask], ['_NormalMap', ids.normal]].flatMap(([property, guid]) => [
      '    - ' + property + ':', `        m_Texture: {fileID: 2800000, guid: ${guid}, type: 3}`,
      '        m_Scale: {x: 2, y: 3}', '        m_Offset: {x: 0.25, y: 0.125}',
    ]),
    '    m_Floats:', '    - _NormalScale: 0.75', '    - _SmoothnessRemapMin: 0.125',
    '    - _MetallicRemapMin: 0.125', '    - _MetallicRemapMax: 0.625',
    '    - _AORemapMin: 0.25', '    - _AORemapMax: 0.75',
    '    m_Colors:', '    - _BaseColor: {r: 0.75, g: 1, b: 0.625, a: 1}', '',
  ].join('\n')
  await Promise.all([
    writeFile(join(directory, 'Panel.fbx'), previewFbx),
    writeFile(join(directory, 'Panel.fbx.meta'), `fileFormatVersion: 2\nguid: ${ids.model}\nModelImporter:\n${remap}\n`),
    writeFile(join(directory, 'Authored.mat'), material),
    writeFile(join(directory, 'Authored.mat.meta'), `fileFormatVersion: 2\nguid: ${ids.material}\nNativeFormatImporter:\n`),
    writeTexture(directory, 'Color.png', ids.albedo, [180, 120, 144, 255], false),
    writeTexture(directory, 'Packed.png', ids.mask, [153, 64, 217, 0], true),
    writeTexture(directory, 'Vectors.png', ids.normal, [156, 171, 241], true, '  flipGreenChannel: 1\n  textureType: 1\n'),
  ])
  return root
}

export async function writeUnityPreviewPackage(root) {
  await writeUnityPreviewFixture(root)
  const entries = await Promise.all([
    ['Panel.fbx', ids.model], ['Authored.mat', ids.material], ['Color.png', ids.albedo],
    ['Packed.png', ids.mask], ['Vectors.png', ids.normal],
  ].map(async ([name, guid]) => {
    const path = join(root, 'Assets', name)
    const [asset, meta] = await Promise.all([readFile(path), readFile(path + '.meta')])
    return [
      { name: guid + '/asset', payload: asset },
      { name: guid + '/asset.meta', payload: meta },
      { name: guid + '/pathname', payload: `Assets/${name}\n` },
    ]
  }))
  return writeUnityFixture(join(root, 'Panel.unitypackage'), entries.flat())
}
