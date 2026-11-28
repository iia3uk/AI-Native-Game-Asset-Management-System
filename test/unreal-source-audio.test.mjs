import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readSourceSoundCue } from '../core/engines/unreal/source-audio/cues.mjs'
import { planPackageCleanup } from '../core/packages/cleanup/plan.mjs'
import { soundCueFixture } from './fixtures/unreal-source-audio.mjs'
import { sourceWave, ue4SourceFixture } from './fixtures/unreal-source-media.mjs'
import { testDirectory } from './server-fixture.mjs'

test('UE4 SoundCue uses typed imports and bounded graph links with serialized playback settings', () => {
  const cue = readSourceSoundCue(soundCueFixture(), 522)
  assert.deepEqual([cue.root, cue.issues, cue.settings], [2, [], { Duration: 2.5, VolumeMultiplier: 0.75 }])
  assert.deepEqual(cue.nodes.map(({ id, children }) => [id, children]), [[2, [3, 4]], [3, []], [4, [3]]])
  assert.deepEqual(cue.nodes[0].settings, { Weights: [0.25, 0.75], bRandomizeWithoutReplacement: true })
  assert.deepEqual(cue.nodes[1].settings, { bLooping: true })
  assert.equal(cue.nodes[1].wave, '/Game/Fixture/Sounds/Step')
  assert.deepEqual(cue.nodes[2].settings, { DelayMin: 0.25, DelayMax: 0.5 })
  assert.deepEqual(readSourceSoundCue(soundCueFixture({ cycle: true }), 522), { issue: 'unreal-sound-cue-layout' })
  assert.deepEqual(readSourceSoundCue(soundCueFixture({ unknown: true, external: true }), 522).issues,
    ['unreal-sound-cue-unsupported-node', 'unreal-sound-cue-external-settings'])
  for (const options of [{ reference: '/Game/Fixture/Unlisted/Step' }, { wave: '/Game/../Step' }, { conflicting: true }]) {
    const linked = readSourceSoundCue(soundCueFixture(options), 522)
    assert.equal(linked.nodes[1].wave, null)
    assert.deepEqual(linked.issues, ['unreal-sound-cue-wave-reference'])
  }
  assert.equal(readSourceSoundCue(soundCueFixture(), 518), null)
  assert.equal(readSourceSoundCue(soundCueFixture(), 523), null)
})

test('SoundCue import links exact WAV assets, exports the graph with its WAV and diagnoses unavailable waves', async t => {
  const root = await testDirectory(t)
  const source = join(root, 'Content')
  const sounds = join(source, 'Fixture', 'Sounds')
  const data = join(root, 'data')
  await mkdir(sounds, { recursive: true })
  const cueBytes = soundCueFixture()
  const waveBytes = sourceWave()
  await Promise.all([
    writeFile(join(sounds, 'Step.uasset'), ue4SourceFixture('SoundWave', waveBytes)),
    writeFile(join(sounds, 'StepCue.uasset'), cueBytes),
    writeFile(join(sounds, 'MissingCue.uasset'), soundCueFixture({ wave: '/Game/Fixture/Sounds/Missing' })),
    writeFile(join(sounds, 'RivalCue.uasset'), soundCueFixture({ wave: '/Game/Fixture/Sounds/Rival' })),
    writeFile(join(sounds, 'Rival.uasset'), ue4SourceFixture('SoundWave', Buffer.alloc(12))),
  ])
  const execute = promisify(execFile)
  const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
  const query = async (...args) => JSON.parse((await execute(process.execPath, [cli, ...args, '--json'],
    { env: { ...process.env, ASSET_VIEWER_DATA_DIR: data }, windowsHide: true })).stdout)
  const { job, scan } = await query('package-import', source)
  assert.equal(scan.status, 'completed')
  assert.deepEqual(job.result.report.soundCues, { converterVersion: 1, graphs: 3, ready: 1, linkedWaves: 1, incomplete: 2 })
  const directory = job.result.directory
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json')))
  const ordinal = manifest.assets.findIndex(asset => asset.sourcePath.endsWith('/StepCue.uasset'))
  const cue = manifest.assets[ordinal]
  const { path, status } = cue.soundCue
  assert.equal(status, 'ready')
  const description = JSON.parse(await readFile(join(directory, path)))
  assert.equal(description.source.sha256, createHash('sha256').update(cueBytes).digest('hex'))
  const [wave] = description.waves
  assert.equal(wave.package, '/Game/Fixture/Sounds/Step')
  assert.equal(wave.status, 'resolved')
  const media = result => resolve(dirname(join(result, path)), wave.wav.uri)
  assert.deepEqual(await readFile(media(directory)), waveBytes)
  assert.equal(wave.wav.sha256, createHash('sha256').update(waveBytes).digest('hex'))

  const missing = manifest.assets.find(asset => asset.sourcePath.endsWith('/MissingCue.uasset'))
  assert.deepEqual([missing.status, missing.soundCue.status, missing.issues],
    ['extracted', 'partial', ['unreal-sound-cue-wave-missing']])
  const unavailable = manifest.assets.find(asset => asset.sourcePath.endsWith('/RivalCue.uasset'))
  assert.deepEqual([unavailable.status, unavailable.soundCue.status, unavailable.issues],
    ['extracted', 'partial', ['unreal-sound-cue-wave-unavailable']])
  const plan = await query('package-export', job.id, root, '--asset', String(ordinal))
  assert.deepEqual([plan.assets, plan.unresolved], [2, 0])
  const selected = await query('package-export', job.id, root, '--asset', String(ordinal), '--plan-key', plan.key)
  assert.deepEqual(await readFile(media(selected.directory)), waveBytes)
  assert.deepEqual(await readFile(join(selected.directory, path)), await readFile(join(directory, path)))
  const selection = JSON.parse(await readFile(join(selected.directory, 'dependencies.json')))
  assert.equal(selection.entries[0].type, 'unreal-sound-cue-wave')
  assert.equal(selection.entries[0].target, wave.target)

  const imports = join(data, 'imports')
  const cleanup = await planPackageCleanup({ imports, protectedRoots: [data], job, source, signal: AbortSignal.timeout(15_000) })
  assert.deepEqual(cleanup.files.map(file => file.original.path), [join(sounds, 'Step.uasset')])
  assert.deepEqual(await readFile(join(sounds, 'StepCue.uasset')), cueBytes)
  const repeat = await query('package-import', source)
  assert.deepEqual([repeat.job.result.reused, repeat.job.result.directory], [true, directory])
})
