import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { app, BrowserWindow, dialog, ipcMain, session, shell, utilityProcess } from 'electron'
import { dataPaths } from '../core/config/data-paths.mjs'

function choosePort(child) {
  return new Promise((resolve, reject) => {
    function exited(code) {
      reject(new Error('The local server exited before opening a port (' + code + ').'))
    }
    child.once('exit', exited)
    child.once('message', message => {
      child.off('exit', exited)
      if (message?.type === 'ready' && Number.isInteger(message.port) && message.port > 0 && message.port <= 65535) {
        resolve(message.port)
      } else {
        reject(new Error('The local server returned an invalid address.'))
      }
    })
  })
}

function trustedExternal(url) {
  try {
    return ['https://www.fab.com', 'https://fab.com'].includes(new URL(url).origin)
  } catch {
    return false
  }
}

export async function startDesktop(applicationRoot = app.getAppPath()) {
  app.setName('Asset Viewer')
  const paths = dataPaths()
  const electronData = join(paths.data, 'electron')
  mkdirSync(electronData, { recursive: true })
  app.setPath('userData', electronData)
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  await app.whenReady()
  const token = randomBytes(32).toString('hex')
  const root = applicationRoot
  const child = utilityProcess.fork(join(root, 'server.mjs'), [], {
    env: { ...process.env, ASSET_VIEWER_PORT: process.env.ASSET_VIEWER_PORT ?? '8178',
      ASSET_VIEWER_PORT_FALLBACK: '1', ASSET_VIEWER_DESKTOP_TOKEN: token,
      ...(app.isPackaged && { ASSET_VIEWER_BLEND_SCRIPT: join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'export-blend.py') }),
    },
    serviceName: 'Asset Viewer Local Server',
    stdio: 'pipe',
  })
  child.stdout?.pipe(process.stdout)
  child.stderr?.pipe(process.stderr)
  let stopped = false
  let quitting = false
  let finished = false
  const exited = once(child, 'exit').then(() => { stopped = true })
  app.on('before-quit', event => {
    if (finished || stopped) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    child.postMessage({ type: 'shutdown' })
    const timeout = new AbortController()
    void Promise.race([exited.then(() => 'exit'), setTimeout(5500, 'timeout', { signal: timeout.signal })]).then(result => {
      timeout.abort()
      if (result === 'timeout') child.kill()
      finished = true
      app.quit()
    })
  })
  let port
  const timeout = new AbortController()
  try {
    port = await Promise.race([choosePort(child), setTimeout(15_000, undefined, { signal: timeout.signal }).then(() => {
      throw new Error('The local server did not start in time.')
    })])
  } finally {
    timeout.abort()
  }
  const origin = 'http://127.0.0.1:' + port
  const desktopSession = session.fromPartition('persist:asset-viewer')
  desktopSession.setPermissionRequestHandler((_contents, _permission, decide) => decide(false))
  desktopSession.setPermissionCheckHandler(() => false)
  desktopSession.webRequest.onBeforeSendHeaders({ urls: [origin + '/*'] }, ({ requestHeaders }, respond) => {
    respond({ requestHeaders: { ...requestHeaders, 'X-Asset-Viewer-Desktop': token } })
  })
  const window = new BrowserWindow({
    title: 'Asset Viewer', width: 1360, height: 860, minWidth: 450, minHeight: 550,
    backgroundColor: '#101512', autoHideMenuBar: true, show: false,
    icon: join(root, 'assets', 'icon.ico'),
    webPreferences: { session: desktopSession, preload: join(root, 'desktop', 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  window.removeMenu()
  app.on('second-instance', () => {
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (trustedExternal(url)) void shell.openExternal(url).catch(error => console.error(error.message))
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', event => {
    if (!event.url?.startsWith(origin + '/')) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  ipcMain.handle('asset-viewer:choose-folder', async event => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        !event.senderFrame?.url.startsWith(origin + '/')) return null
    const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  app.on('window-all-closed', () => app.quit())
  child.once('exit', code => {
    if (quitting || window.isDestroyed()) return
    dialog.showErrorBox('Asset Viewer', 'The local server stopped (' + code + '). Restart the app to reopen the index.')
    app.quit()
  })
  window.once('ready-to-show', () => window.show())
  await window.loadURL(origin + '/')
  return { window, origin, paths }
}
