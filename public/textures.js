export const colorSuffix = /[ _.-]+(?:base[ _-]?(?:colou?r|map)|albedo|alb|diffuse|diff|colou?r|bc|d)$/i
const dataSuffix = /[ _.-]+(?:nrm|normal(?:[ _-]?(?:dx|gl|map))?|norm|spe|specular|rough(?:ness)?|metal(?:lic|ness)?|ao|occlusion|orm|arm|rma|mro|mask\d*|splat\d*|opacity|alpha|height|bump|displacement|emissive)$/i

export const textureName = file => file.name.slice(0, -(file.ext.length + 1))
export const isDataMap = file => dataSuffix.test(textureName(file))

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
