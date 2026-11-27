import assert from 'node:assert/strict'
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { AssetIndex } from '../core/index/asset-index.mjs'
import { generateFixtures } from '../scripts/generate-fixtures.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

test('file identity, versions, search, backups and transactional incremental scans', async t => {
  const directory = await testDirectory(t)
  const library = join(directory, 'library')
  const dbPath = join(directory, 'data', 'index.sqlite')
  await mkdir(library)
  await Promise.all([
    writeFile(join(library, 'Кабина.obj'), 'synthetic model'),
    writeFile(join(library, 'granite.glb'), 'synthetic duplicate'),
    writeFile(join(library, 'other.glb'), 'synthetic duplicate'),
    writeFile(join(library, 'ignore.txt'), 'not indexed'),
  ])
  let index = await AssetIndex.open(dbPath)
  try {
    const { id } = await index.connect(library)
    assert.equal((await index.connect(library)).id, id)
    assert.deepEqual(await index.scan(id), { assets: 3, added: 3, changed: 0, moved: 0, missing: 0,
      hashed: 3, reused: 0, skippedHashes: 0 })
    assert.equal((await index.scan(id)).reused, 3)
    const { assets: [asset] } = index.search({ q: 'КАБИНА OBJ', libraryId: id, kind: 'model' })
    assert.equal(asset.path, 'Кабина.obj')
    assert.match(asset.hash, /^[\da-f]{64}$/)
    assert.equal(index.duplicates()[0].count, 2)
    assert.notEqual(index.search({ q: 'granite' }).assets[0].id, index.search({ q: 'other' }).assets[0].id)
    assert.equal(index.search({ q: 'ка', limit: 1 }).assets[0].id, asset.id)
    assert.equal(index.search({ q: '" OR *' }).assets.length, 0)
    assert.equal(index.search({ limit: 1 }).nextOffset, 1)
    assert.equal(index.search({ limit: 1, offset: 2 }).nextOffset, null)
    index.updateAsset(asset.id, { category: 'Architecture', tags: ['Лес', 'Лес'], note: 'Проверено', review: 'candidate' })
    assert.equal(index.search({ q: 'ЛЕС Проверено' }).assets[0].id, asset.id)
    await rename(join(library, 'Кабина.obj'), join(library, 'cabin-renamed.obj'))
    assert.equal((await index.scan(id)).moved, 1)
    assert.equal(index.search({ q: 'КАБИНА' }).assets.length, 0)
    assert.equal(index.asset(asset.id).path, 'cabin-renamed.obj')
    assert.deepEqual(index.asset(asset.id).tags, ['Лес'])
    assert.deepEqual(index.versions(asset.id).map(version => version.path), ['cabin-renamed.obj', 'Кабина.obj'])

    await rename(join(library, 'granite.glb'), join(library, 'ambiguous.glb'))
    const ambiguous = await index.scan(id)
    assert.deepEqual([ambiguous.added, ambiguous.moved, ambiguous.missing], [1, 0, 1])
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(index.scan(id, { signal: controller.signal }), { name: 'AbortError' })
    assert.equal(index.libraries()[0].assets, 3)

    await rm(join(library, 'cabin-renamed.obj'))
    assert.equal((await index.scan(id)).missing, 1)
    assert.equal(index.search({ q: 'renamed' }).assets.length, 0)
    assert.ok(index.asset(asset.id).missingSince)
    assert.equal(index.disconnect(id), true)
    assert.equal(index.libraries().length, 0)
    assert.equal(index.asset(asset.id), undefined)
    assert.equal((await index.connect(library)).id, id)

    const snapshot = await index.backup(join(directory, 'backups'))
    const copy = await AssetIndex.open(snapshot)
    try {
      assert.equal(copy.integrity().ok, true)
      assert.equal(copy.asset(asset.id).note, 'Проверено')
    } finally { await copy.close() }
    await index.close()
    index = await AssetIndex.open(dbPath)
    assert.equal(index.asset(asset.id).review, 'candidate')
    assert.equal(index.integrity().schemaVersion, 12)
  } finally { await index.close() }
})

test('linked assets are excluded and a replaced library root does not change the index', async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'root')
  const outside = join(directory, 'outside')
  await Promise.all([mkdir(root), mkdir(outside)])
  await writeFile(join(root, 'sample.glb'), 'kept')
  await writeFile(join(outside, 'outside.glb'), 'external')
  const link = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(outside, join(root, 'alias'), link)
  const index = await AssetIndex.open(':memory:')
  try {
    const { id } = await index.connect(root)
    assert.equal((await index.scan(id)).assets, 1)
    await rename(root, join(directory, 'moved'))
    await symlink(outside, root, link)
    await assert.rejects(index.scan(id), { name: 'Error', message: /изменилась/ })
    assert.equal(index.search().assets[0].path, 'sample.glb')
    assert.deepEqual(index.search({ q: 'outside' }).assets, [])
  } finally { await index.close() }
})

test('unreadable or future index schemas are preserved for recovery', async t => {
  const directory = await testDirectory(t)
  const corrupt = join(directory, 'corrupt.sqlite')
  await writeFile(corrupt, 'corrupt index')
  await assert.rejects(AssetIndex.open(corrupt))
  assert.equal(await readFile(corrupt, 'utf8'), 'corrupt index')
  const future = join(directory, 'future.sqlite')
  const database = new DatabaseSync(future)
  database.exec('PRAGMA user_version = 100')
  database.close()
  await assert.rejects(AssetIndex.open(future), /newer version/)
})

test('index routes support connect, search, preview and data persistence across server restarts', { timeout: 15000 }, async t => {
  const directory = await testDirectory(t)
  const root = join(directory, 'assets')
  await generateFixtures(root, { includeErrors: true })
  let server = await startServer(directory)
  try {
    assert.equal((await server.post('/api/index/libraries', { path: root }, { Origin: '' })).status, 403)
    assert.equal((await server.post('/api/index/libraries', { path: 123 })).status, 400)
    const connected = await server.post('/api/index/libraries', { path: root })
    assert.equal(connected.status, 201)
    const { library } = await connected.json()
    const scan = await server.post('/api/index/libraries/' + library.id + '/scan', {})
    assert.equal(scan.status, 200)
    assert.equal((await scan.json()).added, 10)
    assert.equal((await server.request('/api/index/duplicates')).status, 200)
    assert.equal((await server.request('/api/index/search?limit=300')).status, 400)
    const search = await server.request('/api/index/search?q=woodland&kind=model')
    const { assets: [asset] } = await search.json()
    assert.equal(asset.name, 'woodland-cabin.glb')
    const saved = await server.post('/api/index/assets/' + asset.id, { note: 'Keeps my review', tags: ['foliage'] })
    assert.equal(saved.status, 200)
    await server.close()
    server = await startServer(directory)
    const libraries = await server.request('/api/index/libraries').then(response => response.json())
    assert.equal(libraries.libraries[0].id, library.id)
    const review = await server.request('/api/index/search?q=foliage').then(response => response.json())
    assert.equal(review.assets[0].note, 'Keeps my review')
    const opened = await server.post('/api/index/assets/' + asset.id + '/open', {})
    assert.equal(opened.status, 200)
    const preview = await opened.json()
    const file = preview.folder.resources.find(file => file.id === preview.fileId)
    assert.equal(file.name, asset.name)
    assert.equal((await server.request(file.preview)).status, 200)
  } finally { await server.close() }
})
