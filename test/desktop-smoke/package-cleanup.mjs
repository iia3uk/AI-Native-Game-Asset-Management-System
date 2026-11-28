import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { dialog, shell } from 'electron'
import { sourceWave, ue4SourceFixture } from '../fixtures/unreal-source-media.mjs'
import { fixtureModel, ids, writeUnityFixture } from '../fixtures/unitypackage.mjs'

export async function verifyPackageCleanup(webContents, waitFor) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'asset-viewer-cleanup-smoke-')))
  const move = shell.trashItem
  const ask = dialog.showMessageBox
  const pick = dialog.showOpenDialog
  const prompts = []
  const moved = []
  let confirm = false
  let exportRoot
  try {
    dialog.showMessageBox = async (_window, options) => {
      if (exportRoot) {
        const directory = await webContents.executeJavaScript(
          "document.querySelector('#package-process-output').textContent.slice('Экспорт · '.length)")
        assert.equal(directory.startsWith(exportRoot + sep), true)
        const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
        assert.equal(manifest.export.processedOnly, true)
        if (options.checkboxLabel.includes('Unity')) {
          const prefab = manifest.assets.find(asset => asset.id === ids.prefab)
          assert.equal(prefab.output, null)
          const model = manifest.assets.find(asset => asset.id === ids.model)
          assert.equal(await readFile(join(directory, model.output), 'utf8'), fixtureModel)
        } else {
          const [asset] = manifest.assets
          assert.equal(asset.output, null)
          const wav = asset.exports.find(item => item.format === 'wav')
          assert.deepEqual(await readFile(join(directory, wav.path)), sourceWave())
        }
      }
      prompts.push(options)
      return { response: confirm ? 1 : 0, checkboxChecked: true }
    }
    shell.trashItem = async path => {
      assert.equal(path.startsWith(root + sep), true)
      await rename(path, join(root, 'trash-' + moved.length + '-' + basename(path)))
      moved.push(path)
    }
    const input = ue4SourceFixture('SoundWave', sourceWave())
    async function submit(folder, destination) {
      await webContents.executeJavaScript(`{
        document.querySelector('#package-source-cleanup').open = true
        document.querySelector('#package-process-source').value = ${JSON.stringify(folder)}
        document.querySelector('#package-process-destination').value = ${JSON.stringify(destination ?? folder)}
        document.querySelector('#package-engine-mode').value = 'engineless'
        document.querySelector('#package-process-cleanup').click()
      }`)
    }

    async function launch(name, destination = '') {
      const folder = join(root, name)
      await mkdir(folder)
      const source = join(folder, 'Step.uasset')
      await writeFile(source, input)
      await submit(folder, destination)
      return source
    }

    assert.equal(await webContents.executeJavaScript("document.querySelector('#package-source-cleanup').hidden"), false)
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
    const invalid = await launch('Unreal Export Failure', null)
    await waitFor("document.querySelector('#package-cleanup-status').textContent.startsWith('Выберите папку вне') && !document.querySelector('#package-process-cleanup').disabled")
    assert.deepEqual(await readFile(invalid), input)
    assert.equal(prompts.length, 2)
    assert.deepEqual(moved, [first, second])

    await webContents.executeJavaScript("document.querySelector('#package-restore-confirmation').click()")
    await waitFor("document.querySelector('#package-cleanup-status').textContent === 'Подтверждения Unity и Unreal включены.'")
    confirm = false
    exportRoot = join(root, 'Processed')
    await mkdir(exportRoot)
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [exportRoot] })
    await webContents.executeJavaScript("document.querySelector('#package-process-destination-pick').click()")
    await waitFor("document.querySelector('#package-process-destination').value === " + JSON.stringify(exportRoot))
    const third = await launch('Unreal Cleanup Three', exportRoot)
    await waitFor("document.querySelector('#package-cleanup-status').textContent === 'Исходники оставлены.'")
    assert.equal(prompts.length, 3)
    assert.deepEqual(await readFile(third), input)

    const unityFolder = join(root, 'Unity Cleanup')
    await mkdir(unityFolder)
    const unitySource = await writeUnityFixture(join(unityFolder, 'Sample.unitypackage'))
    confirm = true
    await submit(unityFolder, exportRoot)
    await waitFor("document.querySelector('#package-cleanup-status').textContent.startsWith('В корзине · 1')")
    assert.equal(prompts.length, 4)
    assert.match(prompts[3].checkboxLabel, /Unity/)
    assert.deepEqual(moved, [first, second, unitySource])
    await assert.rejects(readFile(unitySource), { code: 'ENOENT' })
  } finally {
    dialog.showMessageBox = ask
    dialog.showOpenDialog = pick
    shell.trashItem = move
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}
