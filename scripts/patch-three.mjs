import { readFile, writeFile } from 'node:fs/promises'
import { extendedSkinningPatches } from './three/extended-skinning.mjs'
import { fbxSkinningPatches } from './three/fbx-skinning.mjs'

const fbx = [
  // Some exporters leave the normal layer header without a normal array.
  ['if ( geoNode.LayerElementNormal ) {', 'if ( geoNode.LayerElementNormal?.[ 0 ]?.Normals?.a?.length ) {'],
  // AllSame can refer to a material other than the first one in the list.
  ['this.addMorphTargets( geo, geoNode, morphTargets, preTransform );',
    `if ( geoInfo.material?.mappingType === 'AllSame' && buffers.vertex.length ) {

\t\t\tgeo.addGroup( 0, buffers.vertex.length / 3, geoInfo.material.buffer[ 0 ] ?? 0 );

\t\t}

\t\tthis.addMorphTargets( geo, geoNode, morphTargets, preTransform );`],
]
const ply = [
  // Per-face UVs can turn a triangle mesh into non-indexed geometry.
  ['geometry.computeBoundingSphere();',
    'geometry.userData.hasPlyFaces = buffer.indices.length > 0;\n\t\t\tgeometry.computeBoundingSphere();'],
]
const vtk = [
  ['new Uint8Array( data, 0, 250 )', 'new Uint8Array( data, 0, Math.min( data.byteLength, 250 ) )'],
  ["meta[ 2 ].includes( 'ASCII' )", "meta[ 2 ]?.includes( 'ASCII' )"],
]
const rhino = [['export { Rhino3dmLoader };', 'export { Rhino3dmLoader, Rhino3dmWorker };']]
const loaderPatches = [['FBXLoader.js', [...fbx, ...fbxSkinningPatches]], ['PLYLoader.js', ply], ['VTKLoader.js', vtk], ['3DMLoader.js', rhino]]
  .map(([name, patches]) => ['examples/jsm/loaders/' + name, patches])
for (const [name, patches] of [...loaderPatches, ...extendedSkinningPatches]) {
  const loader = new URL('../node_modules/three/' + name, import.meta.url)
  const original = await readFile(loader, 'utf8')
  let source = original
  for (const [before, after] of patches) {
    if (source.includes(after)) continue
    if (!source.includes(before)) throw new Error('Review the ' + name + ' patch for ' + before.split('\n')[0].trim())
    source = source.replace(before, after)
  }
  if (source !== original) await writeFile(loader, source, 'utf8')
}
