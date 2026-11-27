import { closest } from '../resource-proximity.js'
import { colorSuffix, companionTexture, isDataMap, opacitySuffix, preferColoredImage, textureName } from './textures.js'

export function materialStem(name = '') {
  return name.toLowerCase().replace(/\.(?:fbx|obj|blend|gltf|glb)$/, '')
    .replace(/[ _.-]+lod[ _.-]?\d+(?:[ _.-]+material[ _.-]?\d+)?$/, '')
    .replace(/^(?:mi|m|t|sm|sk)[_ -]+(?:g[_ -]+)?/, '').replace(/[^a-z\d]/g, '')
}

export function findColorTexture(key, file, images) {
  const stem = materialStem(key)
  if (!stem || /^(?:default(?:material)?\d*|lambert\d*|material\d*|blinn\d*)$/.test(stem)) return
  const matches = suffix => images.filter(item => {
    const name = textureName(item)
    return suffix.test(name) && materialStem(name.replace(suffix, '')) === stem
  })
  const chooseColor = candidates => closest([...new Set(candidates.map(item => preferColoredImage(item, images)))], file)
  const color = chooseColor(matches(colorSuffix))
  if (color) {
    const alpha = companionTexture(color, images, opacitySuffix) ?? closest(matches(opacitySuffix), file)
    return { url: color.url, alphaUrl: alpha?.url, alphaTest: alpha ? .5 : undefined }
  }
  const byName = new Map()
  for (const item of images) {
    const name = textureName(item)
    if (!colorSuffix.test(name)) continue
    const folder = materialStem(item.path.split('/').at(-2))
    if (stem.length < 6 && folder !== stem) continue
    const family = name.replace(colorSuffix, '').replace(/[ _.-]+[a-z\d]+$/i, '')
    const familyStem = materialStem(family)
    if (familyStem !== stem && !(folder === stem && familyStem + 's' === stem)) continue
    const entries = byName.get(name.toLowerCase()) ?? []
    entries.push(item)
    byName.set(name.toLowerCase(), entries)
  }
  const variants = [...byName.values()].map(chooseColor).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
  if (variants.length) return { url: variants[0].url, variants }
  if (file.url.startsWith('/local-files/')) {
    const plain = closest(images.filter(item => !isDataMap(item) && materialStem(textureName(item)) === stem), file)
    if (plain) return { url: plain.url }
  }
}
