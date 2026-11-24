export const colorSuffix = /[ _.-]+(?:base[ _-]?(?:colou?r|map)|albedo|alb|diffuse|diff|colou?r|bc|d)$/i
const dataSuffix = /[ _.-]+(?:id|m|n|o|nrm|normal(?:[ _-]?(?:dx|gl|map))?|norm|spe|specular|rough(?:ness)?|metal(?:lic|ness)?|ao|occlusion|orm|arm|rma|mro|mask\d*|splat\d*|opacity|alpha|height|bump|displacement|emissive)$/i
export const opacitySuffix = /[ _.-]+(?:opacity|alpha|o)$/i
export const idSuffix = /[ _.-]+(?:id|material[ _-]?id)$/i

export const textureName = file => file.name.slice(0, -(file.ext.length + 1))
export const isDataMap = file => dataSuffix.test(textureName(file))

const textureDirectory = file => file.url.slice(0, file.url.lastIndexOf('/')).toLowerCase()

export function companionTexture(color, images, suffix) {
  if (!colorSuffix.test(textureName(color))) return undefined
  const stem = textureName(color).replace(colorSuffix, '').toLowerCase()
  const directory = textureDirectory(color)
  const candidates = images.filter(file => {
    const name = textureName(file)
    return suffix.test(name) && name.replace(suffix, '').toLowerCase() === stem
  })
  const own = candidates.filter(file => textureDirectory(file) === directory)
  if (own.length === 1) return own[0]
  if (own.length || !directory.endsWith('/colored')) return undefined
  const sibling = candidates.filter(file => textureDirectory(file) === directory.slice(0, -'/colored'.length))
  return sibling.length === 1 ? sibling[0] : undefined
}

export function resemblesVertexMask(color) {
  let black = 0
  let separated = 0
  for (let index = 0; index < color.count; index++) {
    const r = color.getX(index), g = color.getY(index), b = color.getZ(index)
    const high = Math.max(r, g, b)
    if (high < .03) black++
    else if (high > .4 && Math.min(r, g, b) < .005) separated++
  }
  return color.count > 0 && black / color.count >= .05 && separated / color.count >= .25
}

export function preferColoredImage(image, images) {
  if (!image || !colorSuffix.test(textureName(image))) return image
  const slash = image.url.lastIndexOf('/')
  const parent = image.url.slice(0, slash).toLowerCase()
  if (parent.endsWith('/colored')) return image
  const expected = parent + '/colored/' + image.url.slice(slash + 1).toLowerCase()
  const matches = images.filter(file => file.url.toLowerCase() === expected)
  return matches.length === 1 ? matches[0] : image
}

export function copyTextureMapping(target, source, flipY) {
  target.flipY = source?.flipY ?? flipY
  if (!source) return
  target.channel = source.channel
  target.wrapS = source.wrapS
  target.wrapT = source.wrapT
  target.repeat.copy(source.repeat)
  target.offset.copy(source.offset)
  target.center.copy(source.center)
  target.rotation = source.rotation
  target.matrixAutoUpdate = source.matrixAutoUpdate
  target.matrix.copy(source.matrix)
}
