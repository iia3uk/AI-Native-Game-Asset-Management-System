import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { locateUnrealDecoder } from '../core/engines/unreal/decoder/run.mjs'
import { generateFixtures } from '../scripts/generate-fixtures.mjs'
import { makePak, wavTone } from './fixtures/unreal-pak.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))

async function waitForJob(server, id) {
  const deadline = Date.now() + 12_000
  do {
    const response = await server.request('/api/index/jobs/' + id)
    assert.equal(response.status, 200)
    const { job } = await response.json()
    if (!['pending', 'running'].includes(job.status)) return job
    await setTimeout(100)
  } while (Date.now() < deadline)
  assert.fail('Pak job did not reach a terminal state.')
}

async function queueImport(server, path, hash) {
  const response = await server.post('/api/index/packages/import', { path, hash })
  assert.equal(response.status, 202)
  const { job } = await response.json()
  return waitForJob(server, job.id)
}

test('universal inspection identifies and refuses encrypted Pak before looking for a decoder', async t => {
  const root = await testDirectory(t)
  const path = join(root, 'Encrypted.bin')
  await writeFile(path, makePak([{ path: 'Tone.wav', content: wavTone() }], { encryptedIndex: true }))
  const server = await startServer(root, { ASSET_VIEWER_CUE4PARSE: 'invalid-relative-override' })
  try {
    const response = await server.post('/api/index/packages/inspect', { path })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /Unreal Pak зашифрован/)
  } finally {
    await server.close()
  }
})

