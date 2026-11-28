export function createAudioPreview(audio, status) {
  audio.addEventListener('error', () => {
    if (!audio.hidden && audio.error) status('Не удалось воспроизвести звук. Файл доступен для скачивания.')
  })
  return {
    clear() {
      if (audio.hidden) return
      audio.hidden = true
      audio.removeAttribute('src')
      audio.load()
    },
    show(file) {
      if (!['wav', 'ogg'].includes(file.ext) || !file.preview) return false
      audio.src = file.preview
      audio.hidden = false
      return true
    },
  }
}
