import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { looseMeshResult } from '../core/engines/unreal/decoder/mesh-protocol.mjs'
import { locateBatchBlender } from '../core/engines/blender/batch.mjs'
import { cookedMaterial } from './fixtures/unreal-cooked-material.mjs'
import { cookedStaticMesh } from './fixtures/unreal-cooked-static-mesh.mjs'
import { cookedTexture } from './fixtures/unreal-cooked-texture.mjs'
import { startServer, testDirectory } from './server-fixture.mjs'

const jobs = '/api/index/jobs/'
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'))

async function post(server, route, data, status = 200) {
  const response = await server.post(route, data)
  const result = await response.json()
  assert.equal(response.status, status, JSON.stringify(result))
  return result
}

async function waitJob(server, id) {
  const deadline = Date.now() + 35_000
  while (Date.now() < deadline) {
    const { job } = await (await server.request(jobs + id)).json()
    if (!['pending', 'running'].includes(job.status)) return job
    await setTimeout(85)
  }
  assert.fail('Cooked mesh job did not finish')
}

function glb(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF')
  assert.equal(bytes.readUInt32LE(8), bytes.length)
  const jsonLength = bytes.readUInt32LE(12)
  return { json: JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength)), bin: bytes.subarray(28 + jsonLength) }
}

function accessor(document, bin, index, reader, stride) {
  const field = document.accessors[index]
  const start = document.bufferViews[field.bufferView].byteOffset
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[field.type]
  return Array.from({ length: field.count * components }, (_, i) => bin[reader](start + i * stride))
}

async function readFbxGeometry(paths) {
  const blender = await locateBatchBlender()
  assert.ok(blender)
  const script = `
import bpy, json, sys
rows = []
for path in sys.argv[sys.argv.index('--') + 1:]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path)
    meshes = [obj.data for obj in bpy.context.scene.objects if obj.type == 'MESH']
    for mesh in meshes:
        mesh.calc_loop_triangles()
    rows.append([sum(len(mesh.loop_triangles) for mesh in meshes), max(len(mesh.uv_layers) for mesh in meshes),
                 max(len(mesh.color_attributes) for mesh in meshes), sum(len(mesh.materials) for mesh in meshes)])
print('COOKED_FBX ' + json.dumps(rows))
`
  const { stdout } = await promisify(execFile)(blender.executable, ['--background', '--factory-startup', '--disable-autoexec',
    '--python-exit-code', '1', '--python-expr', script, '--', ...paths], { timeout: 20_000, windowsHide: true })
  return JSON.parse(stdout.match(/^COOKED_FBX (.*)$/m)[1])
}

test('cooked mesh worker metadata can only address bounded numbered geometry and disjoint sections', () => {
  const section = { slot: 0, firstIndex: 0, triangles: 1, name: null, material: '/Game/Panel', collision: true }
  const lod = { lod: 0, vertices: 3, uvs: 1, colors: false, indices: 3, size: 156, tangentsQuantized: false,
    file: '../outside', sections: [section] }
  const report = { protocol: 1, status: 'completed', meshDecoder: 1,
    entries: [{ index: 0, issue: null, mesh: { lods: [lod], missing: [] } }] }
  assert.equal(looseMeshResult(report, 1).entries[0].lods[0].file, '00000-0.mesh')
  assert.equal(looseMeshResult(report, 2), null)
  for (const changed of [{ size: 96 * 1024 ** 2 }, { sections: [section, section] }, { lod: 2 },
    { sections: [{ ...section, material: '/Game/../Escape' }] }]) {
    report.entries[0].mesh.lods[0] = { ...lod, ...changed }
    assert.equal(looseMeshResult(report, 1), null)
  }
})

