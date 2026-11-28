import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { ExportArtifacts } from '../core/conversion/artifacts.mjs'
import { actorXClips } from '../core/conversion/unreal/viewer/actorx/clips.mjs'
import { publishActorXAnimations } from '../core/conversion/unreal/viewer/actorx/publish.mjs'
import { cleanupCandidates } from '../core/packages/cleanup/candidates.mjs'
import { testDirectory } from './server-fixture.mjs'

function chunk(name, stride, count) {
  const bytes = Buffer.alloc(32 + stride * count)
  bytes.write(name)
  bytes.writeInt32LE(stride, 24)
  bytes.writeInt32LE(count, 28)
  return bytes
}

function walkClip() {
  const header = chunk('ANIMHEAD', 0, 0)
  header.writeInt32LE(20100422, 20)
  const names = chunk('BONENAMES', 120, 2)
  names.write('Root', 32)
  names.write('Foot', 32 + 120)
  names.writeFloatLE(1, 32 + 88)
  names.writeFloatLE(1, 32 + 120 + 88)
  names.writeFloatLE(40, 32 + 120 + 100)
  const info = chunk('ANIMINFO', 168, 1)
  info.write('Walk', 32)
  info.writeInt32LE(2, 32 + 128)
  info.writeFloatLE(30, 32 + 152)
  info.writeInt32LE(2, 32 + 164)
  const keys = chunk('ANIMKEYS', 32, 4)
  for (let index = 0; index < 4; index++) {
    const offset = 32 + 32 * index
    keys.writeFloatLE(10 * index, offset)
    keys.writeFloatLE(index % 2 ? -Math.SQRT1_2 : 0, offset + 16)
    keys.writeFloatLE(index % 2 ? -Math.SQRT1_2 : -1, offset + 24)
    keys.writeFloatLE(1, offset + 28)
  }
  return Buffer.concat([header, names, info, keys, chunk('SCALEKEYS', 16, 0)])
}

test('checked ActorX binding keeps the original skin, applies translation settings and refuses ambiguous matches', async t => {
  const root = await testDirectory(t)
  const output = join(root, 'output')
  await mkdir(join(output, 'Models', 'rig'), { recursive: true })
  const source = join(root, 'Content')
  await mkdir(source)
  const document = { asset: { generator: 'UE Viewer (umodel) build 1590', version: '2.0' },
    nodes: [{ mesh: 0, skin: 0, children: [1] },
      { name: 'Root', translation: [0, 0, 0], rotation: [0, 0, 0, 1], children: [2] },
      { name: 'Foot', translation: [0, .4, 0], rotation: [0, 0, 0, 1] }],
    skins: [{ skeleton: 1, joints: [1, 2], inverseBindMatrices: 0 }],
    buffers: [{ uri: 'Rig.bin', byteLength: 128 }], bufferViews: [{ buffer: 0, byteLength: 128 }],
    accessors: [{ bufferView: 0, type: 'MAT4', componentType: 5126, count: 2 }] }
  const artifact = { path: 'Models/rig/Rig.gltf', role: 'skeletal-model', lod: 0, metrics: { bones: 2, animations: 0 },
    converterVersion: '1590', issues: [] }
  await writeFile(join(output, artifact.path), JSON.stringify(document))
  const rig = { id: 'rig', sourcePath: 'Rig.uasset', exports: [artifact], issues: [] }
  const clip = { id: 'walk', sourcePath: 'Walk.uasset', output: 'Source/Content/Walk.uasset', exports: [], issues: [] }
  const store = new ExportArtifacts(output)
  const stage = async (file, target, bytes, details) => {
    const path = join(root, file)
    await writeFile(path, bytes)
    return store.save(target, { path, info: { size: Buffer.byteLength(bytes) } },
      { method: 'ue-viewer', status: 'converted', ...details })
  }
  const psa = walkClip()
  assert.equal(actorXClips(psa).clips.get('Walk').count, 2)
  assert.equal(actorXClips(psa.subarray(0, -1)), null)
  const configPath = 'Animations/walk/Walk.config'
  const settings = await stage('settings', configPath,
    '[AnimSet]\nbAnimRotationOnly=1\n[UseTranslationBoneNames]\nRoot\n[RemoveTracks]\nWalk.0=rot\n',
    { format: 'config', role: 'actorx-settings' })
  const animation = await stage('clip', 'Animations/walk/Walk.psa', psa, { format: 'psa', settingsPath: configPath })
  clip.exports.push(animation, settings)
  const entry = { asset: clip, artifact: animation, settings }
  const records = { dependencies: [] }
  const run = models => publishActorXAnimations({ models, animations: [entry], output, workspace: root, store, records })
  const model = { asset: rig, artifact }
  assert.deepEqual(await run([model, model]), { models: 0, clips: 0, unbound: 1 })
  assert.ok(clip.issues.includes('unreal-actorx-ambiguous-skeleton'))
  assert.deepEqual(await run([model]), { models: 1, clips: 1, unbound: 0 })
  assert.equal(records.dependencies[0].target, rig.id)
  const { animations, skins, buffers, bufferViews, accessors } = JSON.parse(await readFile(join(output,
    'Models/rig/Rig-animated.gltf'), 'utf8'))
  assert.deepEqual(skins, document.skins)
  assert.deepEqual(buffers[0], document.buffers[0])
  assert.deepEqual(animations[0].channels.map(({ target }) => target), [
    { node: 1, path: 'translation' }, { node: 2, path: 'rotation' },
  ])
  const data = await readFile(join(output, 'Models/rig/Rig-animated.bin'))
  const view = index => data.subarray(bufferViews[accessors[index].bufferView].byteOffset)
  const [translation, rotation] = animations[0].samplers
  assert.ok(Math.abs(view(translation.input).readFloatLE(4) - 1 / 30) < 1e-7)
  assert.ok(Math.abs(view(translation.output).readFloatLE(12) - .2) < 1e-7)
  assert.ok(Math.abs(view(rotation.output).readFloatLE(8) - Math.SQRT1_2) < 1e-7)
  await writeFile(join(source, clip.sourcePath), 'fixture')
  const backups = () => Array.fromAsync(cleanupCandidates('unreal-content', source, {}, [clip], true,
    new AbortController().signal))
  assert.equal((await backups()).length, 1)
  clip.exports.pop()
  assert.equal((await backups()).length, 0)
})
