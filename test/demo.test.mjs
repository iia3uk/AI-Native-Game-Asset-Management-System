import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { generateFixtures } from '../scripts/generate-fixtures.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

test('procedural fixtures are reproducible and contain working geometry and animation', async t => {
  const directory = await testDirectory(t)
  const first = join(directory, 'first')
  const second = join(directory, 'second')
  assert.equal(await generateFixtures(first, { includeErrors: true }), 10)
  assert.equal(await generateFixtures(second), 6)
  const path = 'Architecture/woodland-cabin.glb'
  const cabin = await readFile(join(first, path))
  assert.deepEqual(cabin, await readFile(join(second, path)))
  assert.deepEqual(await readFile(join(first, 'Environment/granite-boulders.glb')),
    await readFile(join(first, 'Test cases/different-name.glb')))
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(cabin).buffer, '')
  assert.equal(gltf.animations[0].duration, 4)
  let meshes = 0
  gltf.scene.traverse(object => { if (object.isMesh) meshes++ })
  assert.ok(meshes > 10)
})

test('demo is opt-in and served in a separate folder session', { timeout: 15000 }, async t => {
  const directory = await testDirectory(t)
  const server = await startServer(directory)
  try {
    await assert.rejects(readFile(join(directory, 'data', 'cache', 'demo-v1', 'Props', 'pennant.obj')), { code: 'ENOENT' })
    const denied = await server.post('/api/demo', {}, { Origin: '' })
    assert.equal(denied.status, 403)
    const response = await server.post('/api/demo', {})
    assert.equal(response.status, 200)
    const demo = await response.json()
    assert.equal(demo.demo, true)
    assert.equal(demo.resources.length, 6)
    const file = demo.resources.find(file => file.name === 'woodland-cabin.glb')
    assert.equal((await (await server.request(file.preview)).text()).slice(0, 4), 'glTF')
    assert.equal((await (await server.request('/api/folder')).json()).startup, null)
  } finally {
    await server.close()
  }
})
