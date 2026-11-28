import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { AssetIndex } from '../core/index/asset-index.mjs'
import { inspectPackage } from '../core/packages/dispatch.mjs'
import { scanPackageFolder } from '../core/packages/folder.mjs'
import { scopedPackageSource } from '../core/packages/source.mjs'
import { ProcessingWorker } from '../core/processing/processing-worker.mjs'
import { writeUnityFolderFixture } from './fixtures/unity-folder.mjs'
import { fixtureModel, unityEntries, writeUnityFixture } from './fixtures/unitypackage.mjs'
import { makePak } from './fixtures/unreal-pak.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const routes = '/api/index/packages'
const linkType = process.platform === 'win32' ? 'junction' : 'dir'
const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
const run = promisify(execFile)
const modelEntries = name => unityEntries('a'.repeat(32), 'Assets/' + name + '.obj', fixtureModel)

test('folder discovery recognizes renamed containers, excludes managed roots and queues only selected packages', async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'incoming')
  const nested = join(root, 'Сцены')
  const outside = join(directory, 'outside')
  const managed = join(directory, 'data', 'imports')
  await Promise.all([nested, outside, managed].map(path => mkdir(path, { recursive: true })))
  const file = await writeUnityFixture(join(nested, 'triangle.data'), modelEntries('folder-fixture'))
  const original = await readFile(file)
  await Promise.all([
    writeUnityFixture(join(outside, 'outside.unitypackage')),
    writeUnityFixture(join(managed, 'generated.unitypackage')),
    writeFile(join(root, 'renamed'), makePak([{ path: 'Sound.wav', content: Buffer.from('fixture') }])),
    writeFile(join(root, 'header-only.bin'), Buffer.from('UnityFS\0')),
    writeFile(join(root, 'not-a-package.pak'), 'unrelated'),
    symlink(outside, join(root, 'alias'), linkType),
  ])
  const server = await startServer(directory)
  try {
    const listing = routes + '/folder'
    assert.equal((await server.post(listing, { path: root }, { Origin: 'http://example.invalid' })).status, 403)
    const response = await server.post(listing, { path: root })
    assert.equal(response.status, 200)
    const report = await response.json()
    assert.deepEqual(Object.fromEntries(report.packages.map(({ path, format }) => [path, format])), {
      'Сцены/triangle.data': 'unitypackage', renamed: 'unreal-pak', 'header-only.bin': 'unityfs',
    })
    assert.equal(report.truncated, false)
    await assert.rejects(stat(join(directory, 'data', 'index.sqlite')), { code: 'ENOENT' })
    assert.equal((await server.post(listing, { path: managed })).status, 400)
    for (const path of ['../outside/outside.unitypackage', 'alias/outside.unitypackage', file]) {
      assert.equal((await server.post(routes + '/inspect', { root: report.root, path })).status, 400)
    }
    const selection = { root: report.root, path: 'Сцены/triangle.data' }
    const analysis = await server.post(routes + '/inspect', selection)
    assert.equal(analysis.status, 200)
    const { package: plan } = await analysis.json()
    assert.equal(plan.format, 'unitypackage')
    const queued = await server.post(routes + '/import', { ...selection, hash: plan.hash })
    assert.equal(queued.status, 202)
    const { job } = await queued.json()
    let scanned
    for (let attempt = 0; attempt < 75; attempt++) {
      const { job: current } = await (await server.request('/api/index/jobs/' + job.id)).json()
      assert.notEqual(current.status, 'failed', current.error)
      if (current.result?.scanJobId) {
        const { job: scan } = await (await server.request('/api/index/jobs/' + current.result.scanJobId)).json()
        if (scan.status === 'completed') {
          scanned = scan
          break
        }
      }
      await setTimeout(100)
    }
    assert.ok(scanned, 'The selected package should be indexed.')
    const { jobs } = await (await server.request('/api/index/jobs?type=package-import')).json()
    assert.equal(jobs.length, 1)
    assert.deepEqual(await readFile(file), original)
  } finally {
    await server.close()
  }
})

