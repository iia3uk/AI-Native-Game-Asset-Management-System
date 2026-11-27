import { join } from 'node:path'
import { fixtureTexture, unityEntries, writeUnityFixture } from '../fixtures/unitypackage.mjs'

export async function verifyPackageWatch(webContents, waitFor, fixtures) {
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
  await webContents.executeJavaScript("document.querySelector('#index-package-watch').click()")
  await waitFor("document.querySelector('#index-package-watch').getAttribute('aria-pressed') === 'true'")
  await writeUnityFixture(join(fixtures, 'watch-ui.unitypackage'), unityEntries('9'.repeat(32), 'Assets/watch-texture.png', fixtureTexture))
  await waitFor("document.querySelector('#package-jobs').textContent.includes('watch-ui.unitypackage · Автоимпорт · Обработан · В индексе')")
  await webContents.executeJavaScript("document.querySelector('#index-package-watch').click()")
  await waitFor("document.querySelector('#index-package-watch').getAttribute('aria-pressed') === 'false'")
}