test('versioned cooked StaticMesh import preserves two LODs and publishes a textured preview and verified export',
  { skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 65_000 }, async t => {
    const root = await testDirectory(t)
    const content = join(root, 'Content')
    const example = join(content, 'Example')
    const destination = join(root, 'Export')
    await mkdir(example, { recursive: true })
    await mkdir(destination)
    const texturePath = '/Game/Example/T_Paint'
    const fixtures = [
      ...cookedStaticMesh({ name: 'SM_Panel', external: true }),
      ...cookedStaticMesh({ name: 'SM_Damaged', invalidIndex: true, split: false }),
      ...cookedStaticMesh({ name: 'SM_Unrelated', rootClass: '/Script/Other' }),
      ...cookedMaterial({ name: 'M_Base', split: false }),
      ...cookedMaterial({ name: 'MI_Panel', parent: ['/Game/Example/M_Base'],
        textures: [{ parameter: 'BaseColor', value: texturePath }], streaming: [{ path: texturePath }] }),
      ...cookedTexture({ name: 'T_Paint', format: 'PF_G8', width: 1, height: 1, pixels: Buffer.from([47]), external: true }),
    ]
    await Promise.all(fixtures.map(file => writeFile(join(example, file.path), file.content)))
    const server = await startServer(root, { ASSET_VIEWER_UE_VIEWER: '' })
    try {
      const { package: source } = await post(server, '/api/index/packages/inspect', { path: content })
      const nativeBlender = process.env.ASSET_VIEWER_TEST_NATIVE_BLENDER === '1'
      const options = { path: content, hash: source.hash, formats: nativeBlender ? ['fbx', 'glb'] : ['glb'] }
      const enqueue = async () => waitJob(server, (await post(server, '/api/index/packages/import', options, 202)).job.id)
      const job = await enqueue()
      assert.equal(job.status, 'completed', job.error)
      const { report, directory, scanJobId } = job.result
      assert.deepEqual(report.unrealCooked.meshes, {
        meshes: 2, gltf: 3, texturedGltf: 3, missingLods: 1, skipped: 0, failed: 0,
        derivatives: { fbx: nativeBlender ? 3 : 0, glb: 3 },
      })
      assert.equal((await waitJob(server, scanJobId)).status, 'completed')
      const manifest = await readJSON(join(directory, 'manifest.json'))
      const row = name => manifest.assets.find(asset => asset.sourcePath === 'Example/' + name + '.uasset')
      const panel = row('SM_Panel')
      const products = panel.exports.filter(item => item.format === 'glb')
      assert.deepEqual(products.map(item => [item.lod, item.metrics.triangles, item.metrics.textures]), [[0, 2, 1], [1, 1, 1]])
      assert.ok(row('SM_Damaged').issues.includes('unreal-cooked-mesh-lods-incomplete'))
      assert.deepEqual(row('SM_Damaged').exports.filter(item => item.format === 'glb').map(item => item.lod), [1])
      assert.equal(row('SM_Unrelated').exports.length, 0)
      const { json, bin } = glb(await readFile(join(directory, products[0].path)))
      const [trim, paint] = json.meshes[0].primitives
      assert.deepEqual(json.materials.map(item => [item.name, item.extras.unrealMaterialSlot]), [['Trim', 1], ['Paint', 0]])
      assert.equal(paint.extras.unrealCollisionEnabled, true)
      assert.equal(json.materials[paint.material].pbrMetallicRoughness.baseColorTexture.index, 0)
      assert.equal(json.images[0].mimeType, 'image/png')
      assert.deepEqual(accessor(json, bin, trim.attributes.POSITION, 'readFloatLE', 4), [0, 0, 0, 0, 0, 1, 2, 0, 0, 2, 0, 1])
      assert.deepEqual(accessor(json, bin, trim.attributes.TEXCOORD_1, 'readFloatLE', 4), [0.25, 0.75, 0.5, 1, 1, 0, 0.75, 0.25])
      assert.deepEqual(accessor(json, bin, trim.indices, 'readUInt16LE', 2), [0, 1, 2])
      assert.deepEqual(accessor(json, bin, paint.indices, 'readUInt16LE', 2), [2, 1, 3])
      assert.ok(accessor(json, bin, trim.attributes.NORMAL, 'readFloatLE', 4)[1] > 0.99)
      assert.equal(accessor(json, bin, trim.attributes.TANGENT, 'readFloatLE', 4)[3], -1)
      assert.ok(Math.abs(accessor(json, bin, trim.attributes.COLOR_0, 'readFloatLE', 4)[0] - 100 / 255) < 1e-7)
      if (nativeBlender) {
        const fbx = panel.exports.filter(item => item.format === 'fbx').map(item => join(directory, item.path))
        assert.deepEqual(await readFbxGeometry(fbx), [[2, 2, 1, 2], [1, 2, 1, 1]])
      }
      const { assets: indexed } = await (await server.request('/api/index/search?kind=model&library=' + job.result.library.id)).json()
      assert.ok(indexed.some(item => item.path === products[0].path))
      const asset = manifest.assets.indexOf(panel)
      const route = jobs + job.id
      const plan = await post(server, route + '/export-plan', { destination, asset })
      assert.equal(plan.unresolved, 0)
      const exported = await post(server, route + '/export', { destination, asset, key: plan.key }, 201)
      const exportedManifest = await readJSON(join(exported.directory, 'manifest.json'))
      assert.deepEqual(exportedManifest.assets.map(item => item.sourcePath).sort(), [
        'M_Base.uasset', 'MI_Panel.uasset', 'MI_Panel.uexp', 'SM_Panel.uasset', 'SM_Panel.uexp', 'SM_Panel.ubulk',
        'T_Paint.uasset', 'T_Paint.ubulk', 'T_Paint.uexp',
      ].map(name => 'Example/' + name).sort())
      for (const file of fixtures) assert.deepEqual(await readFile(join(example, file.path)), file.content)
      assert.equal((await enqueue()).result.reused, true)
    } finally { await server.close() }
  })
