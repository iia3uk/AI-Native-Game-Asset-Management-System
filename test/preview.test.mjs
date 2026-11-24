import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js'
import { geometryBounds, hasTextureImage, PreviewParts } from '../public/parts.js'
import { normalizeFbx, normalizeFbxVertexColors } from '../public/stage.js'

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