test('universal Pak import verifies source, reuses validated output and exposes artifacts in the shared viewer',
  { skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 45_000 }, async t => {
    assert.ok(await locateUnrealDecoder(), 'Build the native Pak decoder first.')
    const root = await testDirectory(t)
    const fixtures = join(root, 'fixtures')
    const data = join(root, 'data')
    const path = join(root, 'Container.bin')
    const audio = wavTone()
    const env = { ...process.env, ASSET_VIEWER_DATA_DIR: data }
    const query = async (...args) => JSON.parse((await run(process.execPath, [cli, ...args, '--json'],
      { env, windowsHide: true })).stdout)

    await generateFixtures(fixtures)
    const model = await readFile(join(fixtures, 'Architecture', 'woodland-cabin.glb'))
    const source = makePak([
      { path: 'Models/Cabin.glb', content: model },
      { path: 'Audio/Tone.wav', content: audio },
      { path: 'Audio/Encrypted.wav', content: audio, encrypted: true },
    ])
    const hash = createHash('sha256').update(source).digest('hex')
    await writeFile(path, source)
    const dryRun = await query('package-import', path, '--dry-run', '--mode', 'auto')
    assert.deepEqual([dryRun.dryRun, dryRun.format, dryRun.hash, dryRun.mode], [true, 'unreal-pak', hash, 'engineless'])
    await assert.rejects(readdir(data), { code: 'ENOENT' })

    const server = await startServer(root)
    try {
      const inspection = await server.post('/api/index/packages/inspect', { path })
      assert.equal(inspection.status, 200)
      const { package: plan } = await inspection.json()
      assert.deepEqual([plan.format, plan.containerVersion, plan.hash, plan.total], ['unreal-pak', 4, hash, 3])
      assert.ok(plan.assets.some(entry => entry.issue === 'unreal-pak-encrypted-entry'))
      for (const options of [{ mode: 'engine-assisted' }, { formats: ['fbx'] }]) {
        const unsupported = await server.post('/api/index/packages/import', { path, hash, ...options })
        assert.equal(unsupported.status, 400)
      }

      const imported = await queueImport(server, path, hash)
      assert.equal(imported.status, 'completed', imported.error)
      assert.equal(imported.result.reused, false)
      assert.deepEqual(imported.result.report.counts, { extracted: 2, skipped: 1 })
      assert.equal(imported.result.report.packageFormat, 'unreal-pak')
      assert.equal((await waitForJob(server, imported.result.scanJobId)).status, 'completed')

      const manifestRequest = await server.request('/api/index/jobs/' + imported.id + '/manifest')
      assert.equal(manifestRequest.status, 200)
      const manifest = await manifestRequest.json()
      assert.equal(manifest.total, 3)
      const exported = manifest.assets.find(entry => entry.format === 'glb')
      assert.deepEqual(await readFile(join(imported.result.directory, exported.artifact.path)), model)
      assert.equal(manifest.assets.find(entry => entry.path.endsWith('/Encrypted.wav')).status, 'skipped')
      const destination = join(root, 'exports')
      await mkdir(destination)
      const asset = manifest.assets.findIndex(entry => entry.path.endsWith('/Tone.wav'))
      const exportRoute = '/api/index/jobs/' + imported.id
      const preview = await server.post(exportRoute + '/export-plan', { destination, asset })
      assert.equal(preview.status, 200)
      const exportPlan = await preview.json()
      assert.equal(exportPlan.dependencyStatus, 'unavailable')
      const publication = await server.post(exportRoute + '/export', { destination, asset, key: exportPlan.key })
      assert.equal(publication.status, 201)
      const { directory } = await publication.json()
      assert.deepEqual(await readFile(join(directory, manifest.assets[asset].artifact.path)), audio)
      const deliverable = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
      assert.deepEqual(deliverable.entries, [manifest.assets[asset]])
      const { assets } = await (await server.request('/api/index/search?library=' + imported.result.library.id)).json()
      assert.deepEqual(assets.map(asset => asset.ext).sort(), ['glb', 'wav'])
      const opened = await server.post('/api/index/assets/' + assets.find(asset => asset.ext === 'glb').id + '/open', {})
      assert.equal(opened.status, 200)
      const { folder, fileId } = await opened.json()
      const resource = folder.resources.find(item => item.id === fileId)
      const served = await server.request(resource.url)
      assert.equal(served.status, 200)
      assert.deepEqual(Buffer.from(await served.arrayBuffer()), model)

      const alternate = join(root, 'Same.pak')
      await writeFile(alternate, source)
      const { job: queued } = await query('package-import', alternate, '--queue')
      const cached = await waitForJob(server, queued.id)
      assert.equal(cached.status, 'completed', cached.error)
      assert.equal(cached.result.reused, true)
      assert.equal(cached.result.directory, imported.result.directory)
      assert.equal(cached.result.library.id, imported.result.library.id)

      await writeFile(path, makePak([{ path: 'Other.wav', content: audio }]))
      const changed = await queueImport(server, path, hash)
      assert.equal(changed.status, 'failed')
      assert.match(changed.error, /изменился после анализа/)
      await writeFile(path, source)
      await writeFile(join(imported.result.directory, exported.artifact.path), 'tampered')
      const corrupt = await queueImport(server, path, hash)
      assert.equal(corrupt.status, 'failed')
      assert.match(corrupt.error, /Кеш импорта Unreal Pak повреждён/)
      assert.deepEqual(await readFile(path), source)

      const emptySource = makePak([{ path: 'Scripts/Sample.txt', content: Buffer.from('fixture') }])
      const empty = join(root, 'Unsupported.pak')
      await writeFile(empty, emptySource)
      const noArtifacts = await queueImport(server, empty, createHash('sha256').update(emptySource).digest('hex'))
      assert.equal(noArtifacts.status, 'completed', noArtifacts.error)
      assert.equal(noArtifacts.result.report.status, 'no-compatible-inputs')
      assert.equal(noArtifacts.result.library, null)
      assert.equal(noArtifacts.result.scanJobId, null)
      const diagnostic = await (await server.request('/api/index/jobs/' + noArtifacts.id + '/manifest')).json()
      assert.equal(diagnostic.assets[0].issue, 'unreal-pak-unsupported-entry')
    } finally {
      await server.close()
    }
  })
