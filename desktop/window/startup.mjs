import { once } from 'node:events'
import { setTimeout } from 'node:timers/promises'

async function waitForInterface(webContents, url, signal) {
  await webContents.loadURL(url)
  while (!signal.aborted) {
    if (await webContents.executeJavaScript('document.documentElement.dataset.viewerReady === "true"')) return
    await setTimeout(100, undefined, { signal })
  }
}

export function rendererFailure({ reason, exitCode }) {
  return new Error('Процесс интерфейса завершился (' + reason + ', код ' + exitCode + ').')
}

export async function loadViewerWindow(window, url, { showWindow, timeoutMs = 15_000 }) {
  const { webContents } = window
  const timeout = new AbortController()
  const options = { signal: timeout.signal }
  const painted = showWindow ? once(window, 'ready-to-show', options) : Promise.resolve()
  try {
    await Promise.race([
      once(webContents, 'render-process-gone', options).then(([, details]) => { throw rendererFailure(details) }),
      once(webContents, 'preload-error', options).then(([, , error]) => {
        throw new Error('Не удалось запустить интерфейс Asset Viewer (' + error.message + ').', { cause: error })
      }),
      setTimeout(timeoutMs, undefined, options).then(() => {
        throw new Error('Интерфейс Asset Viewer не загрузился за ' + timeoutMs / 1000 + ' с.')
      }),
      Promise.all([waitForInterface(webContents, url, timeout.signal), painted]),
    ])
    if (showWindow) window.show()
  } finally {
    timeout.abort()
  }
}
