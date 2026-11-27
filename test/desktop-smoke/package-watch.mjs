import { copyFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fixtureTexture, unityEntries, writeUnityFixture } from '../fixtures/unitypackage.mjs'
import { makePak, wavTone } from '../fixtures/unreal-pak.mjs'

export async function verifyPackageWatch(webContents, waitFor, fixtures, { bundle, player, pak }) {
  await webContents.executeJavaScript("document.querySelector('#index-mode').click()")
  await waitFor("document.querySelector('#index-dialog').open && !document.querySelector('#index-library').disabled")
  await webContents.executeJavaScript(`{
    const select = document.querySelector('#index-library')
    const source = Array.from(select.options).find(option => option.textContent === ${JSON.stringify(fixtures)})
    if (!source) throw new Error('The fixture library is unavailable.')
    select.value = source.value
    select.dispatchEvent(new Event('change'))
  }`)
  await waitFor("!document.querySelector('#index-package-watch').disabled && document.querySelector('#index-watch').getAttribute('aria-pressed') === 'false'")
  await webContents.executeJavaScript("document.querySelector('#index-package-autoimport summary').click()")
  async function toggle(id, enabled) {
    await webContents.executeJavaScript(`document.querySelector('#index-${id}').click()`)
    await waitFor(`document.querySelector('#index-${id}').getAttribute('aria-pressed') === '${enabled}'`)
  }
  await toggle('package-watch', true)
  await writeUnityFixture(join(fixtures, 'watch-ui.unitypackage'), unityEntries('9'.repeat(32), 'Assets/watch-texture.png', fixtureTexture))
  await waitFor("document.querySelector('#package-jobs').textContent.includes('watch-ui.unitypackage · Автоимпорт · Обработан · В индексе')")
  if (bundle) await toggle('bundle-watch', true)
  if (pak) await toggle('pak-watch', true)
  await toggle('package-watch', false)
  if (bundle) {
    await copyFile(bundle, join(fixtures, 'watch-ui.unity3d'))
    await waitFor("document.querySelector('#package-jobs').textContent.includes('watch-ui.unity3d · Автоимпорт · Обработан · В индексе')")
    await toggle('bundle-watch', false)
  }
  if (player) {
    for (const name of ['resources.assets', 'resources.assets.resS', 'resources.resource']) {
      await copyFile(join(dirname(player), name), join(fixtures, name))
    }
    await toggle('serialized-watch', true)
    await waitFor("document.querySelector('#package-jobs').textContent.includes('resources.assets · Автоимпорт · Обработан · В индексе')")
    await toggle('serialized-watch', false)
  }
  if (pak) {
    await writeFile(join(fixtures, 'watch-ui.pak'), makePak([{ path: 'Audio/Watch-Tone.wav', content: wavTone() }]))
    await waitFor("document.querySelector('#package-jobs').textContent.includes('watch-ui.pak · Автоимпорт · Обработан · В индексе')")
    await toggle('pak-watch', false)
  }
}
