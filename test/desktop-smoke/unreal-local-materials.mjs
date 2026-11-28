import assert from 'node:assert/strict'

export async function verifyUnrealLocalMaterials(webContents, waitFor, path) {
  const evaluate = code => webContents.executeJavaScript(code)
  async function clickByText(selector, name) {
    const match = `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .find(node => node.textContent === ${JSON.stringify(name)})`
    await waitFor(`Boolean(${match})`)
    await evaluate(`${match}.click()`)
  }

  await evaluate("document.querySelector('#open-folder').click()")
  await waitFor("!document.querySelector('#folder-tools').hidden")
  await evaluate("document.querySelector('#add-folder').click()")
  await waitFor("document.querySelector('#folder-dialog').open")
  await evaluate(`
    document.querySelector('#folder-path').value = ${JSON.stringify(path)}
    document.querySelector('#folder-form').requestSubmit()
  `)
  await waitFor(`!document.querySelector('#folder-dialog').open &&
    document.querySelector('#folder-root').textContent === ${JSON.stringify(path)}`)
  for (const example of [
    { pack: 'StylizedCraftAssets', model: 'SM_G_Flowers_01.gltf', color: 'T_G_Flowers_A_D.png', count: 2 },
    { pack: 'sA_StylizedForest_Environment · Экспорт', model: 'SM_Mushroomroup_1.glb', color: 'T_Mushroom_1.png', count: 4 },
  ]) {
    await clickByText('#pack-list .pack-title', example.pack)
    await waitFor(`document.querySelector('#pack-title').textContent === ${JSON.stringify(example.pack)}`)
    await evaluate(`{
      const search = document.querySelector('#file-search')
      search.value = ${JSON.stringify(example.model)}
      search.dispatchEvent(new Event('input'))
    }`)
    await clickByText('#file-list .file-name', example.model)
    await waitFor(`document.querySelector('#selected-name').textContent === ${JSON.stringify(example.model)} &&
      !document.querySelector('#color-source').hidden && document.querySelector('#color-source').textContent.includes('с текстурой')`)
    await evaluate("document.querySelector('#model-textures').click()")
    const files = await evaluate("Array.from(document.querySelectorAll('#file-list .file-name'), row => row.textContent)")
    assert.equal(files.length, example.count)
    assert.ok(files.includes(example.color))
    assert.equal(await evaluate("document.querySelector('#selected-name').textContent"), example.model)
    console.log('Unreal model showed its color texture and related files: ' + example.model)
  }
  await evaluate("document.querySelector('#demo-mode').click()")
}
