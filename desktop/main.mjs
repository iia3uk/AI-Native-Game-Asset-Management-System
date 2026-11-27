import { app } from 'electron'
import { startDesktop } from './bootstrap.mjs'
import { showDesktopFailure } from './window/failure.mjs'

void startDesktop().catch(error => {
  showDesktopFailure(error)
  app.exit(1)
})
