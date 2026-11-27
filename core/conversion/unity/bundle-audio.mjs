import { open } from 'node:fs/promises'
import { fileInfo } from '../../files/asset-files.mjs'
import { bundleIdentity } from './bundle-names.mjs'

async function hasPcmHeader(file, { channels, sampleRate }, size) {
  if (file?.info.size !== size) return false
  const handle = await open(file.path, 'r')
  try {
    const header = Buffer.alloc(44)
    const { bytesRead } = await handle.read(header)
    const frameBytes = channels * 2
    return bytesRead === 44 && header.toString('ascii', 0, 4) === 'RIFF' &&
      header.readUInt32LE(4) === size - 8 && header.toString('ascii', 8, 16) === 'WAVEfmt ' &&
      header.readUInt32LE(16) === 16 && header.readUInt16LE(20) === 1 &&
      header.readUInt16LE(22) === channels && header.readUInt32LE(24) === sampleRate &&
      header.readUInt32LE(28) === sampleRate * frameBytes && header.readUInt16LE(32) === frameBytes &&
      header.readUInt16LE(34) === 16 && header.toString('ascii', 36, 40) === 'data' &&
      header.readUInt32LE(40) === size - 44
  } finally {
    await handle.close()
  }
}

export async function saveBundleAudio(asset, stage, store, { method, converterVersion }) {
  const { file: staged, size, ...entry } = asset
  const file = await fileInfo(stage, staged)
  if (!await hasPcmHeader(file, entry.audio, size))
    return { ...entry, status: 'failed', issue: 'unity-bundle-audio-output' }
  const { id, label } = bundleIdentity(entry)
  const name = label ? 'Audio-' + label + '.wav' : 'Audio.wav'
  const artifact = await store.save('Audio/' + id + '/' + name, file, {
    status: 'converted', format: 'wav', role: 'audio', method: method + '-fsb5-pcm16', converterVersion,
  })
  return { ...entry, id, status: artifact.status, artifact }
}
