const audioFormats = new Set(['wav', 'ogg'])

export const canPreviewAudio = file => Boolean(file?.preview && audioFormats.has(file.ext))

export function createAudioPreview(audio, onError) {
  audio.addEventListener('error', () => {
    if (!audio.hidden && audio.error) onError()
  })
  return {
    clear() {
      if (audio.hidden) return
      audio.hidden = true
      audio.removeAttribute('src')
      audio.load()
    },
    show(file) {
      if (!canPreviewAudio(file)) return false
      audio.setAttribute('aria-label', 'Воспроизведение ' + file.name)
      audio.src = file.preview
      audio.hidden = false
      return true
    },
  }
}
