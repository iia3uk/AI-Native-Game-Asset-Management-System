import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { AssetIndex } from '../core/index/asset-index.mjs'
import { fixtureModel, ids, unityEntries, writeUnityFixture } from './fixtures/unitypackage.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const route = '/api/index/folder-run'
const headers = { 'X-Asset-Viewer-Desktop': 'folder-run-test-token' }

async function desktop(directory) {
  const server = await startServer(directory, { ASSET_VIEWER_DESKTOP_TOKEN: headers['X-Asset-Viewer-Desktop'] })
  return {
    close: server.close,
    unauthorized: () => server.request(route),
    post: (path, input) => server.post(path, input, headers),
    async until(predicate) {
      const deadline = Date.now() + 8000
      let run
      do {
        const response = await server.request(route, { headers })
        assert.equal(response.status, 200)
        ;({ run } = await response.json())
        if (predicate(run)) return run
        await delay(80)
      } while (Date.now() < deadline)
      assert.fail('Folder phase did not match: ' + JSON.stringify(run))
    },
  }
}

async function folders(t) {
  const root = await testDirectory(t)
  await Promise.all(['input', 'output'].map(name => mkdir(join(root, name))))
  return { root, input: await realpath(join(root, 'input')), output: await realpath(join(root, 'output')),
    database: join(root, 'data', 'index.sqlite') }
}

async function archive(input, name) {
  return realpath(await writeUnityFixture(join(input, name + '.unitypackage'),
    unityEntries(ids.model, 'Assets/' + name + '.obj', fixtureModel)))
}

test('a folder run resumes the original paused job and exports each archive to the saved destination after server restart',
  { timeout: 24000 }, async t => {
    const { root, input, output, database } = await folders(t)
    const first = await archive(input, 'Alpha')
    const second = await archive(input, 'Zulu')
    const hash = createHash('sha256').update(await readFile(first)).digest('hex')
    const index = await AssetIndex.open(database)
    const held = index.jobs.enqueueImport(first, hash)
    assert.equal(index.jobs.pauseImport(held.id).status, 'paused')
    await index.close()
    const firstServer = await desktop(root)
    let paused
    try {
      assert.equal((await firstServer.unauthorized()).status, 403)
      const start = await firstServer.post(route, { path: input, destination: output })
      assert.equal(start.status, 202)
      paused = await firstServer.until(run => run?.status === 'paused')
      assert.equal(paused.total, 2)
      assert.equal((await firstServer.post(route, { path: input, destination: output })).status, 409)
      assert.deepEqual(await readdir(output), [])
    } finally { await firstServer.close() }

    const restarted = await desktop(root)
    try {
      const saved = await restarted.until(run => run?.status === 'paused')
      assert.equal(saved.id, paused.id)
      assert.equal(saved.destination, output)
      assert.equal((await restarted.post('/api/index/jobs/' + held.id + '/resume', {})).status, 202)
      const done = await restarted.until(run => run.phase !== 'running')
      assert.equal(done.phase, 'cleanup', JSON.stringify(done))
      assert.equal(done.exported, 2)
      const reservations = await readdir(output)
      assert.equal(reservations.length, 2)
      const manifests = await Promise.all(reservations.map(async dir =>
        JSON.parse(await readFile(join(output, dir, 'Package', 'manifest.json'), 'utf8'))))
      assert.ok(manifests.every(manifest => manifest.export.processedOnly))
      assert.equal(manifests.find(manifest => manifest.assets.some(asset => asset.sourcePath === 'Assets/Alpha.obj')).export.jobId,
        held.id)
      assert.equal(await readFile(join(done.firstExport, 'Source', 'Assets', 'Alpha.obj'), 'utf8'), fixtureModel)
      assert.ok((await readFile(first)).length && (await readFile(second)).length)

      const db = await AssetIndex.open(database)
      try {
        assert.equal(db.folderRuns.claimCleanup(done.id, false).phase, 'reviewing')
        assert.equal(db.folderRuns.claimCleanup(done.id, false), null)
        assert.equal(db.folderRuns.dismissCleanup(done.id), true)
        assert.deepEqual(db.folderRuns.get().cleanup, { status: 'cancelled' })
      } finally { await db.close() }
    } finally { await restarted.close() }
  })

test('an export committed before a crash is recovered in place and a modified export is withheld from cleanup',
  { timeout: 24000 }, async t => {
    const { root, input, output, database } = await folders(t)
    await archive(input, 'Single')
    const initial = await desktop(root)
    let exported
    try {
      assert.equal((await initial.post(route, { path: input, destination: output })).status, 202)
      const done = await initial.until(run => run.phase !== 'running')
      assert.equal(done.phase, 'cleanup', JSON.stringify(done))
      exported = done.firstExport
    } finally { await initial.close() }

    function checkpointBeforeCompletion() {
      const db = new DatabaseSync(database)
      try {
        const { state } = db.prepare('SELECT state FROM folder_run').get()
        const previous = JSON.parse(state)
        const { reservation } = previous.items[0]
        assert.ok(reservation)
        previous.position = 0
        previous.step = 'export'
        delete previous.items[0].complete
        delete previous.items[0].directory
        db.prepare("UPDATE folder_run SET phase = 'running', state = ?").run(JSON.stringify(previous))
      } finally { db.close() }
    }
    const intended = await readdir(output)
    checkpointBeforeCompletion()
    const restart = await desktop(root)
    try {
      const recovered = await restart.until(run => run.phase !== 'running')
      assert.equal(recovered.phase, 'cleanup', JSON.stringify(recovered))
      assert.equal(recovered.firstExport, exported)
      assert.deepEqual(await readdir(output), intended)
    } finally { await restart.close() }

    await writeFile(join(exported, 'Source', 'Assets', 'Single.obj'), fixtureModel.replace('v 1 0 0', 'v 2 0 0'))
    checkpointBeforeCompletion()
    const changed = await desktop(root)
    try {
      const failed = await changed.until(run => run.phase !== 'running')
      assert.equal(failed.phase, 'failed')
      assert.match(failed.error, /экспортированные файлы изменились/i)
      assert.deepEqual(await readdir(output), intended)
    } finally { await changed.close() }
  })
