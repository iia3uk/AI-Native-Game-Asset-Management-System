import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureTexture, ids } from '../fixtures/unitypackage.mjs'

export async function verifyPackageExport(webContents, waitFor) {
  const destination = await mkdtemp(join(tmpdir(), 'asset-viewer-export-smoke-'))
  const panel = "document.querySelector('#package-jobs .package-export')"
  const click = label => webContents.executeJavaScript(
    `Array.from(${panel}.querySelectorAll('button')).find(button => button.textContent === ${JSON.stringify(label)}).click()`)
  const status = panel + ".querySelector('[role=status]').textContent"
  try {
    await webContents.executeJavaScript(`{
      const job = Array.from(document.querySelector('#package-jobs').children).find(node => node.textContent.includes('Smoke.unitypackage'))
      const resource = [...job.querySelectorAll('li')].find(node => node.firstChild?.textContent.includes('fixture.mat'))
      resource.querySelector('button').click()
      const input = job.querySelector('.package-export input')
      input.value = ${JSON.stringify(destination)}
      input.dispatchEvent(new Event('input'))
    }`)
    await click('Составить план')
    await waitFor(status + ".includes('Файлов: ') && " + status + ".includes('Неразрешённых зависимостей')")
    assert.deepEqual(await readdir(destination), [])
    await click('Экспортировать')
    await waitFor(status + ".startsWith('Экспорт завершён')")
    const selected = (await webContents.executeJavaScript(status)).split(' · ')[1]
    const manifest = JSON.parse(await readFile(join(selected, 'manifest.json'), 'utf8'))
    assert.equal(manifest.selection.asset, ids.material)
    assert.deepEqual(await readFile(join(selected, 'Source/Assets/Imported/albedo.png')), fixtureTexture)
    await click('Выбрать весь пакет')
    await click('Составить план')
    await waitFor(status + ".includes('Файлов: ')")
    await click('Экспортировать')
    await waitFor(status + ".startsWith('Экспорт завершён')")
    const whole = (await webContents.executeJavaScript(status)).split(' · ')[1]
    assert.notEqual(whole, selected)
    const report = JSON.parse(await readFile(join(whole, 'manifest.json'), 'utf8'))
    assert.equal(report.assets.length, 7)
    assert.ok(report.assets.some(asset => asset.exports?.some(output => output.path?.endsWith('/smoke-cabin.glb'))))
  } finally {
    await rm(destination, { recursive: true, force: true })
  }
}
