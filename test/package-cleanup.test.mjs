import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { cleanupCandidates } from '../core/packages/cleanup/candidates.mjs'
import { planPackageCleanup, trashPackageSources } from '../core/packages/cleanup/plan.mjs'
import { retireNativeCopies } from '../core/packages/cleanup/retired.mjs'
import { unityBinaryReadyForCleanup } from '../core/packages/cleanup/unity-binary.mjs'
import { exportPackageResult } from '../core/packages/export/publish.mjs'
import { packageManifestPage } from '../core/packages/manifest-page.mjs'
import { cleanupPreferences, saveCleanupPreferences } from '../desktop/package-cleanup/preferences.mjs'
import { sourceWave, ue4SourceFixture } from './fixtures/unreal-source-media.mjs'
import { unityEntries, unityFixtureEntries, writeUnityFixture } from './fixtures/unitypackage.mjs'
import { testDirectory } from './server-fixture.mjs'

const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
const execute = promisify(execFile)
async function imported(root, source) {
  const data = join(root, 'data')
  const { stdout } = await execute(process.execPath, [cli, 'package-import', source, '--json'],
    { env: { ...process.env, ASSET_VIEWER_DATA_DIR: data }, windowsHide: true })
  const { job, scan } = JSON.parse(stdout)
  assert.equal(job.status, 'completed')
  assert.equal(scan.status, 'completed')
  const signal = AbortSignal.timeout(30_000)
  return { imports: join(data, 'imports'), protectedRoots: [data], job, source, signal }
}

test('Unreal cleanup requires a verified conversion and skips a replaced source or output', async t => {
  const root = await testDirectory(t)
  const pack = join(root, 'Unreal pack')
  await mkdir(pack)
  const converted = ue4SourceFixture('SoundWave', sourceWave())
  await writeFile(join(pack, 'Step.uasset'), converted)
  await writeFile(join(pack, 'Broken.uasset'), ue4SourceFixture('SoundWave', Buffer.alloc(12)))
  await writeFile(join(pack, 'Step.ubulk'), 'companion kept')
  const input = await imported(root, pack)
  const plan = await planPackageCleanup(input)
  assert.equal(plan.engine, 'unreal')
  assert.deepEqual(plan.files.map(file => basename(file.original.path)), ['Step.uasset'])
  assert.deepEqual((await planPackageCleanup({ ...input, protectedRoots: [pack] })).files, [])
  const pending = []
  const trash = path => { pending.push(path); return rename(path, join(root, 'recycled.uasset')) }
  const output = join(plan.output, 'Audio/Step.wav')
  await writeFile(output, 'broken output')
  assert.deepEqual(await trashPackageSources(plan, trash, input.signal), { moved: 0, skipped: 1, bytes: 0 })
  assert.deepEqual((await planPackageCleanup(input)).files, [])
  await writeFile(output, sourceWave())
  const verified = await planPackageCleanup(input)
  await writeFile(join(pack, 'Step.uasset'), 'replacement')
  assert.deepEqual(await trashPackageSources(verified, trash, input.signal), { moved: 0, skipped: 1, bytes: 0 })
  assert.deepEqual(pending, [])
  await writeFile(join(pack, 'Step.uasset'), converted)
  assert.deepEqual(await trashPackageSources(await planPackageCleanup(input), trash, input.signal),
    { moved: 1, skipped: 0, bytes: converted.length })
  assert.deepEqual(await readFile(join(root, 'recycled.uasset')), converted)
  assert.equal(await readFile(join(pack, 'Step.ubulk'), 'utf8'), 'companion kept')
  assert.deepEqual(await readFile(join(plan.output, 'Source/Content/Step.uasset')), converted)
  assert.deepEqual((await planPackageCleanup(input)).files, [])
})

