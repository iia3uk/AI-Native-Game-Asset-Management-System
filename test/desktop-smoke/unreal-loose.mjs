import { writeUnrealLooseFixture } from '../fixtures/unreal-loose.mjs'

export async function verifyUnrealLoose(webContents, waitFor, root) {
  const { project } = await writeUnrealLooseFixture(root)
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
}
