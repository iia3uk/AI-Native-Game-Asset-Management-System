import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { inflateSync } from 'node:zlib'
import { cleanupCandidates } from '../core/packages/cleanup/candidates.mjs'
import { cookedMaterial } from './fixtures/unreal-cooked-material.mjs'
import { cookedTexture } from './fixtures/unreal-cooked-texture.mjs'
import { cookedAudioFiles, cookedSoundWave } from './fixtures/unreal-cooked-soundwave.mjs'
import { makePak, wavTone } from './fixtures/unreal-pak.mjs'
import { zenOgg } from './fixtures/unreal-zen-audio.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const jobs = '/api/index/jobs/'
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'))

async function post(server, route, data, status = 200) {
  const response = await server.post(route, data)
  const result = await response.json()
  assert.equal(response.status, status, JSON.stringify(result))
  return result
}

async function finish(server, id) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const { job } = await (await server.request(jobs + id)).json()
    if (!['pending', 'running'].includes(job.status)) return job
    await setTimeout(80)
  }
  assert.fail('Cooked Unreal job did not finish')
}

async function importPath(server, path) {
  const { package: source } = await post(server, '/api/index/packages/inspect', { path })
  const { job } = await post(server, '/api/index/packages/import', { path, hash: source.hash }, 202)
  return finish(server, job.id)
}

test('versioned cooked SoundWave imports verified audio from a folder and a Pak',
  { skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 45_000 }, async t => {
    const root = await testDirectory(t)
    const content = join(root, 'Content')
    const destination = join(root, 'Exports')
    await Promise.all([mkdir(content), mkdir(destination)])
    const files = cookedAudioFiles()
    await Promise.all(files.map(file => writeFile(join(content, file.path), file.content)))
    const pak = join(root, 'Audio.pak')
    await writeFile(pak, makePak(files))
    const server = await startServer(root)
    try {
      for (const path of [content, pak]) {
        const job = await importPath(server, path)
        assert.equal(job.status, 'completed', job.error)
        const { directory, report, scanJobId } = job.result
        assert.deepEqual(report.unrealCooked?.audio ?? report.audio, { converted: 2, skipped: 1, failed: 0 })
        assert.equal((await finish(server, scanJobId)).status, 'completed')
        const { assets } = await (await server.request(jobs + job.id + '/manifest')).json()
        const sourcePath = item => item.sourcePath ?? item.path
        const row = name => assets.find(item => sourcePath(item).split('/').at(-1) === name + '.uasset')
        const wave = row('Inline').exports.find(item => item.role === 'audio')
        const ogg = row('Streamed').exports.find(item => item.role === 'audio')
        assert.equal(wave.format, 'wav')
        assert.equal(ogg.format, 'ogg')
        assert.deepEqual(await readFile(join(directory, wave.path)), wavTone())
        assert.deepEqual(await readFile(join(directory, ogg.path)), zenOgg)
        assert.equal(row('Opus').exports.find(item => item.role === 'audio')?.issue, 'unreal-cooked-audio-format')
        assert.ok(!row('OtherClass').exports?.some(item => item.role === 'audio'))
        const asset = assets.indexOf(row('Streamed'))
        const route = jobs + job.id
        const plan = await post(server, route + '/export-plan', { destination, asset })
        const exported = await post(server, route + '/export', { destination, asset, key: plan.key }, 201)
        assert.deepEqual(await readFile(join(exported.directory, ogg.path)), zenOgg)
        const manifest = await readJSON(join(exported.directory, 'manifest.json'))
        assert.ok((manifest.assets ?? manifest.entries).some(item => sourcePath(item).endsWith('Streamed.ubulk')))
        assert.equal((await importPath(server, path)).result.reused, true)
      }
      for (const file of files) assert.deepEqual(await readFile(join(content, file.path)), file.content)
    } finally { await server.close() }
  })

test('cooked SoundWave reports missing bulk, invalid ranges, and corrupt audio separately',
  { skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 30_000 }, async t => {
    const root = await testDirectory(t)
    const path = join(root, 'Damaged.pak')
    const damaged = Buffer.from(zenOgg)
    damaged[damaged.length - 1] ^= 1
    const files = [
      ...cookedSoundWave({ name: 'Missing', format: 'OGG', payload: zenOgg, streaming: true, companion: false }),
      ...cookedSoundWave({ name: 'OutOfRange', format: 'OGG', payload: zenOgg, streaming: true, externalOffset: -1 }),
      ...cookedSoundWave({ name: 'BadCRC', format: 'OGG', payload: damaged }),
      { path: 'Unrelated.ubulk', content: zenOgg },
    ]
    await writeFile(path, makePak(files))
    const server = await startServer(root)
    try {
      const job = await importPath(server, path)
      assert.equal(job.status, 'completed', job.error)
      assert.deepEqual(job.result.report.audio, { converted: 0, skipped: 2, failed: 1 })
      const { assets } = await (await server.request(jobs + job.id + '/manifest')).json()
      const issues = assets.flatMap(item => (item.exports ?? []).filter(x => x.role === 'audio').map(x => x.issue))
      assert.deepEqual(issues.sort(), ['unreal-cooked-audio-bulk-range', 'unreal-cooked-audio-bulk-unavailable',
        'unreal-cooked-audio-output'])
    } finally { await server.close() }
  })

