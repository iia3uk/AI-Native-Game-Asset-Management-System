import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readTexture } from './png.mjs'

const loadJson = async path => JSON.parse(await readFile(path, 'utf8'))

export function glb(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'glTF')
  assert.equal(bytes.readUInt32LE(8), bytes.length)
  const end = 20 + bytes.readUInt32LE(12)
  return { document: JSON.parse(bytes.toString('utf8', 20, end)), bin: bytes.subarray(end + 8) }
}

export async function verifyBundleMaterials(root, query) {
  const input = join(root, 'Bundles', 'materials.bundle')
  const inspected = await query('unity-bundle', input, '--inspect')
  assert.equal(inspected.status, 'completed', JSON.stringify(inspected))
  const asset = (assets, name) => assets.find(item => item.name === name)
  const painted = asset(inspected.assets, 'Painted')
  const front = asset(inspected.assets, 'Front')
  const back = asset(inspected.assets, 'Back')
  assert.deepEqual(painted.meshMaterials, { status: 'linked', slots: [front, back].map(({ pathId }) => ({ fileId: 0, pathId })) })
  assert.deepEqual(asset(inspected.assets, 'Shared').meshMaterials, { status: 'ambiguous' })
  assert.equal(front.material.profile, 'standard')
  assert.deepEqual(front.material.textures.map(slot => [slot.property, slot.texture.pathId, slot.scale, slot.offset]),
    [['_MainTex', asset(inspected.assets, 'FrontColor').pathId, [2, .5], [.25, .125]]])

  const exported = await query('unity-bundle', input, '--fbx')
  assert.equal(exported.converted, 6, JSON.stringify(exported))
  const manifest = await loadJson(join(exported.output, 'manifest.json'))
  const preview = asset(manifest.assets, 'Painted')
  assert.equal(preview.materialPreview, 'bound')
  const { document, bin } = glb(await readFile(join(exported.output, preview.artifact.path)))
  assert.deepEqual(document.meshes[0].primitives.map(primitive => document.materials[primitive.material].name), ['Front', 'Back'])
  assert.equal(document.materials[0].alphaMode, 'MASK')
  assert.ok(Math.abs(document.materials[0].alphaCutoff - .35) < .00001)
  assert.deepEqual(document.materials[0].pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform,
    { scale: [2, .5], offset: [.25, .375] })
  const exportedFbx = preview.exports[0]
  const fbx = exportedFbx.path && await readFile(join(exported.output, exportedFbx.path))
  for (const [index, name, expected] of [[0, 'Front', [211, 19, 41, 201]], [1, 'Back', [11, 191, 73, 255]]]) {
    const { entry, pixel } = await readTexture(manifest, exported.output, name + 'Color')
    assert.deepEqual(pixel(0, 0), expected)
    const binding = await loadJson(join(exported.output, asset(manifest.assets, name).artifact.path))
    assert.deepEqual(binding.textures[0].target, { path: entry.artifact.path, sha256: entry.artifact.sha256, colorSpace: 'srgb' })
    const pointer = document.materials[index].pbrMetallicRoughness.baseColorTexture.index
    const image = document.images[document.textures[pointer].source]
    const range = document.bufferViews[image.bufferView]
    const png = await readFile(join(exported.output, entry.artifact.path))
    assert.deepEqual(bin.subarray(range.byteOffset, range.byteOffset + range.byteLength), png)
    if (fbx) assert.notEqual(fbx.indexOf(png), -1, 'FBX embeds the source PNG bytes')
  }
  assert.ok(fbx || exportedFbx.status === 'requires-tool', JSON.stringify(exportedFbx))
  const shared = asset(manifest.assets, 'Shared')
  assert.equal(shared.materialPreview, 'ambiguous')
  assert.equal(glb(await readFile(join(exported.output, shared.artifact.path))).document.images, undefined)

  const { job } = await query('package-import', input)
  assert.equal(job.status, 'completed', JSON.stringify(job))
  const ordinal = String(manifest.assets.indexOf(preview))
  const plan = await query('package-export', job.id, root, '--asset', ordinal)
  assert.deepEqual([plan.assets, plan.unresolved], [5, 0])
  const saved = await query('package-export', job.id, root, '--asset', ordinal, '--plan-key', plan.key)
  const selection = await loadJson(join(saved.directory, 'manifest.json'))
  assert.deepEqual(selection.assets.map(item => item.name).sort(), ['Back', 'BackColor', 'Front', 'FrontColor', 'Painted'])
  const ambiguous = await query('package-export', job.id, root, '--asset', String(manifest.assets.indexOf(shared)))
  assert.deepEqual([ambiguous.assets, ambiguous.unresolved], [1, 1])
}
