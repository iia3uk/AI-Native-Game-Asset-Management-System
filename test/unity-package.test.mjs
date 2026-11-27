import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { AssetIndex } from '../core/index/asset-index.mjs'
import { stageUnityPackage } from '../core/packages/unity/import.mjs'
import { inspectUnityPackage } from '../core/packages/unity/inspect.mjs'
import { packageSource } from '../core/packages/source.mjs'
import { packageLimits } from '../core/packages/unity/policy.mjs'
import { ProcessingWorker } from '../core/processing/processing-worker.mjs'
import { writeUnityPreviewPackage } from './fixtures/unity-preview.mjs'
import { archiveBytes, fixtureModel, fixtureTexture, ids, tarMember, unityEntries, writeUnityFixture } from './fixtures/unitypackage.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const sha = data => createHash('sha256').update(data).digest('hex')
const completed = job => !['pending', 'running'].includes(job?.status)
const run = promisify(execFile)
const cliScript = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function waitForJob(server, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await server.request('/api/index/jobs/' + id)
    assert.equal(response.status, 200)
    const { job } = await response.json()
    if (completed(job)) return job
    await delay(80)
  }
  throw new Error('Job did not reach a terminal state: ' + id)
}

test('Imported Unity FBX resolves its authored PBR maps through the index viewer route', async t => {
  const directory = await testDirectory(t)
  const path = await writeUnityPreviewPackage(join(directory, 'package-source'))
  const server = await startServer(directory)
  try {
    const queued = await server.post('/api/index/packages/import', { path, hash: sha(await readFile(path)) })
    assert.equal(queued.status, 202)
    const job = await waitForJob(server, (await queued.json()).job.id)
    assert.equal(job.status, 'completed', job.error)
    assert.equal((await waitForJob(server, job.result.scanJobId)).status, 'completed')
    const { assets } = await (await server.request('/api/index/search?q=Panel&kind=model')).json()
    assert.equal(assets.length, 1)
    const opened = await server.post('/api/index/assets/' + assets[0].id + '/open', {})
    assert.equal(opened.status, 200)
    const { folder, fileId } = await opened.json()
    const { materialTextures } = folder.resources.find(file => file.id === fileId)
    const { pbr, remap } = materialTextures.fixtureslot
    assert.equal(remap, true)
    assert.equal(pbr.profile, 'hdrp-lit')
    const packed = folder.resources.find(file => file.path === 'Assets/Packed.png')
    assert.deepEqual([pbr.maps.metallic.url, pbr.maps.roughness.url, pbr.maps.ambientOcclusion.url], Array(3).fill(packed.url))
    assert.deepEqual([pbr.maps.metallic.channels, pbr.maps.roughness.channels, pbr.maps.ambientOcclusion.channels], ['r', 'a', 'g'])
    assert.equal(pbr.maps.normal.flipGreen, true)
    const texture = await server.request(packed.url)
    assert.equal(texture.status, 200)
    assert.deepEqual(Buffer.from(await texture.arrayBuffer()), await readFile(join(directory, 'package-source', 'Assets', 'Packed.png')))
  } finally {
    await server.close()
  }
})

