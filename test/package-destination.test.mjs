import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { archiveBytes, fixtureModel, fixtureTexture, ids, unityEntries, unityFixtureEntries } from './fixtures/unitypackage.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'))

async function finish(server, id) {
  for (let attempts = 0; attempts < 100; attempts++) {
    const { job } = await (await server.request('/api/index/jobs/' + id)).json()
    if (!['pending', 'running'].includes(job.status)) {
      assert.equal(job.status, 'completed', job.error)
      return job
    }
    await delay(80)
  }
  assert.fail('Import did not finish')
}

test('completed package exports preserve reports and selected dependencies in unique destination folders', { timeout: 20000 }, async t => {
  const root = await testDirectory(t)
  const destination = join(root, 'destination')
  const library = join(root, 'library')
  await mkdir(destination)
  await mkdir(library)
  const source = join(library, 'Castle.unitypackage')
  const longName = 'a'.repeat(176) + '.png'
  const bytes = archiveBytes(unityFixtureEntries([
    ...unityEntries('7'.repeat(32), 'Assets/Imported/linked.obj', 'mtllib linked.mtl\n' + fixtureModel),
    ...unityEntries('8'.repeat(32), 'Assets/Imported/linked.mtl', 'newmtl Test\nmap_Kd albedo.png\n'),
    ...unityEntries('9'.repeat(32), 'Assets/Imported/' + longName, fixtureTexture),
  ]))
  await writeFile(source, bytes)
  await writeFile(join(destination, 'manifest.json'), 'existing file')
  const server = await startServer(root)
  async function request(path, options, status) {
    const response = await server.post(path, options)
    const data = await response.json()
    assert.equal(response.status, status, JSON.stringify(data))
    return data
  }
  try {
    await request('/api/index/libraries', { path: library }, 201)
    const { job: queued } = await request('/api/index/packages/import', { path: source, hash: hash(bytes) }, 202)
    const job = await finish(server, queued.id)
    const folder = job.result.directory
    const route = '/api/index/jobs/' + job.id
    const manifest = await readJSON(join(folder, 'manifest.json'))
    const ordinal = manifest.assets.findIndex(row => row.id === ids.prefab)
    const linked = manifest.assets.findIndex(row => row.output?.endsWith('/linked.obj'))
    assert.ok(ordinal >= 0 && linked >= 0)
    await request(route + '/export', { destination }, 400)
    await request(route + '/export-plan', { destination, asset: manifest.assets.length }, 400)
    await request(route + '/export-plan', { destination: library }, 400)
    await request(route + '/export-plan', { destination: server.fab }, 400)
    await request(route + '/export-plan', { destination: folder }, 400)
    assert.equal((await server.post(route + '/export-plan', { destination }, { Origin: 'https://example.test' })).status, 403)
    const plan = await request(route + '/export-plan', { destination }, 200)
    assert.equal(plan.scope, 'package')
    assert.deepEqual(await readdir(destination), ['manifest.json'])
    const whole = await request(route + '/export', { destination, key: plan.key }, 201)
    assert.deepEqual(new Set(await readdir(whole.directory)), new Set(['Animations', 'Audio', 'Materials', 'Metadata', 'Models',
      'Previews', 'Source', 'Textures', 'conversion-report.json', 'dependencies.json', 'manifest.json']))
    for (const document of ['manifest.json', 'dependencies.json', 'conversion-report.json']) {
      assert.deepEqual(await readFile(join(whole.directory, document)), await readFile(join(folder, document)))
    }
    assert.deepEqual(await readFile(join(whole.directory, 'Source/Assets/Imported/' + longName + '.meta')),
      await readFile(join(folder, 'Source/Assets/Imported/' + longName + '.meta')))
    assert.equal(await readFile(join(destination, 'manifest.json'), 'utf8'), 'existing file')
    assert.deepEqual(await readFile(source), bytes)

    const asset = await request(route + '/export-plan', { destination, asset: ordinal }, 200)
    assert.equal(asset.scope, 'asset')
    assert.equal(asset.assets, 4)
    assert.ok(asset.unresolved >= 1)
    await request(route + '/export', { destination, asset: ordinal, key: plan.key }, 409)
    const selected = await request(route + '/export', { destination, asset: ordinal, key: asset.key }, 201)
    assert.notEqual(selected.directory, whole.directory)
    assert.deepEqual(await readFile(join(selected.directory, 'Source/Assets/Imported/albedo.png')), fixtureTexture)
    const selection = await readJSON(join(selected.directory, 'manifest.json'))
    assert.equal(selection.selection.asset, ids.prefab)
    assert.deepEqual(new Set(selection.assets.map(row => row.id)), new Set([ids.prefab, ids.model, ids.material, ids.texture]))
    const relations = await readJSON(join(selected.directory, 'dependencies.json'))
    assert.ok(relations.entries.some(row => row.status === 'missing'))
    const duplicates = await Promise.all(Array.from({ length: 2 }, () =>
      request(route + '/export', { destination, asset: ordinal, key: asset.key }, 201)))
    assert.equal(new Set([selected, ...duplicates].map(item => item.directory)).size, 3)

    const cli = async (...args) => {
      const executable = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
      const { stdout } = await promisify(execFile)(process.execPath,
        [executable, 'package-export', job.id, destination, '--asset', String(linked), ...args, '--json'],
        { env: { ...process.env, ASSET_VIEWER_DATA_DIR: join(root, 'data') } })
      return JSON.parse(stdout)
    }
    const fromCLI = await cli()
    assert.equal(fromCLI.key, (await request(route + '/export-plan', { destination, asset: linked }, 200)).key)
    const savedCLI = await cli('--plan-key', fromCLI.key)
    assert.deepEqual(await readFile(join(savedCLI.directory, 'Source/Assets/Imported/albedo.png')), fixtureTexture)
    assert.equal(await readFile(join(savedCLI.directory, 'Source/Assets/Imported/linked.mtl'), 'utf8'),
      'newmtl Test\nmap_Kd albedo.png\n')

    const beforeFailure = await readdir(destination)
    const texture = join(folder, 'Source/Assets/Imported/albedo.png')
    await writeFile(texture, Buffer.alloc(fixtureTexture.length))
    await request(route + '/export', { destination, asset: ordinal, key: asset.key }, 409)
    assert.deepEqual(await readdir(destination), beforeFailure)
    await writeFile(texture, fixtureTexture)

    const alias = join(root, 'alias')
    await mkdir(alias)
    const before = await request(route + '/export-plan', { destination: alias, asset: ordinal }, 200)
    assert.equal(before.destination, await realpath(alias))
    await rename(alias, join(root, 'previous'))
    await symlink(library, alias, 'junction')
    await request(route + '/export', { destination: alias, asset: ordinal, key: before.key }, 400)
    assert.deepEqual(await readdir(library), ['Castle.unitypackage'])

    manifest.assets[ordinal].output = 'Source/../../Castle.unitypackage'
    await writeFile(join(folder, 'manifest.json'), JSON.stringify(manifest))
    await request(route + '/export-plan', { destination }, 409)
  } finally {
    await server.close()
  }
})
