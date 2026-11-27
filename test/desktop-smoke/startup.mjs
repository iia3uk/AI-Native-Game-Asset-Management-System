import assert from 'node:assert/strict'
import { BrowserWindow } from 'electron'
import { loadViewerWindow } from '../../desktop/window/startup.mjs'

export async function verifyStartupWithoutInterface() {
  const window = new BrowserWindow({ show: false })
  let shown = false
  window.on('show', () => { shown = true })
  try {
    await assert.rejects(loadViewerWindow(window, 'data:text/html,<title>Empty</title>', {
      showWindow: true, timeoutMs: 600,
    }), /Интерфейс Asset Viewer не загрузился/)
    assert.equal(shown, false)
  } finally {
    window.destroy()
  }
}
