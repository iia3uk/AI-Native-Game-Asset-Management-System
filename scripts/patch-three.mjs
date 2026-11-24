import { readFile, writeFile } from 'node:fs/promises'

// Some FBX exporters leave the normal layer header without a normal array.
const loader = new URL('../node_modules/three/examples/jsm/loaders/FBXLoader.js', import.meta.url)
const original = 'if ( geoNode.LayerElementNormal ) {'
const guarded = 'if ( geoNode.LayerElementNormal?.[ 0 ]?.Normals?.a?.length ) {'
const source = await readFile(loader, 'utf8')
if (!source.includes(guarded)) {
  if (!source.includes(original)) throw new Error('Review the FBX normal-layer guard for this version of three.js')
  await writeFile(loader, source.replace(original, guarded), 'utf8')
}
