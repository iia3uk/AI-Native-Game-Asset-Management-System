import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { locateBatchBlender } from '../../core/engines/blender/batch.mjs'
import { runBlender } from '../../core/engines/blender/runner.mjs'
import { readPngRgb } from '../../core/files/png-rgb.mjs'
import { glb } from './materials.mjs'
import { readTexture } from './png.mjs'

const loadJson = async path => JSON.parse(await readFile(path, 'utf8'))
const asset = (report, name) => report.assets.find(item => item.name === name)
const pngPixel = image => [...image.rows.subarray(1, image.channels + 1)]

function embedded(model, info) {
  const { document, bin } = model
  const { source } = document.textures[info.index]
  const view = document.bufferViews[document.images[source].bufferView]
  return readPngRgb(bin.subarray(view.byteOffset, view.byteOffset + view.byteLength))
}

export async function verifyPbrBundle(root, query) {
  const input = join(root, 'Bundles', 'pbr-materials.bundle')
  const plan = await query('unity-bundle', input, '--inspect')
  assert.equal(plan.status, 'completed', JSON.stringify(plan))
  const { material } = asset(plan, 'PbrMetal')
  assert.deepEqual(material.keywords, ['_EMISSION', '_METALLICGLOSSMAP', '_NORMALMAP'])
  assert.deepEqual(material.emissionColor, [2, .5, .25, 1])
  assert.deepEqual(material.mainTransform, { scale: [2, .5], offset: [.125, .25] })
  assert.deepEqual(asset(plan, 'PbrPackedNormal').sampler, { filter: 0, wrapU: 1, wrapV: 2, anisotropy: 1, mipmaps: false })
  const result = await query('unity-bundle', input, '--fbx')
  assert.equal(result.status, 'completed', JSON.stringify(result))
  const published = await loadJson(join(result.output, 'manifest.json'))
  const entry = asset(published, 'PbrMesh')
  assert.equal(entry.materialPreview, 'bound', JSON.stringify(entry.materialIssues))
  assert.deepEqual(entry.materialChannels, ['baseColor', 'metallicRoughness', 'occlusion', 'normal', 'emissive'])

  const model = glb(await readFile(join(result.output, entry.artifact.path)))
  const { document, bin } = model
  const [metal, albedo] = document.meshes[0].primitives.map(item => document.materials[item.material])
  assert.deepEqual([metal.name, albedo.name], ['PbrMetal', 'PbrAlbedoAlpha'])
  assert.deepEqual(document.extensionsUsed.sort(), ['KHR_materials_emissive_strength', 'KHR_texture_transform'])
  const tangent = document.accessors[document.meshes[0].primitives[0].attributes.TANGENT]
  const { byteOffset } = document.bufferViews[tangent.bufferView]
  assert.equal(tangent.type, 'VEC4')
  assert.deepEqual([0, 4, 8, 12].map(offset => bin.readFloatLE(byteOffset + offset) || 0), [1, 0, 0, -1])
  assert.deepEqual(document.samplers[0], { minFilter: 9728, magFilter: 9728, wrapS: 33071, wrapT: 33648 })
  const pbr = metal.pbrMetallicRoughness
  for (const info of [pbr.baseColorTexture, pbr.metallicRoughnessTexture, metal.normalTexture, metal.occlusionTexture, metal.emissiveTexture]) {
    assert.deepEqual(info.extensions.KHR_texture_transform, { scale: [2, .5], offset: [.125, .25] })
  }
  assert.deepEqual([pbr.metallicFactor, pbr.roughnessFactor], [1, 1])
  assert.deepEqual(pngPixel(embedded(model, pbr.metallicRoughnessTexture)), [255, 165, 37])
  assert.deepEqual(pngPixel(embedded(model, metal.occlusionTexture)), [61, 61, 61])
  assert.equal(metal.occlusionTexture.strength, .25)
  assert.deepEqual(pngPixel(embedded(model, metal.emissiveTexture)), [23, 147, 91, 255])
  assert.deepEqual(metal.emissiveFactor, [1, .25, .125])
  assert.equal(metal.extensions.KHR_materials_emissive_strength.emissiveStrength, 2)

  const { pixel } = await readTexture(published, result.output, 'PbrPackedNormal')
  const [r, g, , a] = pixel(0, 0)
  const x = (2 * r * a / 255 ** 2 - 1) * 1.25
  const y = (1 - 2 * g / 255) * 1.25
  const z = Math.sqrt(1 - x ** 2 - y ** 2)
  const normal = pngPixel(embedded(model, metal.normalTexture))
  assert.deepEqual(normal, [x, y, z].map(component => Math.round((component / 2 + .5) * 255)))
  assert.ok(normal[1] < 128, 'V reflection must invert the stored green component')
  assert.equal(albedo.alphaMode, 'MASK')
  assert.ok(Math.abs(albedo.alphaCutoff - .45) < .00001)
  assert.deepEqual(pngPixel(embedded(model, albedo.pbrMetallicRoughness.baseColorTexture)), [110, 121, 138])
  assert.deepEqual(pngPixel(embedded(model, albedo.pbrMetallicRoughness.metallicRoughnessTexture)), [255, 183, 37])
  assert.deepEqual((await readTexture(published, result.output, 'PbrAlbedoAlphaColor')).pixel(0, 0), [110, 121, 138, 96])

  const mismatch = asset(published, 'PbrMismatchMesh')
  assert.equal(mismatch.materialPreview, 'partial')
  assert.deepEqual(mismatch.materialIssues, ['smoothness-sampling-mismatch'])
  const mismatchGlb = glb(await readFile(join(result.output, mismatch.artifact.path)))
  const mismatchMat = mismatchGlb.document.materials[0]
  assert.equal(mismatchMat.emissiveTexture, undefined)
  assert.equal(mismatchMat.pbrMetallicRoughness.roughnessFactor, .5)
  assert.deepEqual(pngPixel(embedded(mismatchGlb, mismatchMat.pbrMetallicRoughness.metallicRoughnessTexture)), [255, 255, 37])
  const mismatchedBindings = await loadJson(join(result.output, asset(published, 'PbrMismatch').artifact.path))
  assert.equal(mismatchedBindings.textures.find(item => item.property === '_EmissionMap').active, false)
  const { job } = await query('package-import', input)
  const exportPlan = await query('package-export', job.id, root, '--asset', String(published.assets.indexOf(entry)))
  assert.deepEqual([exportPlan.assets, exportPlan.unresolved], [9, 0])
  assert.equal((await query('unity-bundle', input, '--fbx')).reused, true)

  const fbx = entry.exports[0]
  if (fbx.status === 'requires-tool') return
  assert.equal(fbx.status, 'converted', JSON.stringify(fbx))
  assert.ok(fbx.issues.includes('fbx-occlusion-unsupported'))
  assert.ok(fbx.issues.includes('fbx-texture-sampling'))
  assert.ok(fbx.issues.includes('fbx-alpha-cutoff'))
  assert.ok(!fbx.issues.includes('fbx-material-channel-unavailable'))
  const blender = await locateBatchBlender()
  const report = join(root, 'unity-materials-fbx.json')
  const script = fileURLToPath(new URL('../fixtures/unity-bundle/inspect-pbr-fbx.py', import.meta.url))
  await runBlender(blender.executable, ['--threads', '2', '--python-exit-code', '1', '--python', script, '--',
    join(result.output, fbx.path), report], { cwd: root, timeout: 30_000 })
  const maps = await loadJson(report)
  for (const data of Object.values(maps)) {
    assert.deepEqual(data.scale, [2, .5])
    assert.deepEqual(data.offset, [.125, .25])
  }
  assert.deepEqual(maps.Metallic.pixel, [37, 37, 37, 255])
  assert.deepEqual(maps.Roughness.pixel, [165, 165, 165, 255])
  assert.deepEqual(maps.Normal.pixel, [...normal, 255])
  assert.deepEqual(maps['Emission Color'].pixel, [23, 76, 30, 255])
}
