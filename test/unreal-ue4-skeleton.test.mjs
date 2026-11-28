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
import { cookedPackageFixture } from './fixtures/unreal-cooked-package.mjs'
import { editorFixture } from './fixtures/unreal-editor-package.mjs'
import { testDirectory } from './server-fixture.mjs'

function fixture({ mesh = false, duplicate = false, invalidIndex = false, wrongClass = false, cooked = false } = {}) {
  const makePackage = cooked ? cookedPackageFixture : editorFixture
  return makePackage(({ i32, name, none, object }) => {
    const bones = [name('Root'), name(duplicate ? 'root' : 'Spine')]
    const bone = (name, parent) => Buffer.concat([name, i32(parent), ...(cooked ? [] : [i32(0)])])
    const pose = (z, scale) => {
      const transform = Buffer.alloc(40)
      const values = [0, 0, 0, 1, 0, 0, z, scale, scale, scale]
      values.forEach((value, index) => transform.writeFloatLE(value, index * 4))
      return transform
    }
    const rig = Buffer.concat([i32(2), bone(bones[0], -1), bone(bones[1], 0), i32(2),
      pose(0, mesh ? 0.5 : 1), pose(25, 1), i32(2),
      bones[1], i32(invalidIndex ? 0 : 1), bones[0], i32(0)])
    const imports = [
      ['Package', wrongClass ? '/Game/Other' : '/Script/Engine'],
      ['Class', mesh ? 'SkeletalMesh' : 'Skeleton', -1],
      ['Package', '/Game/Characters/Character_Skeleton'],
      ['Skeleton', 'Character_Skeleton', -3],
    ]
    const meshHeader = Buffer.alloc(34)
    if (cooked) meshHeader[0] = 1
    const data = Buffer.concat([...(mesh ? [object('Skeleton', -4)] : []), none, i32(0), ...(mesh ? [meshHeader] : []), rig])
    return { imports, objects: [[-2, mesh ? 'SK_Character' : 'Character_Skeleton', 0, data]] }
  })
}

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
  const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
  const run = promisify(execFile)
  const query = async (...args) => JSON.parse((await run(process.execPath, [cli, ...args, '--json'],
    { env: { ...process.env, ASSET_VIEWER_DATA_DIR: data }, windowsHide: true })).stdout)
  const { job, scan } = await query('package-import', source)
  assert.equal(scan.status, 'completed')
  const { directory, report } = job.result
  assert.deepEqual(report.unrealSkeletons, { converterVersion: 1, skeletons: 1, meshReferencePoses: 2, linked: 2, incomplete: 1 })
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
