import assert from 'node:assert/strict'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { AssetIndex } from '../core/asset-index.mjs'
import { LibraryWatcher } from '../core/library-watcher.mjs'
import { ScanWorker } from '../core/scan-worker.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

async function eventually(read, predicate, message) {
  const end = Date.now() + 7000
  do {
    const current = await read()
    if (predicate(current)) return current
    await delay(50)
  } while (Date.now() < end)
  assert.fail(message)
}

test('v2 migration defaults to off and disabling watch preserves an explicitly requested scan', async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'library')
  const database = join(directory, 'index.sqlite')
  await mkdir(root)
  let index = await AssetIndex.open(database)
  const { id } = await index.connect(root)
  const preexisting = index.jobs.enqueue(id)
  await index.close()
  const raw = new DatabaseSync(database)
  raw.exec(`
    DROP INDEX watched_libraries;
    ALTER TABLE libraries DROP COLUMN watch_enabled;
    ALTER TABLE processing_jobs DROP COLUMN trigger;
    PRAGMA user_version = 2;
  `)
  raw.close()
  index = await AssetIndex.open(database)
  try {
    assert.equal(index.libraries()[0].watching, false)
    assert.equal(index.jobs.get(preexisting.id).trigger, 'manual')
    assert.equal(index.jobs.enqueue(id, { trigger: 'watch' }), null)
    index.jobs.cancel(preexisting.id)

    index.setWatching(id, true)
    const automatic = index.jobs.enqueue(id, { trigger: 'watch' })
    assert.equal(index.jobs.enqueue(id).trigger, 'manual')
    index.setWatching(id, false)
    assert.equal(index.jobs.get(automatic.id).status, 'pending')
    index.jobs.cancel(automatic.id)

    index.setWatching(id, true)
    const running = index.jobs.enqueue(id, { trigger: 'watch' })
    assert.equal(index.jobs.claim('test-worker').id, running.id)
    index.setWatching(id, false)
    assert.equal(index.jobs.get(running.id).cancelRequested, true)
  } finally { await index.close() }
})

test('watch merges a burst and periodic reconciliation finds files without a relevant event', { timeout: 14000 }, async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'library')
  const suppressed = join(root, 'suppressed')
  await mkdir(suppressed, { recursive: true })
  const index = await AssetIndex.open(':memory:')
  const { id } = await index.connect(root)
  index.setWatching(id, true)
  const worker = new ScanWorker(index, undefined, { pollMs: 25 })
  const watcher = new LibraryWatcher(index, () => worker.wake(), {
    debounceMs: 230, pollMs: 30, refreshMs: 200, reconcileMs: 1800, ignoredPaths: [suppressed],
  })
  const jobs = () => index.jobs.list({ libraryId: id })
  try {
    await eventually(jobs, list => list[0]?.status === 'completed', 'initial reconciliation did not finish')
    for (const name of ['one.obj', 'two.obj', 'three.obj']) {
      await writeFile(join(root, name), name)
    }
    const changed = await eventually(jobs, list => list.length === 2 && list[0].status === 'completed', 'burst was not scanned')
    assert.equal(changed[0].result.added, 3)
    assert.equal(changed[0].trigger, 'watch')
    await writeFile(join(suppressed, 'periodic.obj'), 'arrived without a matching native event')
    await delay(425)
    assert.equal(index.search({ q: 'periodic.obj' }).assets.length, 0)
    await eventually(() => index.search({ q: 'periodic.obj' }).assets, list => list.length === 1, 'periodic reconciliation missed the file')
  } finally {
    await watcher.stop()
    await worker.stop()
    await index.close()
  }
})

test('watch schedules a follow-up for a change while a scan is running', { timeout: 10000 }, async t => {
  const directory = await testDirectory(t)
  const index = await AssetIndex.open(':memory:')
  const { id } = await index.connect(directory)
  index.setWatching(id, true)
  const watcher = new LibraryWatcher(index, () => {}, {
    debounceMs: 150, pollMs: 30, refreshMs: 200, reconcileMs: 60_000,
  })
  const jobs = () => index.jobs.list({ libraryId: id })
  try {
    await eventually(jobs, list => list[0]?.status === 'pending', 'initial reconciliation was not queued')
    const initial = index.jobs.claim('held-scan')
    await writeFile(join(directory, 'during-scan.obj'), 'created after the scan started')
    await delay(400)
    assert.equal(jobs().length, 1)
    index.jobs.finish(initial.id, 'held-scan', { status: 'completed', progress: 0 })
    const next = await eventually(jobs, list => list[0]?.status === 'pending', 'a change during the scan was lost')
    assert.equal(next.length, 2)
    assert.notEqual(next[0].id, initial.id)
    assert.equal(next[0].trigger, 'watch')
  } finally {
    await watcher.stop()
    await index.close()
  }
})

test('HTTP watching indexes live changes and preserves identity and reviews across restarts', { timeout: 25000 }, async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'library')
  await mkdir(root)
  await writeFile(join(root, 'first.obj'), 'original')
  let server = await startServer(directory)
  try {
    const { library } = await server.post('/api/index/libraries', { path: root }).then(result => result.json())
    const watchPath = '/api/index/libraries/' + library.id + '/watch'
    const search = async query => (await server.request('/api/index/search?q=' + query).then(result => result.json())).assets
    const libraries = async () => (await server.request('/api/index/libraries').then(result => result.json())).libraries
    assert.equal((await libraries())[0].watching, false)
    assert.equal((await server.post(watchPath, { enabled: 'yes' })).status, 400)
    assert.equal((await server.post(watchPath, { enabled: true }, { Origin: '' })).status, 403)
    assert.equal((await server.post(watchPath, { enabled: true })).status, 200)
    const [first] = await eventually(() => search('first'), list => list.length === 1, 'watch startup did not index the existing file')
    const assetPath = '/api/index/assets/' + first.id
    assert.equal((await server.post(assetPath, { note: 'Retain the review' })).status, 200)
    await rename(join(root, 'first.obj'), join(root, 'renamed.obj'))
    const [moved] = await eventually(() => search('renamed'), list => list.length === 1, 'rename not indexed')
    assert.equal(moved.id, first.id)
    assert.equal(moved.note, 'Retain the review')
    await writeFile(join(root, 'renamed.obj'), 'changed model')
    await eventually(() => search('renamed'), list => list.length === 1 && list[0].hash !== moved.hash, 'edit not indexed')

    await server.close()
    await rm(join(root, 'renamed.obj'))
    await writeFile(join(root, 'while-closed.obj'), 'created while closed')
    server = await startServer(directory)
    await eventually(() => search('while-closed'), list => list.length === 1, 'restart did not reconcile downtime')
    assert.equal((await libraries())[0].watching, true)
    const { asset, versions } = await server.request(assetPath).then(result => result.json())
    assert.ok(asset.missingSince)
    assert.equal(asset.note, 'Retain the review')
    assert.ok(versions.length >= 3)

    assert.equal((await server.post(watchPath, { enabled: false })).status, 200)
    await writeFile(join(root, 'ignored-until-manual.obj'), 'created after opt-out')
    await delay(1300)
    assert.deepEqual(await search('ignored-until-manual'), [])
    assert.equal((await libraries())[0].watching, false)
    assert.equal((await server.post('/api/index/libraries/' + library.id + '/scan', {})).status, 200)
    assert.equal((await search('ignored-until-manual')).length, 1)
  } finally { await server.close() }
})
