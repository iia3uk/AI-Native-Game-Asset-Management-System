import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { startDesktop } from '../../desktop/bootstrap.mjs'
import { generateFixtures } from '../../scripts/generate-fixtures.mjs'
import { verifyLocalAudio } from './local-audio.mjs'
import { verifyUnrealLocalMaterials } from './unreal-local-materials.mjs'
import { verifyPackageExport } from './package-export.mjs'
import { verifyPackageCleanup } from './package-cleanup.mjs'
import { verifyPackageFolder } from './package-folder.mjs'
import { verifyPackageWatch } from './package-watch.mjs'
import { verifyStartupWithoutInterface } from './startup.mjs'
import { verifyUnityAudio } from './unity-audio.mjs'
import { verifyUnityBundle } from './unity-bundle.mjs'
import { verifyUnityFolder } from './unity-folder.mjs'
import { verifyUnitySprites } from './unity-sprites.mjs'
import { verifyUnrealLoose } from './unreal-loose.mjs'
import { verifyUnrealIoStore } from './unreal-iostore.mjs'
import { verifyUnrealPak } from './unreal-pak.mjs'
import { verifyUnityPreview } from './unity-preview.mjs'
import { unityEntries, unityFixtureEntries, writeUnityFixture } from '../fixtures/unitypackage.mjs'

const screenshot = process.env.ASSET_VIEWER_SMOKE_SCREENSHOT
const root = fileURLToPath(new URL('../../', import.meta.url))

async function launchSmoke() {
  if (!process.env.ASSET_VIEWER_DATA_DIR) throw new Error('Run npm run test:desktop to create isolated smoke-test data.')
  process.env.ASSET_VIEWER_PORT ||= '0'
  app.commandLine.appendSwitch('use-angle', 'swiftshader')
  return startDesktop(root, { showWindow: false })
}

