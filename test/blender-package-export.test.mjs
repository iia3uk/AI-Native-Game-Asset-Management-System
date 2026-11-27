import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { locateBatchBlender } from '../core/engines/blender/batch.mjs'
import { fixtureModel, ids, unityEntries, writeUnityFixture } from './fixtures/unitypackage.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const fixtureScript = fileURLToPath(new URL('./fixtures/blender-export.py', import.meta.url))
const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
const execute = promisify(execFile)
const nativeOptions = { skip: process.env.ASSET_VIEWER_TEST_NATIVE_BLENDER !== '1', timeout: 60_000 }

function checkRig(scene, animations, format) {
  const meshes = []
  scene.traverse(object => { if (object.isSkinnedMesh) meshes.push(object) })
  assert.equal(meshes.length, 1, format + ' skin')
  const [mesh] = meshes
  assert.equal(mesh.skeleton.bones.length, 1, format + ' skeleton')
  assert.equal(mesh.geometry.getAttribute('position').count, 3, format + ' geometry')
  assert.ok(mesh.geometry.getAttribute('skinWeight'), format + ' weights')
  assert.ok(mesh.geometry.getAttribute('uv') && mesh.geometry.getAttribute('uv1'), format + ' UV channels')
  assert.ok(mesh.geometry.morphAttributes.position?.length, format + ' shape key')
  assert.ok(animations.some(clip => clip.duration > 0 && clip.tracks.length > 0), format + ' animation')
}

test('native Blender round-trip retains the rig, animation, UV sets and shape key in exported FBX and GLB', nativeOptions, async t => {
  const directory = await testDirectory(t)
  const blender = await locateBatchBlender()
  assert.ok(blender, 'Set ASSET_VIEWER_BLENDER to a local Blender 4.5 or newer executable.')
  await execute(blender.executable, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
    '--python', fixtureScript, '--', directory], { windowsHide: true, timeout: 20_000 })
  const source = JSON.parse(await readFile(join(directory, 'rig.gltf'), 'utf8'))
  const binary = await readFile(join(directory, source.buffers[0].uri))
  source.buffers[0].uri = '../Buffers/rig.bin'
  const external = structuredClone(source)
  external.buffers[0].uri = join(directory, 'rig.bin').replaceAll('\\', '/')
  const path = await writeUnityFixture(join(directory, 'rig.unitypackage'), [
    ...unityEntries(ids.model, 'Assets/Models/rig.gltf', JSON.stringify(source)),
    ...unityEntries(ids.texture, 'Assets/Buffers/rig.bin', binary),
    ...unityEntries(ids.prefab, 'Assets/External/external.gltf', JSON.stringify(external)),
  ])
  const archive = await readFile(path)
  const { stdout } = await execute(process.execPath, [cli, 'package-import', path, '--export', 'fbx,glb', '--json'], {
    env: { ...process.env, ASSET_VIEWER_DATA_DIR: join(directory, 'data') }, timeout: 35_000, windowsHide: true,
  })
  const { job, scan } = JSON.parse(stdout)
  assert.equal(job.status, 'completed')
  assert.equal(scan.status, 'completed')
  assert.equal(job.result.report.converted, 1)
  const output = job.result.directory
  const { assets } = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
  const exports = assets.find(asset => asset.id === ids.model).exports.filter(item => item.method === 'blender')
  assert.equal(exports.length, 2)
  const artifact = async format => Uint8Array.from(await readFile(join(output, exports.find(item => item.format === format).path))).buffer
  const fbx = new FBXLoader().parse(await artifact('fbx'), '')
  const glb = await new GLTFLoader().parseAsync(await artifact('glb'), '')
  checkRig(fbx, fbx.animations, 'FBX')
  checkRig(glb.scene, glb.animations, 'GLB')
  const blocked = assets.find(asset => asset.id === ids.prefab).exports.filter(item => item.format !== 'meta')
  assert.deepEqual(blocked.map(item => item.issue), ['missing-model-dependency', 'missing-model-dependency'])
  assert.deepEqual(await readFile(path), archive)
})

test('cancelling a running Blender conversion removes its workspace and does not publish a library', nativeOptions, async t => {
  const directory = await testDirectory(t)
  const blender = await locateBatchBlender()
  assert.ok(blender)
  const path = await writeUnityFixture(join(directory, 'abort.unitypackage'),
    unityEntries(ids.model, 'Assets/model.obj', fixtureModel))
  const original = await readFile(path)
  const marker = join(directory, 'conversion-started')
  const script = join(directory, 'slow-test.py')
  await writeFile(script, `from pathlib import Path
from time import sleep
Path(${JSON.stringify(marker)}).touch()
sleep(30)
`)
  const server = await startServer(directory, { ASSET_VIEWER_BLENDER: blender.executable, ASSET_VIEWER_BLENDER_BATCH_SCRIPT: script })
  try {
    const enqueue = await server.post('/api/index/packages/import', {
      path, formats: ['fbx'], hash: createHash('sha256').update(original).digest('hex'),
    })
    assert.equal(enqueue.status, 202)
    const { job } = await enqueue.json()
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && !await stat(marker).catch(() => null)) await delay(50)
    assert.ok(await stat(marker), 'Blender did not reach the conversion script.')
    assert.equal((await server.post('/api/index/jobs/' + job.id + '/cancel', {})).status, 200)
    let state
    do {
      await delay(100)
      state = (await (await server.request('/api/index/jobs/' + job.id)).json()).job
    } while (state.status === 'running' && Date.now() < deadline + 5000)
    assert.equal(state.status, 'cancelled')
    assert.equal(state.result, null)
    assert.deepEqual(await readdir(join(directory, 'data', 'imports', 'unitypackage-v1-export-v1')), [])
    assert.deepEqual((await (await server.request('/api/index/libraries')).json()).libraries, [])
    assert.deepEqual(await readFile(path), original)
  } finally {
    await server.close()
  }
})
