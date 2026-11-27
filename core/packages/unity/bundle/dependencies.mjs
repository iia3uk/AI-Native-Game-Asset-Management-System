export function bundleDependencies(assets) {
  const entries = assets.filter(asset => asset.sprite).map(({ member, pathId, sprite }) => ({
    type: 'sprite-texture',
    from: { member, pathId },
    to: { member, pathId: sprite.texturePathId },
  }))
  return { version: 1, status: entries.length ? 'partial' : 'unavailable', entries }
}
