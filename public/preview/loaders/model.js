import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js'
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js'
import { TDSLoader } from 'three/addons/loaders/TDSLoader.js'
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js'
import { geometryModel, loadExtraModel } from './extra-models.js'
import { loadObj } from './obj.js'

export async function loadModel(type, file, { manager, findResource, renderer }) {
  let model
  let animations = []
  if (type === 'gltf' || type === 'glb') {
    const draco = new DRACOLoader(manager)
    draco.setDecoderPath('/vendor/three/examples/jsm/libs/draco/gltf/')
    const ktx2 = new KTX2Loader(manager).setTranscoderPath('/vendor/three/examples/jsm/libs/basis/').detectSupport(renderer)
    const loader = new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder).setKTX2Loader(ktx2)
    try {
      const loaded = await loader.loadAsync(file.preview)
      model = loaded.scene
      animations = loaded.animations
    } finally {
      draco.dispose()
      ktx2.dispose()
    }
  } else if (type === 'fbx') {
    model = await new FBXLoader(manager).loadAsync(file.preview)
    animations = model.animations
  } else if (type === 'obj') {
    model = await loadObj(file, manager, findResource)
  } else if (type === 'dae') {
    const loaded = await new ColladaLoader(manager).loadAsync(file.preview)
    model = loaded.scene
    animations = model.animations ?? []
  } else if (type === '3ds' || type === '3mf') {
    const loader = type === '3ds' ? new TDSLoader(manager) : new ThreeMFLoader(manager)
    model = await loader.loadAsync(file.preview)
  } else if (type === 'stl' || type === 'ply') {
    const loader = type === 'stl' ? new STLLoader(manager) : new PLYLoader(manager)
    const geometry = await loader.loadAsync(file.preview)
    model = geometryModel(geometry, type === 'ply' && geometry.userData.hasPlyFaces === false)
  } else {
    const loaded = await loadExtraModel(type, file.preview, manager)
    model = loaded.model
    animations = loaded.animations ?? model.animations ?? []
  }
  return { model, animations }
}