test('Unity packages import through the durable HTTP queue and open in the existing viewer', async t => {
  const directory = await testDirectory(t)
  const path = await writeUnityFixture(join(directory, 'Fixture.unitypackage'))
  const before = await readFile(path)
  const server = await startServer(directory)
  try {
    const inspect = await server.post('/api/index/packages/inspect', { path })
    assert.equal(inspect.status, 200)
    const { package: preview } = await inspect.json()
    assert.equal(preview.hash, sha(before))
    assert.equal(preview.total, 6)
    assert.equal(preview.assets.find(item => item.id === ids.script).status, 'unsupported')
    await assert.rejects(stat(join(directory, 'data', 'imports')), { code: 'ENOENT' })
    assert.equal((await server.post('/api/index/packages/import', { path, hash: preview.hash },
      { Origin: 'https://example.test' })).status, 403)
    const queued = await server.post('/api/index/packages/import', { path, hash: preview.hash })
    assert.equal(queued.status, 202)
    const job = await waitForJob(server, (await queued.json()).job.id)
    assert.equal(job.status, 'completed', job.error)
    const { library, directory: output, report, scanJobId } = job.result
    assert.equal((await waitForJob(server, scanJobId)).status, 'completed')
    assert.equal(job.libraryId, library.id)
    assert.equal(report.counts.unsupported, 1)
    assert.equal(report.counts['requires-engine'], 1)
    assert.equal(report.counts['missing-dependencies'], 1)
    assert.equal(report.converted, 0)
    assert.deepEqual(report.materials, { written: 1, knownShader: 1, unresolvedTextures: 1 })
    assert.deepEqual(await readFile(path), before)
    assert.deepEqual(await readFile(join(library.root, 'Assets/Imported/albedo.png')), fixtureTexture)
    assert.deepEqual(await readFile(join(output, 'Previews', ids.model + '.png')), fixtureTexture)
    assert.equal(await readFile(join(library.root, 'Assets/Imported/fixture-package.obj'), 'utf8'), fixtureModel)
    await assert.rejects(stat(join(library.root, 'Assets/Editor/never.cs')), { code: 'ENOENT' })

    const manifest = await readJson(join(output, 'manifest.json'))
    assert.equal(manifest.source.sha256, sha(before))
    assert.equal(manifest.assets.find(item => item.id === ids.model).hash, sha(fixtureModel))
    assert.deepEqual(manifest.assets.find(item => item.id === ids.prefab).fileIDs, ['100100000', '3300000'])
    const material = manifest.assets.find(item => item.id === ids.material)
    assert.equal(material.materialDescription.path, 'Materials/' + ids.material + '/bindings.json')
    const materialBytes = await readFile(join(output, material.materialDescription.path))
    assert.equal(material.materialDescription.sha256, sha(materialBytes))
    assert.equal(material.materialDescription.size, materialBytes.byteLength)
    const normalized = JSON.parse(materialBytes)
    const byProperty = Object.fromEntries(normalized.textures.map(texture => [texture.property, texture]))
    assert.equal(normalized.source.path, material.output)
    assert.equal(normalized.source.fileID, '2100000')
    assert.equal(normalized.source.sha256, sha(await readFile(join(output, material.output))))
    assert.equal(normalized.shader.profile, 'standard')
    assert.deepEqual(normalized.properties.numbers, { _GlossMapScale: .65 })
    assert.deepEqual(normalized.properties.colors._Color, [1, .5, .25, 1])
    assert.deepEqual(normalized.properties.keywords, ['_METALLICGLOSSMAP'])
    assert.deepEqual(byProperty._MainTex.scale, [2, 3])
    assert.deepEqual(byProperty._MainTex.offset, [-.25, .75])
    assert.equal(byProperty._MainTex.target.importer.colorSpace, 'srgb')
    assert.equal(byProperty._MainTex.target.path, 'Source/Assets/Imported/albedo.png')
    assert.deepEqual(byProperty._MetallicGlossMap.roles, [
      { role: 'metallic', channels: 'r', colorSpace: 'linear' },
      { role: 'roughness', channels: 'a', colorSpace: 'linear', operation: 'one-minus-smoothness' },
    ])
    assert.equal(byProperty._Missing.reference.fileID, '987654321012345678')
    assert.equal(byProperty._Missing.status, 'unresolved')
    assert.deepEqual(byProperty._Missing.roles, [])
    const { dependencies } = await readJson(join(output, 'dependencies.json'))
    assert.ok(dependencies.some(item => item.source === ids.prefab && item.target === ids.material && item.status === 'resolved'))
    assert.ok(dependencies.some(item => item.source === ids.material && item.target === ids.texture && item.status === 'guid-resolved'))
    assert.ok(dependencies.some(item => item.fileID === '987654321012345678' && item.status === 'missing'))
    assert.deepEqual(await readJson(join(output, 'conversion-report.json')), report)

    const { assets: [model] } = await (await server.request('/api/index/search?q=fixture-package&kind=model')).json()
    assert.equal(model.libraryId, library.id)
    const { analysis } = await (await server.request('/api/index/assets/' + model.id)).json()
    assert.equal(analysis.metrics.triangles, 1)
    const opened = await server.post('/api/index/assets/' + model.id + '/open', {})
    assert.equal(opened.status, 200)
    const { folder, fileId } = await opened.json()
    const media = folder.resources.find(file => file.id === fileId)
    assert.equal(media.path, model.path)
    assert.equal(await (await server.request(media.url)).text(), fixtureModel)

    const retry = await server.post('/api/index/packages/import', { path, hash: preview.hash })
    const repeated = await waitForJob(server, (await retry.json()).job.id)
    assert.equal(repeated.status, 'completed', repeated.error)
    assert.equal(repeated.result.reused, true)
    assert.equal(repeated.result.library.id, library.id)
    assert.deepEqual(await readdir(join(directory, 'data', 'imports', 'unitypackage-v1')), [preview.hash])
    await writeFile(join(output, material.materialDescription.path), materialBytes.toString().replace('Fixture', 'Changed'))
    const again = await server.post('/api/index/packages/import', { path, hash: preview.hash })
    const invalid = await waitForJob(server, (await again.json()).job.id)
    assert.equal(invalid.status, 'failed')
    assert.match(invalid.error, /импорт повреждён/)
  } finally {
    await server.close()
  }
})

