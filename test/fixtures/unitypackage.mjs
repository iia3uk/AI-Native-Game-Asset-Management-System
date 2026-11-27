import { writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'

export const ids = Object.freeze({
  folder: '1'.repeat(32),
  model: '2'.repeat(32),
  material: '3'.repeat(32),
  texture: '4'.repeat(32),
  prefab: '5'.repeat(32),
  script: '6'.repeat(32),
})

export const fixtureTexture = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==', 'base64')
export const fixtureModel = 'o Package triangle\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'

function uint(value, width) {
  return value.toString(8).padStart(width - 1, '0') + '\0'
}

export function tarMember({ name, payload = '', type = '0', link = '' }) {
  const bytes = Buffer.from(payload)
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  header.write(uint(0o644, 8), 100)
  header.write(uint(0, 8), 108)
  header.write(uint(0, 8), 116)
  header.write(uint(bytes.length, 12), 124)
  header.write(uint(0, 12), 136)
  header.fill(32, 148, 156)
  header.write(type, 156)
  header.write(link, 157, 100)
  header.write('ustar\0', 257)
  header.write('00', 263)
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)])
}

export function unityEntries(id, path, contents, { meta = '', preview } = {}) {
  return [
    { name: './' + id + '/', type: '5' },
    ...(contents === null ? [] : [{ name: id + '/asset', payload: contents }]),
    { name: id + '/asset.meta', payload: 'fileFormatVersion: 2\nguid: ' + id + '\n' + meta },
    { name: id + '/pathname', payload: path + '\n' },
    ...(preview ? [{ name: id + '/preview.png', payload: preview }] : []),
  ]
}

export function unityFixtureEntries(extra = []) {
  const reference = (fileID, guid) => '{fileID: ' + fileID + ', guid: ' + guid + ', type: 3}'
  return [
    ...unityEntries(ids.folder, 'Assets/Imported', null, { meta: 'folderAsset: yes\n' }),
    ...unityEntries(ids.model, 'Assets/Imported/fixture-package.obj', fixtureModel, { preview: fixtureTexture }),
    ...unityEntries(ids.material, 'Assets/Imported/fixture.mat', [
      '%YAML 1.1', '--- !u!21 &2100000', 'Material:', '  m_Name: Fixture',
      '  m_TexEnvs:', '  - _MainTex:', '      m_Texture: ' + reference('2800000', ids.texture),
      '  - _Missing:', '      m_Texture: ' + reference('987654321012345678', 'a'.repeat(32)), '',
    ].join('\n')),
    ...unityEntries(ids.texture, 'Assets/Imported/albedo.png', fixtureTexture),
    ...unityEntries(ids.prefab, 'Assets/Imported/fixture.prefab', [
      '%YAML 1.1', '--- !u!1 &100100000', 'GameObject:', '  m_Component: {fileID: 3300000}',
      '--- !u!33 &3300000', 'MeshFilter:', '  m_Mesh: ' + reference('4300000', ids.model),
      '  m_Material: ' + reference('2100000', ids.material), '',
    ].join('\n')),
    ...unityEntries(ids.script, 'Assets/Editor/never.cs', 'public class Never {}'),
    ...extra,
  ]
}

export function archiveBytes(entries) {
  return gzipSync(Buffer.concat([...entries.map(tarMember), Buffer.alloc(1024)]))
}

export async function writeUnityFixture(path, entries = unityFixtureEntries()) {
  await writeFile(path, archiveBytes(entries))
  return path
}
