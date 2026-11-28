import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { inflateSync } from 'node:zlib'
import { locateUnrealDecoder } from '../core/engines/unreal/decoder/run.mjs'
import { generateFixtures } from '../scripts/generate-fixtures.mjs'
import { readFbxGeometry } from './fixtures/blender-model.mjs'
import { cookedTexture } from './fixtures/unreal-cooked-texture.mjs'
import { cookedStaticMesh } from './fixtures/unreal-cooked-static-mesh.mjs'
import { pakStaticMesh } from './fixtures/unreal-pak-static-mesh.mjs'
import { makeModernPak, makePak, wavTone } from './fixtures/unreal-pak.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))

async function waitForJob(server, id) {
  const deadline = Date.now() + 12_000
  do {
    const response = await server.request('/api/index/jobs/' + id)
    assert.equal(response.status, 200)
    const { job } = await response.json()
    if (!['pending', 'running'].includes(job.status)) return job
    await setTimeout(100)
  } while (Date.now() < deadline)
  assert.fail('Pak job did not reach a terminal state.')
}

async function queueImport(server, path, hash, options) {
  const response = await server.post('/api/index/packages/import', { path, hash, ...options })
  assert.equal(response.status, 202)
  const { job } = await response.json()
  return waitForJob(server, job.id)
}

test('universal inspection identifies and refuses encrypted Pak before looking for a decoder', async t => {
  const root = await testDirectory(t)
  const path = join(root, 'Encrypted.bin')
  await writeFile(path, makePak([{ path: 'Tone.wav', content: wavTone() }], { encryptedIndex: true }))
  const server = await startServer(root, { ASSET_VIEWER_CUE4PARSE: 'invalid-relative-override' })
  try {
    const response = await server.post('/api/index/packages/inspect', { path })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /Unreal Pak зашифрован/)
  } finally {
    await server.close()
  }
})

