import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { inflateSync } from 'node:zlib'
import { cookedMaterial } from '../fixtures/unreal-cooked-material.mjs'
import { cookedTexture } from '../fixtures/unreal-cooked-texture.mjs'
import { cookedStaticMesh } from '../fixtures/unreal-cooked-static-mesh.mjs'
import { makePak, wavTone } from '../fixtures/unreal-pak.mjs'
import { startServer, testDirectory } from '../server-fixture.mjs'

const run = promisify(execFile)
const packaged = resolve(process.env.ASSET_VIEWER_TEST_PACKAGED_DIR || 'release/win-unpacked')
const executable = join(packaged, 'Asset Viewer.exe')
const archive = join(packaged, 'resources', 'app.asar')

test('The packaged server automatically imports a stock Pak with its bundled worker', { timeout: 35_000 }, async t => {
  const directory = await testDirectory(t)
  const incoming = join(directory, 'Incoming Paks')
  await mkdir(incoming)
  const env = { ELECTRON_RUN_AS_NODE: '1', ASSET_VIEWER_CUE4PARSE: '', ASSET_VIEWER_DATA_DIR: join(directory, 'data') }
  const cli = async (...args) => JSON.parse((await run(executable, [join(archive, 'scripts', 'asset-viewer.mjs'), ...args, '--json'],
    { env: { ...process.env, ...env }, windowsHide: true, timeout: 10_000 })).stdout)
  const library = await cli('connect', incoming)
  const setting = await cli('watch-packages', library.id, 'on', '--format', 'unreal-pak')
  assert.deepEqual(setting.packageWatchFormats, ['unreal-pak'])
  const server = await startServer(directory, env, { executable, entry: join(archive, 'server.mjs') })

  try {
    const read = async route => {
      const response = await server.request('/api/index/' + route, { signal: AbortSignal.timeout(5000) })
      assert.equal(response.status, 200)
      return await response.json()
    }
    assert.deepEqual((await read('libraries')).libraries[0].packageWatchFormats, ['unreal-pak'])
    const audio = wavTone()
    const dxt = cookedTexture({ name: 'Packaged-Tint', format: 'PF_DXT1', width: 4, height: 4,
      pixels: Buffer.from('00f8e00700000000', 'hex'), external: true })
    const material = cookedMaterial({ name: 'Packaged-Paint', parent: ['/Engine/EngineMaterials/DefaultMaterial'],
      textures: [{ parameter: 'BaseColor', value: '/Game/Packaged-Tint' }] })
    const mesh = cookedStaticMesh({ name: 'Packaged-Model', external: true })
    const pak = makePak([{ path: 'Audio/Packaged-Tone.wav', content: audio }, ...dxt, ...material, ...mesh])
    const source = join(incoming, 'Incoming.pak')
    await writeFile(source, pak)
    const inspection = await cli('package-inspect', source)
    assert.equal(inspection.format, 'unreal-pak')
    const deadline = Date.now() + 15_000
    do {
      const { jobs: [job] } = await read('jobs?type=package-import')
      if (job) {
        assert.equal(job.trigger, 'watch')
        assert.equal(job.sourceKey, inspection.hash)
        assert.ok(['pending', 'running', 'completed'].includes(job.status), job.error || job.status)
      }
      if (job?.status === 'completed' && (await read('jobs/' + job.result.scanJobId)).job.status === 'completed') {
        assert.equal(job.result.report.packageFormat, 'unreal-pak')
        const { library: result } = job.result
        const { assets } = await read('search?library=' + result.id)
        const sound = assets.find(asset => asset.name === 'Packaged-Tone.wav')
        assert.deepEqual(await readFile(join(result.root, sound.path)), audio)
        assert.deepEqual(job.result.report.textures, { converted: 1, skipped: 0, failed: 0 })
        assert.deepEqual(job.result.report.materials, { converted: 1, skipped: 0, failed: 0 })
        assert.equal(job.result.report.meshes.gltf, 2)
        assert.equal(job.result.report.meshes.derivatives.glb, 2)
        assert.deepEqual(assets.filter(asset => asset.ext === 'glb').map(asset => asset.name).sort(),
          ['Packaged-Model.glb', 'Packaged-Model_Lod1.glb'])
        const texture = assets.find(asset => asset.name === 'Packaged-Tint.png')
        const png = await readFile(join(result.root, texture.path))
        assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [4, 4])
        const pixels = inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)))
        assert.deepEqual([...pixels.subarray(0, 5)], [0, 255, 0, 0, 255])
        const materialFile = assets.find(asset => asset.name === 'Packaged-Paint.material.json')
        const description = JSON.parse(await readFile(join(result.root, materialFile.path)))
        assert.equal(description.parent, '/Engine/EngineMaterials/DefaultMaterial')
        assert.equal(description.parentStatus, 'missing')
        assert.deepEqual(description.bindings.map(binding => [binding.role, binding.status, binding.path]),
          [['baseColor', 'resolved', texture.path]])
        const reused = await cli('unreal-extract', source, '--fbx')
        assert.equal(reused.reused, true)
        assert.deepEqual(reused.meshes.derivatives, job.result.report.meshes.derivatives)
        assert.deepEqual(await readFile(source), pak)
        return
      }
      await delay(125)
    } while (Date.now() < deadline)
    assert.fail('The packaged server did not index the watched Pak.')
  } finally {
    await server.close()
  }
})
