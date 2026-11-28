import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { bindViewerMaterials } from '../core/conversion/unreal/viewer/bind-materials.mjs'
import { readSourceMaterial } from '../core/engines/unreal/source-material/properties.mjs'
import { sourceNormalSettings, sourceTextureSettings } from '../core/engines/unreal/source-material/texture-properties.mjs'
import { encodePngScanlines } from '../core/files/png.mjs'
import { readPngRgb } from '../core/files/png-rgb.mjs'
import { sourceMaterialParameters } from '../core/materials/unreal/source-parameters.mjs'
import { sourceMaterialFixture, sourceNormalGraph, sourceNormalTexture } from './fixtures/unreal-source-material.mjs'
import { testDirectory } from './server-fixture.mjs'

const path = '/Game/Example/T_Colors'
const png = encodePngScanlines(1, 1, Buffer.from([0, 113, 55, 236, 204]), { alpha: true })
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

test('UE4 normal selection requires direct owned tangent-space color samples and UV0', () => {
  const base = { id: 'base', sourcePath: 'M_Master.uasset' }
  const child = { id: 'child', sourcePath: 'MI_Example.uasset' }
  const material = readSourceMaterial(sourceNormalGraph())
  assert.deepEqual(material.normalInput, { path, parameter: 'SurfaceDetail' })
  assert.equal(readSourceMaterial(sourceNormalGraph({ tangent: false })).normalInput, null)
  assert.equal(readSourceMaterial(sourceNormalGraph({ customCoordinates: true })).normalInput, null)
  assert.equal(readSourceMaterial(sourceNormalGraph({ classOwner: 0 })).normalInput, null)
  const instance = readSourceMaterial(sourceMaterialFixture())
  const parsed = new Map([[base.id, material], [child.id, instance]])
  const resolve = () => base
  assert.equal(sourceMaterialParameters(child, parsed, resolve).normal.path, path)
  instance.textures.push({ name: 'surfacedetail', association: 'GlobalParameter', index: -1, path: null })
  assert.equal(sourceMaterialParameters(child, parsed, resolve).normal, null)
  parsed.set(base.id, readSourceMaterial(sourceNormalGraph({ uv: 1 })))
  assert.equal(sourceMaterialParameters(base, parsed, resolve).normal, null)
  assert.equal(sourceNormalSettings(sourceTextureSettings(sourceNormalTexture({ srgb: true, png }))), null)
})

test('UE4 normal import preserves source pixels and publishes only the needed green-channel conversion', async t => {
  const root = await testDirectory(t)
  const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
  const exec = promisify(execFile)
  for (const flip of [undefined, true]) {
    const pack = join(root, flip ? 'pre-flipped' : 'directx', 'Example')
    await mkdir(pack, { recursive: true })
    await writeFile(join(pack, 'M_Master.uasset'), sourceNormalGraph())
    await writeFile(join(pack, 'T_Colors.uasset'), sourceNormalTexture({ flip, png }))
    const { stdout } = await exec(process.execPath, [cli, 'package-import', pack, '--json'], {
      env: { ...process.env, ASSET_VIEWER_DATA_DIR: join(root, 'app'), ASSET_VIEWER_UE_VIEWER: '' }, windowsHide: true,
    })
    const { job } = JSON.parse(stdout)
    assert.equal(job.status, 'completed')
    assert.equal(job.result.report.unrealSourceMaterials.normalMaterials, 1)
    assert.equal(job.result.report.unrealSourceMaterials.normalDerivatives, flip ? 0 : 1)
    const directory = job.result.directory
    const { assets } = await readJson(join(directory, 'manifest.json'))
    const material = assets.find(asset => asset.sourcePath === 'M_Master.uasset')
    const texture = assets.find(asset => asset.sourcePath === 'T_Colors.uasset')
    const original = texture.exports.find(item => item.role === 'texture')
    assert.deepEqual(await readFile(join(directory, original.path)), png)
    const description = await readJson(join(directory, material.exports[0].path))
    const { normalMap } = description
    assert.equal(normalMap.textureId, texture.id)
    assert.equal(normalMap.convention, 'opengl')
    assert.equal(normalMap.greenInverted, !flip)
    const prepared = readPngRgb(await readFile(join(directory, normalMap.path)))
    assert.deepEqual([...prepared.rows], [0, 113, flip ? 55 : 200, 236, 204])
    const { dependencies } = await readJson(join(directory, 'dependencies.json'))
    assert(dependencies.some(item => item.source === material.id && item.target === texture.id))
    for (const normals of [false, true]) {
      const attributes = normals ? { TEXCOORD_0: 0, NORMAL: 1 } : { TEXCOORD_0: 0 }
      const gltf = { materials: [{ name: 'M_Master', pbrMetallicRoughness: {} }],
        meshes: [{ primitives: [{ attributes, material: 0 }] }] }
      const result = bindViewerMaterials(gltf, () => ({ asset: material, description }), 'Models/Master.gltf')
      assert.equal(result.images, normals ? 1 : 0)
      assert.deepEqual(gltf.materials[0].normalTexture, normals ? { index: 0 } : undefined)
    }
  }
})
