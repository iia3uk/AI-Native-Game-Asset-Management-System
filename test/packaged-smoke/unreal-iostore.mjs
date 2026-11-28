import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { writeIoStoreFixture } from '../fixtures/unreal-iostore.mjs'
import { zenMaterialFixture } from '../fixtures/unreal-zen-material.mjs'
import { assertZenPng } from '../fixtures/unreal-zen-texture.mjs'
import { startServer, testDirectory } from '../server-fixture.mjs'

const run = promisify(execFile)
const packaged = resolve(process.env.ASSET_VIEWER_TEST_PACKAGED_DIR || 'release/win-unpacked')
const executable = join(packaged, 'Asset Viewer.exe')
const archive = join(packaged, 'resources', 'app.asar')
const script = join(archive, 'scripts', 'asset-viewer.mjs')

async function watchedImport(server) {
  const read = async route => {
    const response = await server.request('/api/index/' + route, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    return response.json()
  }
  const deadline = Date.now() + 15_000
  do {
    const { jobs } = await read('jobs?type=package-import')
    assert.ok(jobs.length <= 1)
    const [job] = jobs
    if (job) {
      assert.equal(job.trigger, 'watch')
      assert.ok(['pending', 'running', 'completed'].includes(job.status), job.error || job.status)
      if (job.status === 'completed' && (await read('jobs/' + job.result.scanJobId)).job.status === 'completed') return job
    }
    await delay(100)
  } while (Date.now() < deadline)
  assert.fail('The packaged server did not index the watched IoStore container.')
}

test('The packaged Windows importer verifies and indexes a multi-partition Unreal IoStore', { timeout: 35_000 }, async t => {
  const root = await testDirectory(t)
  const source = join(root, 'Incoming IoStore')
  await mkdir(source)
  const { path, partitionPaths, payloads } = await writeIoStoreFixture(source, 'Installed', { texture: 'external' })
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ASSET_VIEWER_CUE4PARSE: '',
    ASSET_VIEWER_DATA_DIR: join(root, 'data') }
  const cli = async (...args) => JSON.parse((await run(executable, [script, ...args, '--json'],
    { env, windowsHide: true, timeout: 10_000 })).stdout)
  const plan = await cli('package-inspect', path)
  assert.equal(plan.format, 'unreal-iostore')
  assert.equal(plan.partitions, 2)
  const library = await cli('connect', source)
  const setting = await cli('watch-packages', library.id, 'on', '--format', 'unreal-iostore')
  assert.deepEqual(setting.packageWatchFormats, ['unreal-iostore'])
  const server = await startServer(root, env, { executable, entry: join(archive, 'server.mjs') })
  const job = await watchedImport(server).finally(() => server.close())
  assert.equal(job.sourceKey, plan.hash)
  const { directory, report } = job.result
  assert.deepEqual(report.extractedTypes, { package: 1, bulk: 1, file: 1, registry: 0 })
  assert.equal(report.textures.converted, 1)
  const { entries } = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const sound = entries.find(row => row.kind === 'file')
  assert.deepEqual(await readFile(join(directory, sound.artifact.path)), payloads.audio)
  const asset = entries.find(row => row.kind === 'package')
  assertZenPng(await readFile(join(directory, asset.exports[0].path)), false)
  const cached = await cli('package-import', partitionPaths[1], '--export', 'fbx,glb')
  assert.equal(cached.job.status, 'completed', cached.job.error)
  assert.equal(cached.scan.status, 'completed', cached.scan.error)
  assert.equal(cached.job.result.reused, true)
  assert.equal(cached.job.result.directory, directory)

  const audioFixture = await writeIoStoreFixture(root, 'PackagedSoundWave', { soundWave: 'vorbis' })
  const { job: audioJob, scan } = await cli('package-import', audioFixture.path)
  assert.equal(audioJob.status, 'completed', audioJob.error)
  assert.equal(scan.status, 'completed', scan.error)
  assert.deepEqual(audioJob.result.report.audio, { converted: 1, skipped: 0, failed: 0 })
  const audioDirectory = audioJob.result.directory
  const manifest = JSON.parse(await readFile(join(audioDirectory, 'manifest.json'), 'utf8'))
  const [vorbis] = manifest.entries.find(row => row.kind === 'package').exports
  assert.equal(vorbis.format, 'ogg')
  assert.deepEqual(await readFile(join(audioDirectory, vorbis.path)), audioFixture.payloads.soundWave)

  const meshFixture = await writeIoStoreFixture(root, 'PackagedMesh', zenMaterialFixture('ue54'))
  const { job: meshJob, scan: meshScan } = await cli('package-import', meshFixture.path)
  assert.equal(meshJob.status, 'completed', meshJob.error)
  assert.equal(meshScan.status, 'completed', meshScan.error)
  assert.deepEqual(meshJob.result.report.meshes.derivatives, { fbx: 0, glb: 2 })
  assert.deepEqual(meshJob.result.report.materials, { converted: 2, skipped: 0, failed: 0 })
  const meshDirectory = meshJob.result.directory
  const meshManifest = JSON.parse(await readFile(join(meshDirectory, 'manifest.json'), 'utf8'))
  const previews = meshManifest.entries.find(row => row.path.endsWith('/Sample.uasset')).exports.filter(row => row.format === 'glb')
  assert.deepEqual(previews.map(row => row.lod), [0, 1])
  for (const preview of previews) {
    const bytes = await readFile(join(meshDirectory, preview.path))
    assert.equal(bytes.toString('ascii', 0, 4), 'glTF')
    const model = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)))
    assert.equal(model.images[0].mimeType, 'image/png')
  }
})
