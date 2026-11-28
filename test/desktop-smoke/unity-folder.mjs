import assert from 'node:assert/strict'
import { writeUnityFolderFixture } from '../fixtures/unity-folder.mjs'

export async function verifyUnityFolder(webContents, waitFor, root) {
  const { project } = await writeUnityFolderFixture(root)
  await webContents.executeJavaScript(`{
    document.querySelector('#package-importer').open = true
    document.querySelector('#package-path').value = ${JSON.stringify(project)}
    document.querySelector('#package-form').requestSubmit()
  }`)
  assert.equal(await webContents.executeJavaScript("document.querySelector('#package-pick-project').hidden"), false)
  await waitFor("document.querySelector('#package-plans').textContent.includes('Проект Unity · 6000.3.10f1')")
  await webContents.executeJavaScript("document.querySelector('#package-plans button').click()")
  await waitFor(`Array.from(document.querySelectorAll('#package-jobs > li > p'))
    .some(row => row.textContent.includes('Unity Folder Fixture') && row.textContent.includes('В индексе'))`)
}
