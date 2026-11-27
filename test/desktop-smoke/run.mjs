import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electron = require.resolve('electron/cli.js')
const app = fileURLToPath(new URL('.', import.meta.url))
const temporary = process.env.ASSET_VIEWER_DATA_DIR ? null : await mkdtemp(join(tmpdir(), 'asset-viewer-smoke-'))
try {
  const child = spawn(process.execPath, [electron, app], {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, ASSET_VIEWER_DATA_DIR: temporary ?? process.env.ASSET_VIEWER_DATA_DIR },
  })
  const [code] = await once(child, 'exit')
  process.exitCode = code ?? 1
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 5 })
}
