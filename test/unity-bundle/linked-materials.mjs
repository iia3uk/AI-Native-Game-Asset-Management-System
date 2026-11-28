import assert from 'node:assert/strict'
import { appendFile, copyFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { glb } from './materials.mjs'
import { readTexture } from './png.mjs'

const byName = (report, name) => report.assets.find(asset => asset.name === name)
const manifest = async directory => JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))

async function verifySceneMaterials(bundles, query) {
  const input = join(bundles, 'scene-materials.bundle')
  const plan = await query('unity-bundle', input, '--inspect')
  assert.equal(plan.status, 'completed', JSON.stringify(plan))
  const mesh = byName(plan, 'SharedSceneMesh')
  assert.equal(mesh.meshMaterials.status, 'linked')
  assert.match(mesh.meshMaterials.rendererMember, /^BuildPlayer-PaintedScene[AB]$/)
  assert.notEqual(mesh.meshMaterials.rendererMember, mesh.member)
  assert.deepEqual(mesh.meshMaterials.slots.map(({ pathId, targetMember }) => [pathId, targetMember]),
    ['Front', 'Back'].map(name => {
      const material = byName(plan, name)
      return [material.pathId, material.member]
    }))
  assert.ok(mesh.meshMaterials.slots.every(slot => slot.fileId > 0))
  const converted = await query('unity-bundle', input)
  const preview = byName(await manifest(converted.output), mesh.name)
  assert.equal(preview.materialPreview, 'bound')
  const { document } = glb(await readFile(join(converted.output, preview.artifact.path)))
  assert.deepEqual(document.meshes[0].primitives.map(primitive => document.materials[primitive.material].name), ['Front', 'Back'])
  assert.equal(document.images.length, 2)
}

export async function verifyLinkedBundleMaterials(root, query, enqueue) {
  const bundles = join(root, 'Bundles')
  await verifySceneMaterials(bundles, query)
  const modelName = 'linked-model.bundle'
  const materialName = 'linked-paint.bundle'
  const textureName = 'linked-images.bundle'
  const input = join(bundles, modelName)
  const plan = await query('unity-bundle', input, '--inspect')
  assert.equal(plan.status, 'completed', JSON.stringify(plan))
  assert.deepEqual(plan.resources.map(({ name, role }) => [name, role]),
    [[materialName, 'bundle'], [textureName, 'bundle']])
  const mesh = byName(plan, 'LinkedMesh')
  const paint = byName(plan, 'LinkedPaint')
  const texture = byName(plan, 'LinkedPaintColor')
  assert.deepEqual([mesh.sourceArchive, paint.sourceArchive, texture.sourceArchive], [undefined, 1, 2])
  assert.equal(mesh.meshMaterials.status, 'linked')
  const [first, second] = mesh.meshMaterials.slots
  assert.equal(mesh.meshMaterials.slots.length, 2)
  assert.deepEqual(first, second)
  assert.ok(first.fileId > 0)
  assert.deepEqual([first.pathId, first.targetMember], [paint.pathId, paint.member])
  const texturePointer = paint.material.textures[0].texture
  assert.ok(texturePointer.fileId > 0)
  assert.deepEqual([texturePointer.pathId, texturePointer.targetMember], [texture.pathId, texture.member])

  const converted = await query('unity-bundle', input, '--fbx')
  assert.equal(converted.converted, 3, JSON.stringify(converted))
  const published = await manifest(converted.output)
  const preview = byName(published, mesh.name)
  assert.equal(preview.materialPreview, 'bound')
  const { document, bin } = glb(await readFile(join(converted.output, preview.artifact.path)))
  assert.deepEqual(document.meshes[0].primitives.map(primitive => document.materials[primitive.material].name),
    ['LinkedPaint', 'LinkedPaint'])
  const { entry, pixel } = await readTexture(published, converted.output, texture.name)
  assert.deepEqual(pixel(0, 0), [83, 109, 221, 255])
  const image = document.images[document.textures[document.materials[0].pbrMetallicRoughness.baseColorTexture.index].source]
  const range = document.bufferViews[image.bufferView]
  const png = await readFile(join(converted.output, entry.artifact.path))
  assert.deepEqual(bin.subarray(range.byteOffset, range.byteOffset + range.byteLength), png)
  const fbx = preview.exports[0]
  if (fbx.path) assert.notEqual((await readFile(join(converted.output, fbx.path))).indexOf(png), -1)
  else assert.equal(fbx.status, 'requires-tool')

  const { job } = await query('package-import', input)
  assert.equal(job.status, 'completed', JSON.stringify(job))
  const selectionArgs = ['package-export', job.id, root, '--asset', String(published.assets.indexOf(preview))]
  const selection = await query(...selectionArgs)
  assert.deepEqual([selection.assets, selection.unresolved], [3, 0])
  const saved = await query(...selectionArgs, '--plan-key', selection.key)
  assert.deepEqual((await manifest(saved.directory)).assets.map(asset => asset.name).sort(), [mesh.name, paint.name, texture.name])

  const copy = join(root, 'linked-copy')
  await mkdir(copy)
  for (const name of [modelName, materialName, textureName]) {
    await copyFile(join(bundles, name), join(copy, name))
    await copyFile(join(bundles, name + '.manifest'), join(copy, name + '.manifest'))
  }
  const copyInput = join(copy, modelName)
  assert.equal((await query('unity-bundle', copyInput, '--inspect')).hash, plan.hash)
  await copyFile(join(bundles, 'uncompressed', textureName), join(copy, textureName))
  const stale = await enqueue(copyInput, plan.hash)
  assert.equal(stale.status, 'failed')
  assert.match(stale.error, /изменился после анализа/)
  const changed = await query('unity-bundle', copyInput, '--inspect')
  assert.equal(changed.status, 'completed')
  assert.notEqual(changed.hash, plan.hash)
  assert.equal(byName(changed, texture.name).sourceArchive, 2)

  await copyFile(join(copy, materialName), join(copy, 'alternate-paint.bundle'))
  await appendFile(copyInput + '.manifest', '- alternate-paint.bundle\n')
  const duplicate = await query('unity-bundle', copyInput)
  assert.ok(duplicate.output, JSON.stringify(duplicate))
  const reduced = await manifest(duplicate.output)
  assert.equal(byName(reduced, mesh.name).materialPreview, 'unavailable')
  assert.equal(byName(reduced, paint.name), undefined)
}
