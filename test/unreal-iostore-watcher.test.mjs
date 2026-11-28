import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { AssetIndex } from '../core/index/asset-index.mjs'
import { ProcessingWorker } from '../core/processing/processing-worker.mjs'
import { removeIoStoreWatchSchema } from './fixtures/index-schema.mjs'
import { makeIoStore, writeIoStoreFixture } from './fixtures/unreal-iostore.mjs'
import { testDirectory } from './server-fixture.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

test('IoStore autoimport waits for companion files and queues the complete set by content', async t => {
  const root = await testDirectory(t)
  const incoming = join(root, 'incoming')
  const folder = join(incoming, 'nested')
  await mkdir(folder, { recursive: true })
  const { toc, path, data, partitionPaths } = await writeIoStoreFixture(folder, 'Watch', { texture: 'external' })
  const last = partitionPaths[1]
  await rm(last)
  await writeIoStoreFixture(folder, 'Encrypted', { flags: 11 })
  await writeFile(join(folder, 'Fake.utoc'), 'invalid toc')
  await writeFile(join(folder, 'Orphan.ucas'), data[0])
  const names = [path, ...partitionPaths].map(file => basename(file))
  const expected = tail => sha256(JSON.stringify(['unreal-iostore-v1',
    [toc, data[0], tail].map((bytes, i) => [names[i], bytes.length, sha256(bytes)])]))
  const index = await AssetIndex.open(':memory:')
  try {
    const { id } = await index.connect(incoming)
    await index.scan(id)
    assert.equal(index.jobs.refillWatchedImports([]), 0)
    index.setPackageWatching(id, true, [], 'unreal-iostore')
    await index.scan(id)
    assert.equal(index.jobs.refillWatchedImports([]), 0)
    await writeFile(last, Buffer.alloc(0))
    await index.scan(id)
    assert.equal(index.jobs.refillWatchedImports([]), 0)
    await writeFile(last, data[1].subarray(0, data[1].length - 16))
    await index.scan(id)
    assert.equal(index.jobs.refillWatchedImports([]), 0)

    await writeFile(last, data[1])
    await index.scan(id)
    assert.equal(index.jobs.refillWatchedImports([]), 1)
    const [first] = index.jobs.list({ type: 'package-import' })
    assert.equal(first.sourceKey, expected(data[1]))
    assert.equal(first.exportFormats, undefined)
    const source = index.jobs.watchedImportSource(first.id)
    assert.equal(source.path, 'nested/Watch.utoc')
    assert.equal(source.format, 'unreal-iostore')
    await index.scan(id)
    assert.equal(index.jobs.refillWatchedImports([]), 0)

    const changed = Buffer.from(data[1])
    changed[0] ^= 1
    await writeFile(last, changed)
    const worker = new ProcessingWorker(index, { type: 'package-import', importDirectory: join(root, 'imports') })
    try {
      const stale = await worker.wait(first.id, AbortSignal.timeout(5000))
      assert.equal(stale.status, 'failed')
      assert.match(stale.error, /изменилась после анализа/)
    } finally {
      await worker.stop()
    }
    await index.scan(id)
    assert.equal(index.jobs.refillWatchedImports([]), 1)
    const updated = index.jobs.list({ type: 'package-import' }).find(job => job.id !== first.id)
    assert.equal(updated.sourceKey, expected(changed))
    index.setPackageWatching(id, false, [], 'unreal-iostore')
    assert.equal(index.jobs.get(updated.id).status, 'cancelled')

    const newer = makeIoStore({ texture: 'external', soundName: 'Updated.wav' })
    await writeFile(path, newer.toc)
    index.setPackageWatching(id, true, [], 'unreal-iostore')
    assert.equal(index.jobs.refillWatchedImports([]), 0)
    await index.scan(id)
    assert.equal(index.jobs.refillWatchedImports([]), 1)
  } finally {
    await index.close()
  }
})

test('v15 migration preserves watched Unity files, combined hashes and active jobs', async t => {
  const root = await testDirectory(t)
  const incoming = join(root, 'incoming')
  const database = join(root, 'index.sqlite')
  await mkdir(incoming)
  const unity = Buffer.alloc(128)
  unity.writeUInt32BE(22, 8)
  unity.writeUInt32BE(24, 20)
  unity.writeBigUInt64BE(128n, 24)
  unity.writeBigUInt64BE(80n, 32)
  unity.write('6000.3.10f1', 48, 'ascii')
  await writeFile(join(incoming, 'level.assets'), unity)
  await writeFile(join(incoming, 'level.assets.resS'), 'sidecar')
  let index = await AssetIndex.open(database)
  const { id } = await index.connect(incoming)
  await index.scan(id)
  index.setPackageWatching(id, true, [], 'unity-serialized')
  assert.equal(index.jobs.refillWatchedImports([]), 1)
  const [job] = index.jobs.list({ type: 'package-import' })
  const source = index.jobs.watchedImportSource(job.id)
  await index.close()
  const legacy = new DatabaseSync(database)
  removeIoStoreWatchSchema(legacy)
  legacy.exec('PRAGMA user_version = 15')
  const old = legacy.prepare('SELECT * FROM serialized_package_sources').get()
  legacy.close()

  index = await AssetIndex.open(database)
  try {
    assert.equal(index.integrity().schemaVersion, 16)
    assert.deepEqual(index.libraries()[0].packageWatchFormats, ['unity-serialized'])
    assert.deepEqual(index.jobs.get(job.id), job)
    assert.deepEqual(index.jobs.watchedImportSource(job.id), source)
    assert.equal(index.jobs.refillWatchedImports([]), 0)
    const current = new DatabaseSync(database, { readOnly: true })
    try {
      assert.equal(old.source_key, job.sourceKey)
      assert.deepEqual(current.prepare('SELECT * FROM watched_package_sources').get(), old)
    } finally {
      current.close()
    }
  } finally {
    await index.close()
  }
})
