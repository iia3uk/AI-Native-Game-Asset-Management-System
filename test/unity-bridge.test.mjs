import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { locateUnityBridge } from '../core/engines/unity/bridge/run.mjs'
import { stageUnityInputs } from '../core/engines/unity/bridge/safe-inputs.mjs'
import { planPackageCleanup, trashPackageSources } from '../core/packages/cleanup/plan.mjs'
import { retireNativeCopies } from '../core/packages/cleanup/retired.mjs'
import { archiveBytes, ids, unityEntries } from './fixtures/unitypackage.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const unityHeader = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n'
const prefab = unityHeader + '--- !u!1 &1\nGameObject:\n  m_Name: Sample\n'

async function waitForJob(server, id, timeout = 180_000) {
  const deadline = Date.now() + timeout
  do {
    const { job } = await (await server.request('/api/index/jobs/' + id)).json()
    if (!['pending', 'running'].includes(job.status)) return job
    await delay(150)
  } while (Date.now() < deadline)
  assert.fail('Unity package job did not finish: ' + id)
}

test('Unity staging retains GUID references and excludes package scripts, custom serialization and importer settings', async t => {
  const root = await testDirectory(t)
  const output = join(root, 'output')
  const project = join(root, 'project')
  const source = [
    ['1', 'Assets/Plain.prefab', prefab],
    ['2', 'Assets/Custom.prefab', prefab + '--- !u!114 &2\nMonoBehaviour:\n  m_Script: {fileID: 11500000}\n'],
    ['3', 'Assets/Unknown.asset', Buffer.from([1, 2, 3, 0])],
    ['4', 'Assets/Editor/Startup.cs', 'custom script'],
    ['5', 'Packages/third-party/Foreign.prefab', prefab],
    ['6', 'Assets/Plain.asset', unityHeader + '--- !u!43 &4300000\nMesh:\n  m_Name: Triangle\n'],
  ]
  const entries = []
  for (const [number, sourcePath, data] of source) {
    const id = number.repeat(32)
    const name = sourcePath.split('/').pop()
    const directory = join(output, 'Source', id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, name), data)
    await writeFile(join(directory, name + '.meta'), 'fileFormatVersion: 2\nguid: bad\nScriptedImporter:\n  mainObjectFileID: 4300000\n  custom: input\n')
    entries.push({ id, sourcePath, output: 'Source/' + id + '/' + name, metadata: 'Source/' + id + '/' + name + '.meta' })
  }
  const { targets, rejected } = await stageUnityInputs(output, project, entries)
  const staged = join(project, 'Assets', 'BridgeInput')
  assert.deepEqual((await readdir(staged)).sort(), [entries[0].id, entries[5].id])
  assert.deepEqual(targets.map(target => target.kind), ['prefab', 'asset'])
  assert.deepEqual([...rejected.values()], ['unity-serialization-excluded', 'unity-serialization-excluded'])
  assert.equal(await readFile(join(staged, entries[0].id, 'Plain.prefab'), 'utf8'), prefab)
  assert.match(await readFile(join(staged, entries[0].id, 'Plain.prefab.meta'), 'utf8'),
    /^fileFormatVersion: 2\nguid: 11111111111111111111111111111111\nPrefabImporter:\n  externalObjects: \{\}\n  userData: \n  assetBundleName: \n  assetBundleVariant: \n$/)
  assert.match(await readFile(join(staged, entries[5].id, 'Plain.asset.meta'), 'utf8'),
    /\nNativeFormatImporter:\n  externalObjects: \{\}\n  mainObjectFileID: 4300000\n/)
  assert.deepEqual(await readdir(project), ['Assets'])

  const folderProject = join(root, 'folder-project')
  const folderInputs = await stageUnityInputs(output, folderProject, entries, undefined, true)
  assert.ok(folderInputs.targets.some(target => target.id === entries[4].id && target.path.endsWith('/Foreign.prefab')))
  assert.deepEqual(await readdir(folderProject), ['Assets'])
  assert.deepEqual((await readdir(join(folderProject, 'Assets', 'BridgeInput'))).sort(),
    [entries[0].id, entries[4].id, entries[5].id])
})

test('an unavailable Unity version preserves originals and reports the per-asset outcome', async t => {
  const root = await testDirectory(t)
  const path = join(root, 'NoEditor.unitypackage')
  const bytes = archiveBytes(unityEntries(ids.prefab, 'Assets/Plain.prefab', prefab))
  await writeFile(path, bytes)
  const server = await startServer(root)
  try {
    const fields = { path, hash: hash(bytes), formats: ['fbx'], editorVersion: '6000.999.1f1' }
    assert.equal((await server.post('/api/index/packages/import', fields)).status, 400)
    const response = await server.post('/api/index/packages/import', { ...fields, mode: 'engine-assisted' })
    assert.equal(response.status, 202)
    const queued = (await response.json()).job
    const job = await waitForJob(server, queued.id, 15_000)
    assert.equal(job.status, 'completed', job.error)
    assert.deepEqual(job.result.report.export.unity, { status: 'unavailable', issue: 'unity-version-unavailable' })
    const output = job.result.directory
    const { assets } = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
    assert.ok(assets[0].issues.includes('unity-version-unavailable'))
    assert.equal(await readFile(join(output, assets[0].output), 'utf8'), prefab)
    assert.deepEqual(await readFile(path), bytes)
  } finally {
    await server.close()
  }
})

