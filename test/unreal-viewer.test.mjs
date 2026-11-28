import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { ExportArtifacts } from '../core/conversion/artifacts.mjs'
import { verifyExports } from '../core/conversion/cache.mjs'
import { viewerModel } from '../core/conversion/unreal/viewer/model.mjs'
import { publishViewerOutputs } from '../core/conversion/unreal/viewer/publish.mjs'
import { stageViewerInputs } from '../core/engines/unreal/viewer/inputs.mjs'
import { cleanupCandidates } from '../core/packages/cleanup/candidates.mjs'
import { testDirectory } from './server-fixture.mjs'

function gltf(name) {
  return { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }],
    bufferViews: [{ buffer: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
    buffers: [{ uri: name + '.bin', byteLength: 42 }] }
}

function psa() {
  const chunks = [['ANIMHEAD', 0, 0], ['BONENAMES', 120, 1], ['ANIMINFO', 168, 1], ['ANIMKEYS', 32, 1]]
  return Buffer.concat(chunks.map(([name, stride, count]) => {
    const bytes = Buffer.alloc(32 + (stride * count))
    bytes.write(name)
    bytes.writeInt32LE(stride, 24)
    bytes.writeInt32LE(count, 28)
    return bytes
  }))
}

test('UE Viewer output keeps owned meshes, LOD buffers and PSA, with file hashes and strict buffer ranges', async t => {
  const root = await testDirectory(t)
  const decoded = join(root, 'decoded')
  const output = join(root, 'output')
  await mkdir(decoded)
  await mkdir(output)
  const bin = Buffer.alloc(42)
  bin.writeFloatLE(1, 12)
  bin.writeFloatLE(1, 28)
  bin.writeUInt16LE(1, 38)
  bin.writeUInt16LE(2, 40)
  for (const name of ['Fixture', 'Fixture_Lod1', 'Outside', 'Broken', 'Unowned']) {
    const record = gltf(name)
    if (name === 'Outside') record.buffers[0].uri = '../Outside.bin'
    if (name === 'Broken') record.bufferViews[1].byteOffset = 37
    await writeFile(join(decoded, name + '.gltf'), JSON.stringify(record))
    await writeFile(join(decoded, name + '.bin'), bin)
  }
  await writeFile(join(decoded, 'Walk.psa'), psa())
  await writeFile(join(decoded, 'Invalid.psa'), psa().subarray(0, -1))
  assert.equal(await viewerModel(decoded, 'Outside.gltf'), null)
  assert.equal(await viewerModel(decoded, 'Broken.gltf'), null)
  const targets = ['Fixture', 'Walk', 'Outside', 'Broken', 'Invalid'].map(id =>
    ({ id, sourcePath: id + '.uasset', output: 'Source/Content/' + id + '.uasset', exports: [], issues: [] }))
  const { counts, models } = await publishViewerOutputs({ targets, decoded, viewer: { version: '1590' },
    store: new ExportArtifacts(output) })
  assert.deepEqual(counts, { gltf: 2, psa: 1, invalid: 3 })
  assert.deepEqual(models.map(item => item.artifact.lod).sort(), [0, 1])
  assert.equal(models[0].artifact.metrics.triangles, 1)
  assert.deepEqual(await readFile(join(output, 'Models/Fixture/ue-viewer/Fixture.bin')), bin)
  assert.deepEqual(targets[1].exports[0].metrics, { bones: 1, sequences: 1, keys: 1 })
  assert.ok(await verifyExports(output, targets.map(({ exports }) => ({ exports }))))
  const source = join(root, 'Content')
  await mkdir(source)
  await writeFile(join(source, 'Fixture.uasset'), 'fixture')
  const candidates = async () => {
    const result = []
    for await (const item of cleanupCandidates('unreal-content', source, {}, targets, true, new AbortController().signal)) {
      result.push(item)
    }
    return result
  }
  const [model, animation] = await candidates()
  assert.equal(model.path, 'Fixture.uasset')
  assert.deepEqual(model.backups.slice(1).map(item => item.format).sort(), ['bin', 'bin', 'gltf', 'gltf'])
  assert.equal(animation.path, 'Walk.uasset')
  targets[0].exports = targets[0].exports.filter(item => item.format !== 'bin')
  assert.deepEqual((await candidates()).map(item => item.path), ['Walk.uasset'])
})

test('UE Viewer stages versioned UE4 objects and their recorded sidecars outside the managed source copy', async t => {
  const root = await testDirectory(t)
  const output = join(root, 'output')
  const input = join(root, 'input')
  await mkdir(join(output, 'Source'), { recursive: true })
  const file = (id, name, fields) => ({ id, sourcePath: name, output: 'Source/' + name, size: 1, ...fields })
  const assets = [
    file('ue4', 'Fixture.uasset', { type: 'uasset', ue4: 514, ue5: 0, storage: 'editor' }),
    file('ue5', 'Excluded.uasset', { type: 'uasset', ue4: 522, ue5: 1008, storage: 'editor' }),
    file('sidecar', 'Fixture.uexp', { type: 'uexp' }),
    file('unrelated', 'Foreign.uexp', { type: 'uexp' }),
  ]
  for (const asset of assets) await writeFile(join(output, asset.output), 'x')
  const { targets } = await stageViewerInputs({ assets, dependencies: [
    { source: 'ue4', target: 'sidecar', type: 'unreal-package-companion' },
    { source: 'ue5', target: 'unrelated', type: 'unreal-package-companion' },
  ] }, output, input)
  assert.deepEqual(targets.map(row => row.id), ['ue4'])
  assert.equal(await readFile(join(input, 'Fixture.uexp'), 'utf8'), 'x')
  await assert.rejects(access(join(input, 'Excluded.uasset')), { code: 'ENOENT' })
  await assert.rejects(access(join(input, 'Foreign.uexp')), { code: 'ENOENT' })
  await writeFile(join(input, 'Fixture.uasset'), 'y')
  assert.equal(await readFile(join(output, 'Source/Fixture.uasset'), 'utf8'), 'x')
})
