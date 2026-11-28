import { cookedMeshLod, meshPoints } from './unreal-cooked-static-mesh.mjs'
import { long, words, zenFixtureName, zenName, zenPackage } from './unreal-zen-package.mjs'

export function zenStaticMeshPackage(mode, { publicHash, material, materialHash } = {}) {
  const ue54 = mode !== 'ue53'
  const names = [zenFixtureName, 'Sample', 'None', 'Paint', 'Trim']
  const primary = cookedMeshLod(meshPoints, [0, 1, 2, 2, 1, 3], [[1, 0, 1], [0, 3, 1]], { zen: true })
  const secondary = cookedMeshLod(meshPoints.slice(0, 3), [0, 1, 2], [[0, 0, 1]], { zen: true, wide: true, external: true })
  const bulk = Buffer.concat([Buffer.alloc(13, 0x78), secondary.bulkData])
  const bulkOffset = mode === 'broken' ? 14 : 13
  const bulkMap = Buffer.concat([long(bulkOffset), long(0), long(secondary.bulkData.length), words(0x101, 0)])
  const bounds = Buffer.alloc(56)
  for (const [index, value] of [100, 50, 0, 100, 50, 0, 112].entries()) bounds.writeDoubleLE(value, 8 * index)
  const screen = Buffer.alloc(64)
  for (const [index, value] of [1, 0.45, 0, 0, 0, 0, 0, 0].entries()) {
    screen.writeUInt32LE(1, index * 8)
    screen.writeFloatLE(value, index * 8 + 4)
  }
  const object = Buffer.concat([
    ...(ue54 ? [Buffer.from([0])] : []), zenName(names, 'None'), words(0), Buffer.from([1, 0]),
    words(1, 0, 0), Buffer.alloc(16), words(0, 2),
    primary.exportData, secondary.exportData,
    Buffer.from([1, 3, 0, 1, 2, 1, 1]), bounds, words(1), screen,
    ...(ue54 ? [Buffer.from([1, 0])] : []),
    words(0, 2), ...['Paint', 'Trim'].flatMap((label, slot) =>
      [words(material && slot === 0 ? 0xfffffffe : 0), zenName(names, label), Buffer.alloc(24)]),
  ])
  return { asset: zenPackage({ ue54, names, classId: 0x407cde1a593e47cfn, bulkMap, object, publicHash,
    ...(material && { importedNames: [material], importedHashes: [materialHash], importedObjects: [2n << 62n] }) }), bulk }
}
