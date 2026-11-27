import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { AssetIndex } from '../core/index/asset-index.mjs'
import { ProcessingWorker } from '../core/processing/processing-worker.mjs'
import { fixtureTexture, unityEntries, writeUnityFixture } from './fixtures/unitypackage.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

async function waitFor(read, accepts) {
  const deadline = Date.now() + 10_000
  do {
    const value = await read()
    if (accepts(value)) return value
    await delay(75)
  } while (Date.now() < deadline)
  assert.fail('The package watcher did not reach its expected state.')
}

const complete = job => job?.status === 'completed'
const packageAsset = (path, filename) => writeUnityFixture(path, unityEntries('5'.repeat(32), 'Assets/' + filename, fixtureTexture))

test('Opt-in package watching imports real archives, indexes changes and remembers jobs across restarts', { timeout: 30_000 }, async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'incoming')
  const child = join(root, 'drop')
  await mkdir(child, { recursive: true })
  const path = await packageAsset(join(child, 'Texture.UNITYPACKAGE'), 'first-image.png')
  const original = await readFile(path)
  let server = await startServer(directory)
  const read = async route => {
    const response = await server.request('/api/index/' + route)
    assert.equal(response.status, 200)
    return response.json()
  }
  const jobs = async () => (await read('jobs?type=package-import')).jobs
  const scan = async id => (await read('jobs/' + id)).job
  const search = async name => (await read('search?kind=image&q=' + name)).assets
  try {
    const { library } = await (await server.post('/api/index/libraries', { path: root })).json()
    const watch = '/api/index/libraries/' + library.id + '/package-watch'
    assert.equal((await server.post(watch, { enabled: true }, { Origin: 'https://example.test' })).status, 403)
    assert.equal((await server.post(watch, { enabled: 'yes' })).status, 400)
    assert.equal((await server.post('/api/index/libraries/' + library.id + '/scan', {})).status, 200)
    assert.deepEqual(await jobs(), [])
    assert.equal((await server.post(watch, { enabled: true })).status, 200)
    const [first] = await waitFor(jobs, records => records.length === 1 && complete(records[0]))
    assert.equal(first.trigger, 'watch')
    assert.deepEqual(first.exportFormats, ['fbx', 'glb'])
    await waitFor(() => scan(first.result.scanJobId), complete)
    assert.equal((await search('first-image'))[0].libraryId, first.result.library.id)
    assert.deepEqual(await readFile(join(first.result.library.root, 'Source', 'Assets', 'first-image.png')), fixtureTexture)
    assert.deepEqual(await readFile(path), original)
    assert.equal((await server.post('/api/index/libraries/' + first.result.library.id + '/package-watch', { enabled: true })).status, 400)

    await server.close()
    server = await startServer(directory)
    const source = (await read('libraries')).libraries.find(item => item.id === library.id)
    assert.equal(source.packageWatching, true)
    assert.equal(source.watching, false)
    await packageAsset(path, 'second-image.png')
    const [second] = await waitFor(jobs, records => records.length === 2 && records.every(complete))
    assert.notEqual(first.sourceKey, second.sourceKey)
    await waitFor(() => scan(second.result.scanJobId), complete)
    assert.equal((await search('second-image'))[0].libraryId, second.result.library.id)

    const broken = join(child, 'broken.unitypackage')
    await writeFile(broken, 'This is not an archive.')
    const failed = (await waitFor(jobs, records => records.some(item => item.packageName === 'broken.unitypackage' && item.status === 'failed')))
      .find(item => item.packageName === 'broken.unitypackage')
    assert.ok(failed.error)
    const rescan = '/api/index/libraries/' + library.id + '/scan'
    assert.equal((await server.post(rescan, {})).status, 200)
    assert.deepEqual(new Set((await jobs()).map(item => item.id)), new Set([first.id, second.id, failed.id]))

    assert.equal((await server.post(watch, { enabled: false })).status, 200)
    await packageAsset(join(child, 'ignored.unitypackage'), 'ignored-image.png')
    assert.equal((await server.post(rescan, {})).status, 200)
    assert.equal((await jobs()).length, 3)
    assert.deepEqual(await search('ignored-image'), [])
  } finally {
    await server.close()
  }
})

