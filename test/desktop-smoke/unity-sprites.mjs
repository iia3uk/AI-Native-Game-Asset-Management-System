import { basename } from 'node:path'

export async function verifyUnitySprites(webContents, waitFor, fixture) {
  await webContents.executeJavaScript(`
    if (!document.querySelector('#index-dialog').open) document.querySelector('#index-mode').click()
    document.querySelector('#package-importer').open = true
    document.querySelector('#package-path').value = ${JSON.stringify(fixture)}
    document.querySelector('#package-form').requestSubmit()
  `)
  await waitFor("document.querySelector('#package-plans').textContent.includes('LowerSprite · Спрайт 3 × 4')")
  await waitFor("document.querySelector('#package-plans').textContent.includes('Текстура спрайта недоступна')")
  await webContents.executeJavaScript("document.querySelector('#package-plans button').click()")
  const job = `Array.from(document.querySelector('#package-jobs').children)
    .find(item => item.firstElementChild.textContent.startsWith(${JSON.stringify(basename(fixture) + ' · ')}))`
  await waitFor(`(${job})?.firstElementChild.textContent.includes('В индексе')`)
  await webContents.executeJavaScript(`{
    const row = ${job}
    row.querySelector('details').open = true
    Array.from(row.querySelectorAll('button')).find(button => button.textContent === 'Показать файлы').click()
  }`)
  await waitFor(`(${job})?.textContent.includes('Sprite-LowerSprite.png') && (${job})?.textContent.includes('Sprite-UpperSprite.png')`)
  await webContents.executeJavaScript(`Array.from((${job}).querySelectorAll('button'))
    .find(button => button.textContent === 'Показать в индексе').click()`)
  await waitFor("document.querySelector('#index-results').textContent.includes('Sprite-UpperSprite.png')")
  await webContents.executeJavaScript(`Array.from(document.querySelectorAll('#index-results button'))
    .find(button => button.textContent.startsWith('Sprite-UpperSprite.png')).click()`)
  await waitFor("document.querySelector('#index-name').textContent === 'Sprite-UpperSprite.png' && !document.querySelector('#index-preview').disabled")
  await webContents.executeJavaScript("document.querySelector('#index-preview').click()")
  await waitFor(`(() => {
    const image = document.querySelector('#stage-image')
    return !document.querySelector('#index-dialog').open && !image.hidden &&
      image.alt === 'Sprite-UpperSprite.png' && image.naturalWidth === 4 && image.naturalHeight === 2
  })()`)
}