test('Unity cleanup verifies archive identity and its published payloads', async t => {
  const root = await testDirectory(t)
  const archive = await writeUnityFixture(join(root, 'Unity Fixture.unitypackage'), unityFixtureEntries(
    unityEntries('7'.repeat(32), 'Assets/Mesh.obj', Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'))))
  const input = await imported(root, archive)
  const plan = await planPackageCleanup(input)
  assert.equal(plan.engine, 'unity')
  assert.equal(plan.files.length, 1)
  assert.equal(plan.files[0].original.path, archive)
  await writeFile(join(plan.output, 'Source/Assets/Mesh.obj'), 'corrupt payload')
  assert.deepEqual((await planPackageCleanup(input)).files, [])
  assert.ok((await readFile(archive)).length > 0)
})

test('Unity binary cleanup retains packages with undecoded objects or manifest dependencies', async () => {
  const sprite = { member: 'CAB-1', status: 'converted', classId: 213, pathId: '2',
    artifact: { status: 'converted', path: 'Textures/1/Sprite.png' }, sprite: { packed: { atlasPathId: '3' } } }
  const atlas = { member: 'CAB-1', status: 'unsupported', classId: 687078895, pathId: '3',
    issue: 'unity-bundle-sprite-atlas-container' }
  const bundle = { member: 'CAB-1', status: 'unsupported', classId: 142, pathId: '1',
    issue: 'unity-bundle-class-unsupported' }
  assert.equal(unityBinaryReadyForCleanup([sprite, atlas, bundle]), true)
  assert.equal(unityBinaryReadyForCleanup([atlas, bundle]), false)
  assert.equal(unityBinaryReadyForCleanup([sprite, { ...atlas, member: 'CAB-2' }, bundle]), false)
  assert.equal(unityBinaryReadyForCleanup([sprite, atlas, bundle, { status: 'unsupported', classId: 114 }]), false)
  assert.equal(unityBinaryReadyForCleanup([sprite, atlas, bundle, { status: 'converted', artifact: null }]), false)
  assert.equal(unityBinaryReadyForCleanup([sprite, atlas, bundle, { ...sprite, classId: 21 }]), false)
  const source = { size: 128, sha256: '1'.repeat(64) }
  const candidates = resources => Array.fromAsync(cleanupCandidates('unityfs', 'original.bundle',
    { source: { ...source, resources } }, [sprite, atlas, bundle]))
  assert.equal((await candidates([])).length, 1)
  assert.deepEqual(await candidates([{ name: 'library.bundle', role: 'bundle' }]), [])
})

test('compaction retains usable files and provenance, and leaves changed or unsupported data alone', async t => {
  const root = await testDirectory(t)
  const pack = join(root, 'Unreal compact')
  const destination = join(root, 'Exports')
  await Promise.all([mkdir(pack), mkdir(destination)])
  const source = join(pack, 'Step.uasset')
  const original = ue4SourceFixture('SoundWave', sourceWave())
  const unsupported = ue4SourceFixture('SoundWave', Buffer.alloc(12))
  await Promise.all([writeFile(source, original), writeFile(join(pack, 'Broken.uasset'), unsupported)])
  const input = await imported(root, pack)
  const recycled = join(root, 'recycled.uasset')
  const plan = await planPackageCleanup(input)
  const managed = join(plan.output, 'Source', 'Content', 'Step.uasset')
  const wave = join(plan.output, 'Audio', 'Step.wav')
  assert.equal(plan.files.length, 1)
  assert.equal((await trashPackageSources(plan, path => rename(path, recycled), input.signal)).moved, 1)

  await writeFile(wave, 'changed')
  assert.equal((await retireNativeCopies(input.imports, plan.files, input.signal)).skippedRetirement, 1)
  assert.deepEqual(await readFile(managed), original)
  const stillPresent = await packageManifestPage(input.imports, input.job, 0, 10)
  assert.ok(stillPresent.assets.find(asset => asset.sourcePath.endsWith('Step.uasset')).output)

  await writeFile(wave, sourceWave())
  await rename(recycled, source)
  const verified = await planPackageCleanup(input)
  assert.equal((await trashPackageSources(verified, path => rename(path, recycled), input.signal)).moved, 1)
  assert.deepEqual(await retireNativeCopies(input.imports, verified.files, input.signal),
    { retired: 1, retiredBytes: original.length, skippedRetirement: 0 })
  await assert.rejects(readFile(managed), { code: 'ENOENT' })
  assert.deepEqual(await readFile(recycled), original)
  assert.deepEqual(await readFile(join(plan.output, 'Source', 'Content', 'Broken.uasset')), unsupported)
  assert.deepEqual(await readFile(wave), sourceWave())
  const page = await packageManifestPage(input.imports, input.job, 0, 10)
  const row = page.assets.find(asset => asset.sourcePath.endsWith('Step.uasset'))
  assert.equal(row.output, null)
  assert.equal(row.sourceRetired, true)
  assert.match(row.hash, /^[0-9a-f]{64}$/)

  const { imports, protectedRoots, job, signal } = input
  const preview = await exportPackageResult(imports, protectedRoots, job, { destination }, { preview: true, signal })
  const published = await exportPackageResult(imports, protectedRoots, job, { destination, key: preview.key }, { signal })
  assert.deepEqual(await readFile(join(published.directory, 'Audio', 'Step.wav')), sourceWave())
  await assert.rejects(readFile(join(published.directory, 'Source', 'Content', 'Step.uasset')), { code: 'ENOENT' })
  await rename(recycled, source)
  const repeat = await imported(root, pack)
  assert.equal(repeat.job.result.reused, true)
  assert.equal(repeat.job.result.directory, input.job.result.directory)
})

test('cleanup confirmation preferences persist separately and reset', async t => {
  const root = await testDirectory(t)
  assert.deepEqual(await cleanupPreferences(root), { unity: false, unreal: false })
  await saveCleanupPreferences(root, { unity: true, unreal: false })
  assert.deepEqual(await cleanupPreferences(root), { unity: true, unreal: false })
  await saveCleanupPreferences(root, { unity: false, unreal: false })
  assert.deepEqual(await cleanupPreferences(root), { unity: false, unreal: false })
})
