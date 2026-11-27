import assert from 'node:assert/strict'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { startDesktop } from '../../desktop/bootstrap.mjs'
import { generateFixtures } from '../../scripts/generate-fixtures.mjs'

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
  await webContents.executeJavaScript("document.querySelector('#index-analysis summary').click()")
  await waitFor("document.querySelector('#index-analysis').open && document.querySelector('#index-metrics').textContent.includes('Треугольники252')")
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
  assert.deepEqual(externalRequests, [])
  console.log('Desktop demo, library scanning and watching, technical analysis, metadata draft, Node utility process, sandbox, folder bridge and session token passed.')
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})
