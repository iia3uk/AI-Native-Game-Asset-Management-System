import { cookedAudioRevision, looseAudioResult } from '../../../engines/unreal/decoder/audio-protocol.mjs'
import { cue4parseVersion } from '../../../engines/unreal/decoder/run.mjs'
import { cookedAudioMethod, publishContainerAudio } from '../container-audio.mjs'
import { publishLooseBatch } from './batch.mjs'

const options = { method: cookedAudioMethod, converterVersion: cue4parseVersion + '-loose-' + cookedAudioRevision,
  outputIssue: 'unreal-cooked-audio-output' }

export function publishLooseCookedAudio(inputs, settings) {
  const ready = inputs.filter(({ asset }) => !asset.exports.some(item =>
    ['texture', 'audio'].includes(item.role) && item.status === 'converted'))
  return publishLooseBatch(ready, settings, { type: 'audio', validate: looseAudioResult,
    publish: publishContainerAudio, options })
}