test('a Pak publishes decoded Texture2D PNGs with native provenance, selective export and verified reuse',
  { skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 45_000 }, async t => {
    const root = await testDirectory(t)
    const path = join(root, 'Textures.pak')
    const bgra = cookedTexture({ name: 'Tint', format: 'PF_B8G8R8A8', width: 2, height: 2,
      pixels: Buffer.from('11223344123456789123456712345678', 'hex'), split: false })
    const bc1 = cookedTexture({ name: 'External', format: 'PF_DXT1', width: 4, height: 4,
      pixels: Buffer.from('00f8e00700000000', 'hex'), external: true })
    const bc3 = cookedTexture({ name: 'Transparent', format: 'PF_DXT5', width: 4, height: 4,
      pixels: Buffer.from('7f0000000000000000f8e00700000000', 'hex') })
    const gray = cookedTexture({ name: 'Gray', format: 'PF_G8', width: 2, height: 1, pixels: Buffer.from([5, 40]) })
    const rgba = cookedTexture({ name: 'Rgba', format: 'PF_R8G8B8A8', width: 1, height: 1, pixels: Buffer.from([20, 40, 80, 160]) })
    const damaged = cookedTexture({ name: 'Broken', format: 'PF_B8G8R8A8', width: 2, height: 2, pixels: Buffer.alloc(1) })
    const impostor = cookedTexture({ name: 'Unknown', format: 'PF_G8', width: 2, height: 1, pixels: Buffer.alloc(2),
      rootClass: '/Script/Another' })
    const encrypted = cookedTexture({ name: 'Flagged', format: 'PF_DXT1', width: 4, height: 4,
      pixels: Buffer.from('00f8e00700000000', 'hex'), external: true })
    encrypted.at(-1).encrypted = true
    const source = makePak([...bgra, ...bc1, ...bc3, ...gray, ...rgba, ...damaged, ...impostor, ...encrypted])
    const hash = createHash('sha256').update(source).digest('hex')
    await writeFile(path, source)

    const server = await startServer(root)
    try {
      const imported = await queueImport(server, path, hash)
      assert.equal(imported.status, 'completed', imported.error)
      assert.equal((await waitForJob(server, imported.result.scanJobId)).status, 'completed')
      assert.deepEqual(imported.result.report.textures, { converted: 5, skipped: 2, failed: 0 })
      const route = '/api/index/jobs/' + imported.id
      const { assets: entries } = await (await server.request(route + '/manifest')).json()
      const row = name => entries.find(entry => entry.path.endsWith('/' + name + '.uasset'))
      assert.deepEqual(await readFile(join(imported.result.directory, row('Tint').artifact.path)), bgra[0].content)
      assert.equal(row('Unknown').exports, undefined)
      for (const name of ['Broken', 'Flagged']) {
        assert.equal(row(name).exports[0].issue, 'unreal-cooked-texture-mip')
        assert.equal(row(name).artifact.status, 'extracted')
      }
      assert.equal(entries.find(entry => entry.path.endsWith('Flagged.ubulk')).issue, 'unreal-pak-encrypted-entry')
      for (const [name, expected] of [['Tint', [0x33, 0x22, 0x11, 0x44, 0x56, 0x34, 0x12, 0x78]],
        ['External', [255, 0, 0, 255]], ['Transparent', [255, 0, 0, 127]], ['Gray', [5, 5, 5, 255, 40, 40, 40, 255]],
        ['Rgba', [20, 40, 80, 160]]]) {
        const [artifact] = row(name).exports
        assert.deepEqual([artifact.method, artifact.status, artifact.mip, artifact.from],
          ['cue4parse-cooked-texture', 'converted', 0, row(name).artifact.path])
        const png = await readFile(join(imported.result.directory, artifact.path))
        assert.equal(png.subarray(37, 41).toString(), artifact.srgb ? 'sRGB' : 'gAMA')
        const offset = 49 + png.readUInt32BE(33)
        assert.equal(png.toString('ascii', offset, offset + 4), 'IDAT')
        const pixels = inflateSync(png.subarray(offset + 4, offset + 4 + png.readUInt32BE(offset - 4)))
        assert.deepEqual([...pixels.subarray(0, 1 + expected.length)], [0, ...expected])
      }
      const { assets } = await (await server.request('/api/index/search?kind=image&library=' + imported.result.library.id)).json()
      assert.deepEqual(assets.map(asset => asset.name).sort(), ['External.png', 'Gray.png', 'Rgba.png', 'Tint.png', 'Transparent.png'])

      const destination = join(root, 'Exports')
      await mkdir(destination)
      const asset = entries.indexOf(row('External'))
      const plan = await (await server.post(route + '/export-plan', { destination, asset })).json()
      const publication = await server.post(route + '/export', { destination, asset, key: plan.key })
      assert.equal(publication.status, 201)
      const { directory } = await publication.json()
      const derivative = row('External').exports[0].path
      assert.deepEqual(await readFile(join(directory, derivative)), await readFile(join(imported.result.directory, derivative)))
      for (const file of bc1) assert.deepEqual(await readFile(join(directory, 'Source', 'Fixture', 'Content', file.path)), file.content)
      assert.deepEqual(await readFile(path), source)
      assert.equal((await queueImport(server, path, hash)).result.reused, true)

      const cachedImage = join(imported.result.directory, derivative)
      const edited = await readFile(cachedImage)
      edited[45] ^= 1
      await writeFile(cachedImage, edited)
      assert.match((await queueImport(server, path, hash)).error, /Кеш импорта Unreal Pak повреждён/)
    } finally { await server.close() }
  })

