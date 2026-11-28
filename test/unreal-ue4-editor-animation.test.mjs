import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { encodeBoneTracks } from '../core/conversion/unreal/animation/gltf.mjs'
import { readEditorAnimation } from '../core/engines/unreal/animation/ue4-514.mjs'
import { extractEditorSkeleton } from '../core/engines/unreal/skeleton/ue4.mjs'
import { planPackageCleanup } from '../core/packages/cleanup/plan.mjs'
import { demoSkeletonGuid, editorAnimationFixture } from './fixtures/unreal-editor-animation.mjs'
import { editorSkeletalMeshFixture } from './fixtures/unreal-editor-skeletal-mesh.mjs'
import { unrealSkeletonFixture } from './fixtures/unreal-skeleton.mjs'
import { testDirectory } from './server-fixture.mjs'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
const skeleton = () => unrealSkeletonFixture({ guid: demoSkeletonGuid })

function glb(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF')
  const length = bytes.readUInt32LE(12)
  return { document: JSON.parse(bytes.subarray(20, 20 + length)), data: bytes.subarray(28 + length) }
}

function values({ document, data }, id) {
  const { bufferView } = document.accessors[id]
  const { buffer, byteOffset, byteLength } = document.bufferViews[bufferView]
  assert.equal(buffer, 0)
  return Array.from({ length: byteLength / 4 }, (_, i) => data.readFloatLE(byteOffset + i * 4))
}

test('the UE4 editor reader verifies the raw track layout and retains motion, rotation, scale and source time', () => {
  const { clip } = readEditorAnimation(editorAnimationFixture())
  assert.deepEqual(clip.mapping, [{ bone: 1, name: 'Spine' }, { bone: 0, name: 'Root' }])
  assert.equal(clip.skeletonGuid, demoSkeletonGuid)
  assert.equal(clip.frames, 3)
  assert.equal(clip.duration, 2)
  const { rig } = extractEditorSkeleton(skeleton(), 514)
  assert.equal(rig.skeletonGuid, demoSkeletonGuid)
  const { tracks } = encodeBoneTracks(clip, rig)
  assert.equal(tracks.length, 5)
  assert.equal(tracks.find(track => track.bone === 0 && track.path === 'rotation').values.readFloatLE(28),
    Math.fround(Math.SQRT1_2))
  for (const corrupt of ['mapping', 'stride', 'compressed']) {
    assert.equal(readEditorAnimation(editorAnimationFixture({ corrupt })).issue, 'unreal-editor-animation-layout')
  }
})

test('loose UE4 import publishes an independent clip and a skinned GLB with the same keys and exact dependencies', async t => {
  const root = await testDirectory(t)
  const source = join(root, 'Content')
  const character = join(source, 'Characters')
  const data = join(root, 'data')
  await mkdir(character, { recursive: true })
  await Promise.all([
    writeFile(join(character, 'SK_Test.uasset'), editorSkeletalMeshFixture()),
    writeFile(join(character, 'Character_Skeleton.uasset'), skeleton()),
    writeFile(join(character, 'Attack.uasset'), editorAnimationFixture()),
    writeFile(join(character, 'Wrong.uasset'), editorAnimationFixture({ clip: 'Wrong', skeletonGuid: '11'.repeat(16) })),
    writeFile(join(character, 'Missing.uasset'), editorAnimationFixture({ clip: 'Missing', skeleton: '/Game/Characters/Absent' })),
  ])
  const query = async (...args) => JSON.parse((await run(process.execPath, [cli, ...args, '--json'], { windowsHide: true,
    env: { ...process.env, ASSET_VIEWER_DATA_DIR: data, ASSET_VIEWER_UE_VIEWER: '' } })).stdout)
  const importPackage = () => query('package-import', source, '--export', 'glb')
  const { job, scan } = await importPackage()
  assert.equal(scan.status, 'completed')
  const { directory, report } = job.result
  assert.deepEqual(report.unrealEditorAnimations, { clips: 1, models: 1, bindings: 1, incomplete: 2 })
  const manifestPath = join(directory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath))
  const find = name => manifest.assets.find(asset => asset.sourcePath.endsWith('/' + name + '.uasset'))
  const mesh = find('SK_Test')
  const sourceClip = find('Attack')
  assert.ok(find('Wrong').issues.includes('unreal-editor-animation-skeleton-mismatch'))
  assert.ok(find('Missing').issues.includes('unreal-editor-animation-skeleton-missing'))
  const preview = mesh.exports.find(item => item.format === 'glb')
  const clip = sourceClip.exports.find(item => item.role === 'animation')
  assert.equal(preview.metrics.animations, 1)
  assert.equal(clip.name, 'Attack')
  for (const artifact of [preview, clip]) {
    const loaded = glb(await readFile(join(directory, artifact.path)))
    const [animation] = loaded.document.animations
    assert.equal(animation.name, 'Attack')
    const samples = (bone, path) => animation.samplers[
      animation.channels.find(channel => channel.target.path === path &&
        loaded.document.nodes[channel.target.node].name === bone).sampler]
    const rootMove = samples('Root', 'translation')
    assert.deepEqual(values(loaded, rootMove.input), [0, 1, 2])
    assert.deepEqual(values(loaded, rootMove.output).slice(3, 6), [0.25, 1, 0.5])
    assert.deepEqual(values(loaded, samples('Spine', 'scale').output).slice(3, 6), [2, 4, 3])
  }
  const { files } = await planPackageCleanup({ imports: join(data, 'imports'), protectedRoots: [data], job, source,
    signal: AbortSignal.timeout(15_000) })
  assert.deepEqual(files, [])
  const selected = String(manifest.assets.indexOf(mesh))
  const plan = await query('package-export', job.id, root, '--asset', selected)
  const exported = await query('package-export', job.id, root, '--asset', selected, '--plan-key', plan.key)
  for (const path of [preview.path, clip.path, find('Character_Skeleton').skeleton.path]) {
    assert.deepEqual(await readFile(join(exported.directory, path)), await readFile(join(directory, path)))
  }
  assert.equal((await importPackage()).job.result.reused, true)
  mesh.exports = mesh.exports.filter(item => item.role !== 'animation-buffer')
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(importPackage)
})
