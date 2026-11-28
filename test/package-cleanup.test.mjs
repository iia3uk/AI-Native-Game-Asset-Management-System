import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { planPackageCleanup, trashPackageSources } from '../core/packages/cleanup/plan.mjs'
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

test('cleanup confirmation preferences persist separately and reset', async t => {
  const root = await testDirectory(t)
  assert.deepEqual(await cleanupPreferences(root), { unity: false, unreal: false })
  await saveCleanupPreferences(root, { unity: true, unreal: false })
  assert.deepEqual(await cleanupPreferences(root), { unity: true, unreal: false })
  await saveCleanupPreferences(root, { unity: false, unreal: false })
  assert.deepEqual(await cleanupPreferences(root), { unity: false, unreal: false })
})