test('compressed Pak import publishes indexed cooked StaticMesh LODs and their exact material closure',
  { skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 60_000 }, async t => {
    const root = await testDirectory(t)
    const path = join(root, 'CookedModels.pak')
    const destination = join(root, 'delivery')
    const files = pakStaticMesh('SM_PakPanel', { body: {} })
    const truncated = cookedStaticMesh({ name: 'SM_MissingBulk', external: true, split: false, body: { badIndex: true } })
      .filter(file => !file.path.endsWith('.ubulk')).map(file => ({ ...file, path: 'Example/' + file.path }))
    const impostor = cookedStaticMesh({ name: 'SM_Impostor', rootClass: '/Script/Other' })
    const source = makeModernPak([...files, ...truncated, ...impostor].map(file => ({ ...file, compressed: true })))
    const hash = createHash('sha256').update(source).digest('hex')
    await writeFile(path, source)
    await mkdir(destination)
    const server = await startServer(root)
    try {
      const imported = await queueImport(server, path, hash)
      assert.equal(imported.status, 'completed', imported.error)
      const { directory, report, scanJobId, library } = imported.result
      assert.deepEqual(report.meshes, {
        meshes: 2, gltf: 3, texturedGltf: 3, missingLods: 1, skipped: 0, failed: 0, derivatives: { fbx: 0, glb: 3 },
        collision: { assets: 2, shapes: 7, glb: 2, incomplete: 1 },
      })
      assert.equal((await waitForJob(server, scanJobId)).status, 'completed')
      const route = '/api/index/jobs/' + imported.id
      const { assets: entries } = await (await server.request(route + '/manifest')).json()
      const panel = entries.find(entry => entry.path.endsWith('/SM_PakPanel.uasset'))
      const incomplete = entries.find(entry => entry.path.endsWith('/SM_MissingBulk.uasset'))
      assert.ok(incomplete.issues.includes('unreal-cooked-mesh-lods-incomplete'))
      assert.deepEqual(incomplete.exports.filter(item => item.format === 'glb' && item.role === 'model').map(item => item.lod), [0])
      assert.equal(incomplete.collisionIssue, 'unreal-cooked-collision-partial')
      assert.equal(entries.find(entry => entry.path.endsWith('/SM_Impostor.uasset')).exports, undefined)
      const models = panel.exports.filter(item => item.format === 'glb' && item.role === 'model')
      const collision = panel.exports.find(item => item.role === 'collision-shapes')
      const previewCollision = panel.exports.find(item => item.role === 'collision-preview')
      assert.equal(previewCollision.settingsPath, collision.path)
      const physics = JSON.parse(await readFile(join(directory, collision.path), 'utf8'))
      assert.equal(physics.shapes[3].indices.length, 15)
      assert.equal(physics.previewDegenerateTriangles, 1)
      assert.deepEqual(models.map(item => [item.lod, item.metrics.triangles, item.metrics.textures]), [[0, 2, 1], [1, 1, 1]])
      const pngProduct = entries.find(entry => entry.path.endsWith('/T_Panel.uasset')).exports[0]
      const pixels = await readFile(join(directory, pngProduct.path))
      for (const model of models) {
        const glb = await readFile(join(directory, model.path))
        const jsonSize = glb.readUInt32LE(12)
        const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonSize))
        const view = json.bufferViews[json.images[0].bufferView]
        const offset = 28 + jsonSize + view.byteOffset
        assert.deepEqual(glb.subarray(offset, offset + view.byteLength), pixels)
        assert.ok(json.meshes[0].primitives.every(primitive => Number.isInteger(primitive.attributes.TEXCOORD_1)))
      }
      const { assets: modelsIndexed } = await (await server.request('/api/index/search?kind=model&library=' + library.id)).json()
      assert.ok(models.every(product => modelsIndexed.some(item => item.path === product.path)))
      assert.ok(modelsIndexed.some(item => item.path === previewCollision.path))
      const asset = entries.indexOf(panel)
      const plan = await (await server.post(route + '/export-plan', { destination, asset })).json()
      assert.equal(plan.dependencyStatus, 'partial')
      assert.equal(plan.unresolved, 0)
      const publication = await server.post(route + '/export', { destination, asset, key: plan.key })
      assert.equal(publication.status, 201)
      const exported = (await publication.json()).directory
      const exportedManifest = JSON.parse(await readFile(join(exported, 'manifest.json'), 'utf8'))
      assert.deepEqual(exportedManifest.entries.map(entry => entry.path).sort(),
        files.map(file => 'Fixture/Content/' + file.path).sort())
      for (const file of files) {
        assert.deepEqual(await readFile(join(exported, 'Source', 'Fixture', 'Content', file.path)), file.content)
      }
      for (const artifact of [collision, previewCollision]) {
        assert.deepEqual(await readFile(join(exported, artifact.path)), await readFile(join(directory, artifact.path)))
      }
      const cached = await queueImport(server, path, hash)
      assert.equal(cached.status, 'completed', cached.error)
      assert.equal(cached.result.reused, true)
      if (process.env.ASSET_VIEWER_TEST_NATIVE_BLENDER === '1') {
        const fbx = await queueImport(server, path, hash, { formats: ['fbx'] })
        assert.equal(fbx.status, 'completed', fbx.error)
        assert.notEqual(fbx.result.directory, directory)
        assert.deepEqual(fbx.result.report.meshes.derivatives, { fbx: 3, glb: 3 })
        const manifest = JSON.parse(await readFile(join(fbx.result.directory, 'manifest.json'), 'utf8'))
        const derivatives = manifest.entries.find(entry => entry.path === panel.path).exports.filter(item => item.format === 'fbx')
        assert.deepEqual(derivatives.map(item => item.lod), [0, 1])
        assert.deepEqual(await readFbxGeometry(derivatives.map(item => join(fbx.result.directory, item.path))),
          [[2, 2, 1, 2], [1, 2, 1, 1]])
        const cachedFbx = await queueImport(server, path, hash, { formats: ['fbx', 'glb'] })
        assert.equal(cachedFbx.status, 'completed', cachedFbx.error)
        assert.equal(cachedFbx.result.reused, true)
      }
      const manifestPath = join(directory, 'manifest.json')
      const originalManifest = await readFile(manifestPath, 'utf8')
      const editedManifest = JSON.parse(originalManifest)
      const editedPanel = editedManifest.entries.find(entry => entry.path === panel.path)
      editedPanel.exports = editedPanel.exports.filter(item => item.path !== previewCollision.path)
      await writeFile(manifestPath, JSON.stringify(editedManifest))
      assert.match((await queueImport(server, path, hash)).error, /Кеш импорта Unreal Pak повреждён/)
      editedPanel.exports = panel.exports.filter(item => item.path !== models[0].path)
      await writeFile(manifestPath, JSON.stringify(editedManifest))
      assert.match((await queueImport(server, path, hash)).error, /Кеш импорта Unreal Pak повреждён/)
      await writeFile(manifestPath, originalManifest)
      const buffer = panel.exports.find(item => item.role === 'model-buffer')
      const bufferPath = join(directory, buffer.path)
      const binary = await readFile(bufferPath)
      const modified = Buffer.from(binary)
      modified[0] ^= 1
      await writeFile(bufferPath, modified)
      assert.match((await queueImport(server, path, hash)).error, /Кеш импорта Unreal Pak повреждён/)
      await writeFile(bufferPath, binary)
      await writeFile(join(directory, 'conversion-report.json'), JSON.stringify(report))
      assert.match((await queueImport(server, path, hash)).error, /Кеш импорта Unreal Pak повреждён/)
      assert.deepEqual(await readFile(path), source)
    } finally { await server.close() }
  })

