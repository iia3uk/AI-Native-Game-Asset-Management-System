import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { dialog, shell } from 'electron'
import { AssetIndex } from '../../core/index/asset-index.mjs'
import { inspectPackage, packageOptions } from '../../core/packages/dispatch.mjs'
import { importSource } from '../../core/packages/source.mjs'
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
  let beforeAnswer
  let sharedOutput = false
  try {
    dialog.showMessageBox = async (_window, options) => {
      if (exportRoot) {
        const directory = await webContents.executeJavaScript(
          "document.querySelector('#package-process-output').textContent.slice(" +
          (sharedOutput ? 'Библиотека · '.length : 'Экспорт · '.length) + ")")
        assert.equal(directory.startsWith(exportRoot + sep), true)
        const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
        assert.equal(manifest.export?.processedOnly, sharedOutput ? undefined : true)
        if (options.checkboxLabel.includes('Unity')) {
          if (!sharedOutput) assert.equal(manifest.assets.find(asset => asset.id === ids.prefab).output, null)
          const model = manifest.assets.find(asset => asset.id === ids.model)
          assert.equal(await readFile(join(directory, model.output), 'utf8'), fixtureModel)
        } else {
          const [asset] = manifest.assets
          if (sharedOutput) assert.ok(asset.output.endsWith('.uasset'))
          else assert.equal(asset.output, null)
          const wav = asset.exports.find(item => item.format === 'wav')
          assert.deepEqual(await readFile(join(directory, wav.path)), sourceWave())
          await beforeAnswer?.(join(directory, wav.path))
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
    async function submit(folder, destination, compact = false, shared = false) {
      await webContents.executeJavaScript(`{
        document.querySelector('#package-source-cleanup').open = true
        document.querySelector('#package-process-source').value = ${JSON.stringify(folder)}
        document.querySelector('#package-process-destination').value = ${JSON.stringify(destination ?? folder)}
        document.querySelector('#package-process-destination').dispatchEvent(new Event('input'))
        document.querySelector('#package-process-compact').checked = ${compact}
        document.querySelector('#package-process-shared').checked = ${shared}
        document.querySelector('#package-engine-mode').value = 'engineless'
        document.querySelector('#package-process-cleanup').click()
      }`)
    }

    async function launch(name, destination = '', beforeSubmit) {
      const folder = join(root, name)
      await mkdir(folder)
      const source = join(folder, 'Step.uasset')
      await writeFile(source, input)
      await beforeSubmit?.(folder)
      await submit(folder, destination)
      return source
    }

    assert.equal(await webContents.executeJavaScript("document.querySelector('#package-source-cleanup').hidden"), false)
    const unauthorized = await webContents.executeJavaScript("window.assetViewerDesktop.cleanupSource('C:/Outside.uasset')")
    assert.equal(unauthorized.status, 'unavailable')
    const quickButton = "document.querySelector('#package-process-folder-quick')"
    const indexDialog = "document.querySelector('#index-dialog')"
    const sourceInput = "document.querySelector('#package-process-source')"
    const destinationInput = "document.querySelector('#package-process-destination')"
    const startButton = "document.querySelector('#package-process-cleanup')"
    await webContents.executeJavaScript(indexDialog + '.close()')
    assert.equal(await webContents.executeJavaScript(quickButton + '.hidden'), false)
    let picks = 0
    dialog.showOpenDialog = async (_window, options) => {
      assert.deepEqual(options.properties, ['openDirectory'])
      picks++
      return { canceled: true, filePaths: [] }
    }
    await webContents.executeJavaScript(quickButton + '.click()')
    await waitFor('!' + quickButton + '.disabled')
    assert.equal(picks, 1)
    assert.equal(await webContents.executeJavaScript(indexDialog + '.open'), false)
    assert.deepEqual(prompts, [])

    const firstFolder = join(root, 'Unreal Cleanup One')
    const first = join(firstFolder, 'Step.uasset')
    await mkdir(firstFolder)
    await writeFile(first, input)
    dialog.showOpenDialog = async () => {
      picks++
      return { canceled: false, filePaths: [firstFolder] }
    }
    await webContents.executeJavaScript(quickButton + '.click()')
    await waitFor(indexDialog + ".open && document.querySelector('#package-source-cleanup').open && " +
      sourceInput + '.value === ' + JSON.stringify(firstFolder))
    assert.equal(await webContents.executeJavaScript(destinationInput + '.value'), '')
    assert.deepEqual(prompts, [])
    await webContents.executeJavaScript(startButton + '.click()')
    await waitFor("document.querySelector('#package-cleanup-status').textContent === 'Исходники оставлены.'")
    assert.equal(picks, 2)
    assert.deepEqual(await readFile(first), input)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].defaultId, 0)
    assert.match(prompts[0].checkboxLabel, /Unreal/)
    assert.ok(prompts[0].detail.includes(first))
    assert.deepEqual(moved, [])
    const quickIndex = await AssetIndex.open(join(process.env.ASSET_VIEWER_DATA_DIR, 'index.sqlite'))
    try {
      const run = quickIndex.folderRuns.get()
      assert.equal(run.source.path, firstFolder)
      assert.equal(run.destination, null)
      assert.equal(run.options.mode, 'auto')
      assert.deepEqual(run.options.formats, ['fbx', 'glb'])
    } finally { await quickIndex.close() }

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
    assert.equal(await webContents.executeJavaScript("document.querySelector('#package-process-shared').checked"), true)
    const third = await launch('Unreal Cleanup Three', exportRoot, async folder => {
      const source = await importSource(folder)
      const report = await inspectPackage(source)
      const formats = await webContents.executeJavaScript(
        "['fbx', 'glb'].filter(format => document.querySelector('#package-export-' + format).checked)")
      const options = packageOptions(report.format, { formats, mode: 'engineless' })
      const index = await AssetIndex.open(join(process.env.ASSET_VIEWER_DATA_DIR, 'index.sqlite'))
      try {
        const job = index.jobs.enqueueImport(source.path, report.hash, options.formats, options)
        assert.equal(index.jobs.pauseImport(job.id).status, 'paused')
      } finally {
        await index.close()
      }
    })
    await waitFor("document.querySelector('#package-cleanup-status').textContent.includes('Обработка папки на паузе')")
    assert.deepEqual(await readdir(exportRoot), [])
    assert.equal(prompts.length, 2)
    assert.deepEqual(await readFile(third), input)
    const reloaded = once(webContents, 'did-finish-load')
    webContents.reload()
    await reloaded
    await waitFor(quickButton + ".textContent === 'Ход импорта UE / Unity'")
    await webContents.executeJavaScript(quickButton + '.click()')
    await waitFor(indexDialog + '.open')
    await waitFor("document.querySelector('#package-cleanup-status').textContent.includes('Обработка папки на паузе')")
    assert.equal(await webContents.executeJavaScript("document.querySelector('#package-process-destination').value"), exportRoot)
    await waitFor("Array.from(document.querySelectorAll('#package-jobs button')).some(button => button.textContent === 'Продолжить')")
    await webContents.executeJavaScript(`{
      const row = Array.from(document.querySelectorAll('#package-jobs > li')).find(node => node.textContent.includes('Unreal Cleanup Three'))
      Array.from(row.querySelectorAll('button')).find(button => button.textContent === 'Продолжить').click()
    }`)
    await waitFor("document.querySelector('#package-cleanup-status').textContent === 'Исходники оставлены.'")
    assert.equal(prompts.length, 3)
    assert.deepEqual(await readFile(third), input)

    const priorExports = await readdir(exportRoot)
    await submit(dirname(third), exportRoot)
    await waitFor("document.querySelector('#package-cleanup-status').textContent === 'Исходники оставлены. · Использовано готовых экспортов: 1'")
    assert.equal(prompts.length, 4)
    assert.deepEqual(await readdir(exportRoot), priorExports)
    assert.deepEqual(await readFile(third), input)

    const unityFolder = join(root, 'Unity Cleanup')
    await mkdir(unityFolder)
    const unitySource = await writeUnityFixture(join(unityFolder, 'Sample.unitypackage'))
    confirm = true
    await submit(unityFolder, exportRoot)
    await waitFor("document.querySelector('#package-cleanup-status').textContent.startsWith('В корзине · 1')")
    assert.equal(prompts.length, 5)
    assert.match(prompts[4].checkboxLabel, /Unity/)
    assert.deepEqual(moved, [first, second, unitySource])
    await assert.rejects(readFile(unitySource), { code: 'ENOENT' })

    const mixed = join(root, 'Unity and Unreal')
    await mkdir(mixed)
    const mixedUnity = await writeUnityFixture(join(mixed, 'Mixed.unitypackage'))
    const mixedUnreal = join(mixed, 'Mixed.uasset')
    await writeFile(mixedUnreal, input)
    confirm = false
    exportRoot = undefined
    await submit(mixed, '')
    await waitFor("document.querySelector('#package-cleanup-status').textContent.startsWith('В корзине · 1')")
    assert.equal(prompts.length, 6)
    assert.match(prompts[5].checkboxLabel, /Unreal/)
    assert.deepEqual(moved, [first, second, unitySource, mixedUnity])
    assert.deepEqual(await readFile(mixedUnreal), input)

    exportRoot = join(root, 'Compact output')
    await mkdir(exportRoot)
    const compactFolder = join(root, 'Compact Unreal')
    const compactSource = join(compactFolder, 'Step.uasset')
    await mkdir(compactFolder)
    await writeFile(compactSource, input)
    beforeAnswer = wave => writeFile(wave, 'edited after confirmation displayed')
    confirm = true
    await submit(compactFolder, exportRoot, true)
    await waitFor("document.querySelector('#package-cleanup-status').textContent.includes('Экспорт не подтверждён для пакетов: 1')")
    assert.equal(prompts.length, 7)
    assert.match(prompts[6].detail, /служебные копии/)
    assert.deepEqual(await readFile(compactSource), input)

    beforeAnswer = undefined
    await submit(compactFolder, exportRoot, true)
    await waitFor("document.querySelector('#package-cleanup-status').textContent.includes('Удалено служебных копий 1')")
    assert.equal(prompts.length, 8)
    assert.deepEqual(moved, [first, second, unitySource, mixedUnity, compactSource])
    const index = await AssetIndex.open(join(process.env.ASSET_VIEWER_DATA_DIR, 'index.sqlite'))
    try {
      const run = index.folderRuns.get()
      const [item] = run.items
      assert.equal(run.options.compact, true)
      assert.equal(run.cleanup.retired, 1)
      const result = index.jobs.get(item.jobId).result
      await assert.rejects(readFile(join(result.directory, 'Source', 'Content', 'Step.uasset')), { code: 'ENOENT' })
      assert.deepEqual(await readFile(join(result.directory, 'Audio', 'Step.wav')), sourceWave())
      assert.deepEqual(await readFile(join(item.directory, 'Audio', 'Step.wav')), sourceWave())
    } finally { await index.close() }

    await webContents.executeJavaScript("document.querySelector('#package-restore-confirmation').click()")
    await waitFor("document.querySelector('#package-cleanup-status').textContent === 'Подтверждения Unity и Unreal включены.'")
    exportRoot = join(root, 'Shared output')
    sharedOutput = true
    const sharedFolder = join(root, 'Shared Unreal')
    const sharedSource = join(sharedFolder, 'Step.uasset')
    await Promise.all([mkdir(exportRoot), mkdir(sharedFolder)])
    await writeFile(sharedSource, input)
    await webContents.executeJavaScript(indexDialog + '.close()')
    const directories = [sharedFolder, exportRoot]
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directories.shift()] })
    await webContents.executeJavaScript(quickButton + '.click()')
    await waitFor(sourceInput + '.value === ' + JSON.stringify(sharedFolder))
    assert.equal(await webContents.executeJavaScript(destinationInput + '.value'), '')
    await webContents.executeJavaScript("document.querySelector('#package-process-destination-pick').click()")
    await waitFor(destinationInput + '.value === ' + JSON.stringify(exportRoot))
    assert.equal(await webContents.executeJavaScript("document.querySelector('#package-process-shared').checked"), true)
    assert.equal(prompts.length, 8)
    await webContents.executeJavaScript("document.querySelector('#package-process-compact').checked = true; " + startButton + '.click()')
    await waitFor("document.querySelector('#package-cleanup-status').textContent.includes('Удалено служебных копий 1') && document.querySelector('#package-process-output').textContent.startsWith('Библиотека · ')")
    assert.equal(prompts.length, 9)
    assert.deepEqual(moved, [first, second, unitySource, mixedUnity, compactSource, sharedSource])
    const sharedIndex = await AssetIndex.open(join(process.env.ASSET_VIEWER_DATA_DIR, 'index.sqlite'))
    try {
      const run = sharedIndex.folderRuns.get()
      const [item] = run.items
      const result = sharedIndex.jobs.get(item.jobId).result
      assert.equal(run.options.shared, true)
      assert.equal(result.directory, item.directory)
      assert.equal(result.library.root, item.directory)
      assert.deepEqual(await readdir(exportRoot), [basename(run.storagePath)])
      assert.deepEqual(await readFile(join(item.directory, 'Audio', 'Step.wav')), sourceWave())
      await assert.rejects(readFile(join(item.directory, 'Source', 'Content', 'Step.uasset')), { code: 'ENOENT' })

      const nextFolder = join(root, 'Shared Unity')
      await mkdir(nextFolder)
      const nextSource = await writeUnityFixture(join(nextFolder, 'Next.unitypackage'))
      confirm = false
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [nextFolder] })
      await webContents.executeJavaScript(indexDialog + '.close(); ' + quickButton + '.click()')
      await waitFor(sourceInput + '.value === ' + JSON.stringify(nextFolder))
      assert.equal(await webContents.executeJavaScript(destinationInput + '.value'), exportRoot)
      await webContents.executeJavaScript(startButton + '.click()')
      await waitFor("document.querySelector('#package-cleanup-status').textContent === 'Исходники оставлены.'")
      assert.equal(prompts.length, 10)
      assert.match(prompts[9].checkboxLabel, /Unity/)
      assert.ok(prompts[9].detail.includes(nextSource))
      assert.ok((await readFile(nextSource)).length)
      const nextRun = sharedIndex.folderRuns.get()
      assert.equal(nextRun.storagePath, run.storagePath)
      assert.equal(nextRun.options.shared, true)
      assert.notEqual(nextRun.items[0].directory, item.directory)
      assert.deepEqual(await readdir(exportRoot), [basename(run.storagePath)])
      assert.deepEqual(await readFile(join(item.directory, 'Audio', 'Step.wav')), sourceWave())
    } finally { await sharedIndex.close() }
  } finally {
    dialog.showMessageBox = ask
    dialog.showOpenDialog = pick
    shell.trashItem = move
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
}
