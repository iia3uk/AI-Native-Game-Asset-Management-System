export function createAudioPreview(audio, status) {
  audio.addEventListener('error', () => {
    if (!audio.hidden && audio.error) status('Не удалось воспроизвести WAV. Файл доступен для скачивания.')
  })
  return {
    clear() {
      if (audio.hidden) return
      audio.hidden = true
      audio.removeAttribute('src')
      audio.load()
    },
    show(file) {
      if (file.ext !== 'wav' || !file.preview) return false
      audio.src = file.preview
      audio.hidden = false
      return true
    },
  }
}
