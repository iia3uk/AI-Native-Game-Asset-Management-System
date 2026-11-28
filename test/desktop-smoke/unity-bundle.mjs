import { basename } from 'node:path'

export async function verifyUnityBundle(webContents, waitFor, fixture, { standalone = false, materials = false, linked = false, pbr = false } = {}) {
  const mesh = pbr ? 'PbrMesh' : linked ? 'LinkedMesh' : materials ? 'Painted' : 'Triangle'
  const preview = 'Mesh-' + mesh + '.glb'
  await webContents.executeJavaScript(`
    if (!document.querySelector('#index-dialog').open) document.querySelector('#index-mode').click()
    document.querySelector('#package-importer').open = true
    document.querySelector('#package-path').value = ${JSON.stringify(fixture)}
    document.querySelector('#package-form').requestSubmit()
  `)
  const label = standalone ? 'Бинарный файл Unity' : 'UnityFS 8'
  await waitFor(`document.querySelector('#package-plans').textContent.includes(${JSON.stringify(label)})`)
  await waitFor(`document.querySelector('#package-plans').textContent.includes('${mesh} ·')`)
  if (linked) {
    await waitFor(`['Бандлы из манифеста', 'linked-paint.bundle', 'linked-images.bundle']
      .every(text => document.querySelector('#package-plans').textContent.includes(text))`)
  }
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
  await waitFor(`(${row})?.textContent.includes('${preview}')`)
  if (materials) {
    await waitFor(`(${row})?.textContent.includes('Материалы восстановлены в GLB') &&
      (${row})?.textContent.includes('Разные префабы назначают этому мешу разные материалы') &&
      (${row})?.textContent.includes('Material-Front.json')`)
  } else if (linked) {
    await waitFor(`(${row})?.textContent.includes('Материалы восстановлены в GLB') &&
      (${row})?.textContent.includes('Texture-LinkedPaintColor.png')`)
  } else if (pbr) {
    await waitFor(`(${row})?.textContent.includes('Карты GLB · базовый цвет, металличность и шероховатость, затенение, нормали, свечение') &&
      (${row})?.textContent.includes('разные параметры выборки')`)
  } else if (!standalone) await waitFor(`(${row})?.textContent.includes('Texture-Albedo.png')`)
  if (compressed) {
    await waitFor(`(${row})?.textContent.includes('Texture-InlineDXT1.png') && (${row})?.textContent.includes('Texture-StreamedDXT5.png')`)
  }
  await webContents.executeJavaScript(`Array.from((${row}).querySelectorAll('button'))
    .find(button => button.textContent === 'Показать в индексе').click()`)
  await waitFor(`document.querySelector('#index-results').textContent.includes('${preview}')`)
  await webContents.executeJavaScript(`Array.from(document.querySelectorAll('#index-results button'))
    .find(button => button.textContent.startsWith('${preview}')).click()`)
  await waitFor(`document.querySelector('#index-name').textContent === '${preview}' && !document.querySelector('#index-preview').disabled`)
  await webContents.executeJavaScript("document.querySelector('#index-preview').click()")
  await waitFor("!document.querySelector('#index-dialog').open && document.querySelector('#model-stats').textContent.includes('2 треугольника')")
  if (materials) await waitFor("document.querySelector('#color-source').textContent.includes('с текстурой 2')")
  if (linked || pbr) await waitFor("document.querySelector('#color-source').textContent.includes('с текстурой')")
}
