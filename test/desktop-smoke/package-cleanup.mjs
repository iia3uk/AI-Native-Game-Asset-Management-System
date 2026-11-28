import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { dialog, shell } from 'electron'
import { sourceWave, ue4SourceFixture } from '../fixtures/unreal-source-media.mjs'

export async function verifyPackageCleanup(webContents, waitFor) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'asset-viewer-cleanup-smoke-')))
  const move = shell.trashItem
  const ask = dialog.showMessageBox
  const prompts = []
  const moved = []
  let confirm = false
  try {
    dialog.showMessageBox = async (_window, options) => {
      prompts.push(options)
      return { response: confirm ? 1 : 0, checkboxChecked: true }
    }
    shell.trashItem = async path => {
      assert.equal(path.startsWith(root + sep), true)
      await rename(path, join(root, 'trash-' + moved.length + '-' + basename(path)))
      moved.push(path)
    }
    const input = ue4SourceFixture('SoundWave', sourceWave())
    async function launch(name) {
      const folder = join(root, name)
      await mkdir(folder)
      const source = join(folder, 'Step.uasset')
      await writeFile(source, input)
      await webContents.executeJavaScript(`{
        document.querySelector('#package-path').value = ${JSON.stringify(folder)}
        document.querySelector('#package-engine-mode').value = 'engineless'
        document.querySelector('#package-process-cleanup').click()
      }`)
      return source
    }

    assert.equal(await webContents.executeJavaScript("document.querySelector('#package-process-cleanup').parentElement.hidden"), false)
    const unauthorized = await webContents.executeJavaScript("window.assetViewerDesktop.cleanupSource('C:/Outside.uasset')")
    assert.equal(unauthorized.status, 'unavailable')
    const first = await launch('Unreal Cleanup One')
    await waitFor("document.querySelector('#package-cleanup-status').textContent === 'Исходники оставлены.'")
    assert.deepEqual(await readFile(first), input)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].defaultId, 0)
    assert.match(prompts[0].checkboxLabel, /Unreal/)
    assert.ok(prompts[0].detail.includes(first))
    assert.deepEqual(moved, [])

    confirm = true
    await webContents.executeJavaScript(`{
      const row = Array.from(document.querySelectorAll('#package-jobs > li')).find(node => node.textContent.includes('Unreal Cleanup One'))
      Array.from(row.querySelectorAll('button')).find(button => button.textContent === 'Исходники в корзину…').click()
    }`)
    await waitFor("document.querySelector('#package-cleanup-status').textContent.startsWith('В корзине · 1')")
    assert.equal(prompts.length, 2)
    assert.deepEqual(moved, [first])

    const second = await launch('Unreal Cleanup Two')
    await waitFor("document.querySelector('#package-cleanup-status').textContent.startsWith('В корзине · 1')")
    assert.equal(prompts.length, 2)
    assert.deepEqual(moved, [first, second])
    await webContents.executeJavaScript("document.querySelector('#package-restore-confirmation').click()")
    await waitFor("document.querySelector('#package-cleanup-status').textContent === 'Подтверждения Unity и Unreal включены.'")
    confirm = false
    const third = await launch('Unreal Cleanup Three')
    await waitFor("document.querySelector('#package-cleanup-status').textContent === 'Исходники оставлены.'")
    assert.equal(prompts.length, 3)
    assert.deepEqual(await readFile(third), input)
  } finally {
    dialog.showMessageBox = ask
    shell.trashItem = move
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}
