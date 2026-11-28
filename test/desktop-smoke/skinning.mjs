import assert from 'node:assert/strict'

async function renderSkinWeights() {
  const THREE = await import('/vendor/three/build/three.module.js')
  const renderer = new THREE.WebGLRenderer()
  const target = new THREE.WebGLRenderTarget(96, 48)
  renderer.setRenderTarget(target)
  const errors = []
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => errors.push(
    [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].join('\n'))
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, .5, -.5, .1, 10)
  camera.position.z = 2
  const material = new THREE.MeshStandardMaterial({ color: 0x72c078 })
  const light = new THREE.DirectionalLight(0xffffff, 2)
  light.position.set(0, -1, 1)
  scene.add(light, new THREE.AmbientLight(0xffffff, .1))
  const lastBoneRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)
  const lastBoneOffset = new THREE.Vector3(.65, 0, 0)
  const lastBoneWeight = .4

  function triangle() {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-.17, -.3, 0, .17, -.3, 0, 0, .3, 0], 3))
    geo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3))
    return geo
  }

  function skinned(x, primaryWeights, extraWeights) {
    const geo = triangle()
    const repeat = values => [...values, ...values, ...values]
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(repeat([0, 1, 2, 3]), 4))
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(repeat(primaryWeights), 4))
    if (extraWeights) {
      geo.setAttribute('joints_1', new THREE.Uint16BufferAttribute(repeat([4, 5, 6, 7]), 4))
      geo.setAttribute('weights_1', new THREE.Float32BufferAttribute(repeat(extraWeights), 4))
    }
    const mesh = new THREE.SkinnedMesh(geo, material)
    const bones = Array.from({ length: extraWeights ? 8 : 4 }, () => new THREE.Bone())
    mesh.add(...bones)
    mesh.position.x = x
    mesh.bind(new THREE.Skeleton(bones))
    mesh.normalizeSkinWeights()
    if (extraWeights) {
      bones[7].position.copy(lastBoneOffset)
      bones[7].quaternion.copy(lastBoneRotation)
    }
    return mesh
  }

  function reference(x, weight = 0) {
    const geo = triangle()
    for (const name of ['position', 'normal']) {
      const attribute = geo.getAttribute(name)
      for (let i = 0; i < attribute.count; i++) {
        const original = new THREE.Vector3().fromBufferAttribute(attribute, i)
        const rotated = original.clone().applyQuaternion(lastBoneRotation)
        if (name === 'position') rotated.add(lastBoneOffset)
        original.lerp(rotated, weight)
        attribute.setXYZ(i, original.x, original.y, original.z)
      }
    }
    const mesh = new THREE.Mesh(geo, material)
    mesh.position.x = x
    return mesh
  }

  function pixels(objects) {
    objects.forEach((mesh, order) => { mesh.renderOrder = order })
    scene.add(...objects)
    renderer.render(scene, camera)
    const bytes = new Uint8Array(target.width * target.height * 4)
    renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, bytes)
    scene.remove(...objects)
    return bytes
  }

  const extended = skinned(-.8, [.1, .05, 0, 0], [.05, .05, .05, .2])
  const regular = skinned(0, [.8, .1, .1, 0])
  const zero = skinned(.65, [0, 0, 0, 0], [0, 0, 0, 0])
  const referenceMeshes = [reference(-.8, lastBoneWeight), reference(0), reference(.65)]
  const expected = pixels(referenceMeshes)
  const actual = pixels([extended, regular, zero])
  const reverse = pixels([zero, regular, extended])
  const diff = bytes => bytes.reduce((count, value, i) => count + Number(Math.abs(value - expected[i]) > 2), 0)
  renderer.setRenderTarget(null)
  renderer.dispose()
  target.dispose()
  material.dispose()
  for (const mesh of [extended, regular, zero, ...referenceMeshes]) {
    mesh.geometry.dispose()
    mesh.skeleton?.dispose()
  }
  return { errors, differences: [diff(actual), diff(reverse)], litPixels: expected.filter((v, i) => i % 4 === 1 && v > 0).length }
}

export async function verifySkinning(webContents) {
  const { errors, differences, litPixels } = await webContents.executeJavaScript('(' + renderSkinWeights.toString() + ')()')
  assert.deepEqual(errors, [], errors.join('\n'))
  assert.ok(litPixels > 400)
  assert.deepEqual(differences, [0, 0], 'Skinned vertex positions and lighting should match baked geometry')
}