void launchSmoke().then(async ({ window, origin }) => {
  const { webContents } = window
  webContents.setBackgroundThrottling(false)
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
    const status = await webContents.executeJavaScript(`Object.fromEntries(
      ['index-status', 'package-status', 'package-plans', 'package-jobs', 'package-importer'].map(id => {
        const node = document.getElementById(id)
        return [id, id === 'package-importer' ? node.open : node.textContent.slice(0, 500)]
      }))`)
    throw new Error('Renderer did not reach expected state: ' + expression + '. Status: ' + JSON.stringify(status))
  }
  await waitFor("document.querySelector('#library-stats').textContent.includes('3D-файлов')")
  await waitFor("document.querySelector('.brand-mark').naturalWidth > 0")
  assert.equal(await webContents.executeJavaScript(`
    document.querySelector('.brand-mark').src === document.querySelector('link[rel=icon]').href
  `), true)
  assert.equal(await webContents.executeJavaScript("typeof window.assetViewerDesktop.chooseFolder"), 'function')
  await webContents.executeJavaScript("document.querySelector('#demo-mode').click()")
  await waitFor("document.querySelector('#animation-tools').hidden === false")
  await waitFor("document.querySelector('#model-stats').textContent.includes('252')")
  await waitFor("document.querySelectorAll('#pack-list img').length === 3")
  if (screenshot) {
    await mkdir(dirname(screenshot), { recursive: true })
    await writeFile(screenshot, (await webContents.capturePage(undefined, { stayHidden: true })).toPNG())
  }
  await verifyLocalAudio(webContents, waitFor, join(process.env.ASSET_VIEWER_DATA_DIR, 'local-audio-fixture'),
    process.env.ASSET_VIEWER_SMOKE_LOCAL_AUDIO)
  if (process.env.ASSET_VIEWER_SMOKE_UNREAL_MATERIALS) {
    await verifyUnrealLocalMaterials(webContents, waitFor, process.env.ASSET_VIEWER_SMOKE_UNREAL_MATERIALS)
  }
  await verifyUnityPreview(webContents, join(process.env.ASSET_VIEWER_DATA_DIR, 'unity-preview-fixture'))
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
  await verifyPackageExport(webContents, waitFor)
  await webContents.executeJavaScript("Array.from(document.querySelectorAll('#package-jobs button')).find(button => button.textContent === 'Показать в индексе').click()")
  await waitFor("document.querySelector('#index-results').textContent.includes('fixture-package.obj')")
  await webContents.executeJavaScript("Array.from(document.querySelectorAll('#index-results button')).find(button => button.textContent.startsWith('fixture-package.obj')).click()")
  await waitFor("document.querySelector('#index-name').textContent === 'fixture-package.obj' && !document.querySelector('#index-preview').disabled")
  await webContents.executeJavaScript("document.querySelector('#index-preview').click()")
  await waitFor("!document.querySelector('#index-dialog').open && document.querySelector('#model-stats').textContent.includes('1 треугольник')")
  await verifyPackageFolder(webContents, waitFor, join(process.env.ASSET_VIEWER_DATA_DIR, 'incoming-packages'))
  await verifyUnityFolder(webContents, waitFor, join(process.env.ASSET_VIEWER_DATA_DIR, 'unity-folder-fixture'))
  await verifyUnrealLoose(webContents, waitFor, join(process.env.ASSET_VIEWER_DATA_DIR, 'unreal-loose-fixture'))
  await verifyPackageCleanup(webContents, waitFor)
  const bundle = process.env.ASSET_VIEWER_SMOKE_BUNDLE
  const sprites = process.env.ASSET_VIEWER_SMOKE_SPRITES
  const atlas = process.env.ASSET_VIEWER_SMOKE_ATLAS
  const audio = process.env.ASSET_VIEWER_SMOKE_AUDIO
  const standalone = process.env.ASSET_VIEWER_SMOKE_STANDALONE
  const player = process.env.ASSET_VIEWER_SMOKE_PLAYER
  const pak = process.env.ASSET_VIEWER_SMOKE_PAK === '1'
  const ioStore = process.env.ASSET_VIEWER_SMOKE_IOSTORE === '1'
  const watchPlayer = process.env.ASSET_VIEWER_SMOKE_WATCH_PLAYER
  await verifyPackageWatch(webContents, waitFor, fixtures, { bundle, player: watchPlayer, pak, ioStore })
  if (bundle) await verifyUnityBundle(webContents, waitFor, bundle)
  if (sprites) await verifyUnitySprites(webContents, waitFor, sprites)
  if (atlas) await verifyUnitySprites(webContents, waitFor, atlas, { atlas: true })
  if (audio) await verifyUnityAudio(webContents, waitFor, audio)
  if (standalone) await verifyUnityBundle(webContents, waitFor, standalone, { standalone: true })
  if (player) await verifyUnityAudio(webContents, waitFor, player, { companion: true })
  if (pak) await verifyUnrealPak(webContents, waitFor, fixtures)
  if (ioStore) await verifyUnrealIoStore(webContents, waitFor, fixtures)
  await verifyStartupWithoutInterface()
  assert.deepEqual(externalRequests, [])
  assert.equal(window.isVisible(), false)
  console.log('Desktop startup, demo, local audio playback, library watching, thumbnail cache, analysis, metadata, package import, pause, export, PBR material preview and renderer isolation passed.')
  if (bundle) console.log('UnityFS folder watching, inspection, queued import, artifact report and indexed GLB preview passed.')
  if (sprites) console.log('UnityFS sprite inspection, queued import, dependency reporting and indexed PNG preview passed.')
  if (atlas) console.log('UnityFS SpriteAtlas inspection, queued import and indexed PNG preview passed.')
  if (audio) console.log('UnityFS PCM inspection, queued import, local byte ranges and indexed WAV playback passed.')
  if (standalone) console.log('Standalone Unity file inspection, queued import and indexed GLB preview passed.')
  if (player) console.log('Unity Player companion inspection, queued texture and audio import and WAV playback passed.')
  if (watchPlayer) console.log('Unity Player watched-folder opt-in, import and indexing passed.')
  if (pak) console.log('Unreal Pak folder watching, inspection, queued texture and material import, artifact report and indexed GLB preview passed.')
  if (ioStore) console.log('Unreal IoStore inspection, queued extraction, indexed WAV and Zen Vorbis playback, PNG and static mesh GLB previews passed.')
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})
