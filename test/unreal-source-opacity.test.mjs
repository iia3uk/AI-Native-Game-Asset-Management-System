import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { bindViewerMaterials } from '../core/conversion/unreal/viewer/bind-materials.mjs'
import { readSourceMaterial } from '../core/engines/unreal/source-material/properties.mjs'
import { encodePngScanlines } from '../core/files/png.mjs'
import { readPngPixels } from '../core/files/png-rgb.mjs'
import { sourceMaterialParameters } from '../core/materials/unreal/source-parameters.mjs'
import { sourceOpacityGraph, sourceOpacityTexture, sourceSurfaceInstance } from './fixtures/unreal-source-material.mjs'
import { testDirectory } from './server-fixture.mjs'

const rgba = pixel => encodePngScanlines(1, 1, Buffer.from([0, ...pixel]), { alpha: true })
const clip = rgba([113, 55, 236, 204])
const gray = encodePngScanlines(1, 1, Buffer.from([0, 128, 128, 128]))
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

test('UE4 opacity masks honor instance override flags and reject custom or incompatible UV inputs', () => {
  const base = { id: 'base', sourcePath: 'M_Master.uasset' }
  const child = { id: 'child', sourcePath: 'MI_Example.uasset' }
  const sample = readSourceMaterial(sourceOpacityGraph())
  assert.equal(sample.surface.mask.channel, 'alpha')
  assert.equal(sample.surface.color.path, sample.surface.mask.path)
  const parsed = new Map([[base.id, sample]])
  const resolve = () => base
  for (const override of [true, false]) {
    parsed.set(child.id, readSourceMaterial(sourceSurfaceInstance({ override })))
    const { surface } = sourceMaterialParameters(child, parsed, resolve)
    assert.equal(surface.cutoff, override ? 0.75 : 0.25)
    assert.equal(surface.doubleSided, !override)
    assert.equal(surface.mask.path, '/Game/Example/T_Colors')
  }
  assert.equal(readSourceMaterial(sourceOpacityGraph({ customCoordinates: true })).surface.mask, undefined)
  parsed.set(base.id, readSourceMaterial(sourceOpacityGraph({ uv: 1 })))
  assert.equal(sourceMaterialParameters(base, parsed, resolve).surface.mask, null)
})

test('UE4 cutout import keeps original alpha and packs verified separate grayscale into linear glTF alpha', async t => {
  const root = await testDirectory(t)
  const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
  const exec = promisify(execFile)
  for (const separate of [false, true]) {
    const pack = join(root, separate ? 'gray' : 'rgba', 'Example')
    await mkdir(pack, { recursive: true })
    await writeFile(join(pack, 'M_Master.uasset'), sourceOpacityGraph({ separate }))
    await writeFile(join(pack, 'T_Colors.uasset'), sourceOpacityTexture({ label: 'T_Colors', png: separate ? gray : clip }))
    if (separate) await writeFile(join(pack, 'T_Base.uasset'), sourceOpacityTexture({ label: 'T_Base', png: clip }))
    const { stdout } = await exec(process.execPath, [cli, 'package-import', pack, '--json'], {
      env: { ...process.env, ASSET_VIEWER_DATA_DIR: join(root, 'app'), ASSET_VIEWER_UE_VIEWER: '' }, windowsHide: true,
    })
    const { job } = JSON.parse(stdout)
    assert.equal(job.status, 'completed')
    assert.equal(job.result.report.unrealSourceMaterials.opacityMaterials, 1)
    assert.equal(job.result.report.unrealSourceMaterials.opacityDerivatives, Number(separate))
    const directory = job.result.directory
    const { assets } = await readJson(join(directory, 'manifest.json'))
    const material = assets.find(asset => asset.sourcePath === 'M_Master.uasset')
    const texture = assets.find(asset => asset.sourcePath === 'T_Colors.uasset')
    const original = texture.exports.find(item => item.role === 'texture')
    assert.deepEqual(await readFile(join(directory, original.path)), separate ? gray : clip)
    const description = await readJson(join(directory, material.exports[0].path))
    const { opacityMask } = description
    assert.equal(opacityMask.colorTextureId, separate ? assets.find(asset => asset.sourcePath === 'T_Base.uasset').id : texture.id)
    assert.equal(opacityMask.textureId, texture.id)
    assert.equal(opacityMask.channel, separate ? 'rgb' : 'alpha')
    const pixels = readPngPixels(await readFile(join(directory, opacityMask.path)))
    assert.deepEqual([...pixels.rows], [0, 113, 55, 236, separate ? 55 : 204])
    const { dependencies } = await readJson(join(directory, 'dependencies.json'))
    for (const target of new Set([texture.id, opacityMask.colorTextureId])) {
      assert(dependencies.some(item => item.source === material.id && item.target === target))
    }
    const gltf = { materials: [{ name: 'M_Master', pbrMetallicRoughness: {} }],
      meshes: [{ primitives: [{ attributes: { TEXCOORD_0: 1 }, material: 0 }] }] }
    assert.equal(bindViewerMaterials(gltf, () => ({ asset: material, description }), 'Models/Master.gltf').images, 1)
    const { alphaMode, alphaCutoff, doubleSided } = gltf.materials[0]
    assert.deepEqual({ alphaMode, alphaCutoff, doubleSided }, { alphaMode: 'MASK', alphaCutoff: 0.25, doubleSided: true })
  }
})
