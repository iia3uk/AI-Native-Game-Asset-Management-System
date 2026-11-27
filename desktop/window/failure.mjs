import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dialog } from 'electron'
import { dataPaths } from '../../core/config/data-paths.mjs'

export function showDesktopFailure(error) {
  console.error(error)
  let message = error.message
  try {
    const { logs } = dataPaths()
    const diagnostic = join(logs, 'desktop-error.log')
    mkdirSync(logs, { recursive: true })
    writeFileSync(diagnostic, new Date().toISOString() + '\n' + error.stack + '\n')
    message += '\n\nЖурнал ошибки\n' + diagnostic
  } catch (logError) {
    console.error(logError.message)
  }
  if (process.env.ASSET_VIEWER_DESKTOP_DIAGNOSTICS !== '1') dialog.showErrorBox('Asset Viewer', message)
}
