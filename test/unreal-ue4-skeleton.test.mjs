import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { extractEditorSkeleton } from '../core/engines/unreal/skeleton/ue4.mjs'
import { planPackageCleanup } from '../core/packages/cleanup/plan.mjs'
import { makeModernPak } from './fixtures/unreal-pak.mjs'
import { unrealSkeletonFixture as fixture } from './fixtures/unreal-skeleton.mjs'
import { testDirectory } from './server-fixture.mjs'

const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
const run = promisify(execFile)
const queryWith = data => async (...args) => JSON.parse((await run(process.execPath, [cli, ...args, '--json'],
  { env: { ...process.env, ASSET_VIEWER_DATA_DIR: data }, windowsHide: true })).stdout)

test('stock UE4 skeletons keep their exact hierarchy and distinct mesh reference pose', () => {
  const { rig: skeleton } = extractEditorSkeleton(fixture(), 522)
  const { rig: mesh } = extractEditorSkeleton(fixture({ mesh: true }), 522)
  assert.equal(skeleton.objectClass, 'Skeleton')
  assert.equal(mesh.objectClass, 'SkeletalMesh')
  assert.equal(mesh.skeletonPackage, '/Game/Characters/Character_Skeleton')
  assert.deepEqual(skeleton.bones, [
    { name: 'Root', parent: -1, rotation: [0, 0, 0, 1], translation: [0, 0, 0], scale: [1, 1, 1] },
    { name: 'Spine', parent: 0, rotation: [0, 0, 0, 1], translation: [0, 0, 25], scale: [1, 1, 1] },
  ])
  assert.deepEqual(mesh.bones[0].scale, [0.5, 0.5, 0.5])
  assert.deepEqual(mesh.bones[1], skeleton.bones[1])
})

test('stock UE4 skeleton decoder rejects duplicate bones and invalid reverse bone map indices', () => {
  for (const options of [{ duplicate: true }, { invalidIndex: true }]) {
    assert.deepEqual(extractEditorSkeleton(fixture(options), 522), { issue: 'unreal-ue4-skeleton-layout' })
  }
  assert.equal(extractEditorSkeleton(fixture({ wrongClass: true }), 522), null)
})

test('loose UE4 import publishes editor and split cooked reference poses, preserves dependencies and reuses verified output', async t => {
  const root = await testDirectory(t)
  const source = join(root, 'Content')
  const character = join(source, 'Characters')
  const data = join(root, 'data')
  await mkdir(character, { recursive: true })
  const cooked = fixture({ cooked: true, mesh: true })
  const original = fixture()
  await Promise.all([
    writeFile(join(character, 'Character_Skeleton.uasset'), original),
    writeFile(join(character, 'SK_Editor.uasset'), fixture({ mesh: true })),
    writeFile(join(character, 'SK_Cooked.uasset'), cooked.uasset),
    writeFile(join(character, 'SK_Cooked.uexp'), cooked.uexp),
    writeFile(join(character, 'SK_MissingSidecar.uasset'), cooked.uasset),
  ])
  const query = queryWith(data)
  const { job, scan } = await query('package-import', source)
  assert.equal(scan.status, 'completed')
  const { directory, report } = job.result
  assert.deepEqual(report.unrealSkeletons, { converterVersion: 2, skeletons: 1, meshReferencePoses: 2, linked: 2, incomplete: 1 })
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json')))
  const byName = new Map(manifest.assets.map(asset => [asset.sourcePath, asset]))
  const skeleton = byName.get('Characters/Character_Skeleton.uasset')
  const cookedMesh = byName.get('Characters/SK_Cooked.uasset')
  const editorMesh = byName.get('Characters/SK_Editor.uasset')
  const readRig = asset => readFile(join(directory, asset.skeleton.path)).then(JSON.parse)
  assert.equal(skeleton.status, 'converted')
  assert.equal((await readRig(skeleton)).source.sha256, createHash('sha256').update(original).digest('hex'))
  for (const mesh of [editorMesh, cookedMesh]) {
    assert.equal(mesh.status, 'extracted')
    assert.deepEqual((await readRig(mesh)).bones[0].scale, [0.5, 0.5, 0.5])
  }
  assert.deepEqual((await readRig(cookedMesh)).source.companion, {
    path: 'Characters/SK_Cooked.uexp', sha256: createHash('sha256').update(cooked.uexp).digest('hex'),
  })
  assert.ok(byName.get('Characters/SK_MissingSidecar.uasset').issues.includes('unreal-ue4-skeleton-export-missing'))
  const dependencies = JSON.parse(await readFile(join(directory, 'dependencies.json'))).dependencies
  assert.deepEqual(dependencies.filter(item => item.type === 'unreal-skeletal-mesh-skeleton').map(item =>
    [item.source, item.target, item.status]), [[editorMesh.id, skeleton.id, 'resolved'], [cookedMesh.id, skeleton.id, 'resolved']])
  const selected = String(manifest.assets.indexOf(cookedMesh))
  const plan = await query('package-export', job.id, root, '--asset', selected)
  assert.deepEqual([plan.assets, plan.unresolved], [3, 0])
  const result = await query('package-export', job.id, root, '--asset', selected, '--plan-key', plan.key)
  assert.deepEqual(await readFile(join(result.directory, skeleton.skeleton.path)), await readFile(join(directory, skeleton.skeleton.path)))
  const cleanup = await planPackageCleanup({ imports: join(data, 'imports'), protectedRoots: [data], job, source,
    signal: AbortSignal.timeout(15_000) })
  assert.deepEqual(cleanup.files, [])
  const repeat = await query('package-import', source)
  assert.deepEqual([repeat.job.result.reused, repeat.job.result.directory], [true, directory])
})

