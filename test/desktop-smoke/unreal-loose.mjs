import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cookedMaterial } from '../fixtures/unreal-cooked-material.mjs'
import { cookedSoundWave } from '../fixtures/unreal-cooked-soundwave.mjs'
import { cookedStaticMesh } from '../fixtures/unreal-cooked-static-mesh.mjs'
import { cookedTexture } from '../fixtures/unreal-cooked-texture.mjs'
import { demoSkeletonGuid, editorAnimationFixture } from '../fixtures/unreal-editor-animation.mjs'
import { editorSkeletalMeshFixture } from '../fixtures/unreal-editor-skeletal-mesh.mjs'
import { writeUnrealLooseFixture } from '../fixtures/unreal-loose.mjs'
import { soundCueFixture } from '../fixtures/unreal-source-audio.mjs'
import { sourceWave, ue4SourceFixture } from '../fixtures/unreal-source-media.mjs'
import { sourceArtPackage, sourceArtPng } from '../fixtures/unreal-source-texture.mjs'
import { unrealSkeletonFixture } from '../fixtures/unreal-skeleton.mjs'
import { zenOgg } from '../fixtures/unreal-zen-audio.mjs'
import { playIndexedAudio } from './unreal-iostore.mjs'

export async function verifyUnrealLoose(webContents, waitFor, root) {
  const { project, content } = await writeUnrealLooseFixture(root)
  await writeFile(join(content, 'Props/SmokeWave.uasset'), ue4SourceFixture('SoundWave', sourceWave()))
  await writeFile(join(content, 'Props/SmokeCue.uasset'), soundCueFixture({ wave: '/Game/Props/SmokeWave' }))
  await writeFile(join(content, 'Props/SourceArt.uasset'), sourceArtPackage(sourceArtPng(), { compressed: true }))
  const skeleton = '/Game/Props/Character_Skeleton'
  await writeFile(join(content, 'Props/SkeletalSmoke.uasset'), editorSkeletalMeshFixture({
    name: 'SkeletalSmoke', skeletonPackage: skeleton }))
  await writeFile(join(content, 'Props/Character_Skeleton.uasset'), unrealSkeletonFixture({ guid: demoSkeletonGuid }))
  await writeFile(join(content, 'Props/SmokeAttack.uasset'), editorAnimationFixture({ clip: 'SmokeAttack', skeleton }))
  const cooked = process.env.ASSET_VIEWER_SMOKE_PAK === '1'
  if (cooked) {
    const fixtures = [
      ...cookedTexture({ name: 'CookedTint', format: 'PF_G8', width: 1, height: 1, pixels: Buffer.from([49]), external: true }),
      ...cookedMaterial({ name: 'CookedPaint', textures: [{ parameter: 'BaseColor', value: '/Game/Props/CookedTint' }] }),
      ...cookedStaticMesh({ name: 'CookedModel', external: true }),
      ...cookedSoundWave({ name: 'CookedTone', streaming: true, format: 'OGG', payload: zenOgg }),
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
    if (!glb.checked) glb.click()
    document.querySelector('#package-plans button').click()
  }`)
  await waitFor(`Array.from(document.querySelectorAll('#package-jobs > li > p')).some(row =>
    row.textContent.includes('Unreal Loose Fixture') && row.textContent.includes('В индексе'))`)
  if (!glbWasChecked) await webContents.executeJavaScript("document.querySelector('#package-export-glb').click()")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('Запрошенная версия Unreal недоступна')")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('1 WAV')")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('1 PNG')")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('Графов SoundCue · 1')")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('Скелетных моделей UE4 · 1')")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('Клипов UE4 · 1')")
  if (cooked) {
    await waitFor(`Array.from(document.querySelectorAll('#package-jobs li p')).some(row =>
      row.textContent.includes('Cooked UE4.27') && row.textContent.includes('Текстуры · 1 PNG') &&
      row.textContent.includes('Описания материалов · 1'))`)
    await waitFor(`Array.from(document.querySelectorAll('#package-jobs li p')).some(row =>
      row.textContent.includes('Модели cooked UE4.27') && row.textContent.includes('LOD · 2'))`)
    await waitFor("document.querySelector('#package-jobs').textContent.includes('Аудио из cooked-ресурсов · Готово 1')")
  }
  await webContents.executeJavaScript(`{
    const job = Array.from(document.querySelectorAll('#package-jobs > li')).find(row => row.textContent.includes('Unreal Loose Fixture'))
    job.querySelector('details').open = true
    Array.from(job.querySelectorAll('button')).find(button => button.textContent === 'Показать файлы').click()
  }`)
  await waitFor("document.querySelector('#package-jobs').textContent.includes('PCM 16 бит, 44100 Гц, 1 кан.')")
  await waitFor("document.querySelector('#package-jobs').textContent.includes('Связанных WAV · 1')")
  const job = "Array.from(document.querySelectorAll('#package-jobs > li')).find(row => row.textContent.includes('Unreal Loose Fixture'))"
  await webContents.executeJavaScript(`Array.from((${job}).querySelectorAll('button'))
    .find(button => button.textContent === 'Показать в индексе').click()`)
  const models = [['SkeletalSmoke.glb', '2 треугольника', 'SmokeAttack'], ['SmokeAttack.glb', '2 кости', 'SmokeAttack']]
  if (cooked) {
    await playIndexedAudio(webContents, waitFor, 'CookedTone.ogg', 0.5, 0.024)
    models.push(['CookedModel.glb', '2 треугольника'], ['CookedModel_Lod1.glb', '1 треугольник'])
  }
  for (const [file, stats, clip] of models) {
    const name = JSON.stringify(file)
    const card = "Array.from(document.querySelectorAll('#index-results button')).find(button => button.textContent.startsWith(" + name + "))"
    await webContents.executeJavaScript("if (!document.querySelector('#index-dialog').open) document.querySelector('#index-mode').click()")
    await waitFor(`document.querySelector('#index-dialog').open &&
      document.querySelector('#index-results').getAttribute('aria-busy') === 'false' && Boolean(${card})`)
    await webContents.executeJavaScript(`(${card}).click()`)
    await waitFor(`document.querySelector('#index-name').textContent === ${name} && !document.querySelector('#index-preview').disabled`)
    await webContents.executeJavaScript("document.querySelector('#index-preview').click()")
    await waitFor(`!document.querySelector('#index-dialog').open &&
      document.querySelector('#model-stats').textContent.includes(${JSON.stringify(stats)})`)
    if (clip) {
      await waitFor(`!document.querySelector('#animation-tools').hidden &&
        document.querySelector('#animation').selectedOptions[0].textContent === ${JSON.stringify(clip)}`)
      await webContents.executeJavaScript("document.querySelector('#play').click()")
      await waitFor("document.querySelector('#play').getAttribute('aria-pressed') === 'true'")
    }
  }
}
