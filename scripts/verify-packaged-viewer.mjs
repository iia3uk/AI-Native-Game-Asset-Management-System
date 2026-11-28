import { createRequire } from 'node:module'
import { access } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { bridgeScripts } from '../core/engines/unity/bridge/project.mjs'
import { unrealBridgeScripts } from '../core/engines/unreal/bridge/project.mjs'
import { verifyUnrealWorker } from './packaging/verify-unreal-worker.mjs'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const { statFile } = builderRequire('@electron/asar')

export default async function verifyPackagedViewer({ appOutDir, electronPlatformName }) {
  if (electronPlatformName !== 'win32') return
  const resources = join(appOutDir, 'resources')
  const archive = join(resources, 'app.asar')
  for (const path of [
    'desktop/window/startup.mjs',
    'desktop/window/failure.mjs',
    'desktop/package-cleanup/ipc.mjs',
    'core/packages/cleanup/plan.mjs',
    'public/package-importer/cleanup.js',
    'public/app.js',
    'public/catalog/classification.js',
    'public/catalog/pack-list.js',
    'public/catalog/file-list.js',
    'core/library/local-folders.mjs',
    'core/index/schema/package-watch.mjs',
    'core/processing/package-watch.mjs',
    'core/packages/watch-formats.mjs',
    'public/library/package-watch.js',
    'core/materials/unity/folder-bindings.mjs',
    'core/materials/unity/preview-bindings.mjs',
    'core/materials/unity/yaml.mjs',
    'core/packages/unity/material-outputs.mjs',
    'public/library/index-thumbnail.js',
    'public/preview/stage.js',
    'public/preview/loaders/model.js',
    'public/preview/loaders/audio-preview.js',
    'public/preview/materials/external-textures.js',
    'public/preview/materials/packed-channels.js',
    'public/preview/materials/unity-preview.js',
    'public/styles/viewer.css',
    'core/thumbnails/thumbnail-render.mjs',
    'core/packages/unity/import.mjs',
    'core/packages/unity/folder/inspect.mjs',
    'core/packages/dispatch.mjs',
    'core/packages/detect.mjs',
    'core/packages/folder.mjs',
    'scripts/cli/package-folder.mjs',
    'scripts/cli/package-export.mjs',
    'core/packages/manifest-page.mjs',
    'core/packages/export/plan.mjs',
    'core/packages/export/dependencies.mjs',
    'core/packages/export/publish.mjs',
    'core/packages/source.mjs',
    'core/packages/workspace.mjs',
    'core/packages/unity/bundle/cache.mjs',
    'core/packages/unity/bundle/dependencies.mjs',
    'core/packages/unity/bundle/fingerprint.mjs',
    'core/packages/unity/bundle/watch-source.mjs',
    'core/packages/unity/bundle/source.mjs',
    'core/packages/unity/bundle/import.mjs',
    'core/conversion/unity/bundle-audio.mjs',
    'core/packages/unreal/pak/cache.mjs',
    'core/packages/unreal/pak/import.mjs',
    'core/packages/unreal/loose/source.mjs',
    'core/packages/unreal/loose/inspect.mjs',
    'core/packages/unreal/loose/import.mjs',
    'core/packages/unreal/loose/convert.mjs',
    'core/packages/unreal/loose/viewer.mjs',
    'core/engines/unreal/viewer/run.mjs',
    'core/engines/unreal/viewer/inputs.mjs',
    'core/conversion/unreal/viewer/model.mjs',
    'core/conversion/unreal/viewer/animation.mjs',
    'core/conversion/unreal/viewer/publish.mjs',
    'core/conversion/unreal/viewer/derivatives.mjs',
    'core/conversion/unreal/viewer/bind-materials.mjs',
    'core/conversion/unreal/viewer/materials.mjs',
    'core/conversion/unreal/viewer/packed-maps.mjs',
    'core/materials/unreal/describe.mjs',
    'core/materials/unreal/packed-layout.mjs',
    'core/materials/unreal/viewer-properties.mjs',
    'core/conversion/unreal/preview.mjs',
    'core/conversion/unreal/source-media/extract.mjs',
    'core/conversion/unreal/source-media/payload.mjs',
    'core/engines/unreal/source-mesh/package.mjs',
    'core/engines/unreal/source-mesh/worker.mjs',
    'core/conversion/unreal/source-mesh/publish.mjs',
    'core/conversion/unreal/source-mesh/gltf.mjs',
    'core/engines/inventory.mjs',
    'core/engines/blender/preview.mjs',
    'core/engines/unity/bundle/run.mjs',
    'core/engines/unity/bundle/stage-file.mjs',
    'core/engines/unreal/decoder/run.mjs',
    'core/engines/unreal/decoder/protocol.mjs',
    ...bridgeScripts.map(file => 'core/engines/unity/bridge/editor/' + file),
    ...unrealBridgeScripts.map(file => 'core/engines/unreal/bridge/editor/' + file),
    'public/package-importer/index.js',
    'public/package-importer/folder.js',
    'public/package-importer/folder-processing.js',
    'public/package-importer/export.js',
    'public/package-importer/formats.js',
    'core/packages/export/processed.mjs',
    'core/engines/unity/serialized/header.mjs',
    'core/engines/unity/serialized/companions.mjs',
    'core/files/hash.mjs',
    'core/files/png-structure.mjs',
    'core/files/png-rgb.mjs',
    'node_modules/three/build/three.module.js',
    'node_modules/three/examples/jsm/controls/OrbitControls.js',
    'node_modules/three/examples/jsm/loaders/GLTFLoader.js',
    'node_modules/three/examples/jsm/loaders/OBJLoader.js',
    'node_modules/three/examples/jsm/loaders/3DMLoader.js',
    'node_modules/three/examples/jsm/libs/draco/gltf/draco_decoder.wasm',
    'node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm',
    'node_modules/rhino3dm/rhino3dm.wasm',
    'node_modules/@threenative/raw-unreal/dist/index.js',
    'node_modules/@threenative/raw-unreal/LICENSE',
  ]) {
    if (!statFile(archive, normalize(path)).size) throw new Error('Missing renderer dependency in app.asar: ' + path)
  }
  await access(join(resources, 'app.asar.unpacked', 'scripts', 'export-blend.py'))
  for (const path of [
    'AssetViewer.UnityBundle.exe', 'AssetViewer.UnityBundle.dll', 'AssetsTools.NET.dll', 'coreclr.dll',
    'Notices/AssetsTools.NET.LICENSE.txt', 'Notices/LICENSE.TXT', 'Notices/THIRD-PARTY-NOTICES.TXT',
  ]) {
    await access(join(resources, 'unity-bundle', path))
  }
  await verifyUnrealWorker(join(resources, 'cue4parse'))
  for (const script of ['batch.py', 'stage_inputs.py']) {
    await access(join(resources, 'app.asar.unpacked', 'core', 'engines', 'blender', 'scripts', script))
  }
}
