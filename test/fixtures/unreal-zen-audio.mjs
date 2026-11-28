import { readFileSync } from 'node:fs'
import { wavTone } from './unreal-pak.mjs'
import { long, words, zenFixtureName, zenName, zenPackage } from './unreal-zen-package.mjs'

// A half-second 440 Hz mono sine generated with FFmpeg and libvorbis, at 16 kHz.
export const zenOgg = readFileSync(new URL('./zen-tone.ogg', import.meta.url))
const engineSoundWave = 0x44f26264628e498dn
const inlineBulk = bytes => Buffer.concat([words(0x40, bytes.length, bytes.length), long(0), bytes])

export function zenAudioPackage(mode) {
  const streamed = mode !== 'pcm'
  const format = mode === 'unsupported' ? 'BINKA' : streamed ? 'OGG' : 'PCM'
  const names = [zenFixtureName, 'Sample', 'None', format, 'bStreaming', 'BoolProperty']
  const name = value => zenName(names, value)
  const properties = Buffer.concat([...(streamed ? [Buffer.from([0])] : []),
    name('bStreaming'), name('BoolProperty'), words(0, 0), streamed ? Buffer.from([0x10]) : Buffer.alloc(2), name('None')])
  const audio = streamed ? Buffer.from(zenOgg) : wavTone()
  if (mode === 'corrupt') audio[audio.length - 1] ^= 1
  const prefix = Buffer.concat([properties, words(0, 1), ...(streamed ? [words(0)] : [])])
  const guid = Buffer.alloc(16)
  let platform
  let bulk
  let bulkMap
  if (streamed) {
    const first = audio.subarray(0, 128)
    const last = audio.subarray(first.length)
    const padding = Buffer.alloc(16, 17)
    bulk = Buffer.concat([padding, last, padding])
    bulkMap = Buffer.concat([long(padding.length), long(0), long(last.length + padding.length), words(0x101, 0)])
    platform = Buffer.concat([guid, words(2), name(format),
      words(5), inlineBulk(first), words(first.length, first.length),
      words(3, 0, last.length + padding.length, last.length, 0)])
  } else {
    bulk = Buffer.from('No external sound data')
    bulkMap = Buffer.alloc(0)
    platform = Buffer.concat([words(1), name(format), inlineBulk(audio), guid])
  }
  const object = Buffer.concat([prefix, platform])
  return { asset: zenPackage({ ue54: streamed, names, classId: engineSoundWave, bulkMap, object }), bulk, audio }
}
