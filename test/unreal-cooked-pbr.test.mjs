import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readPngRgb } from '../core/files/png-rgb.mjs'
import { cookedPbrFixture, cookedPbrMask } from './fixtures/unreal-cooked-pbr.mjs'
import { makeModernPak } from './fixtures/unreal-pak.mjs'
import { testDirectory } from './server-fixture.mjs'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
const json = path => readFile(path, 'utf8').then(JSON.parse)

function glbTexture(bytes, texture) {
  const bin = 20 + bytes.readUInt32LE(12)
  const document = JSON.parse(bytes.toString('utf8', 20, bin))
  const image = document.images[document.textures[texture.index].source]
  const { byteOffset, byteLength } = document.bufferViews[image.bufferView]
  return bytes.subarray(bin + 8 + byteOffset, bin + 8 + byteOffset + byteLength)
}

for (const mode of ['loose', 'pak']) test('cooked ' + mode + ' publishes verified normal and packed PBR maps for both LODs', {
  skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 60_000,
}, async t => {
  const root = await testDirectory(t)
  const fixture = cookedPbrFixture()
  const pak = makeModernPak(fixture.map(item => ({ ...item, compressed: true })))
  const loose = mode === 'loose'
  const source = join(root, loose ? 'Content' : 'Materials.pak')
  if (loose) {
    await mkdir(join(source, 'Characters'), { recursive: true })
    await Promise.all(fixture.map(item => writeFile(join(source, item.path), item.content)))
  } else await writeFile(source, pak)
  const query = async (...args) => JSON.parse((await run(process.execPath, [cli, ...args, '--json'], { windowsHide: true,
    env: { ...process.env, ASSET_VIEWER_DATA_DIR: join(root, 'data'), ASSET_VIEWER_UE_VIEWER: '' } })).stdout)
  const load = () => query('package-import', source, '--export', 'glb')
  const { job, scan } = await load()
  assert.equal(scan.status, 'completed')
  const { directory, report } = job.result
  const summary = loose ? report.unrealCooked : report
  const { materials } = summary
  assert.deepEqual([materials.normalMaterials, materials.normalDerivatives, materials.packedMaterials, materials.repackedMaps], [2, 1, 4, 2])

  const manifestPath = join(directory, 'manifest.json')
  const manifest = await json(manifestPath)
  const key = loose ? 'assets' : 'entries'
  const rows = manifest[key]
  const find = name => rows.find(row => (row.sourcePath ?? row.path).endsWith('/' + name + '.uasset'))
  const description = name => json(join(directory, find(name).exports.find(item => item.role === 'material').path))
  const paint = await description('MI_Paint')
  assert.equal((await description('MI_Inherited')).normalMap.path, paint.normalMap.path)
  assert.equal((await description('MI_Inherited')).packedMap.path, paint.packedMap.path)
  assert.equal((await description('MI_ORM')).packedMap.path, paint.packedMap.sourceImage)
  assert.equal((await description('MI_WrongUv')).packedMap.issue, 'unreal-packed-material-unconfirmed')
  assert.equal((await description('MI_WrongUv')).normalMap.issue, 'unreal-cooked-normal-unconfirmed')
  assert.equal((await description('MI_Unsafe')).packedMap.issue, 'unreal-cooked-packed-color-space')
  assert.equal((await description('MI_Unsafe')).normalMap.issue, 'unreal-cooked-normal-format')
  assert.equal((await description('MI_Conflict')).packedMap.issue, 'unreal-packed-material-ambiguous')

  const normalBytes = await readFile(join(directory, paint.normalMap.path))
  const normal = readPngRgb(normalBytes)
  const original = readPngRgb(await readFile(join(directory, paint.normalMap.sourceImage)))
  assert.deepEqual([normal.width, normal.height], [2, 1])
  assert.deepEqual([...original.rows.subarray(1, 3)], [100, 180])
  assert.deepEqual([...normal.rows.subarray(1)], [100, 75, original.rows[3], 255, 100, 75, original.rows[7], 255])
  const packed = await readFile(join(directory, paint.packedMap.path))
  assert.deepEqual([...readPngRgb(packed).rows], [0, 150, 72, 10])
  for (const bytes of [packed, normalBytes]) {
    assert.equal(bytes.toString('ascii', 37, 41), 'gAMA')
    assert.equal(bytes.readUInt32BE(41), 100_000)
  }
  const rma = await description('MI_RMA')
  assert.deepEqual([...readPngRgb(await readFile(join(directory, rma.packedMap.path))).rows], [0, 150, 10, 72])
  assert.deepEqual(readPngRgb(await readFile(join(directory, paint.packedMap.sourceImage))).rows.subarray(1), cookedPbrMask)

  const mesh = find('SK_Test')
  const previews = mesh.exports.filter(item => item.role === 'skeletal-model' && item.format === 'glb')
  assert.equal(previews.length, 2)
  for (const preview of previews) {
    const bytes = await readFile(join(directory, preview.path))
    const model = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)))
    const [material] = model.materials
    assert.ok(material.pbrMetallicRoughness.baseColorTexture)
    assert.equal(model.images.length, 3)
    assert.deepEqual(material.occlusionTexture, material.pbrMetallicRoughness.metallicRoughnessTexture)
    assert.deepEqual(glbTexture(bytes, material.normalTexture), normalBytes)
    assert.deepEqual(glbTexture(bytes, material.occlusionTexture), packed)
  }

  const destination = join(root, 'Export')
  await mkdir(destination)
  const selection = ['package-export', job.id, destination, '--asset', String(rows.indexOf(mesh))]
  const plan = await query(...selection)
  assert.equal(plan.unresolved, 0)
  const exported = await query(...selection, '--plan-key', plan.key)
  assert.deepEqual(await readFile(join(exported.directory, paint.normalMap.path)), normalBytes)
  assert.deepEqual(await readFile(join(exported.directory, paint.packedMap.path)), packed)

  assert.equal((await load()).job.result.reused, true)
  if (loose) {
    for (const item of fixture) assert.deepEqual(await readFile(join(source, item.path)), item.content)
  } else assert.deepEqual(await readFile(source), pak)
  const texture = find('T_Bump')
  texture.exports = texture.exports.filter(item => item.role !== 'preview-texture')
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(load, error => /импорт Unreal|импорта Unreal/.test(JSON.parse(error.stdout).job.error))
})
