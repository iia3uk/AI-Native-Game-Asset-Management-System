import { posix } from 'node:path'
import { packedLayout } from './packed-layout.mjs'

const signals = Object.freeze({
  basecolor: ['baseColor', 'sRGB', 'Diffuse'],
  albedo: ['baseColor', 'sRGB', 'Diffuse'],
  normal: ['normal', 'linear', 'Normal'],
  normalmap: ['normal', 'linear', 'Normal'],
  roughness: ['roughness', 'linear'],
  metallic: ['metallic', 'linear'],
  metalness: ['metallic', 'linear'],
  ambientocclusion: ['ambientOcclusion', 'linear'],
  emissive: ['emissive', 'sRGB', 'Emissive'],
  opacity: ['opacity', 'linear', 'Opacity'],
  height: ['height', 'linear'],
  displacement: ['displacement', 'linear'],
  specular: ['specular', 'linear', 'Specular'],
})
const key = name => name.toLowerCase().replace(/[ _-]/g, '')

export function describeUnrealMaterial({ asset, properties, slots = {}, resolve, version,
  method = 'ue-viewer-properties', corroborate }) {
  const bindings = properties.textures.map(({ name, path }) => {
    const parameter = key(name)
    const layout = packedLayout(parameter)
    const [role = null, colorSpace = null, evidence] =
      layout ? ['packed', 'linear'] : Object.hasOwn(signals, parameter) ? signals[parameter] : []
    const nameInSlot = posix.basename(path, '.uasset')
    const corroborated = corroborate ? !!role && corroborate(path) : layout ? Object.entries(slots).some(([slot, value]) =>
      (slot === 'Mask' || /^Other\[\d+\]$/.test(slot)) && value === nameInSlot) :
      !!evidence && slots[evidence] === nameInSlot
    const texture = resolve(path)
    const artifact = texture?.exports.find(item => item.path && item.role === 'texture' && item.format === 'png')
    return { parameter: name, sourcePath: path, role, colorSpace, textureId: texture?.id ?? null,
      path: artifact?.path ?? null, status: artifact ? 'resolved' : texture ? 'missing-output' : 'missing',
      corroborated, ...(layout && { layout }) }
  })
  return {
    schemaVersion: 1, source: { engine: 'unreal', path: asset.sourcePath, sha256: asset.hash },
    method, converterVersion: version,
    parent: properties.parent, scalars: properties.scalars, slots, bindings,
    limitations: ['shader-graph-not-reconstructed', 'texture-color-space-from-parameter-role',
      'normal-orientation-unverified', 'unreal-packed-shader-operations-unverified'],
  }
}
