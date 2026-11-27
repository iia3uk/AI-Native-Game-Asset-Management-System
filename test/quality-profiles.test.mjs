import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { AssetIndex } from '../core/index/asset-index.mjs'
import { validateQuality } from '../core/analysis/quality-profiles.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const byKey = validation => Object.fromEntries(validation.checks.map(check => [check.key, check]))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0p8AAAAASUVORK5CYII=', 'base64')
const obj = 'mtllib source.mtl\nv 0 0 0\nv 4 0 0\nv 0 1 0\nusemtl Material\nf 1 2 3\n'

test('profile evaluation distinguishes known failures, missing evidence and irrelevant checks', () => {
  const profile = { id: 'custom-project', limits: {
    maxTriangles: 10, minExtent: 1, maxExtent: 5, maxTextureEdge: 1024,
    requireUV: true, requireVerifiedDependencies: true, requireValidStructure: true,
  } }
  const model = { kind: 'model' }
  const partial = { status: 'partial', metrics: { triangles: 10, bounds: { size: [5, 1, 0] }, hasUV: false },
    issues: ['unsupported-obj-surfaces'], dependenciesComplete: false, dependencies: [
      { role: 'image', status: 'available', path: 'large.png', dimensions: { width: 1200, height: 10 } },
      { role: 'image', status: 'external', dimensions: null },
    ] }
  const validation = validateQuality(model, partial, profile)
  assert.equal(validation.status, 'fail')
  const checks = byKey(validation)
  assert.equal(checks.maxTriangles.status, 'pass')
  assert.equal(checks.maxTriangles.actual, 10)
  assert.equal(checks.minExtent.status, 'pass')
  assert.equal(checks.maxExtent.status, 'pass')
  assert.deepEqual(checks.maxTextureEdge, {
    key: 'maxTextureEdge', status: 'fail', limit: 1024, actual: 1200, reason: 'outside-budget', evidence: 'large.png',
  })
  assert.equal(checks.requireUV.status, 'unknown')
  assert.equal(checks.requireVerifiedDependencies.status, 'unknown')
  assert.equal(checks.requireValidStructure.status, 'unknown')
  const image = validateQuality({ kind: 'image' }, { ...partial, status: 'analyzed', metrics: { width: 16, height: 16 } }, profile)
  assert.equal(image.status, 'pass')
  assert.equal(byKey(image).maxTriangles.status, 'not-applicable')
  assert.equal(byKey(image).maxTextureEdge.actual, 16)
  assert.equal(validateQuality(model, partial, { limits: {} }).status, 'not-applicable')
  assert.equal(validateQuality({ ...model, missingSince: 'deleted' }, partial, profile).status, 'unknown')
})

