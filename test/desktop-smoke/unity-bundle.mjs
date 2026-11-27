import { basename } from 'node:path'

export async function verifyUnityBundle(webContents, waitFor, fixture, { standalone = false } = {}) {
  await webContents.executeJavaScript(`
    if (!document.querySelector('#index-dialog').open) document.querySelector('#index-mode').click()
    document.querySelector('#package-importer').open = true
    document.querySelector('#package-path').value = ${JSON.stringify(fixture)}
    document.querySelector('#package-form').requestSubmit()
  `)
  const label = standalone ? 'Бинарный файл Unity' : 'UnityFS 8'
  await waitFor(`document.querySelector('#package-plans').textContent.includes(${JSON.stringify(label)})`)
  await waitFor("document.querySelector('#package-plans').textContent.includes('Triangle ·')")
  const compressed = await webContents.executeJavaScript("document.querySelector('#package-plans').textContent.includes('StreamedDXT5 · DXT5')")
  await webContents.executeJavaScript("document.querySelector('#package-plans button').click()")
  const row = `Array.from(document.querySelector('#package-jobs').children)
    .find(item => item.firstElementChild.textContent.startsWith(${JSON.stringify(basename(fixture) + ' · ')}))`
  await waitFor(`(${row})?.firstElementChild.textContent.includes('В индексе')`)
  await webContents.executeJavaScript(`{
    const bundle = ${row}
    bundle.querySelector('details').open = true
    Array.from(bundle.querySelectorAll('button')).find(button => button.textContent === 'Показать файлы').click()
  }`)
  await waitFor(`(${row})?.textContent.includes('Mesh-Triangle.glb')`)
  if (!standalone) await waitFor(`(${row})?.textContent.includes('Texture-Albedo.png')`)
  if (compressed) {
    await waitFor(`(${row})?.textContent.includes('Texture-InlineDXT1.png') && (${row})?.textContent.includes('Texture-StreamedDXT5.png')`)
  }
  await webContents.executeJavaScript(`Array.from((${row}).querySelectorAll('button'))
    .find(button => button.textContent === 'Показать в индексе').click()`)
  await waitFor("document.querySelector('#index-results').textContent.includes('Mesh-Triangle.glb')")
  await webContents.executeJavaScript(`Array.from(document.querySelectorAll('#index-results button'))
    .find(button => button.textContent.startsWith('Mesh-Triangle.glb')).click()`)
  await waitFor("document.querySelector('#index-name').textContent === 'Mesh-Triangle.glb' && !document.querySelector('#index-preview').disabled")
  await webContents.executeJavaScript("document.querySelector('#index-preview').click()")
  await waitFor("!document.querySelector('#index-dialog').open && document.querySelector('#model-stats').textContent.includes('2 треугольника')")
}