test('compressed Unreal Pak verifies skeleton links, exports native companions, and rejects missing cache artifacts',
  { skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 55_000 }, async t => {
    const root = await testDirectory(t)
    const source = join(root, 'Characters.pak')
    const data = join(root, 'data')
    const standalone = fixture({ cooked: true, split: false })
    const skeletalMesh = fixture({ cooked: true, mesh: true })
    const files = [
      ['Character_Skeleton.uasset', standalone.uasset],
      ['SK_Character.uasset', skeletalMesh.uasset],
      ['SK_Character.uexp', skeletalMesh.uexp],
      ['SK_WithoutExport.uasset', skeletalMesh.uasset],
      ['SK_OtherClass.uasset', fixture({ cooked: true, mesh: true, split: false, wrongClass: true }).uasset],
      ['Wrong_Skeleton.uasset', fixture({ cooked: true, split: false, objectName: 'Renamed' }).uasset],
      ['SK_WrongSkeleton.uasset', fixture({ cooked: true, mesh: true, split: false, skeletonName: 'Wrong_Skeleton' }).uasset],
    ]
    const pak = makeModernPak(files.map(([name, content]) => ({ path: 'Characters/' + name, content, compressed: true })))
    await writeFile(source, pak)
    const query = queryWith(data)
    const { job, scan } = await query('package-import', source)
    assert.equal(scan.status, 'completed')
    const { directory, report } = job.result
    assert.deepEqual(report.unrealSkeletons, { converterVersion: 2, skeletons: 2, meshReferencePoses: 2, linked: 1, incomplete: 1 })
    const manifestPath = join(directory, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const row = name => manifest.entries.find(entry => entry.path.endsWith('/' + name))
    const mesh = row('SK_Character.uasset')
    const skeleton = row('Character_Skeleton.uasset')
    assert.equal(mesh.status, 'extracted')
    assert.equal(row('SK_OtherClass.uasset').skeleton, undefined)
    assert.ok(row('SK_WithoutExport.uasset').issues.includes('unreal-ue4-skeleton-export-missing'))
    const meshPath = join(directory, mesh.skeleton.path)
    const meshDescription = await readFile(meshPath)
    const { source: provenance, bones } = JSON.parse(meshDescription)
    assert.deepEqual(provenance, { id: mesh.id, path: mesh.path, sha256: createHash('sha256').update(skeletalMesh.uasset).digest('hex'),
      storage: 'cooked', companion: { path: row('SK_Character.uexp').path, sha256: createHash('sha256').update(skeletalMesh.uexp).digest('hex') } })
    assert.deepEqual(bones[0].scale, [0.5, 0.5, 0.5])
    const links = JSON.parse(await readFile(join(directory, 'dependencies.json'), 'utf8')).entries
    assert.deepEqual(links, [
      { source: mesh.id, target: skeleton.id, path: '/Game/Characters/Character_Skeleton',
        type: 'unreal-skeletal-mesh-skeleton', status: 'resolved' },
      { source: row('SK_WrongSkeleton.uasset').id, target: row('Wrong_Skeleton.uasset').id, path: '/Game/Characters/Wrong_Skeleton',
        type: 'unreal-skeletal-mesh-skeleton', status: 'unavailable' },
    ])
    const selected = String(manifest.entries.indexOf(mesh))
    const plan = await query('package-export', job.id, root, '--asset', selected)
    assert.deepEqual([plan.assets, plan.unresolved], [3, 0])
    const result = await query('package-export', job.id, root, '--asset', selected, '--plan-key', plan.key)
    for (const relative of [mesh.artifact.path, mesh.skeleton.path, skeleton.artifact.path, skeleton.skeleton.path,
      row('SK_Character.uexp').artifact.path]) {
      assert.deepEqual(await readFile(join(result.directory, relative)), await readFile(join(directory, relative)))
    }
    assert.deepEqual(await readFile(source), pak)
    const repeat = await query('package-import', source)
    assert.deepEqual([repeat.job.result.reused, repeat.job.result.directory], [true, directory])
    const cacheError = error => error.code === 1 && /Кеш импорта Unreal Pak повреждён/.test(JSON.parse(error.stdout).job.error)
    await writeFile(meshPath, Buffer.concat([meshDescription, Buffer.from(' ')]))
    await assert.rejects(query('package-import', source), cacheError)
    await writeFile(meshPath, meshDescription)
    delete mesh.skeleton
    mesh.exports = []
    await writeFile(manifestPath, JSON.stringify(manifest))
    await assert.rejects(query('package-import', source), cacheError)
  })
