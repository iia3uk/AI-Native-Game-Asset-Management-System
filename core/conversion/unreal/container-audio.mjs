import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { fileInfo } from '../../files/asset-files.mjs'
import { oggVorbis } from '../audio/ogg-vorbis.mjs'
import { embeddedWave, waveMagic } from './source-media/wave.mjs'

export const zenAudioMethod = 'cue4parse-iostore-zen-audio'

export async function publishContainerAudio(root, store, { audio, audioIssue, path }, artifact, id, version, signal) {
  const details = { role: 'audio', method: zenAudioMethod, converterVersion: version, from: artifact.path }
  if (audioIssue) return { ...details, status: 'skipped', issue: audioIssue }
  const { file: input, size, format } = audio
  const file = await fileInfo(root, input)
  const metrics = file?.info.size === size ? await readAudio(file, format, signal) : null
  if (!metrics) return { ...details, format, status: 'failed', issue: 'unreal-iostore-audio-output' }
  const destination = 'Audio/' + id + '/' + posix.basename(path).slice(0, -7) + '.' + format
  return store.save(destination, file, { ...details, ...metrics, format, status: 'converted' })
}

async function readAudio(file, format, signal) {
  const bytes = await readFile(file.path, { signal })
  if (bytes.length !== file.info.size) return null
  if (format === 'ogg') return oggVorbis(bytes, signal)
  const wave = bytes.subarray(0, 4).equals(waveMagic) && embeddedWave(bytes, 0)
  return wave?.end === bytes.length ? wave.audio : null
}
