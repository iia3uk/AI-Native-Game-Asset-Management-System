import assert from 'node:assert/strict'
import { writeUnityPreviewFixture } from '../fixtures/unity-preview.mjs'

async function renderUnityPreview(path) {
  const THREE = await import('/vendor/three/build/three.module.js')
  const { ModelStage } = await import('/preview/stage.js')
  const response = await fetch('/api/folder', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) })
  if (!response.ok) throw new Error(await response.text())
  const directory = await response.json()
  const group = directory.packs[0]
  const pack = await (await fetch('/api/folder/' + directory.id + '/group/' + group.id)).json()
  const file = pack.files.find(item => item.ext === 'fbx')
  const stage = new ModelStage(document.createElement('div'))
  const { renderer } = stage
  renderer.setAnimationLoop(null)
  stage.observer.disconnect()
  renderer.setPixelRatio(1)
  renderer.setSize(32, 32, false)
  const errors = []
  renderer.debug.onShaderError = (gl, program, vertex, fragment) => errors.push(
    [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].join('\n'))
  const report = await stage.load(file, directory.resources, pack.unityMaterials)
  const [{ materials: [authored], mesh: { geometry } }] = stage.parts.meshes
  const actualProperties = [authored.isMeshStandardMaterial, authored.map.colorSpace, authored.metalnessMap.colorSpace,
    authored.metalnessMap === authored.roughnessMap && authored.metalnessMap === authored.aoMap,
    authored.aoMap.channel, authored.normalScale.toArray(), authored.map.repeat.toArray(), authored.map.offset.toArray()]

  const renderScene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .1, 10)
  camera.position.set(0, 0, 2)
  const sun = new THREE.DirectionalLight(0xffffff, 2)
  sun.position.set(.3, .5, 2)
  const panel = new THREE.Mesh(geometry, authored)
  renderScene.add(new THREE.AmbientLight(0xffffff, 1.2), sun, panel)
  const target = new THREE.WebGLRenderTarget(32, 32)
  renderer.toneMapping = THREE.NoToneMapping
  renderer.setRenderTarget(target)
  function pixel(material) {
    panel.material = material
    renderer.render(renderScene, camera)
    const bytes = new Uint8Array(4)
    renderer.readRenderTargetPixels(target, 15, 15, 1, 1, bytes)
    return [...bytes]
  }

  const ao = new THREE.DataTexture(new Uint8Array([Math.round((.25 + .5 * 64 / 255) * 255), 255, 255, 255]), 1, 1)
  ao.needsUpdate = true
  const reference = new THREE.MeshStandardMaterial({ color: new THREE.Color(.75, 1, .625),
    map: authored.map, normalMap: authored.normalMap, normalScale: new THREE.Vector2(.75, -.75),
    metalness: .125 + .5 * 153 / 255, roughness: .875, aoMap: ao })
  const actual = pixel(authored)
  const expected = pixel(reference)
  reference.metalness = .125
  reference.roughness = .125
  const different = pixel(reference)
  renderer.setRenderTarget(null)

  const manualImage = directory.resources.find(item => item.name === 'Color.png')
  await stage.setManualTexture(0, manualImage)
  const manualApplied = stage.manualTexture(0) === manualImage.id
  await stage.setManualTexture(0, null)
  const manualRestored = stage.automaticTexture(0) === manualImage.url
  stage.clear()
  stage.scene.environment.dispose()
  stage.controls.dispose()
  renderer.dispose()
  target.dispose()
  reference.dispose()
  ao.dispose()
  return { triangles: report.triangles, actualProperties, actual, expected, different, errors, manualApplied, manualRestored }
}

export async function verifyUnityPreview(webContents, root) {
  const path = await writeUnityPreviewFixture(root)
  const result = await webContents.executeJavaScript('(' + renderUnityPreview.toString() + ')(' + JSON.stringify(path) + ')')
  assert.deepEqual(result.errors, [])
  assert.equal(result.triangles, 2)
  assert.deepEqual(result.actualProperties, [true, 'srgb', '', true, 0, [.75, -.75], [2, 3], [.25, .125]])
  assert.equal(result.actual[3], 255)
  assert.ok(result.actual.every((channel, index) => Math.abs(channel - result.expected[index]) <= 2), JSON.stringify(result))
  assert.ok(result.actual.some((channel, index) => Math.abs(channel - result.different[index]) >= 5), JSON.stringify(result))
  assert.equal(result.manualApplied, true)
  assert.equal(result.manualRestored, true)
}
