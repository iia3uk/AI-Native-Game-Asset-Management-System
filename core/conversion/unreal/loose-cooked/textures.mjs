import { looseTextureResult, looseTextureRevision } from '../../../engines/unreal/decoder/protocol.mjs'
import { cue4parseVersion } from '../../../engines/unreal/decoder/run.mjs'
import { publishContainerTexture } from '../container-texture.mjs'
import { publishLooseBatch } from './batch.mjs'

const options = { method: 'cue4parse-cooked-texture', converterVersion: cue4parseVersion + '-loose-' + looseTextureRevision,
  outputIssue: 'unreal-cooked-texture-output' }

export function publishLooseCookedTextures(inputs, settings) {
  const ready = inputs.filter(({ asset }) => !asset.exports.some(item => item.role === 'texture' && item.status === 'converted'))
  return publishLooseBatch(ready, settings, { type: 'textures', validate: looseTextureResult,
    publish: publishContainerTexture, options })
}
