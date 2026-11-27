import { app, dialog } from 'electron'
import { startDesktop } from './bootstrap.mjs'

void startDesktop().catch(error => {
  console.error(error.message)
  if (process.env.ASSET_VIEWER_DESKTOP_DIAGNOSTICS !== '1') dialog.showErrorBox('Asset Viewer', error.message)
  app.exit(1)
})
