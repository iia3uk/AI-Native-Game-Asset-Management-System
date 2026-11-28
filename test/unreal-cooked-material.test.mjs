import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { test } from 'node:test'
import { readCookedMaterial } from '../core/engines/unreal/cooked-package/material.mjs'
import { fileInfo } from '../core/files/asset-files.mjs'
import { cleanupCandidates } from '../core/packages/cleanup/candidates.mjs'
import { cookedMaterial } from './fixtures/unreal-cooked-material.mjs'
import { cookedTexture } from './fixtures/unreal-cooked-texture.mjs'
import { makeModernPak } from './fixtures/unreal-pak.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const sha = data => createHash('sha256').update(data).digest('hex')
const parent = ['/Game/Example/M_Master']
const label = '/Game/Example/T_Paint'
const painted = { parameter: 'BaseColor', value: label }

async function queueImport(server, path, hash) {
  const request = await server.post('/api/index/packages/import', { path, hash })
  assert.equal(request.status, 202)
  const { job } = await request.json()
  return waitForJob(server, job.id)
}

async function waitForJob(server, id) {
  const deadline = Date.now() + 13_000
  while (Date.now() < deadline) {
    const response = await server.request('/api/index/jobs/' + id)
    assert.equal(response.status, 200)
    const { job } = await response.json()
    if (!['pending', 'running'].includes(job.status)) return job
    await setTimeout(100)
  }
  assert.fail('Pak job did not reach a terminal state')
}

function makeMaterialFixtures() {
  const master = cookedMaterial({ name: 'M_Master', split: false })
  const middle = cookedMaterial({ name: 'MI_Parent', parent, textures: [painted],
    scalars: [{ parameter: 'Roughness', value: 0.75, omitAssociation: true }, { parameter: 'LayerStrength', value: 0.5, layer: 1 }] })
  const leaf = cookedMaterial({ name: 'MI_Paint', parent: ['/Game/Example/MI_Parent', 'MaterialInstanceConstant'],
    textures: [{ parameter: 'Normal', value: '/Game/Other/T_Missing' }],
    vectors: [{ parameter: 'Tint', value: [0.25, 0.5, 0.75, 1] }] })
  const damaged = cookedMaterial({ name: 'MI_Damaged', parent, malformed: true })
  const orphan = cookedMaterial({ name: 'MI_Orphan', parent }).slice(0, 1)
  const impostor = cookedMaterial({ name: 'MI_Impostor', parent, rootClass: '/Script/Another' })
  const texture = cookedTexture({ name: 'T_Paint', format: 'PF_G8', width: 1, height: 1, pixels: Buffer.from([42]) })
  const wrongDirectory = cookedTexture({ name: 'T_Missing', format: 'PF_G8', width: 1, height: 1, pixels: Buffer.from([70]) })
  return { master, middle, leaf, damaged, orphan, impostor, texture, wrongDirectory }
}

test('cooked UE4 materials accept only the native class and a bounded inline or split export', async t => {
  const root = await testDirectory(t)
  for (const [key, files] of Object.entries(makeMaterialFixtures())) {
    await Promise.all(files.map(file => writeFile(join(root, file.path), file.content)))
    const [header, companion] = await Promise.all(files.map(file => fileInfo(root, file.path)))
    const result = await readCookedMaterial(root, header, companion)
    if (key === 'master') assert.deepEqual([result.material.type, result.split], ['Material', false])
    if (key === 'middle') {
      assert.deepEqual([result.material.parent, result.split], [parent[0], true])
      assert.deepEqual(result.material.scalars.map(row => [row.association, row.index, row.value]),
        [['GlobalParameter', -1, 0.75], ['LayerParameter', 1, 0.5]])
    }
    if (key === 'damaged') assert.equal(result.issue, 'unreal-cooked-material-layout')
    if (key === 'orphan') assert.equal(result.issue, 'unreal-cooked-material-export-missing')
    if (['impostor', 'texture', 'wrongDirectory'].includes(key)) assert.equal(result, null)
  }
})

