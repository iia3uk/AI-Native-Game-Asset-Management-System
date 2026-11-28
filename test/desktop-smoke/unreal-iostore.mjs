import { dirname } from 'node:path'
import { writeIoStoreFixture } from '../fixtures/unreal-iostore.mjs'

export async function verifyUnrealIoStore(webContents, waitFor, fixtures) {
  const fixture = await writeIoStoreFixture(dirname(fixtures), 'SmokeIoStore')
  await webContents.executeJavaScript(`
    if (!document.querySelector('#index-dialog').open) document.querySelector('#index-mode').click()
    document.querySelector('#package-importer').open = true
    document.querySelector('#package-path').value = ${JSON.stringify(fixture.path)}
    document.querySelector('#package-form').requestSubmit()
  `)
  await waitFor("document.querySelector('#package-plans').textContent.includes('SmokeIoStore_s1.ucas')")
  await webContents.executeJavaScript("document.querySelector('#package-plans button').click()")
  const row = `Array.from(document.querySelector('#package-jobs').children)
    .find(item => item.firstElementChild.textContent.startsWith('SmokeIoStore.utoc · '))`
  await waitFor(`(${row})?.firstElementChild.textContent.includes('В индексе')`)
  await waitFor(`(${row})?.textContent.includes('Готовых файлов · 1 · Блоков в формате IoStore · 2')`)
  await webContents.executeJavaScript(`Array.from((${row}).querySelectorAll('button'))
    .find(button => button.textContent === 'Показать в индексе').click()`)
  await waitFor("document.querySelector('#index-results').textContent.includes('IoStore-Tone.wav')")
  await webContents.executeJavaScript(`Array.from(document.querySelectorAll('#index-results button'))
    .find(button => button.textContent.startsWith('IoStore-Tone.wav')).click()`)
  await waitFor("document.querySelector('#index-name').textContent === 'IoStore-Tone.wav' && !document.querySelector('#index-preview').disabled")
  await webContents.executeJavaScript("document.querySelector('#index-preview').click()")
  await waitFor(`(() => {
    const audio = document.querySelector('#stage-audio')
    return !audio.hidden && audio.currentSrc.endsWith('IoStore-Tone.wav') && Math.abs(audio.duration - 2204 / 22050) < 0.001
  })()`)
  await webContents.executeJavaScript(`(() => {
    const audio = document.querySelector('#stage-audio')
    audio.muted = true
    return audio.play()
  })()`, true)
  await waitFor("document.querySelector('#stage-audio').ended")
}
