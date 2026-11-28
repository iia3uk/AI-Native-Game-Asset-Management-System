import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { association, companion, packagePrefix, primary, writeUnrealLooseFixture } from './fixtures/unreal-loose.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const packages = '/api/index/packages'
const jobs = '/api/index/jobs/'
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'))

async function finish(server, id, status = 'completed') {
  for (let attempts = 0; attempts < 100; attempts++) {
    const { job } = await (await server.request(jobs + id)).json()
    if (!['pending', 'running'].includes(job.status)) {
      assert.equal(job.status, status, job.error)
      return job
    }
    await delay(80)
  }
  assert.fail('Import did not finish')
}

test('Unreal projects and loose packages share read-only import, indexing, companion exports and verified cache', { timeout: 30000 }, async t => {
  let server
  t.after(() => server?.close())
  const root = await testDirectory(t)
  const { project, descriptor, content } = await writeUnrealLooseFixture(root)
  const outside = join(root, 'outside')
  const destination = join(root, 'export')
  await mkdir(outside)
  await mkdir(destination)
  await writeFile(join(outside, 'Outside.uasset'), packagePrefix(-8, 522, 1008, 0))
  await symlink(outside, join(content, 'Alias'), process.platform === 'win32' ? 'junction' : 'dir')
  server = await startServer(root)
  async function post(path, input, status) {
    const response = await server.post(path, input)
    const result = await response.json()
    assert.equal(response.status, status, JSON.stringify(result))
    return result
  }
  async function inspect(path) {
    return (await post(packages + '/inspect', { path }, 200)).package
  }
  async function enqueue(path, hash, options, status) {
    const { job } = await post(packages + '/import', { path, hash, ...options }, 202)
    return finish(server, job.id, status)
  }

  const plan = await inspect(project)
  assert.equal(plan.format, 'unreal-project')
  assert.equal(plan.engineVersion, association)
  assert.equal(plan.descriptorVersion, 3)
  assert.equal(plan.hash, (await inspect(descriptor)).hash)
  assert.equal(plan.assets.find(row => row.sourcePath.includes('Cooked')).storage, 'cooked')
  assert.equal(plan.assets.find(row => row.sourcePath.includes('Malformed')).issue, 'unreal-package-signature')
  assert.equal(plan.assets.find(row => row.sourcePath.includes('Orphan')).issue, 'unreal-companion-orphan')
  assert.ok(!plan.assets.some(row => /Alias|Outside|startup/.test(row.sourcePath)))
  assert.equal((await inspect(content)).format, 'unreal-content')
  const singlePath = join(content, primary)
  const single = await inspect(singlePath)
  assert.equal(single.format, 'unreal-asset')
  assert.deepEqual(single.assets.map(row => row.path), ['Fixture.UEXP', 'Fixture.uasset'])
  await post(packages + '/import', { path: singlePath, hash: single.hash, mode: 'engine-assisted' }, 400)
  await post(packages + '/import', { path: project, hash: plan.hash, formats: ['invalid-format'] }, 400)
  await post(packages + '/import', { path: project, hash: plan.hash, mode: 'auto', editorVersion: 'bad-version' }, 400)

  const first = await enqueue(project, plan.hash)
  const { directory, report } = first.result
  assert.equal(report.written, 4)
  assert.equal(report.converted, 0)
  assert.equal(report.packageFormat, plan.format)
  const indexed = await finish(server, first.result.scanJobId)
  assert.ok(indexed.result.assets >= 2)
  const manifest = await readJSON(join(directory, 'manifest.json'))
  assert.deepEqual(await readFile(join(directory, 'Source/Content', primary)), await readFile(singlePath))
  assert.equal(await readFile(join(directory, 'Source/Content', companion), 'utf8'), 'sidecar-v1')
  await assert.rejects(readFile(join(directory, 'Source/Content/Props/startup.py')), { code: 'ENOENT' })
  await assert.rejects(readFile(join(directory, 'Source/Content/Props/Orphan.ubulk')), { code: 'ENOENT' })
  const asset = manifest.assets.findIndex(row => row.sourcePath === primary)
  assert.ok(asset >= 0)
  const route = jobs + first.id
  await post(route + '/export-plan', { destination: content, asset }, 400)
  const exportPlan = await post(route + '/export-plan', { destination, asset }, 200)
  assert.equal(exportPlan.assets, 2)
  const exported = await post(route + '/export', { destination, asset, key: exportPlan.key }, 201)
  assert.equal(await readFile(join(exported.directory, 'Source/Content', companion), 'utf8'), 'sidecar-v1')
  const reused = await enqueue(descriptor, plan.hash)
  assert.equal(reused.result.directory, directory)
  assert.equal(reused.result.reused, true)
  await post(jobs + reused.id + '/export-plan', { destination: content }, 400)
  const importedSingle = await enqueue(singlePath, single.hash)
  assert.equal(importedSingle.result.report.written, 2)
  assert.equal(await readFile(join(importedSingle.result.directory, 'Source/Content/Fixture.UEXP'), 'utf8'), 'sidecar-v1')

  const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
  const { stdout } = await promisify(execFile)(process.execPath,
    [cli, 'package-import', descriptor, '--queue', '--mode', 'auto', '--unreal-version', association, '--json'],
    { env: { ...process.env, ASSET_VIEWER_DATA_DIR: join(root, 'data') }, windowsHide: true })
  const fallback = await finish(server, JSON.parse(stdout).job.id)
  assert.equal(fallback.result.report.unreal.issue, 'unreal-version-unavailable')
  assert.equal(fallback.result.report.written, report.written)
  assert.deepEqual((await readJSON(join(fallback.result.directory, 'manifest.json'))).assets[asset].issues,
    ['unreal-version-unavailable'])

  await writeFile(join(content, companion), 'sidecar-v2')
  assert.notEqual((await inspect(descriptor)).hash, plan.hash)
  const stale = await enqueue(project, plan.hash, undefined, 'failed')
  assert.match(stale.error, /изменились после анализа/)
  const revised = await inspect(project)
  const newer = await enqueue(project, revised.hash)
  await writeFile(join(newer.result.directory, 'Source/Content', companion), 'corrupted!')
  const corrupt = await enqueue(project, revised.hash, undefined, 'failed')
  assert.match(corrupt.error, /импорт Unreal повреждён/)
  assert.equal(await readFile(join(content, companion), 'utf8'), 'sidecar-v2')
})
