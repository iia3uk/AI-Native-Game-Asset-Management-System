import { dirname } from 'node:path'
import { writeIoStoreFixture } from '../fixtures/unreal-iostore.mjs'
import { zenMaterialFixture } from '../fixtures/unreal-zen-material.mjs'

export async function verifyUnrealIoStore(webContents, waitFor, fixtures) {
  const fixture = await writeIoStoreFixture(dirname(fixtures), 'SmokeIoStore', { texture: 'external' })
  await showIoStoreLibrary(webContents, waitFor, fixture.path, 'SmokeIoStore', 'Текстур из Zen-пакетов · 1 PNG')
  await playIndexedAudio(webContents, waitFor, 'IoStore-Tone.wav', 2204 / 22050)
  await openIndexedAsset(webContents, waitFor, 'Sample.png')
  await waitFor(`(() => {
    const image = document.querySelector('#stage-image')
    return !image.hidden && image.currentSrc.endsWith('Sample.png') && image.naturalWidth === 2 && image.naturalHeight === 2
  })()`)

  const audio = await writeIoStoreFixture(dirname(fixtures), 'SmokeZenAudio', { soundWave: 'vorbis' })
  await showIoStoreLibrary(webContents, waitFor, audio.path, 'SmokeZenAudio', 'Аудио из Zen-пакетов · Готово 1')
  // Chromium can include a Vorbis block of decoder padding in the reported duration.
  await playIndexedAudio(webContents, waitFor, 'Sample.ogg', 0.5, 0.024)

  const mesh = await writeIoStoreFixture(dirname(fixtures), 'SmokeZenMesh', zenMaterialFixture('ue54'))
  await showIoStoreLibrary(webContents, waitFor, mesh.path, 'SmokeZenMesh', 'Материалы из Zen-пакетов · Готово 2', 5)
  await openIndexedAsset(webContents, waitFor, 'Sample_Lod1.glb')
  await waitFor("!document.querySelector('#index-dialog').open && document.querySelector('#model-stats').textContent.includes('1 треугольник')")
}

async function showIoStoreLibrary(webContents, waitFor, path, name, details, chunks = 2) {
  await webContents.executeJavaScript(`
    if (!document.querySelector('#index-dialog').open) document.querySelector('#index-mode').click()
    document.querySelector('#package-importer').open = true
    document.querySelector('#package-path').value = ${JSON.stringify(path)}
    document.querySelector('#package-form').requestSubmit()
  `)
  await waitFor(`document.querySelector('#package-plans').textContent.includes(${JSON.stringify(name + '_s1.ucas')})`)
  await webContents.executeJavaScript("document.querySelector('#package-plans button').click()")
  const row = `Array.from(document.querySelector('#package-jobs').children)
    .find(item => item.firstElementChild.textContent.startsWith(${JSON.stringify(name + '.utoc · ')}))`
  await waitFor(`(${row})?.firstElementChild.textContent.includes('В индексе')`)
  await waitFor(`(${row})?.textContent.includes('Готовых файлов · 1 · Блоков в формате IoStore · ${chunks}')`)
  await waitFor(`(${row})?.textContent.includes(${JSON.stringify(details)})`)
  await webContents.executeJavaScript(`Array.from((${row}).querySelectorAll('button'))
    .find(button => button.textContent === 'Показать в индексе').click()`)
}

async function openIndexedAsset(webContents, waitFor, name) {
  const label = JSON.stringify(name)
  await waitFor(`document.querySelector('#index-results').textContent.includes(${label})`)
  await webContents.executeJavaScript(`Array.from(document.querySelectorAll('#index-results button'))
    .find(button => button.textContent.startsWith(${label})).click()`)
  await waitFor(`document.querySelector('#index-name').textContent === ${label} && !document.querySelector('#index-preview').disabled`)
  await webContents.executeJavaScript("document.querySelector('#index-preview').click()")
}

async function playIndexedAudio(webContents, waitFor, name, duration, tolerance = 0.001) {
  await openIndexedAsset(webContents, waitFor, name)
  await waitFor(`(() => {
    const audio = document.querySelector('#stage-audio')
    return !audio.hidden && audio.currentSrc.endsWith(${JSON.stringify(name)}) && Math.abs(audio.duration - ${duration}) < ${tolerance}
  })()`).catch(async error => {
    const state = await webContents.executeJavaScript(`(() => {
      const audio = document.querySelector('#stage-audio')
      return { hidden: audio.hidden, src: audio.currentSrc, duration: audio.duration, readyState: audio.readyState,
        error: audio.error?.message, ogg: audio.canPlayType('audio/ogg; codecs=vorbis') }
    })()`)
    throw new Error(error.message + ' Audio: ' + JSON.stringify(state))
  })
  await webContents.executeJavaScript(`(() => {
    const audio = document.querySelector('#stage-audio')
    audio.muted = true
    return audio.play()
  })()`, true)
  await waitFor("document.querySelector('#stage-audio').ended")
}
