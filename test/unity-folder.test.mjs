import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { inspectPackage } from '../core/packages/dispatch.mjs'
import { inspectUnityFolder } from '../core/packages/unity/folder/inspect.mjs'
import { packageLimits } from '../core/packages/unity/policy.mjs'
import { importSource, queuedPackageSource } from '../core/packages/source.mjs'
import { packageWorkspaceRoot } from '../core/packages/workspace.mjs'
import { ids, fixtureModel, fixtureTexture } from './fixtures/unitypackage.mjs'
import { localUpmName, upmName, writeUnityFolderFixture } from './fixtures/unity-folder.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const readJSON = async path => JSON.parse(await readFile(path, 'utf8'))
const route = '/api/index/packages'
const jobs = '/api/index/jobs/'

async function finish(server, id, expected = 'completed') {
  for (let attempts = 0; attempts < 100; attempts++) {
    const { job } = await (await server.request(jobs + id)).json()
    if (!['pending', 'running'].includes(job.status)) {
      assert.equal(job.status, expected, job.error)
      return job
    }
    await delay(80)
  }
  assert.fail('Import did not finish')
}

test('Unity folder projects and packages share queue, GUIDs, dependency reports, index and export', { timeout: 30000 }, async t => {
  let server
  t.after(() => server?.close())
  const root = await testDirectory(t)
  const { project, upm, outside } = await writeUnityFolderFixture(root)
  const destination = join(root, 'export')
  await mkdir(destination)
  await symlink(outside, join(project, 'Assets', 'Alias'), process.platform === 'win32' ? 'junction' : 'dir')
  server = await startServer(root)
  async function post(path, input, status) {
    const response = await server.post(path, input)
    const result = await response.json()
    assert.equal(response.status, status, JSON.stringify(result))
    return result
  }
  async function enqueue(plan, path = project) {
    const { job } = await post(route + '/import', { path, hash: plan.hash }, 202)
    return job.id
  }
  const { package: plan } = await post(route + '/inspect', { path: project }, 200)
  assert.equal(plan.format, 'unity-project')
  assert.equal(plan.engineVersion, '6000.3.10f1')
  assert.deepEqual(plan.packages.map(pack => pack.name), [upmName, localUpmName])
  const texture = 'Packages/' + upmName + '/Runtime/albedo.png'
  assert.equal(plan.assets.find(entry => entry.sourcePath === texture).id, ids.texture)
  assert.equal(plan.assets.find(entry => entry.sourcePath.endsWith('Invalid.md')).issue, 'metadata-guid-invalid')
  assert.ok(!plan.assets.some(entry => /Alias|PackageCache|private\.txt|Assets\/Local UPM/.test(entry.sourcePath)))
  assert.equal(plan.hash, (await inspectPackage(await importSource(project))).hash)
  assert.ok(!plan.assets.some(entry => 'payload' in entry || 'meta' in entry))

  const first = await finish(server, await enqueue(plan))
  const output = first.result.directory
  const indexed = await finish(server, first.result.scanJobId)
  const manifest = await readJSON(join(output, 'manifest.json'))
  const { dependencies } = await readJSON(join(output, 'dependencies.json'))
  assert.equal(first.result.report.packageFormat, 'unity-project')
  assert.equal(indexed.result.skippedHashes, 0)
  assert.ok(indexed.result.assets > 0)
  assert.equal(manifest.engineVersion, '6000.3.10f1')
  assert.deepEqual(manifest.source.packages, plan.packages)
  assert.ok(dependencies.some(row => row.source === ids.material && row.target === ids.texture &&
    row.status === 'guid-resolved' && row.path === texture))
  assert.ok(manifest.assets.find(entry => entry.id === ids.material).materialDescription?.sha256)
  assert.equal(manifest.assets.find(entry => entry.id === ids.script).status, 'unsupported')
  assert.equal(manifest.assets.find(entry => entry.id === ids.script).output, null)
  assert.equal(manifest.assets.find(entry => entry.sourcePath.endsWith('Invalid.md')).metadata, null)
  assert.deepEqual(await readFile(join(output, 'Source', texture)), fixtureTexture)
  assert.deepEqual(await readFile(join(output, 'Source', texture + '.meta')), await readFile(join(upm, 'Runtime/albedo.png.meta')))
  assert.equal(await readFile(join(project, 'Assets/Imported/fixture-package.obj'), 'utf8'), fixtureModel)
  await assert.rejects(readFile(join(output, 'Source/Assets/Editor/never.cs')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(output, 'Source/Assets/Imported/Invalid.md.meta')), { code: 'ENOENT' })

  const reused = await finish(server, await enqueue(plan))
  assert.equal(reused.result.directory, output)
  assert.equal(reused.result.reused, true)
  await post(jobs + first.id + '/export-plan', { destination: project }, 400)
  const asset = manifest.assets.findIndex(entry => entry.id === ids.material)
  const exportPlan = await post(jobs + first.id + '/export-plan', { destination, asset }, 200)
  const exported = await post(jobs + first.id + '/export', { destination, asset, key: exportPlan.key }, 201)
  assert.deepEqual(await readFile(join(exported.directory, 'Source', texture)), fixtureTexture)

  const { package: upmPlan } = await post(route + '/inspect', { path: upm }, 200)
  assert.equal(upmPlan.format, 'unity-upm')
  assert.notEqual(upmPlan.hash, plan.hash)
  const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'package-import', upm, '--queue', '--json'],
    { env: { ...process.env, ASSET_VIEWER_DATA_DIR: join(root, 'data') }, windowsHide: true })
  const upmJob = await finish(server, JSON.parse(stdout).job.id)
  assert.equal(upmJob.result.report.packageFormat, 'unity-upm')
  assert.deepEqual(await readFile(join(upmJob.result.directory, 'Source', texture)), fixtureTexture)

  const meta = join(upm, 'Runtime/albedo.png.meta')
  await writeFile(meta, (await readFile(meta, 'utf8')).replace('sRGBTexture: 1', 'sRGBTexture: 0'))
  const stale = await finish(server, await enqueue(plan), 'failed')
  assert.match(stale.error, /изменился после анализа/)
  const changed = await inspectPackage(await importSource(project))
  assert.notEqual(changed.hash, plan.hash)
  const changedJob = await finish(server, await enqueue(changed))
  await writeFile(join(changedJob.result.directory, 'Source', texture), Buffer.alloc(fixtureTexture.length))
  const corrupt = await finish(server, await enqueue(changed), 'failed')
  assert.match(corrupt.error, /сохранённый импорт повреждён/)
})

