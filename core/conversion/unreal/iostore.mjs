import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { ioStoreTextureRevision } from '../../engines/unreal/decoder/protocol.mjs'
import { fileInfo } from '../../files/asset-files.mjs'
import { publishContainerAudio, zenAudioMethod } from './container-audio.mjs'
import { containerFileFolders, validateContainerFile } from './container-files.mjs'
import { publishContainerTexture } from './container-texture.mjs'

export const ioStoreMethod = 'cue4parse-iostore'
export const zenTextureMethod = 'cue4parse-iostore-zen-texture'

export async function publishIoStoreEntries(entries, root, store, version, signal) {
  const results = []
  for (const row of entries) {
    signal?.throwIfAborted()
    const { file: input, texture, textureIssue, audio, audioIssue, mesh, meshIssue,
      meshMaterials, material, materialIssue, ...entry } = row
    if (!input) {
      results.push(entry)
      continue
    }
    const file = await fileInfo(root, input)
    if (file?.info.size !== entry.size ||
        (entry.kind === 'file' && !await validateContainerFile(root, { ...entry, file: input }, file, signal))) {
      results.push({ ...entry, status: 'failed', issue: 'unreal-iostore-invalid-payload' })
      continue
    }
    const id = createHash('sha256').update(entry.path).digest('hex').slice(0, 32)
    const destination = entry.kind === 'file'
      ? [containerFileFolders[entry.format], id, posix.basename(entry.path)].join('/')
      : 'Source/' + entry.path
    const artifact = await store.save(destination, file, { status: 'extracted', format: entry.format,
      role: entry.kind === 'file' ? 'embedded-file' : 'iostore-' + entry.kind + '-chunk',
      method: ioStoreMethod, converterVersion: version })
    const exports = []
    if (artifact.path && (texture || textureIssue)) {
      exports.push(await publishContainerTexture(root, store, row, artifact, id, { method: zenTextureMethod,
        converterVersion: version + '-zen-texture-' + ioStoreTextureRevision,
        outputIssue: 'unreal-iostore-texture-output' }, signal))
    }
    if (artifact.path && (audio || audioIssue)) {
      exports.push(await publishContainerAudio(root, store, row, artifact, id, { method: zenAudioMethod,
        converterVersion: version, outputIssue: 'unreal-iostore-audio-output' }, signal))
    }
    results.push({ ...entry, id, status: artifact.status, artifact, ...(exports.length && { exports }) })
  }
  return results
}
