import assert from 'node:assert/strict'
import { basename } from 'node:path'

export async function verifyUnityAudio(webContents, waitFor, fixture, { companion = false } = {}) {
  await webContents.executeJavaScript(`
    if (!document.querySelector('#index-dialog').open) document.querySelector('#index-mode').click()
    document.querySelector('#package-importer').open = true
    document.querySelector('#package-path').value = ${JSON.stringify(fixture)}
    document.querySelector('#package-form').requestSubmit()
  `)
  await waitFor("document.querySelector('#package-plans').textContent.includes('StereoPcm · PCM 16 бит, 48000 Гц, 2 кан.')")
  await waitFor("document.querySelector('#package-plans').textContent.includes('Для аудио Unity поддерживается PCM 16 бит')")
  if (companion) {
    await waitFor("document.querySelector('#package-plans').textContent.includes('Файлы данных · resources.assets.resS, resources.resource')")
    await waitFor("document.querySelector('#package-plans').textContent.includes('StreamedDXT5 · DXT5 · Внешние данные')")
  }
  await webContents.executeJavaScript("document.querySelector('#package-plans button').click()")
  const job = `Array.from(document.querySelector('#package-jobs').children)
    .find(item => item.firstElementChild.textContent.startsWith(${JSON.stringify(basename(fixture) + ' · ')}))`
  await waitFor(`(${job})?.firstElementChild.textContent.includes('В индексе')`)
  await webContents.executeJavaScript(`{
    const row = ${job}
    row.querySelector('details').open = true
    Array.from(row.querySelectorAll('button')).find(button => button.textContent === 'Показать файлы').click()
  }`)
  await waitFor(`(${job})?.textContent.includes('Audio-StereoPcm.wav') && (${job})?.textContent.includes('Audio-MonoPcm.wav')`)
  if (companion) await waitFor(`(${job})?.textContent.includes('Texture-StreamedDXT5.png')`)
  await webContents.executeJavaScript(`Array.from((${job}).querySelectorAll('button'))
    .find(button => button.textContent === 'Показать в индексе').click()`)
  await waitFor("document.querySelector('#index-results').textContent.includes('Audio-StereoPcm.wav')")
  await webContents.executeJavaScript(`Array.from(document.querySelectorAll('#index-results button'))
    .find(button => button.textContent.startsWith('Audio-StereoPcm.wav')).click()`)
  await waitFor("document.querySelector('#index-name').textContent === 'Audio-StereoPcm.wav' && !document.querySelector('#index-preview').disabled")
  await webContents.executeJavaScript("document.querySelector('#index-preview').click()")
  await waitFor(`(() => {
    const audio = document.querySelector('#stage-audio')
    return !document.querySelector('#index-dialog').open && !audio.hidden &&
      audio.paused && audio.currentSrc.endsWith('Audio-StereoPcm.wav') && Math.abs(audio.duration - 2309 / 48000) < 0.001
  })()`)
  await webContents.executeJavaScript(`(() => {
    const audio = document.querySelector('#stage-audio')
    audio.muted = true
    return audio.play()
  })()`, true)
  await waitFor("document.querySelector('#stage-audio').ended")
  assert.equal(await webContents.executeJavaScript(`
    fetch(document.querySelector('#stage-audio').src, { headers: { Range: 'bytes=0-43' } })
      .then(response => response.status === 206 && response.headers.get('content-type') === 'audio/wav')
  `), true)
  await webContents.executeJavaScript("document.querySelector('#demo-mode').click()")
  await waitFor("document.querySelector('#audio-preview').hidden && !document.querySelector('#stage-audio').hasAttribute('src')")
}
