import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { AssetIndex } from '../core/index/asset-index.mjs'
import { sourceWave, ue4SourceFixture } from './fixtures/unreal-source-media.mjs'
import { fixtureModel, ids, unityEntries, writeUnityFixture } from './fixtures/unitypackage.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const route = '/api/index/folder-run'
const headers = { 'X-Asset-Viewer-Desktop': 'folder-run-test-token' }

async function desktop(directory) {
  const server = await startServer(directory, { ASSET_VIEWER_DESKTOP_TOKEN: headers['X-Asset-Viewer-Desktop'] })
  return {
    close: server.close,
    unauthorized: () => server.request(route),
    get: path => server.request(path, { headers }),
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

test('one folder run imports Unity archives, an Unreal project and loose Unreal sources to the same destination',
  { timeout: 24000 }, async t => {
    const { root, input, output } = await folders(t)
    const content = join(input, 'Native project', 'Content')
    const pack = join(input, 'Unpacked')
    const soundFolder = join(pack, 'Audio')
    await Promise.all([mkdir(content, { recursive: true }), mkdir(soundFolder, { recursive: true })])
    const descriptor = join(input, 'Native project', 'Sample.uproject')
    const native = join(content, 'ProjectSound.uasset')
    const loose = join(soundFolder, 'PackSound.uasset')
    const single = join(input, 'RootSound.uasset')
    const wave = sourceWave()
    const sources = [native, loose, single].map((path, index) => {
      const bytes = Buffer.from(wave)
      bytes.writeInt16LE(5000 + index, 46)
      return { path, bytes, original: ue4SourceFixture('SoundWave', bytes) }
    })
    await Promise.all([
      writeFile(descriptor, JSON.stringify({ FileVersion: 3, EngineAssociation: '4.27' })),
      archive(pack, 'UnityCopy'),
      writeFile(join(pack, 'unrelated.uasset'), 'not an Unreal package'),
      ...sources.map(({ path, original }) => writeFile(path, original)),
    ])
    const catalog = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
    const { stdout } = await promisify(execFile)(process.execPath, [catalog, 'package-folder', input, '--json'], {
      env: { ...process.env, ASSET_VIEWER_DATA_DIR: join(root, 'cli-data') }, windowsHide: true,
    })
    const expected = {
      'Native project/Sample.uproject': 'unreal-project',
      'RootSound.uasset': 'unreal-asset',
      Unpacked: 'unreal-content',
      'Unpacked/UnityCopy.unitypackage': 'unitypackage',
    }
    const formats = report => Object.fromEntries(report.packages.map(({ path, format }) => [path, format]))
    assert.deepEqual(formats(JSON.parse(stdout)), expected)

    const server = await desktop(root)
    try {
      const preview = await server.post('/api/index/packages/folder', { path: input, structured: true })
      assert.equal(preview.status, 200)
      assert.deepEqual(formats(await preview.json()), expected)
      const singleFolder = await server.post('/api/index/packages/folder', { path: pack, structured: true })
      assert.deepEqual(formats(await singleFolder.json()), { '.': 'unreal-content', 'UnityCopy.unitypackage': 'unitypackage' })
      const analyzed = await server.post('/api/index/packages/inspect', { root: pack, path: '.' })
      assert.equal(analyzed.status, 200, await analyzed.text())
      assert.equal((await server.post(route, { path: input, compact: true })).status, 400)
      const response = await server.post(route, { path: input, destination: output })
      assert.equal(response.status, 202)
      const done = await server.until(run => run?.phase !== 'running')
      assert.equal(done.phase, 'cleanup', JSON.stringify(done))
      assert.equal(done.total, 4)
      assert.equal(done.exported, 4)
      assert.equal(done.failureCount, 0)
      const dirs = await readdir(output)
      assert.equal(dirs.length, 4)
      const manifests = await Promise.all(dirs.map(async name => {
        const dir = join(output, name, 'Package')
        const data = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
        return { dir, data }
      }))
      for (const { path, bytes, original } of sources) {
        const name = basename(path)
        const matches = manifests.flatMap(({ dir, data }) => data.assets
          .filter(asset => asset.sourcePath.endsWith(name) && asset.exports?.some(entry => entry.format === 'wav'))
          .map(asset => join(dir, asset.exports.find(entry => entry.format === 'wav').path)))
        assert.equal(matches.length, 1, name)
        assert.deepEqual(await readFile(matches[0]), bytes)
        assert.deepEqual(await readFile(path), original)
      }
      const model = manifests.flatMap(({ dir, data }) => data.assets
        .filter(asset => asset.sourcePath === 'Assets/UnityCopy.obj').map(asset => join(dir, asset.output)))
      assert.equal(model.length, 1)
      assert.equal(await readFile(model[0], 'utf8'), fixtureModel)
    } finally { await server.close() }
  })

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

test('shared folder runs index the only published files, reuse them after restart, and reject a replaced storage root',
  { timeout: 24000 }, async t => {
    const { root, input, output, database } = await folders(t)
    const unity = await archive(input, 'Shared')
    const native = join(input, 'Step.uasset')
    const original = ue4SourceFixture('SoundWave', sourceWave())
    await writeFile(native, original)
    const body = { path: input, destination: output, shared: true }
    const readIndex = async action => {
      const index = await AssetIndex.open(database)
      try { return action(index) }
      finally { await index.close() }
    }
    const finished = run => readIndex(index => {
      const state = index.folderRuns.claimCleanup(run.id, false)
      assert.equal(state.phase, 'reviewing')
      assert.equal(index.folderRuns.dismissCleanup(run.id), true)
      return { jobs: state.items.map(item => index.jobs.get(item.jobId)), assets: index.search().assets }
    })
    const hash = createHash('sha256').update(await readFile(unity)).digest('hex')
    const held = await readIndex(index => index.jobs.pauseImport(index.jobs.enqueueImport(unity, hash).id))
    const first = await desktop(root)
    let storagePath, exports, model, unityJob
    try {
      assert.equal((await first.post(route, { path: input, shared: true })).status, 400)
      assert.equal((await first.post(route, body)).status, 202)
      const run = await first.until(run => run.phase !== 'running')
      assert.equal(run.phase, 'cleanup', JSON.stringify(run))
      assert.equal(run.shared, true)
      assert.equal(run.exported, 2)
      assert.equal(run.reused, 0)
      storagePath = run.storagePath
      assert.deepEqual(await readdir(output), [basename(storagePath)])
      const { jobs, assets } = await finished(run)
      unityJob = jobs.find(job => job.packageName === basename(unity))
      const unrealJob = jobs.find(job => job.result.report.packageFormat.startsWith('unreal-'))
      assert.notEqual(unityJob.id, held.id)
      assert.equal(await readIndex(index => index.jobs.get(held.id).status), 'paused')
      assert.equal(unityJob.outputRootId, unrealJob.outputRootId)
      assert.equal(unityJob.result.storage.path, storagePath)
      assert.equal(unrealJob.result.storage.path, storagePath)
      assert.equal(unityJob.result.storage.ino, String((await lstat(storagePath, { bigint: true })).ino))
      assert.equal(unityJob.result.storage.destination.ino, String((await lstat(output, { bigint: true })).ino))
      assert.deepEqual(await readdir(join(root, 'data', 'imports')).catch(error => {
        assert.equal(error.code, 'ENOENT')
        return []
      }), [])
      assert.equal(await readFile(join(unityJob.result.directory, 'Source', 'Assets', 'Shared.obj'), 'utf8'), fixtureModel)
      assert.deepEqual(await readFile(join(unrealJob.result.directory, 'Audio', 'Step.wav')), sourceWave())
      assert.deepEqual(await readFile(native), original)
      exports = jobs.map(job => job.result.directory)
      model = assets.find(asset => asset.ext === 'obj')
      const opened = await first.post('/api/index/assets/' + model.id + '/open', {})
      assert.equal(opened.status, 200, await opened.clone().text())
      const preview = (await opened.json()).folder.resources.find(file => file.path === model.path).url
      assert.equal(await (await first.get(preview)).text(), fixtureModel)

      const manifest = '/api/index/jobs/' + unityJob.id + '/manifest'
      assert.equal((await first.get(manifest)).status, 200)
      const extra = join(root, 'manual-export')
      await mkdir(extra)
      const plan = await first.post('/api/index/jobs/' + unityJob.id + '/export-plan', { destination: extra })
      assert.equal(plan.status, 200, await plan.clone().text())
      assert.ok((await plan.json()).paths.includes('Source/Assets/Shared.obj'))

      const offline = storagePath + '-offline'
      await rename(storagePath, offline)
      await cp(offline, storagePath, { recursive: true, errorOnExist: true })
      assert.equal((await first.get(preview)).status, 404)
      assert.equal((await first.post('/api/index/assets/' + model.id + '/open', {})).status, 404)
      assert.equal((await first.get(manifest)).status, 404)
      await rename(storagePath, join(root, 'replacement'))
      await rename(offline, storagePath)
      assert.equal(await (await first.get(preview)).text(), fixtureModel)
    } finally { await first.close() }

    const repeat = await desktop(root)
    try {
      assert.equal((await repeat.post(route, body)).status, 202)
      const run = await repeat.until(run => run.phase !== 'running')
      assert.equal(run.phase, 'cleanup', JSON.stringify(run))
      assert.equal(run.reused, 2)
      const { jobs, assets } = await finished(run)
      assert.deepEqual(jobs.map(job => job.result.directory), exports)
      assert.equal(assets.find(asset => asset.ext === 'obj').id, model.id)
      assert.deepEqual(await readdir(output), [basename(storagePath)])
    } finally { await repeat.close() }
  })

function checkpointBeforeExportCompletion(database) {
  const db = new DatabaseSync(database)
  try {
    const { state } = db.prepare('SELECT state FROM folder_run').get()
    const previous = JSON.parse(state)
    const [item] = previous.items
    assert.ok(item.reservation)
    previous.position = 0
    previous.step = 'export'
    delete previous.cleanup
    delete item.complete
    delete item.directory
    db.prepare("UPDATE folder_run SET phase = 'running', state = ?").run(JSON.stringify(previous))
  } finally { db.close() }
}

test('repeated folder runs verify and reuse existing exports, preserving edited copies and original provenance',
  { timeout: 24000 }, async t => {
    const { root, input, output, database } = await folders(t)
    await archive(input, 'Repeated')

    async function runFolder(startRun = true) {
      const server = await desktop(root)
      try {
        if (startRun) {
          const start = await server.post(route, { path: input, destination: output })
          assert.equal(start.status, 202, await start.text())
        }
        const run = await server.until(run => run?.phase !== 'running')
        assert.equal(run.phase, 'cleanup', JSON.stringify(run))
        assert.equal(run.exported, 1)
        const index = await AssetIndex.open(database)
        try {
          const [item] = index.folderRuns.claimCleanup(run.id, false).items
          assert.equal(index.folderRuns.dismissCleanup(run.id), true)
          return { run, item, job: index.jobs.get(item.jobId) }
        } finally { await index.close() }
      } finally { await server.close() }
    }

    const initial = await runFolder()
    assert.equal(initial.run.reused, 0)
    const originalDirectory = initial.run.firstExport
    const earlierManifest = await readFile(join(originalDirectory, 'manifest.json'))
    const listing = await readdir(output)
    const repeated = await runFolder()
    assert.notEqual(repeated.item.jobId, initial.item.jobId)
    assert.equal(repeated.job.result.reused, true)
    assert.equal(repeated.item.exportJobId, initial.item.jobId)
    assert.equal(repeated.run.reused, 1)
    assert.equal(repeated.run.firstExport, originalDirectory)
    assert.deepEqual(await readdir(output), listing)
    assert.deepEqual(await readFile(join(originalDirectory, 'manifest.json')), earlierManifest)

    checkpointBeforeExportCompletion(database)
    const resumed = await runFolder(false)
    assert.equal(resumed.run.id, repeated.run.id)
    assert.equal(resumed.run.reused, 1)
    assert.equal(resumed.run.firstExport, originalDirectory)
    assert.deepEqual(await readdir(output), listing)

    const model = 'Source/Assets/Repeated.obj'
    const edited = fixtureModel.replace('v 1 0 0', 'v 2 0 0')
    assert.equal(Buffer.byteLength(edited), Buffer.byteLength(fixtureModel))
    // A valid lookalike outside the destination must not be adopted through a link.
    const external = join(root, 'external-copy')
    await cp(initial.item.reservation.path, external, { recursive: true, errorOnExist: true })
    const alias = join(output, 'AssetViewer-Repeated-000000')
    await symlink(external, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(originalDirectory, model), edited)
    const replacement = await runFolder()
    assert.equal(replacement.run.reused, 0)
    assert.notEqual(replacement.run.firstExport, originalDirectory)
    assert.equal(await readFile(join(originalDirectory, model), 'utf8'), edited)
    assert.equal(await readFile(join(replacement.run.firstExport, model), 'utf8'), fixtureModel)
  })

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

    const intended = await readdir(output)
    checkpointBeforeExportCompletion(database)
    const restart = await desktop(root)
    try {
      const recovered = await restart.until(run => run.phase !== 'running')
      assert.equal(recovered.phase, 'cleanup', JSON.stringify(recovered))
      assert.equal(recovered.firstExport, exported)
      assert.deepEqual(await readdir(output), intended)
    } finally { await restart.close() }

    await writeFile(join(exported, 'Source', 'Assets', 'Single.obj'), fixtureModel.replace('v 1 0 0', 'v 2 0 0'))
    checkpointBeforeExportCompletion(database)
    const changed = await desktop(root)
    try {
      const failed = await changed.until(run => run.phase !== 'running')
      assert.equal(failed.phase, 'failed')
      assert.match(failed.error, /экспортированные файлы изменились/i)
      assert.deepEqual(await readdir(output), intended)
    } finally { await changed.close() }
  })