test('path validation, tar bounds and corruption fail before publication', async t => {
  const dir = await testDirectory(t)
  const file = join(dir, 'fixture.unitypackage')
  const validate = async (entries, pattern) => {
    await writeUnityFixture(file, entries)
    await assert.rejects(inspectUnityPackage(await packageSource(file)), pattern)
  }
  for (const path of ['../outside.obj', 'Assets/../escape.txt', 'Assets/AUX.txt', 'Assets/evil.exe:bad',
    'Assets/CON .txt', 'Assets/subdirname/file/..', 'Assets/SUBDIR~1/asset.obj',
    'Assets//asset.obj', '/Assets/escape.obj', 'C:\\escape.obj']) {
    await validate(unityEntries(ids.model, path, fixtureModel), /опасный путь/)
  }
  await validate([{ name: '../../escape', payload: 'x' }], /опасный путь/)
  await validate([{ name: ids.model + '/asset', type: '2', link: '../../escape' }], /ссылки/)
  await validate([{ name: ids.model + '/asset', type: '1', link: '../../escape' }], /ссылки/)
  await validate([
    ...unityEntries(ids.model, 'Assets/Geo/Mesh.obj', fixtureModel),
    ...unityEntries(ids.texture, 'Assets/geo/asset.png', fixtureTexture),
  ], /конфликт/)
  await validate([
    ...unityEntries(ids.model, 'Assets/Mesh.obj', fixtureModel),
    ...unityEntries(ids.texture, 'Assets/Mesh.obj/asset.png', fixtureTexture),
  ], /конфликт/)
  await validate([
    ...unityEntries(ids.model, 'Assets/Mesh.obj', fixtureModel),
    { name: ids.model + '/asset', payload: 'duplicate' },
  ], /повторяется/)
  const wrongMeta = unityEntries(ids.model, 'Assets/Mesh.obj', fixtureModel)
  wrongMeta[2].payload = 'guid: ' + ids.texture + '\n'
  await validate(wrongMeta, /GUID.*не совпадает/)
  const valid = unityEntries(ids.model, 'Assets/Mesh.obj', 'x'.repeat(8192))
  await writeUnityFixture(file, valid)
  assert.equal((await inspectUnityPackage(await packageSource(file))).total, 1)
  await assert.rejects(inspectUnityPackage(await packageSource(file), { limits: { ...packageLimits, unpacked: 7000 } }),
    /распакованного объёма/)
  await assert.rejects(inspectUnityPackage(await packageSource(file), { limits: { ...packageLimits, entry: 100 } }),
    /допустимый размер/)
  await assert.rejects(inspectUnityPackage(await packageSource(file), { limits: { ...packageLimits, entries: 3 } }),
    /числа записей/)
  const broken = tarMember({ name: ids.model + '/pathname', payload: 'Assets/Mesh.obj' })
  broken[8] ^= 1
  await writeFile(file, gzipSync(Buffer.concat([broken, Buffer.alloc(1024)])))
  await assert.rejects(inspectUnityPackage(await packageSource(file)), /контрольная сумма/)
  const zipped = archiveBytes(valid)
  await writeFile(file, zipped.subarray(0, -8))
  await assert.rejects(inspectUnityPackage(await packageSource(file)), /повреждены сжатые данные/)
  await writeFile(file, 'wrong format')
  await assert.rejects(inspectUnityPackage(await packageSource(file)), /формат не распознан/)
})

test('a queued import survives restart and changed sources fail even when an export is cached', async t => {
  const dir = await testDirectory(t)
  const source = await packageSource(await writeUnityFixture(join(dir, 'smoke.unitypackage')))
  const plan = await inspectUnityPackage(source)
  let index = await AssetIndex.open(join(dir, 'data', 'index.sqlite'))
  const queued = index.jobs.enqueueImport(source.path, plan.hash)
  assert.equal(index.jobs.enqueueImport(source.path, plan.hash).id, queued.id)
  await index.close()
  const server = await startServer(dir)
  try {
    const first = await waitForJob(server, queued.id)
    assert.equal(first.status, 'completed', first.error)
    await waitForJob(server, first.result.scanJobId)
    await writeUnityFixture(source.path, unityEntries(ids.model, 'Assets/changed.obj', fixtureModel))
    const response = await server.post('/api/index/packages/import', { path: source.path, hash: plan.hash })
    const second = await waitForJob(server, (await response.json()).job.id)
    assert.equal(second.status, 'failed')
    assert.match(second.error, /изменился после анализа/)
    assert.deepEqual(await readdir(join(dir, 'data', 'imports', 'unitypackage-v1')), [plan.hash])
  } finally { await server.close() }
})

