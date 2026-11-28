import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

async function waitForVersion(server, index) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const response = await server.request('/api/index/jobs?type=package-import')
    assert.equal(response.status, 200)
    const { jobs } = await response.json()
    const watched = jobs.filter(job => job.trigger === 'watch')
    assert.ok(watched.every(job => job.packageName === 'resources.assets'))
    if (watched.length === index) {
      const job = watched[0]
      if (!['pending', 'running'].includes(job.status)) {
        assert.equal(job.status, 'completed', job.error)
        const scan = await server.request('/api/index/jobs/' + job.result.scanJobId)
        if ((await scan.json()).job?.status === 'completed') return job
      }
    }
    await delay(100)
  }
  assert.fail('The watched Unity Player version did not reach the index.')
}

async function manifestOf(job) {
  return JSON.parse(await readFile(join(job.result.directory, 'manifest.json'), 'utf8'))
}

export async function verifyPlayerWatch(root, files, plan, server) {
  const incoming = join(root, 'incoming-player')
  const child = join(incoming, 'watch-drop')
  await mkdir(child, { recursive: true })
  const primary = join(child, 'resources.assets')
  const texture = join(child, 'resources.assets.resS')
  const audio = join(child, 'resources.resource')
  await copyFile(files.primary, primary)
  await copyFile(files.texture, texture)
  await writeFile(join(child, 'scene.asset'), '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n')
  const response = await server.post('/api/index/libraries', { path: incoming })
  assert.equal(response.status, 201)
  const { library } = await response.json()
  const enabled = await server.post('/api/index/libraries/' + library.id + '/package-watch',
    { enabled: true, format: 'unity-serialized' })
  assert.equal(enabled.status, 200)
  const first = await waitForVersion(server, 1)
  const partial = await manifestOf(first)
  assert.deepEqual(partial.source.resources.map(resource => resource.role), ['texture'])
  assert.ok(partial.assets.some(asset => asset.issue === 'unity-bundle-audio-stream-missing'))

  await copyFile(files.audio, audio)
  const second = await waitForVersion(server, 2)
  assert.equal(second.sourceKey, plan.hash)
  assert.equal(second.result.report.converted, 10)
  assert.deepEqual((await manifestOf(second)).source.resources, plan.resources)

  const clip = join(root, 'PlayerProject', 'Assets', 'Resources', 'StereoPcm.wav')
  const expected = await readFile(clip)
  const changed = await readFile(audio)
  const sample = changed.indexOf(expected.subarray(44))
  assert.ok(sample >= 0)
  changed[sample] ^= 1
  expected[44] ^= 1
  await writeFile(audio, changed)
  const third = await waitForVersion(server, 3)
  assert.notEqual(third.sourceKey, second.sourceKey)
  const updated = await manifestOf(third)
  const stereo = updated.assets.find(asset => asset.name === 'StereoPcm')
  assert.deepEqual(await readFile(join(third.result.directory, stereo.artifact.path)), expected)

  const bytes = await readFile(texture)
  bytes[bytes.length - 1] ^= 1
  await writeFile(texture, bytes)
  const fourth = await waitForVersion(server, 4)
  assert.notEqual(fourth.sourceKey, third.sourceKey)
  assert.equal(fourth.result.report.converted, 10)
  assert.deepEqual(await readFile(primary), await readFile(files.primary))
}
