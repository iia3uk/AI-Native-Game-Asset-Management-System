import { createRequire } from 'node:module'
import { access } from 'node:fs/promises'
import { join, normalize } from 'node:path'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const { statFile } = builderRequire('@electron/asar')

export default async function verifyPackagedViewer({ appOutDir, electronPlatformName }) {
  if (electronPlatformName !== 'win32') return
  const resources = join(appOutDir, 'resources')
  const archive = join(resources, 'app.asar')
  for (const path of [
    'public/app.js',
    'node_modules/three/build/three.module.js',
    'node_modules/three/examples/jsm/controls/OrbitControls.js',
    'node_modules/three/examples/jsm/loaders/GLTFLoader.js',
    'node_modules/three/examples/jsm/loaders/3DMLoader.js',
    'node_modules/three/examples/jsm/libs/draco/gltf/draco_decoder.wasm',
    'node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm',
    'node_modules/rhino3dm/rhino3dm.wasm',
  ]) {
    if (!statFile(archive, normalize(path)).size) throw new Error('Missing renderer dependency in app.asar: ' + path)
  }
  await access(join(resources, 'app.asar.unpacked', 'scripts', 'export-blend.py'))
}