test('Pak material import indexes bindings, exports dependency closure and validates cached reports',
  { skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 45_000 }, async t => {
    const root = await testDirectory(t)
    const path = join(root, 'Materials.pak')
    const fixtures = makeMaterialFixtures()
    const files = Object.values(fixtures).flat().map(file => ({ ...file, path: 'Example/' + file.path, compressed: true }))
    const source = makeModernPak(files)
    const hash = sha(source)
    await writeFile(path, source)
    const server = await startServer(root)
    try {
      const imported = await queueImport(server, path, hash)
      assert.equal(imported.status, 'completed', imported.error)
      assert.deepEqual(imported.result.report.materials, { converted: 3, skipped: 2, failed: 0 })
      assert.deepEqual(imported.result.report.textures, { converted: 2, skipped: 0, failed: 0 })
      assert.equal((await waitForJob(server, imported.result.scanJobId)).status, 'completed')
      const { directory: output } = imported.result
      const route = '/api/index/jobs/' + imported.id
      const { assets } = await (await server.request(route + '/manifest')).json()
      const row = name => assets.find(entry => entry.path.endsWith('/' + name + '.uasset'))
      const candidates = entries => Array.fromAsync(cleanupCandidates('unreal-pak', path,
        { source: { size: source.length, sha256: hash } }, entries, false, new AbortController().signal))
      assert.deepEqual(await candidates(assets), [])
      const leaf = row('MI_Paint')
      const [bindingFile] = leaf.exports
      const bindingBytes = await readFile(join(output, bindingFile.path))
      const description = JSON.parse(bindingBytes)
      assert.equal(bindingFile.sha256, sha(bindingBytes))
      assert.deepEqual(description.source, { engine: 'unreal', path: leaf.path, sha256: sha(fixtures.leaf[0].content),
        payload: { path: leaf.path.slice(0, -7) + '.uexp', sha256: sha(fixtures.leaf[1].content) } })
      assert.equal(description.parentStatus, 'resolved')
      assert.equal(description.effectiveParameters.scalars[0].value, 0.75)
      assert.deepEqual(description.parameters.vectors[0].value, [0.25, 0.5, 0.75, 1])
      assert.deepEqual(description.bindings.map(binding => [binding.role, binding.status, binding.textureId]),
        [['normal', 'missing', null], ['baseColor', 'resolved', row('T_Paint').id]])
      assert.equal(row('MI_Impostor').exports, undefined)
      assert.equal(row('MI_Damaged').exports[0].issue, 'unreal-cooked-material-layout')
      assert.equal(row('MI_Orphan').exports[0].issue, 'unreal-cooked-material-export-missing')
      const search = '/api/index/search?kind=other&library=' + imported.result.library.id
      const indexed = (await (await server.request(search)).json()).assets
      assert.ok(indexed.some(asset => asset.name === 'MI_Paint.material.json'))

      const destination = join(root, 'Exports')
      await mkdir(destination)
      const asset = assets.indexOf(leaf)
      const plan = await (await server.post(route + '/export-plan', { destination, asset })).json()
      assert.equal(plan.unresolved, 1)
      assert.equal(plan.dependencyStatus, 'partial')
      const exported = await server.post(route + '/export', { destination, asset, key: plan.key })
      assert.equal(exported.status, 201)
      const { directory } = await exported.json()
      const contents = JSON.parse(await readFile(join(directory, 'manifest.json'))).entries
      const selected = ['M_Master.uasset', 'MI_Parent.uasset', 'MI_Parent.uexp', 'MI_Paint.uasset', 'MI_Paint.uexp', 'T_Paint.uasset', 'T_Paint.uexp']
      assert.deepEqual(contents.map(entry => entry.path.split('/').at(-1)).sort(), selected.sort())
      for (const file of files.filter(file => selected.includes(file.path.split('/').at(-1)))) {
        assert.deepEqual(await readFile(join(directory, 'Source', 'Fixture', 'Content', file.path)), file.content)
      }
      assert.deepEqual(await readFile(join(directory, bindingFile.path)), bindingBytes)
      assert.deepEqual(await readFile(join(directory, row('T_Paint').exports[0].path)),
        await readFile(join(output, row('T_Paint').exports[0].path)))
      assert.deepEqual(await readFile(path), source)
      assert.equal((await queueImport(server, path, hash)).result.reused, true)
      const report = join(output, 'dependencies.json')
      await writeFile(report, (await readFile(report, 'utf8')) + '\n')
      assert.match((await queueImport(server, path, hash)).error, /Кеш импорта Unreal Pak повреждён/)
    } finally { await server.close() }
  })


test('Pak cleanup requires every member to be recovered as a usable original file', async t => {
  const root = await testDirectory(t)
  const source = join(root, 'Native.pak')
  const eligible = { format: 'wav', status: 'extracted', artifact: { path: 'Audio/id/Tone.wav', status: 'extracted' } }
  const candidates = rows => Array.fromAsync(cleanupCandidates('unreal-pak', source,
    { source: { size: 64, sha256: 'a'.repeat(64) } }, rows, false, new AbortController().signal))
  assert.equal((await candidates([eligible])).length, 1)
  assert.deepEqual(await candidates([eligible, { format: 'wav', status: 'skipped' }]), [])
  assert.deepEqual(await candidates([eligible, { format: 'uasset', status: 'extracted',
    artifact: { path: 'Source/Fixture/Content/Tone.uasset', status: 'extracted' },
    exports: [{ format: 'json', path: 'Materials/id/Material.material.json', status: 'converted' }] }]), [])
})