test('universal Pak import verifies source, reuses validated output and exposes artifacts in the shared viewer',
  { skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 45_000 }, async t => {
    assert.ok(await locateUnrealDecoder(), 'Build the native Pak decoder first.')
    const root = await testDirectory(t)
    const fixtures = join(root, 'fixtures')
    const data = join(root, 'data')
    const path = join(root, 'Container.bin')
    const audio = wavTone()
    const env = { ...process.env, ASSET_VIEWER_DATA_DIR: data }
    const query = async (...args) => JSON.parse((await run(process.execPath, [cli, ...args, '--json'],
      { env, windowsHide: true })).stdout)

    await generateFixtures(fixtures)
    const model = await readFile(join(fixtures, 'Architecture', 'woodland-cabin.glb'))
    const source = makePak([
      { path: 'Models/Cabin.glb', content: model },
      { path: 'Audio/Tone.wav', content: audio },
      { path: 'Audio/Encrypted.wav', content: audio, encrypted: true },
    ])
    const hash = createHash('sha256').update(source).digest('hex')
    await writeFile(path, source)
    const dryRun = await query('package-import', path, '--dry-run', '--mode', 'auto')
    assert.deepEqual([dryRun.dryRun, dryRun.format, dryRun.hash, dryRun.mode], [true, 'unreal-pak', hash, 'engineless'])
    await assert.rejects(readdir(data), { code: 'ENOENT' })

    const server = await startServer(root)
    try {
      const inspection = await server.post('/api/index/packages/inspect', { path })
      assert.equal(inspection.status, 200)
      const { package: plan } = await inspection.json()
      assert.deepEqual([plan.format, plan.containerVersion, plan.hash, plan.total], ['unreal-pak', 4, hash, 3])
      assert.ok(plan.assets.some(entry => entry.issue === 'unreal-pak-encrypted-entry'))
      for (const options of [{ mode: 'engine-assisted' }, { formats: ['obj'] }]) {
        const unsupported = await server.post('/api/index/packages/import', { path, hash, ...options })
        assert.equal(unsupported.status, 400)
      }

      const imported = await queueImport(server, path, hash)
      assert.equal(imported.status, 'completed', imported.error)
      assert.equal(imported.result.reused, false)
      assert.deepEqual(imported.result.report.counts, { extracted: 2, skipped: 1 })
      assert.equal(imported.result.report.packageFormat, 'unreal-pak')
      assert.equal((await waitForJob(server, imported.result.scanJobId)).status, 'completed')

      const manifestRequest = await server.request('/api/index/jobs/' + imported.id + '/manifest')
      assert.equal(manifestRequest.status, 200)
      const manifest = await manifestRequest.json()
      assert.equal(manifest.total, 3)
      const exported = manifest.assets.find(entry => entry.format === 'glb')
      assert.deepEqual(await readFile(join(imported.result.directory, exported.artifact.path)), model)
      assert.equal(manifest.assets.find(entry => entry.path.endsWith('/Encrypted.wav')).status, 'skipped')
      const destination = join(root, 'exports')
      await mkdir(destination)
      const asset = manifest.assets.findIndex(entry => entry.path.endsWith('/Tone.wav'))
      const exportRoute = '/api/index/jobs/' + imported.id
      const preview = await server.post(exportRoute + '/export-plan', { destination, asset })
      assert.equal(preview.status, 200)
      const exportPlan = await preview.json()
      assert.equal(exportPlan.dependencyStatus, 'unavailable')
      const publication = await server.post(exportRoute + '/export', { destination, asset, key: exportPlan.key })
      assert.equal(publication.status, 201)
      const { directory } = await publication.json()
      assert.deepEqual(await readFile(join(directory, manifest.assets[asset].artifact.path)), audio)
      const deliverable = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
      assert.deepEqual(deliverable.entries, [manifest.assets[asset]])
      const { assets } = await (await server.request('/api/index/search?library=' + imported.result.library.id)).json()
      assert.deepEqual(assets.map(asset => asset.ext).sort(), ['glb', 'wav'])
      const opened = await server.post('/api/index/assets/' + assets.find(asset => asset.ext === 'glb').id + '/open', {})
      assert.equal(opened.status, 200)
      const { folder, fileId } = await opened.json()
      const resource = folder.resources.find(item => item.id === fileId)
      const served = await server.request(resource.url)
      assert.equal(served.status, 200)
      assert.deepEqual(Buffer.from(await served.arrayBuffer()), model)

      const alternate = join(root, 'Same.pak')
      await writeFile(alternate, source)
      const { job: queued } = await query('package-import', alternate, '--queue')
      const cached = await waitForJob(server, queued.id)
      assert.equal(cached.status, 'completed', cached.error)
      assert.equal(cached.result.reused, true)
      assert.equal(cached.result.directory, imported.result.directory)
      assert.equal(cached.result.library.id, imported.result.library.id)

      await writeFile(path, makePak([{ path: 'Other.wav', content: audio }]))
      const changed = await queueImport(server, path, hash)
      assert.equal(changed.status, 'failed')
      assert.match(changed.error, /изменился после анализа/)
      await writeFile(path, source)
      await writeFile(join(imported.result.directory, exported.artifact.path), 'tampered')
      const corrupt = await queueImport(server, path, hash)
      assert.equal(corrupt.status, 'failed')
      assert.match(corrupt.error, /Кеш импорта Unreal Pak повреждён/)
      assert.deepEqual(await readFile(path), source)

      const emptySource = makePak([{ path: 'Scripts/Sample.txt', content: Buffer.from('fixture') }])
      const empty = join(root, 'Unsupported.pak')
      await writeFile(empty, emptySource)
      const noArtifacts = await queueImport(server, empty, createHash('sha256').update(emptySource).digest('hex'))
      assert.equal(noArtifacts.status, 'completed', noArtifacts.error)
      assert.equal(noArtifacts.result.report.status, 'no-compatible-inputs')
      assert.equal(noArtifacts.result.library, null)
      assert.equal(noArtifacts.result.scanJobId, null)
      const diagnostic = await (await server.request('/api/index/jobs/' + noArtifacts.id + '/manifest')).json()
      assert.equal(diagnostic.assets[0].issue, 'unreal-pak-unsupported-entry')
    } finally {
      await server.close()
    }
  })
