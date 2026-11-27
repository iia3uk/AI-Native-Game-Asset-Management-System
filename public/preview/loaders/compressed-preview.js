import * as THREE from 'three'

const loaderByFormat = { dds: 'DDSLoader', ktx: 'KTXLoader', ktx2: 'KTX2Loader', pvr: 'PVRLoader' }
export const compressedImages = new Set(Object.keys(loaderByFormat))

export async function compressedImageUrl(file) {
  const name = loaderByFormat[file.ext]
  const module = await import('three/addons/loaders/' + name + '.js')
  const renderer = new THREE.WebGLRenderer({ alpha: true, preserveDrawingBuffer: true })
  const loader = new module[name]()
  let texture, quad
  try {
    if (file.ext === 'ktx2') {
      loader.setTranscoderPath('/vendor/three/examples/jsm/libs/basis/').detectSupport(renderer)
    }
    texture = await loader.loadAsync(file.url)
    const { width, height } = texture.image ?? {}
    if (!width || !height || texture.isCubeTexture || texture.isDataArrayTexture || texture.isCompressedArrayTexture || texture.isData3DTexture) {
      throw new Error('Предпросмотр доступен для двумерных текстур')
    }
    const limit = renderer.capabilities.maxTextureSize
    if (width > limit || height > limit) throw new Error('Текстура превышает максимальный размер, поддерживаемый браузером')
    if (texture.isCompressedTexture) {
      const { WebGLUtils } = await import('/vendor/three/src/renderers/webgl/WebGLUtils.js')
      if (WebGLUtils(renderer.getContext(), renderer.extensions).convert(texture.format, texture.colorSpace) === null) {
        throw new Error('Видеокарта или браузер не поддерживает кодек этой текстуры')
      }
    }
    texture.minFilter = THREE.LinearFilter
    texture.needsUpdate = true
    const scale = Math.min(1, 2048 / Math.max(width, height))
    renderer.setSize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), false)
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 2)
    camera.position.z = 1
    quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false }))
    scene.add(quad)
    renderer.render(scene, camera)
    const image = await new Promise(resolve => renderer.domElement.toBlob(resolve, 'image/png'))
    if (!image) throw new Error('Не удалось подготовить изображение')
    return URL.createObjectURL(image)
  } finally {
    quad?.geometry.dispose()
    quad?.material.dispose()
    texture?.dispose()
    loader.dispose?.()
    renderer.dispose()
    renderer.forceContextLoss()
  }
}
