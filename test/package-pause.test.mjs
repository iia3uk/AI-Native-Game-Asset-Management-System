import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { AssetIndex } from '../core/index/asset-index.mjs'
import { removePackageImportPauseSchema } from './fixtures/index-schema.mjs'
import { fixtureModel, ids, unityEntries, writeUnityFixture } from './fixtures/unitypackage.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
const execute = promisify(execFile)

test('a paused import holds its recipe across restart and resumes to verified output via HTTP', { timeout: 15000 }, async t => {
  const directory = await testDirectory(t)
  const archive = await realpath(await writeUnityFixture(join(directory, 'Pause.unitypackage'),
    unityEntries(ids.model, 'Assets/model.obj', fixtureModel)))
  const bytes = await readFile(archive)
  const key = createHash('sha256').update(bytes).digest('hex')
  const data = join(directory, 'data')
  const database = join(data, 'index.sqlite')
  let index = await AssetIndex.open(database)
  const original = index.jobs.enqueueImport(archive, key)
  await index.close()
  const previous = new DatabaseSync(database)
  try {
    removePackageImportPauseSchema(previous)
    previous.exec('PRAGMA user_version = 12')
  } finally {
    previous.close()
  }
  index = await AssetIndex.open(database)
  assert.deepEqual(index.jobs.get(original.id), original)
  await index.close()

  const { stdout } = await execute(process.execPath, [cli, 'jobs', original.id, '--pause', '--json'], {
    env: { ...process.env, ASSET_VIEWER_DATA_DIR: data }, windowsHide: true,
  })
  assert.equal(JSON.parse(stdout).status, 'paused')
  index = await AssetIndex.open(database)
  try {
    const paused = index.jobs.enqueueImport(archive, key)
    assert.equal(paused.id, original.id)
    assert.equal(paused.status, 'paused')
    assert.equal(index.jobs.claim('check', 'package-import'), null)
  } finally {
    await index.close()
  }

  const server = await startServer(directory)
  try {
    const route = '/api/index/jobs/' + original.id
    const readJob = async path => (await (await server.request(path)).json()).job
    assert.equal((await readJob(route)).status, 'paused')
    assert.deepEqual((await (await server.request('/api/index/libraries')).json()).libraries, [])
    const resume = await server.post(route + '/resume', {})
    assert.equal(resume.status, 202)
    assert.equal((await resume.json()).job.status, 'pending')
    const waitFor = async (path, status) => {
      const deadline = Date.now() + 5000
      let current
      do {
        current = await readJob(path)
        if (current.status === status || !['pending', 'running'].includes(current.status)) break
        await delay(50)
      } while (Date.now() < deadline)
      assert.equal(current.status, status, JSON.stringify(current))
      return current
    }
    const finished = await waitFor(route, 'completed')
    await waitFor('/api/index/jobs/' + finished.result.scanJobId, 'completed')
    assert.equal(finished.attempts, 1)
    assert.equal(await readFile(join(finished.result.directory, 'Source', 'Assets', 'model.obj'), 'utf8'), fixtureModel)
    assert.deepEqual(await readFile(archive), bytes)
    assert.equal((await server.post(route + '/pause', {})).status, 409)
  } finally {
    await server.close()
  }
})

test('a running pause blocks publication, releases a lost lease, and allows cancellation on pause', async t => {
  const database = join(await testDirectory(t), 'index.sqlite')
  const index = await AssetIndex.open(database)
  const other = await AssetIndex.open(database)
  const raw = new DatabaseSync(database)
  try {
    const first = index.jobs.enqueueImport('first.unitypackage', '1'.repeat(64), 'fbx')
    const second = index.jobs.enqueueImport('second.unitypackage', '2'.repeat(64))
    assert.equal(index.jobs.claim('first-worker', 'package-import').id, first.id)
    assert.equal(other.jobs.pauseImport(first.id).pauseRequested, true)
    assert.equal(other.jobs.resumeImport(first.id), undefined)
    assert.throws(() => index.jobs.completeImport(first.id, 'first-worker', () => assert.fail('published during pause')),
      /отменена/)
    assert.equal(index.jobs.heartbeat(first.id, 'first-worker', 35).paused, 1)
    raw.prepare('UPDATE processing_jobs SET lease_until = 0 WHERE id = ?').run(first.id)
    assert.equal(other.jobs.claim('second-worker', 'package-import').id, second.id)
    const paused = index.jobs.get(first.id)
    assert.equal(paused.status, 'paused')
    assert.equal(paused.attempts, 0)
    assert.equal(paused.progress, 0)
    assert.deepEqual(paused.exportFormats, ['fbx'])
    assert.equal(index.jobs.cancel(first.id).status, 'cancelled')
    assert.equal(other.jobs.resumeImport(first.id), undefined)
    assert.equal(other.jobs.retry(first.id).pauseRequested, undefined)
  } finally {
    raw.close()
    await other.close()
    await index.close()
  }
})
