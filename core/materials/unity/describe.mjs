import { unityMaterialSlot, unityShaderProfile } from './shaders.mjs'

export function describeUnityMaterial(material, source, resolveTexture) {
  const inherited = material.parent?.fileID && material.parent.fileID !== '0'
  const profile = inherited ? null : unityShaderProfile(material.shader)
  const keywords = new Set(material.keywords)
  const textures = material.textures.map(({ property, reference, scale, offset }) => {
    const target = reference && reference.fileID !== '0' ? resolveTexture(reference) : null
    const roles = unityMaterialSlot(profile, property, material.numbers, keywords)
    return { property, reference, scale, offset, roles,
      target: target ?? null, status: !reference || reference.fileID === '0' ? 'unassigned' : target?.status ?? 'unresolved' }
  })
  return {
    schemaVersion: 1, source: { ...source, engine: 'unity', fileID: material.fileID }, name: material.name,
    shader: { reference: material.shader, profile, parent: material.parent },
    properties: { numbers: material.numbers, colors: material.colors, keywords: material.keywords },
    textures,
  }
}
