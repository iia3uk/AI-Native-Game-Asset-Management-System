import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { startDesktop } from '../../desktop/bootstrap.mjs'
import { generateFixtures } from '../../scripts/generate-fixtures.mjs'
import { unityEntries, unityFixtureEntries, writeUnityFixture } from '../fixtures/unitypackage.mjs'

const screenshot = process.env.ASSET_VIEWER_SMOKE_SCREENSHOT
const root = fileURLToPath(new URL('../../', import.meta.url))
if (!process.env.ASSET_VIEWER_DATA_DIR) throw new Error('Provide isolated ASSET_VIEWER_DATA_DIR for this test.')
process.env.ASSET_VIEWER_PORT ||= '0'
app.commandLine.appendSwitch('use-angle', 'swiftshader')

void startDesktop(root).then(async ({ window, origin }) => {
  const { webContents } = window
  const externalRequests = []
  webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, ({ url }, respond) => {
    const local = new URL(url).origin === origin
    if (!local) externalRequests.push(url)
    respond({ cancel: !local })
  })
  const properties = webContents.getLastWebPreferences()
  assert.equal(properties.sandbox, true)
  assert.equal(properties.nodeIntegration, false)
  assert.equal(properties.contextIsolation, true)
  assert.equal((await fetch(origin + '/api/library')).status, 403)
  async function waitFor(expression) {
    const deadline = Date.now() + 15_000
    do {
      if (await webContents.executeJavaScript(expression)) return
      await setTimeout(125)
    } while (Date.now() < deadline)
    const status = await webContents.executeJavaScript("document.querySelector('#index-status')?.textContent")
    throw new Error('Renderer did not reach expected state: ' + expression + '. Index status: ' + status)
  }
  await waitFor("document.querySelector('#library-stats').textContent.includes('3D-файлов')")
  assert.equal(await webContents.executeJavaScript("typeof window.assetViewerDesktop.chooseFolder"), 'function')
  await webContents.executeJavaScript("document.querySelector('#demo-mode').click()")
  await waitFor("document.querySelector('#animation-tools').hidden === false")
  await waitFor("document.querySelector('#model-stats').textContent.includes('252')")
  await waitFor("document.querySelectorAll('#pack-list img').length === 3")
  if (screenshot) {
    await mkdir(dirname(screenshot), { recursive: true })
    await writeFile(screenshot, (await webContents.capturePage()).toPNG())
  }
  const fixtures = join(process.env.ASSET_VIEWER_DATA_DIR, 'smoke-fixtures')
  await generateFixtures(fixtures, { includeErrors: true })
  await webContents.executeJavaScript("document.querySelector('#index-mode').click()")
  await waitFor("document.querySelector('#index-dialog').open && !document.querySelector('#index-connect button:not([type])').disabled")
  await webContents.executeJavaScript(`
    document.querySelector('#index-root').value = ${JSON.stringify(fixtures)}
    document.querySelector('#index-connect').requestSubmit()
  `)
  await waitFor("document.querySelector('#index-count').textContent.includes('10 файлов')")
  await waitFor("document.querySelector('#index-job-status').textContent.includes('Добавлено: 10')")
  await waitFor("document.querySelector('#index-results').textContent.includes('woodland-cabin.glb')")
  await webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('#index-results button'))
      .find(button => button.textContent.startsWith('woodland-cabin.glb')).click()
  `)
  await waitFor("!document.querySelector('#index-metadata').hidden && !document.querySelector('#index-watch').disabled")
  await waitFor("!document.querySelector('#index-thumbnail').hidden && !document.querySelector('#index-thumbnail-generate').hidden")
  await webContents.executeJavaScript("document.querySelector('#index-thumbnail-generate').click()")
  await waitFor("document.querySelector('#index-thumbnail-image').naturalWidth === 160 && !document.querySelector('#index-thumbnail-image').hidden")
  await webContents.executeJavaScript("document.querySelector('#index-thumbnail-cache summary').click()")
  await waitFor("document.querySelector('#index-thumbnail-cache-usage').textContent.startsWith('Миниатюр 1 ·')")
  await webContents.executeJavaScript("document.querySelector('#index-thumbnail-cache-clear').click()")
  await waitFor("document.querySelector('#index-thumbnail-cache-usage').textContent.startsWith('Миниатюр 0 ·') && document.querySelector('#index-thumbnail-image').hidden")
  await webContents.executeJavaScript("document.querySelector('#index-thumbnail-cache summary').click()")
  await webContents.executeJavaScript("document.querySelector('#index-analysis summary').click()")
  await waitFor("document.querySelector('#index-analysis').open && document.querySelector('#index-metrics').textContent.includes('Треугольники252')")
  const customProfile = `
    const select = document.querySelector('#index-quality-profile')
    select.value = 'custom-project'
    select.dispatchEvent(new Event('change'))
  `
  await webContents.executeJavaScript(customProfile)
  await waitFor("!document.querySelector('#index-quality-edit').disabled")
  async function setTriangleBudget(value) {
    await webContents.executeJavaScript("document.querySelector('#index-quality-edit').click()")
    await waitFor("!document.querySelector('#index-quality-editor').hidden && !document.querySelector('#index-quality-save').disabled")
    await webContents.executeJavaScript(`{
      const editor = document.querySelector('#index-quality-editor')
      editor.elements.maxTriangles.value = ${JSON.stringify(value)}
      editor.requestSubmit()
    }`)
    await waitFor("document.querySelector('#index-quality-editor').hidden && !document.querySelector('#index-watch').disabled")
  }
  await setTriangleBudget('251')
  await waitFor("document.querySelector('#index-quality-report [data-result=fail]') && document.querySelector('#index-quality-report').textContent.includes('252')")
  await setTriangleBudget('252')
  await waitFor("document.querySelector('#index-quality-report [data-result=pass]')")
  await webContents.executeJavaScript(`
    document.querySelector('#index-metadata').elements.note.value = 'Unsaved smoke test note'
    document.querySelector('#index-watch').click()
  `)
  await waitFor("document.querySelector('#index-watch').getAttribute('aria-pressed') === 'true'")
  await copyFile(join(fixtures, 'Architecture', 'woodland-cabin.glb'), join(fixtures, 'watched-cabin.glb'))
  await waitFor("document.querySelector('#index-count').textContent.includes('11 файлов')")
  await waitFor("document.querySelector('#index-results').textContent.includes('watched-cabin.glb') && !document.querySelector('#index-watch').disabled")
  assert.equal(await webContents.executeJavaScript("document.querySelector('#index-metadata').elements.note.value"), 'Unsaved smoke test note')
  assert.equal(await webContents.executeJavaScript("document.querySelector('#index-analysis').open"), true)
  await webContents.executeJavaScript("document.querySelector('#index-watch').click()")
  await waitFor("document.querySelector('#index-watch').getAttribute('aria-pressed') === 'false'")
  const cabin = await readFile(join(fixtures, 'Architecture', 'woodland-cabin.glb'))
  const packagePath = await writeUnityFixture(join(process.env.ASSET_VIEWER_DATA_DIR, 'Smoke.unitypackage'),
    unityFixtureEntries(unityEntries('7'.repeat(32), 'Assets/Imported/smoke-cabin.glb', cabin)))
  assert.equal(await webContents.executeJavaScript("window.assetViewerDesktop.selectedFilePath(new File(['mock'], 'fake.unitypackage'))"), '')
  await webContents.executeJavaScript(`{
    document.querySelector('#package-importer').open = true
    document.querySelector('#package-path').value = ${JSON.stringify(packagePath)}
    document.querySelector('#package-form').requestSubmit()
  }`)
  await waitFor("document.querySelector('#package-plans summary')?.textContent.includes('Smoke.unitypackage · 7')")
  await webContents.executeJavaScript("document.querySelector('#package-engines').click()")
  await waitFor("document.querySelector('#package-engine-list').textContent.includes('Unreal Editor') && !document.querySelector('#package-engines').disabled")
  assert.equal(await webContents.executeJavaScript("document.querySelector('#package-editor-version-control').hidden"), true)
  await webContents.executeJavaScript(`
    {
      const mode = document.querySelector('#package-engine-mode')
      mode.value = 'engine-assisted'
      mode.dispatchEvent(new Event('change'))
      document.querySelector('#package-editor-version').value = '6000.999.1f1'
    }
    document.querySelector('#package-export-glb').click()
    document.querySelector('#package-plans button').click()
  `)
  assert.equal(await webContents.executeJavaScript("document.querySelector('#package-editor-version-control').hidden"), false)
  await waitFor("document.querySelector('#package-jobs').textContent.includes('В индексе')")
  await webContents.executeJavaScript(`
    document.querySelector('#package-jobs details').open = true
    Array.from(document.querySelectorAll('#package-jobs button')).find(button => button.textContent === 'Показать файлы').click()
  `)
  await waitFor("document.querySelector('#package-jobs').textContent.includes('GLB · Оригинал · Previews/')")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('Привязки материала · standard · Materials/')")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('Запрошенная версия Unity недоступна')")
  await webContents.executeJavaScript("Array.from(document.querySelectorAll('#package-jobs button')).find(button => button.textContent === 'Показать в индексе').click()")
  await waitFor("document.querySelector('#index-results').textContent.includes('fixture-package.obj')")
  await webContents.executeJavaScript("Array.from(document.querySelectorAll('#index-results button')).find(button => button.textContent.startsWith('fixture-package.obj')).click()")
  await waitFor("document.querySelector('#index-name').textContent === 'fixture-package.obj' && !document.querySelector('#index-preview').disabled")
  await webContents.executeJavaScript("document.querySelector('#index-preview').click()")
  await waitFor("!document.querySelector('#index-dialog').open && document.querySelector('#model-stats').textContent.includes('1 треугольник')")
  assert.deepEqual(externalRequests, [])
  console.log('Desktop demo, library watching, thumbnail cache, technical analysis, metadata, Unity package import and renderer isolation passed.')
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})