async function createNativeFixture(root, editor) {
  const project = join(root, 'FixtureProject')
  for (const folder of ['Assets/Editor', 'Packages', 'ProjectSettings']) {
    await mkdir(join(project, folder), { recursive: true })
  }
  const script = fileURLToPath(new URL('./fixtures/unity-bridge-fixture.cs', import.meta.url))
  const log = join(root, 'fixture-editor.log')
  await Promise.all([
    copyFile(script, join(project, 'Assets', 'Editor', 'UnityBridgeFixture.cs')),
    writeFile(join(project, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: {} })),
    writeFile(join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: ' + editor.version + '\n'),
  ])
  try {
    await promisify(execFile)(editor.executable, ['-batchmode', '-nographics', '-quit', '-projectPath', project,
      '-executeMethod', 'UnityBridgeFixture.Create', '-logFile', log], { timeout: 120_000, killSignal: 'SIGKILL', windowsHide: true })
  } catch (error) {
    throw new Error((await readFile(log, 'utf8').catch(() => error.message)).slice(-6000), { cause: error })
  }
  return join(root, 'NativeBridge.unitypackage')
}

test('native Unity bridge exports separately editable prefab parts, a mesh, an animation, a PNG and material bindings', {
  skip: process.env.ASSET_VIEWER_TEST_NATIVE_UNITY !== '1', timeout: 240_000,
}, async t => {
  const requested = process.env.ASSET_VIEWER_TEST_UNITY_VERSION || '6000.3.10f1'
  const { editor, match } = await locateUnityBridge(requested)
  assert.equal(match, 'exact', 'The native test requires the requested Unity Editor version')
  const root = await testDirectory(t)
  const path = await createNativeFixture(root, editor)
  const original = await readFile(path)
  const server = await startServer(root)
  try {
    const response = await server.post('/api/index/packages/import', {
      path, hash: hash(original), formats: ['fbx'], mode: 'engine-assisted', editorVersion: requested,
    })
    assert.equal(response.status, 202)
    const queued = (await response.json()).job
    const job = await waitForJob(server, queued.id)
    assert.equal(job.status, 'completed', job.error)
    assert.equal(job.result.report.export.unity.status, 'completed', JSON.stringify(job.result.report.export.unity))
    assert.equal(job.result.report.export.unity.editorVersion, requested)
    assert.equal((await waitForJob(server, job.result.scanJobId, 15_000)).status, 'completed')

    const directory = job.result.directory
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    assert.equal(manifest.conversionEditorVersion, requested)
    const entry = name => manifest.assets.find(asset => asset.sourcePath === 'Assets/Fixture/' + name)
    const reader = file => readFile(join(directory, file.path))
    const fbx = async file => new FBXLoader().parse(Uint8Array.from(await reader(file)).buffer, '')
    const triangleCount = model => {
      let triangles = 0
      model.traverse(node => {
        if (node.isMesh) triangles += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3
      })
      return triangles
    }
    const products = entry('BridgeFixture.prefab').exports.filter(file => file.method === 'unity-editor')
    assert.deepEqual(products.map(file => [file.role, file.status]), [
      ['prefab', 'converted'], ['component', 'converted'], ['component', 'converted'],
    ])
    assert.equal(new Set(products.map(file => file.path)).size, 3)
    assert.deepEqual(products.slice(1).map(file => file.nodePath), ['LeftPart', 'RightPart'])
    assert.equal(products[1].unityGUID, entry('Triangle.asset').id)
    assert.equal(products[2].unityGUID, entry('Skin.asset').id)
    const model = await fbx(products[0])
    assert.equal(triangleCount(model), 2)
    assert.ok(model.getObjectByName('LeftPart'))
    const skinned = model.getObjectByName('RightPart')
    assert.equal(skinned?.isSkinnedMesh, true)
    assert.equal(skinned.skeleton.bones[0].name, 'RigBone')
    assert.equal(skinned.geometry.attributes.skinWeight.getX(0), 1)
    for (const component of products.slice(1)) assert.equal(triangleCount(await fbx(component)), 1)
    const skinComponent = await fbx(products.find(file => file.name === 'RightPart'))
    assert.equal(skinComponent.getObjectByName('RightPart')?.skeleton?.bones[0]?.name, 'RigBone')
    assert.equal(triangleCount(await fbx(entry('Triangle.asset').exports.find(file => file.role === 'mesh'))), 1)

    const texture = entry('Albedo.asset').exports.find(file => file.role === 'texture')
    assert.equal(texture?.status, 'converted', JSON.stringify(entry('Albedo.asset')))
    const png = await reader(texture)
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [4, 4])
    const materialEntry = entry('FixtureMaterial.mat')
    const bindingJson = JSON.parse(await reader(materialEntry.materialDescription))
    const albedo = bindingJson.textures.find(binding => binding.property === '_MainTex')
    assert.equal(bindingJson.shader.profile, 'standard')
    assert.equal(albedo?.status, 'object-resolved')
    assert.equal(albedo.target.converted.path, texture.path)
    assert.equal(albedo.reference.fileID, texture.unityFileID)
    const material = materialEntry.exports.find(file => file.role === 'material')
    const { textures } = JSON.parse(await reader(material))
    assert.ok(textures.some(binding => binding.property === '_MainTex' &&
      binding.guid === entry('Albedo.asset').id && binding.fileID === texture.unityFileID))

    const animation = entry('Lift.anim').exports.find(file => file.role === 'animation')
    assert.equal(animation?.status, 'converted', JSON.stringify(entry('Lift.anim')))
    const animated = await fbx(animation)
    assert.equal(animated.animations.length, 1)
    assert.ok(animated.animations[0].tracks.some(track => track.name.includes('LeftPart')))
    assert.deepEqual(await readFile(path), original)
    assert.equal((await readdir(join(directory, '..'))).some(name => name.startsWith('.stage-')), false)

    const project = join(root, 'FixtureProject')
    const packageName = 'com.test.native-assets'
    const embedded = join(project, 'Packages', packageName)
    await rename(join(project, 'Assets', 'Fixture'), embedded)
    await writeFile(join(embedded, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0' }))
    const originalPrefab = await readFile(join(embedded, 'BridgeFixture.prefab'))
    const inspection = await server.post('/api/index/packages/inspect', { path: project })
    assert.equal(inspection.status, 200)
    const { package: importedProject } = await inspection.json()
    assert.equal(importedProject.engineVersion, requested)
    const importRequest = await server.post('/api/index/packages/import', {
      path: project, hash: importedProject.hash, formats: ['fbx'], mode: 'auto',
    })
    assert.equal(importRequest.status, 202)
    const converted = await waitForJob(server, (await importRequest.json()).job.id)
    assert.equal(converted.status, 'completed', converted.error)
    assert.equal(converted.result.report.export.unity.status, 'completed', JSON.stringify(converted.result.report.export.unity))
    assert.equal(converted.result.report.export.unity.editorVersion, requested)
    const folderManifest = JSON.parse(await readFile(join(converted.result.directory, 'manifest.json'), 'utf8'))
    const fromUpm = folderManifest.assets.find(asset => asset.sourcePath === 'Packages/' + packageName + '/BridgeFixture.prefab')
    assert.equal(fromUpm.id, entry('BridgeFixture.prefab').id)
    const folderFbx = fromUpm.exports.find(file => file.role === 'prefab' && file.status === 'converted')
    const fileBytes = await readFile(join(converted.result.directory, folderFbx.path))
    assert.equal(triangleCount(new FBXLoader().parse(Uint8Array.from(fileBytes).buffer, '')), 2)
    assert.deepEqual(await readFile(join(embedded, 'BridgeFixture.prefab')), originalPrefab)

    const source = join(embedded, 'Triangle.asset')
    const recycled = join(root, 'recycled-triangle.asset')
    const triangleBytes = await readFile(source)
    const imports = join(root, 'data', 'imports')
    const signal = AbortSignal.timeout(20_000)
    const plan = await planPackageCleanup({ imports, protectedRoots: [join(root, 'data')], job: converted, source: project, signal })
    const triangle = plan.files.find(file => file.original.path === source)
    assert.ok(triangle?.nativeCopy)
    assert.equal((await trashPackageSources({ files: [triangle] }, path => rename(path, recycled), signal)).moved, 1)
    assert.equal((await retireNativeCopies(imports, [triangle], signal)).retired, 1)
    await assert.rejects(readFile(triangle.nativeCopy.file.path), { code: 'ENOENT' })
    const triangleExport = triangle.backups.find(file => file.path.endsWith('.fbx'))
    assert.equal(triangleCount(new FBXLoader().parse(Uint8Array.from(await readFile(triangleExport.path)).buffer, '')), 1)
    await rename(recycled, source)
    assert.deepEqual(await readFile(source), triangleBytes)
    const repeat = await server.post('/api/index/packages/import', {
      path: project, hash: importedProject.hash, formats: ['fbx'], mode: 'auto',
    })
    assert.equal(repeat.status, 202)
    const reused = await waitForJob(server, (await repeat.json()).job.id)
    assert.equal(reused.status, 'completed', reused.error)
    assert.equal(reused.result.reused, true)
  } finally {
    await server.close()
  }
})
