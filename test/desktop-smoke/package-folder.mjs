import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fixtureModel, unityEntries, writeUnityFixture } from '../fixtures/unitypackage.mjs'

export async function verifyPackageFolder(webContents, waitFor, root) {
  const nested = join(root, 'nested')
  await mkdir(nested, { recursive: true })
  const entries = unityEntries('d'.repeat(32), 'Assets/folder-smoke.obj', fixtureModel)
  await Promise.all(Array.from({ length: 17 }, (_, index) =>
    writeUnityFixture(join(nested, 'folder-' + String(index).padStart(2, '0') + '.data'), entries)))

  await webContents.executeJavaScript(`{
    document.querySelector('#index-mode').click()
    document.querySelector('#package-importer').open = true
    const form = document.querySelector('#package-folder-form')
    form.closest('details').open = true
    document.querySelector('#package-folder-path').value = ${JSON.stringify(root)}
    form.requestSubmit()
  }`)
  await waitFor("document.querySelector('#package-folder-page').textContent === '1–16 из 17'")
  await webContents.executeJavaScript("document.querySelector('#package-folder-next').click()")
  await waitFor("document.querySelector('#package-folder-page').textContent === '17–17 из 17'")
  await webContents.executeJavaScript("document.querySelector('#package-folder-inspect').click()")
  await waitFor("document.querySelector('#package-plans summary')?.textContent.includes('nested/folder-16.data')")
  assert.equal(await webContents.executeJavaScript("document.querySelectorAll('#package-plans li.index-analysis').length"), 1)
  await webContents.executeJavaScript(`{
    const mode = document.querySelector('#package-engine-mode')
    mode.value = 'engineless'
    mode.dispatchEvent(new Event('change'))
    document.querySelector('#package-export-glb').checked = false
    document.querySelector('#package-plans button').click()
  }`)
  await waitFor(`Array.from(document.querySelectorAll('#package-jobs > li > p'))
    .some(row => row.textContent.includes('folder-16.data') && row.textContent.includes('В индексе'))`)
}
