import { ShaderChunk } from 'three'

const roles = {
  roughness: ['roughnessmap_fragment', 'texelRoughness.g'],
  metallic: ['metalnessmap_fragment', 'texelMetalness.b'],
  ambientOcclusion: ['aomap_fragment', 'texture2D( aoMap, vAoMapUv ).r'],
}

function channelExpression(sample, { channels, operation, range }) {
  if (!/^[rgba]$/.test(channels) || range?.length !== 2 ||
      range.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return null
  const [low, high] = range.map(value => value.toFixed(8))
  const raw = sample.slice(0, -1) + channels
  const mapped = range[0] === 0 && range[1] === 1 ? raw : `mix( ${low}, ${high}, ${raw} )`
  return operation === 'one-minus-smoothness' ? `( 1.0 - ${mapped} )` : mapped
}

export function bindPackedChannels(material, maps) {
  const overrides = []
  for (const [role, [chunkName, sample]] of Object.entries(roles)) {
    if (!maps[role]) continue
    const expression = channelExpression(sample, maps[role])
    if (expression && expression !== sample) {
      overrides.push([chunkName, sample, expression])
    }
  }
  if (!overrides.length) return
  material.onBeforeCompile = shader => {
    for (const [chunkName, sample, expression] of overrides) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <' + chunkName + '>',
        ShaderChunk[chunkName].replace(sample, expression))
    }
  }
  material.customProgramCacheKey = () => JSON.stringify(overrides)
}
