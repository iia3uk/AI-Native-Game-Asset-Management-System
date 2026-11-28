import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { cookedTexture } from '../fixtures/unreal-cooked-texture.mjs'
import { makePak, wavTone } from '../fixtures/unreal-pak.mjs'

export async function verifyUnrealPak(webContents, waitFor, fixtures) {
  const model = await readFile(join(fixtures, 'Architecture', 'woodland-cabin.glb'))
  const path = join(dirname(fixtures), 'SmokeUnreal.pak')
  await writeFile(path, makePak([
    { path: 'Models/Pak-Cabin.glb', content: model },
    { path: 'Audio/Pak-Encrypted.wav', content: wavTone(), encrypted: true },
    ...cookedTexture({ name: 'Pak-Tint', format: 'PF_G8', width: 2, height: 2, pixels: Buffer.from([5, 40, 80, 255]) }),
  ]))
  await webContents.executeJavaScript(`
    if (!document.querySelector('#index-dialog').open) document.querySelector('#index-mode').click()
    document.querySelector('#package-importer').open = true
    document.querySelector('#package-path').value = ${JSON.stringify(path)}
    document.querySelector('#package-form').requestSubmit()
  `)
  await waitFor("document.querySelector('#package-plans').textContent.includes('Unreal Pak 4')")
  await waitFor("document.querySelector('#package-plans').textContent.includes('Pak-Encrypted.wav · Пропущено · Запись зашифрована')")
  await webContents.executeJavaScript("document.querySelector('#package-plans button').click()")
  const row = `Array.from(document.querySelector('#package-jobs').children)
    .find(item => item.firstElementChild.textContent.startsWith('SmokeUnreal.pak · '))`
  await waitFor(`(${row})?.firstElementChild.textContent.includes('В индексе')`)
  await webContents.executeJavaScript(`{
    const pak = ${row}
    pak.querySelector('details').open = true
    Array.from(pak.querySelectorAll('button')).find(button => button.textContent === 'Показать файлы').click()
  }`)
  await waitFor(`(${row})?.textContent.includes('GLB · Извлечён · Previews/') && (${row})?.textContent.includes('Запись зашифрована')`)
  await waitFor(`(${row})?.textContent.includes('Текстур из cooked-ресурсов · 1 PNG') &&
    (${row})?.textContent.includes('Pak-Tint.png · 2 × 2 · Мип 0')`)
  await webContents.executeJavaScript(`Array.from((${row}).querySelectorAll('button'))
    .find(button => button.textContent === 'Показать в индексе').click()`)
  await waitFor("document.querySelector('#index-results').textContent.includes('Pak-Cabin.glb') && " +
    "document.querySelector('#index-results').textContent.includes('Pak-Tint.png')")
  await webContents.executeJavaScript(`Array.from(document.querySelectorAll('#index-results button'))
    .find(button => button.textContent.startsWith('Pak-Cabin.glb')).click()`)
  await waitFor("document.querySelector('#index-name').textContent === 'Pak-Cabin.glb' && !document.querySelector('#index-preview').disabled")
  await webContents.executeJavaScript("document.querySelector('#index-preview').click()")
  await waitFor("!document.querySelector('#index-dialog').open && document.querySelector('#model-stats').textContent.includes('252')")
}
