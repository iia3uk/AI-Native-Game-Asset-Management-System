import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { AssetIndex } from '../core/index/asset-index.mjs'
import { ProcessingWorker } from '../core/processing/processing-worker.mjs'
import { testDirectory } from './server-fixture.mjs'

const sha256 = value => createHash('sha256').update(value).digest('hex')

function catalogHeader() {
  const data = Buffer.alloc(128)
  data.writeUInt32BE(22, 8)
  data.writeUInt32BE(24, 20)
  data.writeBigUInt64BE(128n, 24)
  data.writeBigUInt64BE(80n, 32)
  data.write('6000.3.10f1', 48, 'ascii')
  return data
}

test('serialized package watch queues each verified source fingerprint and rejects a replaced companion before decoding', async t => {
  const root = await testDirectory(t)
  const libraryRoot = join(root, 'incoming')
  const binary = catalogHeader()
  const name = 'level.sharedAssets'
  const companion = join(libraryRoot, name + '.resS')
  await mkdir(libraryRoot)
  await writeFile(join(libraryRoot, name), binary)
  await writeFile(join(libraryRoot, 'ordinary.asset'), '%YAML 1.1')
  await writeFile(join(libraryRoot, 'wrong.assets'), 'invalid serialized data')
  await writeFile(companion, 'original')
  const index = await AssetIndex.open(':memory:')
  try {
    const { id } = await index.connect(libraryRoot)
    await index.scan(id)
    assert.equal(index.jobs.refillWatchedImports([]), 0)
    assert.deepEqual(index.setPackageWatching(id, true, [], 'unity-serialized').packageWatchFormats, ['unity-serialized'])
    assert.equal(index.jobs.refillWatchedImports([]), 1)
    const [first] = index.jobs.list({ type: 'package-import' })
    const raw = sha256(binary)
    const expected = text => sha256(JSON.stringify(['unity-serialized-companions-v1', name, raw,
      [{ name: name + '.resS', role: 'texture', size: text.length, sha256: sha256(text) }]]))
    assert.equal(first.packageName, name)
    assert.equal(first.sourceKey, expected('original'))
    assert.deepEqual(first.exportFormats, ['fbx', 'glb'])
    assert.equal(index.jobs.watchedImportSource(first.id).format, 'unity-serialized')
    await index.scan(id)
    assert.equal(index.jobs.refillWatchedImports([]), 0)

    await writeFile(companion, 'modified')
    const worker = new ProcessingWorker(index, { type: 'package-import', importDirectory: join(root, 'imports') })
    try {
      const stale = await worker.wait(first.id, AbortSignal.timeout(5000))
      assert.equal(stale.status, 'failed')
      assert.match(stale.error, /изменился после анализа/)
    } finally {
      await worker.stop()
    }
    await index.scan(id)
    assert.equal(index.jobs.refillWatchedImports([]), 1)
    const [changed] = index.jobs.list({ type: 'package-import' })
    assert.equal(changed.sourceKey, expected('modified'))
    index.setPackageWatching(id, false, [], 'unity-serialized')
    assert.equal(index.jobs.get(changed.id).status, 'cancelled')
    assert.equal(index.jobs.refillWatchedImports([]), 0)
    assert.equal(index.libraries()[0].assets, 3)
  } finally {
    await index.close()
  }
})