test('HTTP profiles are editable and resettable and explain changes in indexed evidence', async t => {
  const directory = await testDirectory(t)
  const libraryPath = join(directory, 'library')
  await mkdir(libraryPath)
  await writeFile(join(libraryPath, 'source.obj'), obj)
  await writeFile(join(libraryPath, 'source.mtl'), 'newmtl Material\nmap_Kd diffuse.png\n')
  await writeFile(join(libraryPath, 'unsupported.fbx'), 'synthetic opaque fixture')
  let server = await startServer(directory)
  const qualityUrl = '/api/index/quality-profiles'
  const list = () => server.request(qualityUrl).then(result => result.json())
  const custom = qualityUrl + '/custom-project'
  try {
    const { profiles, fields } = await list()
    assert.deepEqual(profiles.map(profile => profile.name), [
      'Mobile Game', 'Desktop Game', 'Stylized Game', 'Realistic Game', 'VR', 'Custom Project',
    ])
    assert.deepEqual(fields.maxTriangles, { type: 'integer', min: 1, max: 1_000_000_000 })
    assert.equal((await server.post(custom, { revision: 0, limits: {} }, { Origin: '' })).status, 403)
    for (const limits of [{ maxVertices: -1 }, { maxTriangles: 1.2 }, { maxTextureEdge: '42' },
      { minExtent: 3, maxExtent: 2 }, { requireUV: 1 }, { unexpected: true }]) {
      assert.equal((await server.post(custom, { revision: 0, limits })).status, 400)
    }
    assert.equal((await server.post(custom, { limits: {} })).status, 400)
    assert.equal((await server.post(custom, { revision: 0, reset: true, limits: {} })).status, 400)

    const { library } = await server.post('/api/index/libraries', { path: libraryPath }).then(result => result.json())
    const scan = async () => assert.equal((await server.post('/api/index/libraries/' + library.id + '/scan', {})).status, 200)
    await scan()
    const find = async q => (await server.request('/api/index/search?q=' + q).then(result => result.json())).assets[0]
    const model = await find('source.obj')
    const unsupported = await find('unsupported.fbx')
    const check = (id = model.id) => server.request('/api/index/assets/' + id + '?profile=custom-project')
      .then(result => result.json()).then(result => result.validation)
    assert.equal((await check()).status, 'not-applicable')
    const limits = { maxTriangles: 1, maxTextureEdge: 1, minExtent: 4, maxExtent: 4, requireVerifiedDependencies: true }
    const changed = await server.post(custom, { revision: 0, limits })
    assert.equal(changed.status, 200)
    assert.deepEqual((await changed.json()).profile, { id: 'custom-project', name: 'Custom Project', limits, revision: 1, customized: true })
    assert.equal((await server.post(custom, { revision: 0, limits: {} })).status, 409)
    assert.equal((await server.request('/api/index/assets/' + model.id + '?profile=typo')).status, 400)
    const afterSave = await check()
    assert.equal(afterSave.status, 'fail')
    assert.equal(byKey(afterSave).maxTextureEdge.status, 'unknown')
    assert.equal(byKey(afterSave).requireVerifiedDependencies.evidence, 'diffuse.png')
    assert.equal(byKey(afterSave).maxTriangles.status, 'pass')
    assert.equal((await check(unsupported.id)).status, 'unknown')
    await writeFile(join(libraryPath, 'diffuse.png'), png)
    await scan()
    const withTexture = await check()
    assert.equal(withTexture.status, 'pass')
    assert.equal(byKey(withTexture).maxTextureEdge.actual, 1)

    const mobile = profiles[0]
    assert.equal((await server.post(qualityUrl + '/mobile-game', { revision: 0, limits: { maxTriangles: 50 } })).status, 200)
    await server.close()
    server = await startServer(directory)
    assert.equal((await check()).profile.revision, 1)
    const beforeReset = (await list()).profiles[0]
    assert.deepEqual(beforeReset.limits, { maxTriangles: 50 })
    const reset = await server.post(qualityUrl + '/mobile-game', { revision: beforeReset.revision, reset: true })
    assert.deepEqual((await reset.json()).profile, { ...mobile, revision: 2 })
    assert.equal((await server.post(qualityUrl + '/mobile-game', { revision: 0, limits: {} })).status, 409)
  } finally { await server.close() }
})

test('schema 4 migration retains existing analysis and profile edits survive backup', async t => {
  const directory = await testDirectory(t)
  const library = join(directory, 'library')
  const database = join(directory, 'index.sqlite')
  await mkdir(library)
  await writeFile(join(library, 'source.obj'), obj)
  let index = await AssetIndex.open(database)
  const { id } = await index.connect(library)
  await index.scan(id)
  const [asset] = index.search().assets
  const before = index.inspect(asset.id)
  await index.close()

  const raw = new DatabaseSync(database)
  try { raw.exec('DROP TABLE quality_profiles; PRAGMA user_version = 4;') }
  finally { raw.close() }

  index = await AssetIndex.open(database)
  try {
    assert.equal(index.integrity().schemaVersion, 7)
    assert.deepEqual(index.inspect(asset.id), before)
    const profile = index.qualityProfiles.update('custom-project', { revision: 0, limits: { maxTriangles: 1 } })
    const snapshot = await index.backup(join(directory, 'backups'))
    const copy = new AssetIndex(snapshot, { readOnly: true })
    try {
      assert.deepEqual(copy.qualityProfiles.get('custom-project'), profile)
      assert.equal(copy.inspect(asset.id, { profileId: profile.id }).validation.status, 'pass')
    } finally { await copy.close() }
  } finally { await index.close() }
})
