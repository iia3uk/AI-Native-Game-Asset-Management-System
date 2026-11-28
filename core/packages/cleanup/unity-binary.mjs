const atlasId = (member, pathId) => member + ':' + pathId
const converted = asset => asset?.status === 'converted' && Boolean(asset.artifact?.path) &&
  asset.artifact.status === 'converted'

export function unityBinaryReadyForCleanup(assets) {
  const results = assets.filter(converted)
  if (!results.length) return false
  const usedAtlases = new Set()
  for (const { member, sprite } of results) {
    if (sprite?.packed) usedAtlases.add(atlasId(member, sprite.packed.atlasPathId))
  }
  return assets.every(asset => {
    if (converted(asset)) return asset.classId !== 21
    if (asset?.status !== 'unsupported') return false
    if (asset.classId === 142) return asset.issue === 'unity-bundle-class-unsupported'
    return asset.classId === 687078895 && asset.issue === 'unity-bundle-sprite-atlas-container' &&
      usedAtlases.has(atlasId(asset.member, asset.pathId))
  })
}
