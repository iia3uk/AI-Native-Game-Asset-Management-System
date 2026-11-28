import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeUnrealLooseFixture } from '../fixtures/unreal-loose.mjs'
import { soundCueFixture } from '../fixtures/unreal-source-audio.mjs'
import { sourceWave, ue4SourceFixture } from '../fixtures/unreal-source-media.mjs'

export async function verifyUnrealLoose(webContents, waitFor, root) {
  const { project, content } = await writeUnrealLooseFixture(root)
  await writeFile(join(content, 'Props/SmokeWave.uasset'), ue4SourceFixture('SoundWave', sourceWave()))
  await writeFile(join(content, 'Props/SmokeCue.uasset'), soundCueFixture({ wave: '/Game/Props/SmokeWave' }))
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
  await webContents.executeJavaScript(`{
    const job = Array.from(document.querySelectorAll('#package-jobs > li')).find(row => row.textContent.includes('Unreal Loose Fixture'))
    job.querySelector('details').open = true
    Array.from(job.querySelectorAll('button')).find(button => button.textContent === 'Показать файлы').click()
  }`)
  await waitFor("document.querySelector('#package-jobs').textContent.includes('PCM 16 бит, 44100 Гц, 1 кан.')")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('Связанных WAV · 1')")
}