test('aborting decompression removes the stage and never publishes a library', async t => {
  const directory = await testDirectory(t)
  const source = await packageSource(await writeUnityFixture(join(directory, 'abort.unitypackage')))
  const plan = await inspectUnityPackage(source)
  const imports = join(directory, 'imports')
  const controller = new AbortController()
  await assert.rejects(stageUnityPackage(imports, source, plan.hash, {
    signal: controller.signal,
    onProgress: () => controller.abort(),
    publish: () => assert.fail('publication after abort'),
  }), { name: 'AbortError' })
  assert.deepEqual(await readdir(join(imports, 'unitypackage-v1')), [])
})

test('cancelled and interrupted package jobs cannot publish and can be retried', async t => {
  const directory = await testDirectory(t)
  const source = await packageSource(await writeUnityFixture(join(directory, 'jobs.unitypackage')))
  const plan = await inspectUnityPackage(source)
  const database = join(directory, 'index.sqlite')
  const index = await AssetIndex.open(database)
  const connection = await AssetIndex.open(database)
  const raw = new DatabaseSync(database)
  try {
    const job = index.jobs.enqueueImport(source.path, plan.hash)
    assert.equal(index.jobs.cancel(job.id).status, 'cancelled')
    assert.equal(index.jobs.retry(job.id).status, 'pending')
    assert.equal(index.jobs.claim('first', 'package-import').id, job.id)
    const second = index.jobs.enqueueImport(source.path, 'a'.repeat(64))
    assert.equal(connection.jobs.claim('other', 'package-import'), null)
    index.jobs.cancel(job.id)
    assert.throws(() => connection.jobs.completeImport(job.id, 'first', () => assert.fail('publication after cancellation')), /отменена/)
    raw.prepare('UPDATE processing_jobs SET lease_until = 0 WHERE id = ?').run(job.id)
    assert.equal(connection.jobs.claim('other', 'package-import').id, second.id)
    assert.equal(index.jobs.get(job.id).status, 'cancelled')
    raw.prepare('UPDATE processing_jobs SET lease_until = 0 WHERE id = ?').run(second.id)
    index.jobs.claim('recovery', 'package-import')
    assert.equal(index.jobs.get(second.id).status, 'interrupted')
    index.jobs.retry(job.id)
    const worker = new ProcessingWorker(index, { type: 'package-import', importDirectory: join(directory, 'imports') })
    try {
      const done = await worker.wait(job.id)
      assert.equal(done.status, 'completed', done.error)
      assert.equal(done.attempts, 2)
      assert.equal(index.jobs.get(done.result.scanJobId).status, 'pending')
    } finally { await worker.stop() }
  } finally {
    raw.close()
    await connection.close()
    await index.close()
  }
})

test('CLI dry-run writes nothing and direct package import finishes indexing', async t => {
  const directory = await testDirectory(t)
  const path = await writeUnityFixture(join(directory, 'cli.unitypackage'))
  const data = join(directory, 'data')
  const cli = async (...args) => {
    const { stdout } = await run(process.execPath, [cliScript, ...args, '--json'], {
      env: { ...process.env, ASSET_VIEWER_DATA_DIR: data }, windowsHide: true,
    })
    return JSON.parse(stdout)
  }
  assert.equal((await cli('package-inspect', path)).total, 6)
  assert.equal((await cli('package-import', path, '--dry-run')).dryRun, true)
  await assert.rejects(stat(data), { code: 'ENOENT' })
  const { job, scan } = await cli('package-import', path)
  assert.equal(job.status, 'completed')
  assert.equal(scan.status, 'completed')
  assert.equal((await cli('jobs', '--type', 'package-import'))[0].id, job.id)
  assert.equal((await cli('search', 'fixture-package', '--kind', 'model')).assets[0].libraryId, job.libraryId)
})

test('archives with only excluded assets create a report without an empty library', async t => {
  const directory = await testDirectory(t)
  const path = await writeUnityFixture(join(directory, 'code-only.unitypackage'),
    unityEntries(ids.script, 'Assets/Editor/Example.cs', 'public class Example {}'))
  const server = await startServer(directory)
  try {
    const { package: plan } = await (await server.post('/api/index/packages/inspect', { path })).json()
    const { job: queued } = await (await server.post('/api/index/packages/import', { path, hash: plan.hash })).json()
    const job = await waitForJob(server, queued.id)
    assert.equal(job.status, 'completed')
    assert.equal(job.result.library, null)
    assert.equal(job.result.scanJobId, null)
    assert.equal(job.result.report.written, 0)
    assert.equal(job.result.report.counts.unsupported, 1)
    assert.deepEqual((await (await server.request('/api/index/libraries')).json()).libraries, [])
  } finally { await server.close() }
})
