import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { wavTone } from '../fixtures/unreal-pak.mjs'
import { zenOgg } from '../fixtures/unreal-zen-audio.mjs'

const audio = "document.querySelector('#stage-audio')"
const player = "document.querySelector('#audio-preview')"
const loop = "document.querySelector('#audio-loop')"
const tab = "document.querySelector('#file-tabs [data-kind=audio]')"

async function openFolder(webContents, waitFor, root, button) {
  await webContents.executeJavaScript(`document.querySelector('#${button}').click()`)
  await waitFor("document.querySelector('#folder-dialog').open")
  await webContents.executeJavaScript(`
    document.querySelector('#folder-path').value = ${JSON.stringify(root)}
    document.querySelector('#folder-form').requestSubmit()
  `)
  await waitFor(`!document.querySelector('#folder-dialog').open &&
    document.querySelector('#folder-root').textContent === ${JSON.stringify(root)} && !${tab}.hidden`)
}

async function select(webContents, waitFor, name) {
  await webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('#file-list [data-file]'))
      .find(button => button.querySelector('.file-name').textContent === ${JSON.stringify(name)}).click()
  `)
  await waitFor(`!${player}.hidden && ${audio}.currentSrc.endsWith(${JSON.stringify(encodeURIComponent(name))}) &&
    Number.isFinite(${audio}.duration) && ${audio}.duration > 0 && ${audio}.paused`)
}

async function play(webContents, waitFor, mime) {
  assert.equal(await webContents.executeJavaScript(`
    fetch(${audio}.src, { headers: { Range: 'bytes=0-43' } })
      .then(response => response.status === 206 && response.headers.get('content-type') === ${JSON.stringify(mime)})
  `), true)
  await webContents.executeJavaScript(`${audio}.muted = true; ${audio}.play()`, true)
  await waitFor(`${audio}.ended`)
}

async function verifyLoop(webContents, waitFor) {
  assert.equal(await webContents.executeJavaScript(`${loop}.checked || ${audio}.loop`), false)
  await webContents.executeJavaScript(`
    ${loop}.click()
    const player = ${audio}
    player.dataset.repeats = '0'
    player.addEventListener('seeked', () => {
      if (player.loop && !player.paused) player.dataset.repeats = String(Number(player.dataset.repeats) + 1)
    })
    player.muted = true
    player.play()
  `, true)
  await waitFor(`${loop}.checked && ${audio}.loop && !${audio}.ended && Number(${audio}.dataset.repeats) >= 2`)
}

export async function verifyLocalAudio(webContents, waitFor, root, sample) {
  await mkdir(root)
  await Promise.all([
    writeFile(join(root, '00-support.bin'), Buffer.from([1, 2])),
    writeFile(join(root, 'Footstep.wav'), wavTone()),
    writeFile(join(root, 'Reward.ogg'), zenOgg),
  ])
  await openFolder(webContents, waitFor, root, 'open-folder')
  await waitFor(`${tab}.getAttribute('aria-pressed') === 'true' &&
    document.querySelector('#selected-name').textContent === 'Footstep.wav' && ${audio}.controls`)
  assert.deepEqual(await webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('#file-list .file-name'), row => row.textContent)
  `), ['Footstep.wav', 'Reward.ogg'])
  await select(webContents, waitFor, 'Footstep.wav')
  await verifyLoop(webContents, waitFor)
  await select(webContents, waitFor, 'Reward.ogg')
  assert.equal(await webContents.executeJavaScript(`${loop}.checked && ${audio}.loop`), true)
  await webContents.executeJavaScript(`${loop}.click()`)
  await play(webContents, waitFor, 'audio/ogg')
  await webContents.executeJavaScript(`
    document.querySelector('#file-tabs [data-kind=all]').click()
    Array.from(document.querySelectorAll('#file-list [data-file]'))
      .find(button => button.querySelector('.file-name').textContent === '00-support.bin').click()
  `)
  await waitFor(`${player}.hidden && ${audio}.paused && !${audio}.hasAttribute('src')`)

  if (sample) {
    await openFolder(webContents, waitFor, dirname(sample), 'add-folder')
    await select(webContents, waitFor, basename(sample))
    await play(webContents, waitFor, 'audio/wav')
    console.log('Selected local WAV played to completion: ' + basename(sample))
  }
  await webContents.executeJavaScript("document.querySelector('#demo-mode').click()")
  await waitFor(`${player}.hidden && !${audio}.hasAttribute('src') && ${tab}.hidden`)
}
