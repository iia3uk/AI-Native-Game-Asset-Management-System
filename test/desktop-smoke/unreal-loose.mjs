import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cookedMaterial } from '../fixtures/unreal-cooked-material.mjs'
import { cookedStaticMesh } from '../fixtures/unreal-cooked-static-mesh.mjs'
import { cookedTexture } from '../fixtures/unreal-cooked-texture.mjs'
import { writeUnrealLooseFixture } from '../fixtures/unreal-loose.mjs'
import { soundCueFixture } from '../fixtures/unreal-source-audio.mjs'
import { sourceWave, ue4SourceFixture } from '../fixtures/unreal-source-media.mjs'

export async function verifyUnrealLoose(webContents, waitFor, root) {
  const { project, content } = await writeUnrealLooseFixture(root)
  await writeFile(join(content, 'Props/SmokeWave.uasset'), ue4SourceFixture('SoundWave', sourceWave()))
  await writeFile(join(content, 'Props/SmokeCue.uasset'), soundCueFixture({ wave: '/Game/Props/SmokeWave' }))
  const cooked = process.env.ASSET_VIEWER_SMOKE_PAK === '1'
  if (cooked) {
    const fixtures = [
      ...cookedTexture({ name: 'CookedTint', format: 'PF_G8', width: 1, height: 1, pixels: Buffer.from([49]), external: true }),
      ...cookedMaterial({ name: 'CookedPaint', textures: [{ parameter: 'BaseColor', value: '/Game/Props/CookedTint' }] }),
      ...cookedStaticMesh({ name: 'CookedModel', external: true }),
    ]
    await Promise.all(fixtures.map(file => writeFile(join(content, 'Props', file.path), file.content)))
  }
  await webContents.executeJavaScript(`{
    document.querySelector('#package-importer').open = true
    document.querySelector('#package-path').value = ${JSON.stringify(project)}
    document.querySelector('#package-form').requestSubmit()
  }`)
  await waitFor("document.querySelector('#package-plans').textContent.includes('Проект Unreal · 5.997.998')")
  const glbWasChecked = await webContents.executeJavaScript("document.querySelector('#package-export-glb').checked")
  await webContents.executeJavaScript(`{
    const mode = document.querySelector('#package-engine-mode')
    mode.value = 'engine-assisted'
    mode.dispatchEvent(new Event('change'))
    document.querySelector('#package-unreal-version').value = '5.997.998'
    const glb = document.querySelector('#package-export-glb')
    if (${cooked} && !glb.checked) glb.click()
    document.querySelector('#package-plans button').click()
  }`)
  await waitFor(`Array.from(document.querySelectorAll('#package-jobs > li > p')).some(row =>
    row.textContent.includes('Unreal Loose Fixture') && row.textContent.includes('В индексе'))`)
  if (cooked && !glbWasChecked) await webContents.executeJavaScript("document.querySelector('#package-export-glb').click()")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('Запрошенная версия Unreal недоступна')")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('1 WAV')")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('Графов SoundCue · 1')")
  if (cooked) {
    await waitFor(`Array.from(document.querySelectorAll('#package-jobs li p')).some(row =>
      row.textContent.includes('Cooked UE4.27') && row.textContent.includes('Текстуры · 1 PNG') &&
      row.textContent.includes('Описания материалов · 1'))`)
    await waitFor(`Array.from(document.querySelectorAll('#package-jobs li p')).some(row =>
      row.textContent.includes('Статические модели cooked UE4.27') && row.textContent.includes('LOD · 2'))`)
  }
  await webContents.executeJavaScript(`{
    const job = Array.from(document.querySelectorAll('#package-jobs > li')).find(row => row.textContent.includes('Unreal Loose Fixture'))
    job.querySelector('details').open = true
    Array.from(job.querySelectorAll('button')).find(button => button.textContent === 'Показать файлы').click()
  }`)
  await waitFor("document.querySelector('#package-jobs').textContent.includes('PCM 16 бит, 44100 Гц, 1 кан.')")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('Связанных WAV · 1')")
  if (!cooked) return

  const job = "Array.from(document.querySelectorAll('#package-jobs > li')).find(row => row.textContent.includes('Unreal Loose Fixture'))"
  await webContents.executeJavaScript(`Array.from((${job}).querySelectorAll('button'))
    .find(button => button.textContent === 'Показать в индексе').click()`)
  for (const [file, triangles] of [['CookedModel.glb', '2 треугольника'], ['CookedModel_Lod1.glb', '1 треугольник']]) {
    const name = JSON.stringify(file)
    const card = "Array.from(document.querySelectorAll('#index-results button')).find(button => button.textContent.startsWith(" + name + "))"
    await webContents.executeJavaScript("if (!document.querySelector('#index-dialog').open) document.querySelector('#index-mode').click()")
    await waitFor(`document.querySelector('#index-dialog').open &&
      document.querySelector('#index-results').getAttribute('aria-busy') === 'false' && Boolean(${card})`)
    await webContents.executeJavaScript(`(${card}).click()`)
    await waitFor(`document.querySelector('#index-name').textContent === ${name} && !document.querySelector('#index-preview').disabled`)
    await webContents.executeJavaScript("document.querySelector('#index-preview').click()")
    await waitFor(`!document.querySelector('#index-dialog').open &&
      document.querySelector('#model-stats').textContent.includes(${JSON.stringify(triangles)})`)
  }
}