async function fixture(t) {
  const root = await testDirectory(t)
  const content = join(root, 'Content')
  const example = join(content, 'Example')
  await mkdir(example, { recursive: true })
  const files = [
    ...cookedMaterial({ name: 'M_Master', split: false }),
    ...cookedMaterial({ name: 'MI_Paint', parent: ['/Game/Example/M_Master'],
      textures: [{ parameter: 'BaseColor', value: '/Game/Example/T_Paint' }] }),
    ...cookedTexture({ name: 'T_Paint', format: 'PF_G8', width: 1, height: 1, pixels: Buffer.from([42]), external: true }),
    ...cookedTexture({ name: 'T_Single', format: 'PF_G8', width: 1, height: 1, pixels: Buffer.from([75]), split: false }),
    ...cookedTexture({ name: 'T_Orphan', format: 'PF_G8', width: 1, height: 1, pixels: Buffer.from([21]) }).slice(0, 1),
  ]
  await Promise.all(files.map(file => writeFile(join(example, file.path), file.content)))
  return { root, content, example, files }
}

function pngPixels(png) {
  const data = []
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at)
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') data.push(png.subarray(at + 8, at + 8 + size))
    at += size + 12
  }
  return [...inflateSync(Buffer.concat(data))]
}

test('loose cooked materials keep a typed dependency graph when the native texture worker is absent', async t => {
  const { root, content } = await fixture(t)
  const server = await startServer(root, { ASSET_VIEWER_CUE4PARSE: join(root, 'absent-worker') })
  try {
    const job = await importPath(server, content)
    assert.equal(job.status, 'completed', job.error)
    const { directory, report } = job.result
    assert.equal(report.unrealCooked.textures.issue, 'unreal-loose-textures-unavailable')
    assert.equal(report.unrealCooked.materials.converted, 2)
    const manifest = await readJSON(join(directory, 'manifest.json'))
    const painted = manifest.assets.find(row => row.sourcePath === 'Example/MI_Paint.uasset')
    const { parentStatus, bindings } = await readJSON(join(directory, painted.exports[0].path))
    assert.equal(parentStatus, 'resolved')
    assert.equal(bindings[0].status, 'missing-output')
    assert.equal((await importPath(server, content)).result.reused, true)
  } finally { await server.close() }
})

test('loose cooked folder import publishes a verified PNG, material and their native dependency closure',
  { skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 30_000 }, async t => {
    const { root, content, example, files } = await fixture(t)
    const server = await startServer(root)
    try {
      const job = await importPath(server, content)
      assert.equal(job.status, 'completed', job.error)
      const { directory, report } = job.result
      assert.deepEqual(report.unrealCooked, { textures: { converted: 2, skipped: 1, failed: 0 },
        materials: { converted: 2, skipped: 0, failed: 0 }, partial: false })
      assert.equal((await finish(server, job.result.scanJobId)).status, 'completed')
      const manifest = await readJSON(join(directory, 'manifest.json'))
      const row = name => manifest.assets.find(item => item.sourcePath === 'Example/' + name + '.uasset')
      const texture = row('T_Paint')
      const [image] = texture.exports
      const texels = await readFile(join(directory, image.path))
      assert.deepEqual(pngPixels(texels), [0, 42, 42, 42, 255])
      assert.ok(texels.includes(Buffer.from(image.srgb ? 'sRGB' : 'gAMA')))
      assert.equal(row('T_Orphan').exports[0].issue, 'unreal-cooked-texture-layout')
      const material = row('MI_Paint')
      const [description] = material.exports
      const binding = await readJSON(join(directory, description.path))
      assert.equal(binding.parentStatus, 'resolved')
      assert.equal(binding.bindings[0].status, 'resolved')
      assert.equal(binding.bindings[0].textureId, texture.id)
      const cleanup = await Array.fromAsync(cleanupCandidates('unreal-content', content, manifest, manifest.assets,
        true, new AbortController().signal))
      assert.deepEqual(cleanup, [])
      const dst = join(root, 'Exports')
      await mkdir(dst)
      const asset = manifest.assets.indexOf(material)
      const plan = await post(server, jobs + job.id + '/export-plan', { destination: dst, asset })
      assert.equal(plan.unresolved, 0)
      const exported = await post(server, jobs + job.id + '/export', { destination: dst, asset, key: plan.key }, 201)
      const exportedManifest = await readJSON(join(exported.directory, 'manifest.json'))
      const names = [material, row('M_Master'), texture].map(item => item.sourcePath)
      names.push('Example/MI_Paint.uexp', 'Example/T_Paint.uexp', 'Example/T_Paint.ubulk')
      assert.deepEqual(exportedManifest.assets.map(item => item.sourcePath).sort(), names.sort())
      assert.deepEqual(await readFile(join(exported.directory, image.path)), texels)
      for (const file of files) {
        assert.deepEqual(await readFile(join(example, file.path)), file.content)
        assert.deepEqual(await readFile(join(directory, 'Source', 'Content', 'Example', file.path)), file.content)
      }
      const single = await importPath(server, join(example, 'T_Single.uasset'))
      assert.equal(single.status, 'completed', single.error)
      assert.equal(single.result.report.unrealCooked.textures.converted, 1)
      assert.equal((await importPath(server, content)).result.reused, true)
      const dependencies = join(directory, 'dependencies.json')
      await writeFile(dependencies, (await readFile(dependencies, 'utf8')) + '\n')
      assert.match((await importPath(server, content)).error, /Сохранённый импорт Unreal повреждён/)
    } finally { await server.close() }
  })
