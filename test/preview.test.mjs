import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js'
import { geometryBounds, hasTextureImage, PreviewParts } from '../public/parts.js'
import { ModelStage, normalizeFbx, normalizeFbxVertexColors } from '../public/stage.js'
import { companionTexture, copyTextureMapping, idSuffix, isDataMap, opacitySuffix,
  preferColoredImage, resemblesVertexMask } from '../public/textures.js'
import { isCollisionFile, visualModelFor } from '../public/model-names.js'
import { animatedTranslationRoot } from '../public/animation-motion.js'
import { storedValue } from '../public/viewer-storage.js'

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

test('in-place animation removes horizontal drift and retains height, rotation and pause', () => {
  const stage = Object.create(ModelStage.prototype)
  const model = new THREE.Group()
  const container = new THREE.Group()
  const hips = new THREE.Group()
  hips.name = 'Hips'
  hips.add(new THREE.Bone(), new THREE.Bone())
  container.position.set(3, 0, 2)
  container.add(model)
  model.add(hips)
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
  const clip = new THREE.AnimationClip('Walk', 2, [
    new THREE.VectorKeyframeTrack('Hips.position', [0, 1, 2], [0, 0, 0, 20, 4, -12, 40, 8, -24]),
    new THREE.QuaternionKeyframeTrack('Hips.quaternion', [0, 1, 2], [0, 0, 0, 1, ...rotation, ...rotation]),
  ])

  Object.assign(stage, { model, root: container, clips: [clip], mixer: new THREE.AnimationMixer(model),
    inPlace: true, animationOffset: container.position.clone(), motionOrigin: new THREE.Vector3(),
    motionSample: new THREE.Vector3() })
  assert.equal(stage.play(0), true)
  stage.updateAnimation(1)
  const world = () => hips.getWorldPosition(new THREE.Vector3()).toArray()
  assert.deepEqual(world(), [3, 4, 2])
  assert.ok(hips.quaternion.angleTo(rotation) < .001)
  stage.pause()
  stage.updateAnimation(.25)
  assert.deepEqual(world(), [3, 4, 2])
  stage.setInPlace(false)
  assert.deepEqual(world(), [23, 4, -10])
  stage.setInPlace(true)
  assert.deepEqual(world(), [3, 4, 2])
  stage.play(0)
  stage.updateAnimation(.25)
  assert.deepEqual(world(), [3, 5, 2])
})

test('moving one part of a scene does not shift the whole preview', () => {
  const model = new THREE.Group()
  const door = new THREE.Mesh()
  door.name = 'Door'
  model.add(door, new THREE.Mesh())
  const clip = new THREE.AnimationClip('Open', 1,
    [new THREE.VectorKeyframeTrack('Door.position', [0, 1], [0, 0, 0, 1, 0, 0])])
  assert.equal(animatedTranslationRoot(model, clip), null)
})

test('browser settings migrate to the new namespace without replacing current settings', () => {
  const storage = {
    'prior.folders.v1': '[1]',
    getItem(key) { return this[key] ?? null },
    setItem(key, value) { this[key] = value },
  }
  assert.equal(storedValue(storage, 'asset-viewer.folders.v1'), '[1]')
  storage['prior.folders.v1'] = '[2]'
  assert.equal(storedValue(storage, 'asset-viewer.folders.v1'), '[1]')
})

test('opacity and ID maps pair with the same color atlas without borrowing a different asset', () => {
  const image = (dir, name) => ({ name, ext: 'png', url: dir + '/' + name })
  const root = '/local-files/root/Textures/Oak'
  const albedo = image(root + '/Colored', 'T_Oak01_D.png')
  const opacity = image(root, 'T_Oak01_O.png')
  const id = image(root, 'T_Oak01_ID.png')
  const wrongTree = image(root, 'T_Oak02_O.png')
  const wrongFolder = image('/local-files/other/Textures/Oak', opacity.name)
  const sources = [opacity, id, wrongTree, wrongFolder]

  assert.equal(companionTexture(albedo, sources, opacitySuffix), opacity)
  assert.equal(companionTexture(albedo, sources, idSuffix), id)
  assert.equal(companionTexture(albedo, [wrongTree, wrongFolder], opacitySuffix), undefined)
  for (const name of ['T_Oak01_O.png', 'T_Oak01_ID.png', 'T_Oak01_M.png', 'T_Oak01_N.png']) {
    assert.equal(isDataMap(image(root, name)), true)
  }
  assert.equal(isDataMap(albedo), false)
})

test('vertex mask detection distinguishes black and separated channels from painted gradients', () => {
  const mask = new THREE.Float32BufferAttribute([
    0, 0, 0, .8, .9, 0, .6, 1, 0, 0, .7, .5,
  ], 3)
  const painted = new THREE.Float32BufferAttribute([
    0, 0, 0, .5, .38, .25, .6, .34, .22, .8, .41, .18,
  ], 3)
  const saturated = new THREE.Float32BufferAttribute([
    .8, .2, 0, .9, .1, 0, .7, .3, 0, .8, .2, 0,
  ], 3)
  assert.equal(resemblesVertexMask(mask), true)
  assert.equal(resemblesVertexMask(painted), false)
  assert.equal(resemblesVertexMask(saturated), false)
})
