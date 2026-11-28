const audioFormats = new Set(['wav', 'ogg'])

export const canPreviewAudio = file => Boolean(file?.preview && audioFormats.has(file.ext))

export function createAudioPreview({ container, audio, repeat }, onError) {
  audio.loop = repeat.checked
  repeat.addEventListener('change', () => { audio.loop = repeat.checked })
  audio.addEventListener('error', () => {
    if (!container.hidden && audio.error) onError()
  })
  return {
    clear() {
      if (container.hidden) return
      container.hidden = true
      audio.removeAttribute('src')
      audio.load()
    },
    show(file) {
      if (!canPreviewAudio(file)) return false
      audio.setAttribute('aria-label', 'Воспроизведение ' + file.name)
      audio.src = file.preview
      container.hidden = false
      return true
    },
  }
}