test('queued manual import rejects a replaced folder even when the replacement contains identical bytes', async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'incoming')
  const nested = join(root, 'nested')
  const replacement = join(directory, 'replacement')
  await Promise.all([nested, replacement].map(path => mkdir(path, { recursive: true })))
  const file = await writeUnityFixture(join(nested, 'fixture.unitypackage'))
  await writeFile(join(replacement, 'fixture.unitypackage'), await readFile(file))
  const source = await scopedPackageSource(root, 'nested/fixture.unitypackage')
  const plan = await inspectPackage(source)
  const index = await AssetIndex.open(join(directory, 'index.sqlite'))
  try {
    const queued = index.jobs.enqueueImport(source.path, plan.hash)
    await rename(nested, join(root, 'original'))
    await symlink(replacement, nested, linkType)
    const imports = join(directory, 'imports')
    const worker = new ProcessingWorker(index, { type: 'package-import', importDirectory: imports })
    try {
      const finished = await worker.wait(queued.id, AbortSignal.timeout(8_000))
      assert.equal(finished.status, 'failed')
      assert.match(finished.error, /Исходный пакет больше не доступен/)
      await assert.rejects(stat(imports), { code: 'ENOENT' })
    } finally {
      await worker.stop()
    }
  } finally {
    await index.close()
  }
})

test('folder search reports its result limit', async t => {
  const root = await testDirectory(t)
  const header = Buffer.from('UnityFS\0')
  await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(join(root, index + '.bundle'), header)))
  const report = await scanPackageFolder(root)
  assert.equal(report.packages.length, 500)
  assert.equal(report.truncated, true)
})

test('structured search keeps Unity project mounts together and excludes linked or managed package trees', async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'scoped')
  const managed = join(root, 'generated')
  const outside = join(directory, 'outside')
  await Promise.all([mkdir(managed, { recursive: true }), mkdir(outside)])
  const { project, upm } = await writeUnityFolderFixture(root)
  await Promise.all([
    writeUnityFixture(join(upm, 'Embedded.unitypackage')),
    writeUnityFixture(join(managed, 'managed.unitypackage')),
    writeUnityFixture(join(outside, 'external.unitypackage')),
    symlink(outside, join(root, 'shortcut'), linkType),
  ])
  const report = await scanPackageFolder(root, { structured: true, ignoredPaths: [managed] })
  assert.equal(report.truncated, false)
  assert.deepEqual(report.packages, [
    { path: 'outside-upm', format: 'unity-upm' },
    { path: 'Unity Folder Fixture', format: 'unity-project' },
  ])
  const direct = await scanPackageFolder(project, { structured: true })
  assert.deepEqual(direct.packages, [{ path: '.', format: 'unity-project' }])
  await assert.rejects(scopedPackageSource(report.root, 'shortcut'), /не доступен/)
  assert.equal((await inspectPackage(await scopedPackageSource(report.root, 'Unity Folder Fixture'))).format, 'unity-project')
})

test('CLI lists without opening the database and imports more packages than the active queue capacity', async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'incoming')
  const data = join(directory, 'data')
  await mkdir(root)
  await Promise.all(Array.from({ length: 17 }, (_, index) =>
    writeUnityFixture(join(root, 'Package-' + index + '.unitypackage'), modelEntries('bulk-' + index))))
  const args = [cli, 'package-folder', root, '--json']
  const options = { env: { ...process.env, ASSET_VIEWER_DATA_DIR: data }, windowsHide: true }
  const listing = JSON.parse((await run(process.execPath, args, options)).stdout)
  assert.equal(listing.packages.length, 17)
  await assert.rejects(stat(data), { code: 'ENOENT' })
  await writeFile(join(root, '00-corrupt.unitypackage'), gzipSync('not a tar archive'))
  await assert.rejects(run(process.execPath, [...args, '--import'], options), error => {
    assert.equal(error.code, 1)
    const { results } = JSON.parse(error.stdout)
    assert.equal(results[0].path, '00-corrupt.unitypackage')
    assert.ok(results[0].error)
    assert.equal(results.length, 18)
    for (const result of results.slice(1)) {
      assert.equal(result.job?.status, 'completed', result.error ?? result.job?.error)
      assert.equal(result.scan.status, 'completed', result.scan.error)
    }
    return true
  })
})
