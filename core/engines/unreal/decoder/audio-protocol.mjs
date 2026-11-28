export const cookedAudioRevision = 1
export const cookedAudioBatchBytes = 128 * 1024 ** 2
export const ioStoreAudioRevision = 1
const audioFormats = new Set(['wav', 'ogg'])

export function numberedAudio(value, stem) {
  const { format, size } = value ?? {}
  if (!audioFormats.has(format) || !Number.isSafeInteger(size) || size < 44 || size > 32 * 1024 ** 2) return null
  return { format, size, file: stem + '.' + format }
}

export const cookedAudioIssue = value => typeof value === 'string' && /^unreal-cooked-audio-[a-z0-9-]{1,45}$/.test(value)

export function looseAudioResult(raw, count) {
  if (raw?.protocol !== 1) return null
  if (raw.status === 'failed' && /^unreal-[a-z0-9-]{1,70}$/.test(raw.issue ?? '')) {
    return { status: 'failed', issue: raw.issue }
  }
  if (raw.status !== 'completed' || raw.audioDecoder !== cookedAudioRevision ||
      !Array.isArray(raw.entries) || raw.entries.length !== count) return null
  let bytes = 0
  const entries = []
  for (const [index, row] of raw.entries.entries()) {
    if (row?.index !== index) return null
    if (row.audio != null) {
      const audio = numberedAudio(row.audio, String(index).padStart(5, '0'))
      if (row.audioIssue != null || !audio) return null
      bytes += audio.size
      if (bytes > cookedAudioBatchBytes) return null
      entries.push({ audio })
    } else if (row.audioIssue != null) {
      if (!cookedAudioIssue(row.audioIssue)) return null
      entries.push({ audioIssue: row.audioIssue })
    } else {
      entries.push(null)
    }
  }
  return { status: 'completed', entries }
}
