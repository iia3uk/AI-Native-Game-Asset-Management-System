import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { AssetIndex } from '../core/index/asset-index.mjs'
import { ProcessingWorker } from '../core/processing/processing-worker.mjs'
import { testDirectory } from './server-fixture.mjs'

const sha256 = data => createHash('sha256').update(data).digest('hex')

function bundleHeader(marker) {
  const bytes = Buffer.alloc(96)
  bytes.write('UnityFS\0')
  bytes[95] = marker
  return bytes
}

test('UnityFS folder watch uses only verified manifest siblings and queues a changed dependency', async t => {
  const root = await testDirectory(t)
  const library = join(root, 'library')
  const folder = join(library, 'assets')
  await mkdir(folder, { recursive: true })
  const modelName = 'Model.bundle'
  const mesh = bundleHeader(1)
  const paint = bundleHeader(2)
  const original = bundleHeader(3)
  const revised = bundleHeader(4)
  const fixture = {
    [modelName]: mesh,
    [modelName + '.manifest']: [
      'ManifestFileVersion: 0', 'Dependencies:', '- C:/old-build/bundles/Paint.bin',
      '- ../Outside.bundle', '- folder/../Sibling.bundle', '- C:/old-build/bundles/Invalid.bin',
    ].join('\r\n'),
    'Paint.bin': paint,
    'Paint.bin.manifest': 'ManifestFileVersion: 0\nDependencies:\n- Image.bin\n- Model.bundle\n',
    'Image.bin': original,
    'Sibling.bundle': bundleHeader(5),
    'Invalid.bin': Buffer.alloc(96),
  }
  await writeFile(join(library, 'Outside.bundle'), bundleHeader(6))
  for (const [name, data] of Object.entries(fixture)) await writeFile(join(folder, name), data)
  const key = image => sha256(JSON.stringify(['unity-bundle-dependencies-v1', modelName, sha256(mesh),
    [['Paint.bin', paint], ['Image.bin', image]].map(([name, data]) => ({
      name, role: 'bundle', size: data.length, sha256: sha256(data),
    }))]))

  const index = await AssetIndex.open(':memory:')
  try {
    const { id } = await index.connect(library)
    await index.scan(id)
    assert.deepEqual(index.setPackageWatching(id, true, [], 'unityfs').packageWatchFormats, ['unityfs'])
    index.jobs.refillWatchedImports([])
    const pending = () => index.jobs.list({ type: 'package-import' }).filter(job => job.packageName === modelName)
    const [first] = pending()
    assert.equal(first.sourceKey, key(original))
    assert.equal(index.jobs.watchedImportSource(first.id).format, 'unityfs')

    await writeFile(join(folder, 'Image.bin'), revised)
    const worker = new ProcessingWorker(index, { type: 'package-import', importDirectory: join(root, 'imports') })
    try {
      const stale = await worker.wait(first.id, AbortSignal.timeout(5000))
      assert.equal(stale.status, 'failed')
      assert.match(stale.error, /изменился после анализа/)
    } finally {
      await worker.stop()
    }
    await index.scan(id)
    index.jobs.refillWatchedImports([])
    const changed = pending().find(job => job.sourceKey === key(revised))
    assert.equal(changed?.status, 'pending')
    index.setPackageWatching(id, false, [], 'unityfs')
    assert.equal(index.jobs.get(changed.id).status, 'cancelled')
  } finally {
    await index.close()
  }
})
