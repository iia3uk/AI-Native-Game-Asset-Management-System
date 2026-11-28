import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { AssetIndex } from '../core/index/asset-index.mjs'
import { removePackageImportPauseSchema, removePackageWatchSchema } from './fixtures/index-schema.mjs'
import { generateFixtures } from '../scripts/generate-fixtures.mjs'
import { archiveBytes, fixtureTexture, ids, unityEntries } from './fixtures/unitypackage.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')

async function awaitJob(server, id) {
  for (let count = 0; count < 150; count++) {
    const { job } = await (await server.request('/api/index/jobs/' + id)).json()
    if (!['pending', 'running'].includes(job.status)) return job
    await delay(80)
  }
  throw new Error('Job did not finish: ' + id)
}

test('batch export reuses a self-contained animated GLB and texture originals while reporting unsupported models', async t => {
  const directory = await testDirectory(t)
  await generateFixtures(directory)
  const glb = await readFile(join(directory, 'Architecture', 'woodland-cabin.glb'))
  const path = join(directory, 'Export.unitypackage')
  const source = archiveBytes([
    ...unityEntries(ids.model, 'Assets/Animation/cabin.glb', glb),
    ...unityEntries(ids.texture, 'Assets/Texture/albedo.png', fixtureTexture),
    ...unityEntries(ids.prefab, 'Assets/Native/example.blend', 'Original retained for review.'),
  ])
  await writeFile(path, source)
  const server = await startServer(directory)
  try {
    const enqueue = async formats => {
      const response = await server.post('/api/index/packages/import', { path, hash: hash(source), formats })
      assert.equal(response.status, 202)
      return (await response.json()).job
    }
    assert.equal((await server.post('/api/index/packages/import', { path, hash: hash(source), formats: ['exe'] })).status, 400)
    const queued = await enqueue(['glb'])
    const job = await awaitJob(server, queued.id)
    assert.equal(job.status, 'completed', job.error)
    assert.deepEqual(job.exportFormats, ['glb'])
    assert.deepEqual(job.result.report.export.counts, { ready: 1, extracted: 4, unsupported: 1 })
    assert.equal((await awaitJob(server, job.result.scanJobId)).status, 'completed')
    const response = await server.request('/api/index/jobs/' + job.id + '/manifest?limit=1')
    const page = await response.json()
    assert.equal(page.total, 3)
    assert.equal(page.nextOffset, 1)
    assert.equal(page.assets[0].id, ids.model)
    const output = job.result.directory
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
    const preview = manifest.assets.find(asset => asset.id === ids.model).exports.find(entry => entry.format === 'glb')
    const texture = manifest.assets.find(asset => asset.id === ids.texture).exports.find(entry => entry.format === 'png')
    assert.equal(preview.sha256, hash(glb))
    assert.deepEqual(await readFile(join(output, texture.path)), fixtureTexture)
    assert.deepEqual(await readFile(path), source)
    const bytes = await readFile(join(output, preview.path))
    assert.deepEqual(bytes, glb)
    assert.equal((await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, '')).animations[0].duration, 4)
    const search = await (await server.request('/api/index/search?q=cabin&kind=model')).json()
    assert.ok(search.assets.some(asset => asset.path === preview.path))
    for (const name of ['Models', 'Textures', 'Materials', 'Animations', 'Audio', 'Previews', 'Metadata']) {
      assert.ok((await stat(join(output, name))).isDirectory())
    }
    const repeated = await awaitJob(server, (await enqueue(['glb'])).id)
    assert.equal(repeated.result.reused, true)
    assert.equal(repeated.result.library.id, job.result.library.id)
    // A modified cache artifact must never pass as byte-identical output.
    await writeFile(join(output, texture.path), Buffer.alloc(fixtureTexture.length))
    const damaged = await awaitJob(server, (await enqueue(['glb'])).id)
    assert.equal(damaged.status, 'failed')
    assert.match(damaged.error, /повреждён/)
  } finally {
    await server.close()
  }
})

test('schema 7 pending imports survive the migration and format choices distinguish active jobs', async t => {
  const root = await testDirectory(t)
  const path = join(root, 'package.unitypackage')
  const database = join(root, 'index.sqlite')
  const key = 'b'.repeat(64)
  let index = await AssetIndex.open(database)
  const previous = index.jobs.enqueueImport(path, key)
  await index.close()
  const raw = new DatabaseSync(database)
  try {
    removePackageWatchSchema(raw)
    removePackageImportPauseSchema(raw)
    raw.exec(`DROP INDEX one_active_import_per_package;
      CREATE UNIQUE INDEX one_active_import_per_package ON processing_jobs (package_path, source_key)
        WHERE type = 'package-import' AND status IN ('pending','running');
      ALTER TABLE processing_jobs DROP COLUMN editor_version;
      ALTER TABLE processing_jobs DROP COLUMN engine_mode;
      ALTER TABLE processing_jobs DROP COLUMN export_formats;
      PRAGMA user_version = 7;`)
  } finally { raw.close() }
  index = await AssetIndex.open(database)
  try {
    assert.deepEqual(index.jobs.get(previous.id), previous)
    const exportJob = index.jobs.enqueueImport(path, key, 'fbx,glb')
    assert.notEqual(exportJob.id, previous.id)
    assert.equal(index.jobs.enqueueImport(path, key, 'fbx,glb').id, exportJob.id)
    index.jobs.cancel(exportJob.id)
    assert.deepEqual(index.jobs.retry(exportJob.id).exportFormats, ['fbx', 'glb'])
    const options = { mode: 'engine-assisted', editorVersion: '6000.3.10f1' }
    const bridgeJob = index.jobs.enqueueImport(path, key, 'fbx,glb', options)
    assert.notEqual(bridgeJob.id, exportJob.id)
    assert.equal(index.jobs.enqueueImport(path, key, 'fbx,glb', options).id, bridgeJob.id)
    index.jobs.cancel(bridgeJob.id)
    const retried = index.jobs.retry(bridgeJob.id)
    assert.equal(retried.engineMode, options.mode)
    assert.equal(retried.editorVersion, options.editorVersion)
  } finally {
    await index.close()
  }
})