test('Package watching reserves manual queue capacity and stops only automatic jobs when disabled', async t => {
  const root = await testDirectory(t)
  const input = join(root, 'library')
  const imports = join(input, 'generated')
  await mkdir(imports, { recursive: true })
  const original = await packageAsset(join(input, 'package-00.unitypackage'), 'texture.png')
  await Promise.all(Array.from({ length: 16 }, (_, n) => copyFile(original, join(input, 'package-' + (n + 1) + '.unitypackage'))))
  await copyFile(original, join(imports, 'inside-managed.unitypackage'))
  const index = await AssetIndex.open(':memory:')
  try {
    const { id } = await index.connect(input)
    await index.scan(id)
    index.setPackageWatching(id, true)
    assert.equal(index.jobs.refillWatchedImports([imports]), 15)
    assert.equal(index.jobs.refillWatchedImports([imports]), 0)
    const [automatic] = index.jobs.list({ type: 'package-import' })
    const promoted = index.jobs.enqueueImport(index.jobs.importSource(automatic.id), automatic.sourceKey, 'fbx,glb')
    assert.equal(promoted.id, automatic.id)
    assert.equal(promoted.trigger, 'manual')
    const manual = index.jobs.enqueueImport(original, '0'.repeat(64))
    assert.equal(index.jobs.claim('fixture', 'package-import').id, promoted.id)
    index.setPackageWatching(id, false)
    assert.equal(index.jobs.get(promoted.id).cancelRequested, false)
    assert.equal(index.jobs.get(manual.id).status, 'pending')
    assert.equal(index.jobs.list({ type: 'package-import' }).filter(job => job.status === 'cancelled').length, 14)
    assert.equal(index.jobs.refillWatchedImports([imports]), 0)
    index.setPackageWatching(id, true)
    assert.equal(index.jobs.refillWatchedImports([imports]), 2)
    assert.equal(index.jobs.list({ type: 'package-import' }).some(job => job.packageName === 'inside-managed.unitypackage'), false)
  } finally {
    await index.close()
  }
})

test('A watched import rejects a child directory replaced with a link after indexing', async t => {
  const root = await testDirectory(t)
  const input = join(root, 'library')
  const child = join(input, 'nested')
  const outside = join(root, 'outside')
  await mkdir(child, { recursive: true })
  await packageAsset(join(child, 'asset.unitypackage'), 'texture.png')
  const index = await AssetIndex.open(':memory:')
  try {
    const { id } = await index.connect(input)
    await index.scan(id)
    index.setPackageWatching(id, true)
    assert.equal(index.jobs.refillWatchedImports([]), 1)
    const [job] = index.jobs.list({ type: 'package-import' })
    await rename(child, outside)
    await symlink(outside, child, 'junction')
    const worker = new ProcessingWorker(index, { type: 'package-import', importDirectory: join(root, 'imports') })
    try {
      const finished = await worker.wait(job.id, AbortSignal.timeout(5000))
      assert.equal(finished.status, 'failed')
      assert.match(finished.error, /больше не доступен/)
      assert.equal(index.libraries().length, 1)
    } finally {
      await worker.stop()
    }
  } finally {
    await index.close()
  }
})

test('Schema 9 migration preserves libraries and existing jobs with package watching disabled', async t => {
  const root = await testDirectory(t)
  const database = join(root, 'index.sqlite')
  let index = await AssetIndex.open(database)
  const { id } = await index.connect(root)
  index.setWatching(id, true)
  const { id: jobId } = index.jobs.enqueue(id)
  await index.close()
  const legacy = new DatabaseSync(database)
  try {
    legacy.exec(`DROP TABLE package_watch_imports; DROP TABLE package_watch_libraries; DROP INDEX live_unity_packages;
      PRAGMA user_version = 9;`)
  } finally {
    legacy.close()
  }
  index = await AssetIndex.open(database)
  try {
    const [library] = index.libraries()
    assert.equal(library.id, id)
    assert.equal(library.watching, true)
    assert.equal(library.packageWatching, false)
    assert.equal(index.jobs.get(jobId).status, 'pending')
  } finally {
    await index.close()
  }
})
