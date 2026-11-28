import { cookedObject, i32, i64 } from './unreal-cooked-texture.mjs'
import { wavTone } from './unreal-pak.mjs'
import { zenOgg } from './unreal-zen-audio.mjs'

export function cookedSoundWave({ name, format = 'PCM', payload = wavTone(), streaming = false,
  companion = true, rootClass, split, externalOffset = 9 }) {
  const bytes = streaming ? Buffer.concat([payload.subarray(128), Buffer.alloc(7)]) : null
  const sidecars = streaming && companion ? [{ path: name + '.ubulk',
    content: Buffer.concat([Buffer.alloc(9), bytes]) }] : []
  const bulk = (flags, size, offset) => [i32(flags), i32(size), i32(size), i64(offset)]
  return cookedObject({ name, type: 'SoundWave', extraNames: ['bStreaming', 'BoolProperty', format],
    rootClass, split, sidecars,
    serialize(fname, headerSize) {
      const tags = streaming ? [] : [fname('bStreaming'), fname('BoolProperty'), i32(0), i32(0), Buffer.alloc(2)]
      const prefix = [...tags, fname('None'), i32(0), i32(1)]
      const guid = Buffer.alloc(16)
      if (!streaming) return Buffer.concat([...prefix, i32(1), fname(format),
        ...bulk(0x40, payload.length, 0), payload, guid])
      const first = payload.subarray(0, 128)
      const chunks = [
        i32(1), ...bulk(0x40, first.length, 0), first, i32(first.length), i32(first.length),
        i32(3), ...bulk(0x101, bytes.length, 0), i32(bytes.length), i32(payload.length - first.length), i32(0),
      ]
      const data = Buffer.concat([...prefix, guid, i32(2), fname(format), ...chunks])
      data.writeBigInt64LE(BigInt(externalOffset - headerSize - data.length), data.length - 20)
      return data
    },
  })
}

export function cookedAudioFiles() {
  return [
    ...cookedSoundWave({ name: 'Inline', split: false }),
    ...cookedSoundWave({ name: 'Streamed', format: 'OGG', payload: zenOgg, streaming: true }),
    ...cookedSoundWave({ name: 'Opus', format: 'OPUS', payload: zenOgg }),
    ...cookedSoundWave({ name: 'OtherClass', rootClass: '/Script/Other' }),
  ]
}
