import { basename } from 'node:path'

export async function verifyUnitySprites(webContents, waitFor, fixture, { atlas = false } = {}) {
  const details = atlas ? ['Button · Спрайт 8 × 6', 'атлас #'] :
    ['LowerSprite · Спрайт 3 × 4', 'Текстура спрайта недоступна']
  const [other, preview, width, height] = atlas ? ['Sprite-Panel.png', 'Sprite-Button.png', 8, 6] :
    ['Sprite-LowerSprite.png', 'Sprite-UpperSprite.png', 4, 2]
  await webContents.executeJavaScript(`
    if (!document.querySelector('#index-dialog').open) document.querySelector('#index-mode').click()
    document.querySelector('#package-importer').open = true
    document.querySelector('#package-path').value = ${JSON.stringify(fixture)}
    document.querySelector('#package-form').requestSubmit()
  `)
  for (const text of details) await waitFor(`document.querySelector('#package-plans').textContent.includes(${JSON.stringify(text)})`)
  await webContents.executeJavaScript("document.querySelector('#package-plans button').click()")
  const job = `Array.from(document.querySelector('#package-jobs').children)
    .find(item => item.firstElementChild.textContent.startsWith(${JSON.stringify(basename(fixture) + ' · ')}))`
  await waitFor(`(${job})?.firstElementChild.textContent.includes('В индексе')`)
  await webContents.executeJavaScript(`{
    const row = ${job}
    row.querySelector('details').open = true
    Array.from(row.querySelectorAll('button')).find(button => button.textContent === 'Показать файлы').click()
  }`)
  for (const name of [other, preview]) await waitFor(`(${job})?.textContent.includes(${JSON.stringify(name)})`)
  await webContents.executeJavaScript(`Array.from((${job}).querySelectorAll('button'))
    .find(button => button.textContent === 'Показать в индексе').click()`)
  await waitFor(`document.querySelector('#index-results').textContent.includes(${JSON.stringify(preview)})`)
  await webContents.executeJavaScript(`Array.from(document.querySelectorAll('#index-results button'))
    .find(button => button.textContent.startsWith(${JSON.stringify(preview)})).click()`)
  await waitFor(`document.querySelector('#index-name').textContent === ${JSON.stringify(preview)} && !document.querySelector('#index-preview').disabled`)
  await webContents.executeJavaScript("document.querySelector('#index-preview').click()")
  await waitFor(`(() => {
    const image = document.querySelector('#stage-image')
    return !document.querySelector('#index-dialog').open && !image.hidden &&
      image.alt === ${JSON.stringify(preview)} && image.naturalWidth === ${width} && image.naturalHeight === ${height}
  })()`)
}
