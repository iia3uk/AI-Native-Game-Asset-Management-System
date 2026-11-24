import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js'
import { geometryBounds, hasTextureImage, PreviewParts } from '../public/parts.js'
import { ModelStage, normalizeFbx, normalizeFbxVertexColors } from '../public/stage.js'
import { copyTextureMapping, isDataMap, preferColoredImage } from '../public/textures.js'
import { isCollisionFile, visualModelFor } from '../public/model-names.js'

function fbxMesh(material) {
  const geometry = new THREE.BoxGeometry()
  geometry.clearGroups()
  geometry.deleteAttribute('normal')
  return new THREE.Mesh(geometry, material)
}

test('FBX albedo alpha is used once when both slots point to the same image', () => {
  const image = { width: 2, height: 2, src: 'http://127.0.0.1/textures/atlas.png' }
  const map = new THREE.Texture(image)
  const alphaMap = new THREE.Texture({ ...image })
  const material = new THREE.MeshPhongMaterial({ map, alphaMap, alphaTest: .5, transparent: true })
  const mesh = fbxMesh(material)

  normalizeFbx(mesh)

  assert.equal(material.map, map)
  assert.equal(material.alphaMap, null)
  assert.equal(material.alphaTest, .5)
  assert.ok(mesh.userData.replacedTextures.has(alphaMap))
})

test('FBX preserves a separate opacity map and valid one-pixel textures', () => {
  const map = new THREE.DataTexture(new Uint8Array([40, 50, 60, 255]), 1, 1)
  const alphaMap = new THREE.Texture({ width: 2, height: 2, src: 'http://127.0.0.1/opacity.png' })
  const material = new THREE.MeshPhongMaterial({ map, alphaMap })

  normalizeFbx(fbxMesh(material))

  assert.ok(hasTextureImage(map))
  assert.equal(material.map, map)
  assert.equal(material.alphaMap, alphaMap)
})

test('FBX drops failed textures and draws meshes whose material groups are missing', () => {
  const placeholder = new THREE.DataTexture()
  const material = new THREE.MeshPhongMaterial({ color: 0x999999, map: placeholder })
  const mesh = fbxMesh([material, new THREE.MeshPhongMaterial()])

  normalizeFbx(mesh)

  assert.equal(material.map, null)
  assert.ok(mesh.geometry.hasAttribute('normal'))
  assert.deepEqual(mesh.geometry.groups, [{ start: 0, count: mesh.geometry.index.count, materialIndex: 0 }])
  assert.equal(new PreviewParts(mesh).meshes.length, 1)
})

test('FBX vertex color masks and absent layers do not black out textured objects', () => {
  const map = new THREE.DataTexture(new Uint8Array([40, 50, 60, 255]), 1, 1)
  const material = new THREE.MeshPhongMaterial({ map, vertexColors: true })
  const model = new THREE.Group()
  const meshes = [fbxMesh(material), fbxMesh(material), fbxMesh(material)]
  const count = meshes[0].geometry.getAttribute('position').count
  const mask = new THREE.Float32BufferAttribute(new Float32Array(count * 4), 4)
  mask.setW(0, .5)
  const painted = new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3)
  painted.setXYZ(0, .5, 0, 0)
  meshes[0].geometry.setAttribute('color', mask)
  meshes[2].geometry.setAttribute('color', painted)
  model.add(...meshes)

  normalizeFbxVertexColors(model)

  assert.equal(mask.getX(0), 1)
  assert.equal(mask.getW(0), .5)
  assert.equal(meshes[1].geometry.getAttribute('color').getX(0), 1)
  assert.equal(painted.getX(0), .5)
})

test('the default view hides collision meshes and lower detail levels, with parts still inspectable', () => {
  const model = new THREE.Group()
  for (const name of ['Rock_LOD0', 'Rock_LOD1', 'Rock_ConvexHulls']) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhongMaterial())
    mesh.name = name
    model.add(mesh)
  }
  model.updateMatrixWorld(true)
  const parts = new PreviewParts(model)
  parts.apply(false)

  assert.deepEqual(model.children.map(mesh => mesh.layers.mask), [1, 0, 0])
  assert.equal(parts.choices.length, 3)
  assert.ok(!parts.select(2, false).isEmpty())
  assert.deepEqual(model.children.map(mesh => mesh.layers.mask), [0, 0, 1])
  parts.dispose()
  assert.deepEqual(model.children.map(mesh => mesh.layers.mask), [1, 1, 1])
})

