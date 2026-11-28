import { posix } from 'node:path'

const signals = Object.freeze({
  basecolor: ['baseColor', 'sRGB', 'Diffuse'],
  albedo: ['baseColor', 'sRGB', 'Diffuse'],
  normal: ['normal', 'linear', 'Normal'],
  roughness: ['roughness', 'linear'],
  metallic: ['metallic', 'linear'],
  metalness: ['metallic', 'linear'],
  ambientocclusion: ['ambientOcclusion', 'linear'],
  emissive: ['emissive', 'sRGB', 'Emissive'],
  opacity: ['opacity', 'linear', 'Opacity'],
  height: ['height', 'linear'],
  displacement: ['displacement', 'linear'],
  specular: ['specular', 'linear', 'Specular'],
  orm: ['packed', 'linear'],
  rma: ['packed', 'linear'],
  mra: ['packed', 'linear'],
})
const key = name => name.toLowerCase().replace(/[ _-]/g, '')

export function describeUnrealMaterial({ asset, properties, slots, resolve, version }) {
  const bindings = properties.textures.map(({ name, path }) => {
    const [role = null, colorSpace = null, corroboration] = Object.hasOwn(signals, key(name)) ? signals[key(name)] : []
    const texture = resolve(path)
    const artifact = texture?.exports.find(item => item.path && item.role === 'texture' && item.format === 'png')
    return { parameter: name, sourcePath: path, role, colorSpace, textureId: texture?.id ?? null,
      path: artifact?.path ?? null, status: artifact ? 'resolved' : texture ? 'missing-output' : 'missing',
      corroborated: !!corroboration && slots[corroboration] === posix.basename(path, '.uasset') }
  })
  return {
    schemaVersion: 1, source: { engine: 'unreal', path: asset.sourcePath, sha256: asset.hash },
    method: 'ue-viewer-properties', converterVersion: version,
    parent: properties.parent, scalars: properties.scalars, slots, bindings,
    limitations: ['shader-graph-not-reconstructed', 'texture-color-space-from-parameter-role',
      'normal-orientation-and-packed-channels-unverified'],
  }
}
