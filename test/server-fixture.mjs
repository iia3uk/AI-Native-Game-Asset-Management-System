import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export async function testDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), 'asset-viewer-test-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}

export async function startServer(directory, env = {}, { executable = process.execPath,
  entry = fileURLToPath(new URL('../server.mjs', import.meta.url)) } = {}) {
  const fab = join(directory, 'fab')
  await mkdir(fab, { recursive: true })
  const child = spawn(executable, [entry], {
    env: { ...process.env, ASSET_VIEWER_PORT: '0', FAB_ASSETS_ROOT: fab, ASSET_VIEWER_FOLDER: '',
      ASSET_VIEWER_DATA_DIR: join(directory, 'data'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  const stopped = once(child, 'close')
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data })
  const lines = createInterface({ input: child.stdout })
  let origin
  for await (const line of lines) {
    origin = /http:\/\/127\.0\.0\.1:\d+/.exec(line)?.[0]
    if (origin) break
  }
  if (!origin) throw new Error('Test server failed to start: ' + stderr)
  return {
    origin, fab,
    request: (route, options) => fetch(origin + route, options),
    post: (route, input, headers = {}) => fetch(origin + route, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(input),
    }),
    async close() {
      child.kill()
      await stopped
    },
  }
}
