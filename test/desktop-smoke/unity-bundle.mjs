import { basename } from 'node:path'

export async function verifyUnityBundle(webContents, waitFor, fixture) {
  await webContents.executeJavaScript(`
    document.querySelector('#package-path').value = ${JSON.stringify(fixture)}
    document.querySelector('#package-form').requestSubmit()
  `)
  await waitFor("document.querySelector('#package-plans').textContent.includes('UnityFS 8')")
  await waitFor("document.querySelector('#package-plans').textContent.includes('Triangle ·')")
  await webContents.executeJavaScript("document.querySelector('#package-plans button').click()")
  const row = `Array.from(document.querySelector('#package-jobs').children)
    .find(item => item.firstElementChild.textContent.startsWith(${JSON.stringify(basename(fixture) + ' · ')}))`
  await waitFor(`(${row})?.firstElementChild.textContent.includes('В индексе')`)
  await webContents.executeJavaScript(`{
    const bundle = ${row}
    bundle.querySelector('details').open = true
    Array.from(bundle.querySelectorAll('button')).find(button => button.textContent === 'Показать файлы').click()
  }`)
  await waitFor(`(${row})?.textContent.includes('Mesh-Triangle.glb') && (${row})?.textContent.includes('Texture-Albedo.png')`)
  await webContents.executeJavaScript(`Array.from((${row}).querySelectorAll('button'))
    .find(button => button.textContent === 'Показать в индексе').click()`)
  await waitFor("document.querySelector('#index-results').textContent.includes('Mesh-Triangle.glb')")
  await webContents.executeJavaScript(`Array.from(document.querySelectorAll('#index-results button'))
    .find(button => button.textContent.startsWith('Mesh-Triangle.glb')).click()`)
  await waitFor("document.querySelector('#index-name').textContent === 'Mesh-Triangle.glb' && !document.querySelector('#index-preview').disabled")
  await webContents.executeJavaScript("document.querySelector('#index-preview').click()")
  await waitFor("!document.querySelector('#index-dialog').open && document.querySelector('#model-stats').textContent.includes('2 треугольника')")
}
