import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { AssetIndex } from '../core/index/asset-index.mjs'
import { removePackageWatchSchema } from './fixtures/index-schema.mjs'
import { ProcessingWorker } from '../core/processing/processing-worker.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

test('queue migration retains assets, leases recover, and retries commit matching scan results', async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'library')
  const database = join(directory, 'data', 'index.sqlite')
  await mkdir(root)
  await writeFile(join(root, 'sample.obj'), 'first version')
  const initial = await AssetIndex.open(database)
  const { id } = await initial.connect(root)
  await initial.scan(id)
  const { assets: [asset] } = initial.search()
  initial.updateAsset(asset.id, { note: 'Keep this during migration' })
  await initial.close()
  const raw = new DatabaseSync(database)
  removePackageWatchSchema(raw)
  raw.exec(`
    DROP TABLE quality_profiles;
    DROP TABLE asset_dependencies;
    DROP TABLE asset_analysis;
    DROP INDEX watched_libraries;
    ALTER TABLE libraries DROP COLUMN watch_enabled;
    DROP TABLE processing_jobs;
    PRAGMA user_version = 1;
  `)
  const index = await AssetIndex.open(database)
  const other = await AssetIndex.open(database)
  let worker
  try {
    assert.equal(index.integrity().schemaVersion, 12)
    assert.equal(index.asset(asset.id).note, 'Keep this during migration')
    const queued = index.jobs.enqueue(id)
    assert.equal(other.jobs.enqueue(id).id, queued.id)
    assert.equal(index.jobs.cancel(queued.id).status, 'cancelled')
    assert.equal(other.jobs.retry(queued.id).status, 'pending')
    assert.equal(other.jobs.claim('lost-worker').attempts, 1)
    assert.equal(index.jobs.claim('second-worker'), null)
    raw.exec('UPDATE processing_jobs SET lease_until = 0')
    assert.equal(index.jobs.claim('second-worker'), null)
    assert.equal(index.jobs.get(queued.id).status, 'interrupted')
    assert.equal(other.jobs.retry(queued.id).status, 'pending')
    await writeFile(join(root, 'next.obj'), 'second asset')
    worker = new ProcessingWorker(index)
    const done = await worker.wait(queued.id, AbortSignal.timeout(5000))
    assert.equal(done.status, 'completed')
    assert.equal(done.attempts, 2)
    assert.equal(done.progress, 2)
    assert.equal(done.result.added, 1)
    assert.equal(other.search().assets.length, 2)
  } finally {
    await worker?.stop()
    await index.close()
    await other.close()
    raw.close()
  }
})

test('a queued job survives an application restart and can be read through HTTP', { timeout: 10000 }, async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'library')
  await mkdir(root)
  await writeFile(join(root, 'demo.glb'), 'pending scan')
  const index = await AssetIndex.open(join(directory, 'data', 'index.sqlite'))
  const { id } = await index.connect(root)
  const job = index.jobs.enqueue(id)
  await index.close()

  const server = await startServer(directory)
  try {
    let current
    const deadline = Date.now() + 5000
    do {
      await delay(50)
      const response = await server.request('/api/index/jobs/' + job.id)
      assert.equal(response.status, 200)
      ;({ job: current } = await response.json())
    } while (['pending', 'running'].includes(current.status) && Date.now() < deadline)
    assert.equal(current.status, 'completed')
    assert.equal(current.result.added, 1)
    assert.equal((await server.request('/api/index/jobs?limit=-1')).status, 400)
    assert.equal((await server.post('/api/index/jobs/' + job.id + '/retry', {})).status, 409)
    const pending = await server.post('/api/index/libraries/' + id + '/jobs', {})
    assert.equal(pending.status, 202)
    assert.notEqual((await pending.json()).job.id, job.id)
  } finally {
    await server.close()
  }
})
