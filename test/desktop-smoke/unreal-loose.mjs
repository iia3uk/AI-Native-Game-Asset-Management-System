import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cookedMaterial } from '../fixtures/unreal-cooked-material.mjs'
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
    ]
    await Promise.all(fixtures.map(file => writeFile(join(content, 'Props', file.path), file.content)))
  }
  await webContents.executeJavaScript(`{
    document.querySelector('#package-importer').open = true
    document.querySelector('#package-path').value = ${JSON.stringify(project)}
    document.querySelector('#package-form').requestSubmit()
  }`)
  await waitFor("document.querySelector('#package-plans').textContent.includes('Проект Unreal · 5.997.998')")
  await webContents.executeJavaScript(`{
    const mode = document.querySelector('#package-engine-mode')
    mode.value = 'engine-assisted'
    mode.dispatchEvent(new Event('change'))
    document.querySelector('#package-unreal-version').value = '5.997.998'
    document.querySelector('#package-plans button').click()
  }`)
  await waitFor(`Array.from(document.querySelectorAll('#package-jobs > li > p')).some(row =>
    row.textContent.includes('Unreal Loose Fixture') && row.textContent.includes('В индексе'))`)
  await waitFor("document.querySelector('#package-jobs').textContent.includes('Запрошенная версия Unreal недоступна')")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('1 WAV')")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('Графов SoundCue · 1')")
  if (cooked) {
    await waitFor(`Array.from(document.querySelectorAll('#package-jobs li p')).some(row =>
      row.textContent.includes('Cooked UE4.27') && row.textContent.includes('Текстуры · 1 PNG') &&
      row.textContent.includes('Описания материалов · 1'))`)
  }
  await webContents.executeJavaScript(`{
    const job = Array.from(document.querySelectorAll('#package-jobs > li')).find(row => row.textContent.includes('Unreal Loose Fixture'))
    job.querySelector('details').open = true
    Array.from(job.querySelectorAll('button')).find(button => button.textContent === 'Показать файлы').click()
  }`)
  await waitFor("document.querySelector('#package-jobs').textContent.includes('PCM 16 бит, 44100 Гц, 1 кан.')")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('Связанных WAV · 1')")
}