test('Unity folder imports reject GUID collisions, limits, and queued root aliases', async t => {
  const root = await testDirectory(t)
  const { project, upm, outside } = await writeUnityFolderFixture(root)
  const source = await importSource(project)
  await assert.rejects(inspectUnityFolder(source, { limits: { ...packageLimits, entries: 4 } }), /лимит записей/)
  const duplicate = join(upm, 'Runtime', 'duplicate.png')
  await writeFile(duplicate, fixtureTexture)
  await writeFile(duplicate + '.meta', 'guid: ' + ids.texture + '\n')
  await assert.rejects(inspectPackage(source), /GUID повторяется/)
  await rename(project, project + '-moved')
  await symlink(outside, project, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(queuedPackageSource(project), /Исходный пакет больше не доступен/)
})

test('Unity folder staging refuses application output within the selected source', async t => {
  let server
  t.after(() => server?.close())
  const root = await testDirectory(t)
  const { project } = await writeUnityFolderFixture(root)
  const alias = join(root, 'output-link')
  await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(packageWorkspaceRoot(join(alias, 'nested', 'imports'), 'unity', { sourceRoot: project }),
    /вне каталога импорта/)
  server = await startServer(root, { ASSET_VIEWER_DATA_DIR: join(project, 'managed-data') })
  const plan = await inspectPackage(await importSource(project))
  const response = await server.post(route + '/import', { path: project, hash: plan.hash })
  assert.equal(response.status, 202)
  const { job } = await response.json()
  assert.match((await finish(server, job.id, 'failed')).error, /вне каталога импорта/)
})
