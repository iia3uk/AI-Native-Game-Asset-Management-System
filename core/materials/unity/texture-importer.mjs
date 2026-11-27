export function unityTextureImporter(meta) {
  if (!/^TextureImporter:[ \t]*\r?$/m.test(meta)) return null
  const flag = name => meta.match(new RegExp(`^ +${name}:[ \\t]*([01])[ \\t]*\\r?$`, 'm'))?.[1]
  const srgb = flag('sRGBTexture')
  const flip = flag('flipGreenChannel')
  const type = meta.match(/^  textureType:[ \t]*(\d+)[ \t]*\r?$/m)?.[1]
  const convertToNormal = flag('convertToNormalMap')
  return {
    colorSpace: srgb === undefined ? null : srgb === '1' ? 'srgb' : 'linear',
    normalMap: type === undefined ? null : type === '1',
    flipGreen: flip === undefined ? null : flip === '1',
    convertToNormal: convertToNormal === undefined ? null : convertToNormal === '1',
  }
}