test('non-finite geometry bounds do not break framing of the remaining objects', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhongMaterial())
  mesh.position.x = Infinity
  mesh.updateMatrixWorld(true)

  assert.equal(geometryBounds(mesh), null)
})

test('PLY point clouds and triangle meshes are distinguishable to the preview', () => {
  const loader = new PLYLoader()
  const header = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n'
  const positions = '0 0 0\n1 0 0\n0 1 0\n'
  const cloud = loader.parse(header + 'end_header\n' + positions)
  const mesh = loader.parse(header + 'element face 1\nproperty list uchar int vertex_indices\nend_header\n' +
    positions + '3 0 1 2\n')

  assert.equal(cloud.userData.hasPlyFaces, false)
  assert.equal(cloud.getAttribute('position').count, 3)
  assert.equal(mesh.userData.hasPlyFaces, true)
})

test('albedo preview prefers an exact Colored counterpart from the same directory tree', () => {
  const image = (dir, name) => ({ name, ext: 'png', url: dir + '/' + name })
  const mask = image('/local-files/first/Tex', 'Bridge%2301_ALB.png')
  const preferred = image('/local-files/first/Tex/Colored', mask.name)
  const unrelated = image('/local-files/second/Tex/Colored', mask.name)
  const normal = image('/local-files/first/Tex', 'Bridge%2301_NRM.png')
  const coloredNormal = image('/local-files/first/Tex/Colored', normal.name)

  assert.equal(preferColoredImage(mask, [mask, unrelated, preferred]), preferred)
  assert.equal(preferColoredImage(mask, [mask, unrelated]), mask)
  assert.equal(preferColoredImage(normal, [normal, coloredNormal]), normal)
  assert.equal(isDataMap(mask), false)
  assert.equal(isDataMap(normal), true)
})

test('a texture replacement keeps the authored UV channel and transform', () => {
  const original = new THREE.Texture()
  original.flipY = false
  original.channel = 2
  original.wrapS = THREE.MirroredRepeatWrapping
  original.repeat.set(2, 3)
  original.offset.set(.2, .3)
  original.center.set(.5, .5)
  original.rotation = .4
  original.updateMatrix()
  original.matrixAutoUpdate = false
  const replacement = new THREE.Texture()

  copyTextureMapping(replacement, original, true)

  assert.equal(replacement.channel, 2)
  assert.equal(replacement.flipY, false)
  assert.equal(replacement.wrapS, THREE.MirroredRepeatWrapping)
  assert.equal(replacement.matrixAutoUpdate, false)
  assert.ok(original.matrix.equals(replacement.matrix))
  assert.ok(original.repeat.equals(replacement.repeat))
})

test('standalone collision files link only to an unambiguous render model', () => {
  const fbx = (name, displayPath = name) => ({ kind: 'model', ext: 'fbx', name, displayPath })
  const collider = fbx('UCX_SM_TownHall.fbx')
  const hall = fbx('SM_TownHall.fbx')
  const tower = fbx('SM_TownHall_Tower.fbx')
  assert.equal(isCollisionFile(collider), true)
  assert.equal(isCollisionFile(fbx('shape.fbx', 'Meshes/Colliders/shape.fbx')), true)
  assert.equal(isCollisionFile(hall), false)
  assert.equal(visualModelFor(collider, [hall, tower, collider]), hall)
  assert.equal(visualModelFor(collider, [hall, { ...hall }, tower, collider]), undefined)
})

test('resizing a framed long scene keeps the bounds in a narrower viewport', () => {
  const stage = Object.create(ModelStage.prototype)
  stage.camera = new THREE.PerspectiveCamera(38, 1.7)
  stage.element = { clientWidth: 380, clientHeight: 580 }
  stage.renderer = { setSize() {} }
  stage.controls = {
    target: new THREE.Vector3(),
    update() { stage.camera.lookAt(this.target) },
  }
  stage.bounds = new THREE.Box3(new THREE.Vector3(-49, 0, -6), new THREE.Vector3(49, 14, 6))
  stage.fit()
  const previous = stage.camera.position.distanceTo(stage.controls.target)

  stage.resize()
  stage.camera.updateMatrixWorld()

  assert.ok(stage.camera.position.distanceTo(stage.controls.target) > previous)
  for (const x of [-49, 49]) for (const y of [0, 14]) for (const z of [-6, 6]) {
    const point = new THREE.Vector3(x, y, z).project(stage.camera)
    assert.ok(Math.abs(point.x) < 1 && Math.abs(point.y) < 1)
  }
})
