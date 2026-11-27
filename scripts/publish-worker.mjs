import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function publishWorker(command, project, folder) {
  const platform = { win32: 'win', linux: 'linux' }[process.platform]
  const rid = process.argv[2] || (platform && process.arch === 'x64' ? platform + '-x64' : '')
  if (!['win-x64', 'linux-x64'].includes(rid) || process.argv.length > 3) {
    console.error('Use npm run ' + command + ' -- [win-x64|linux-x64].')
    process.exitCode = 2
    return
  }
  const root = fileURLToPath(new URL('..', import.meta.url))
  const output = resolve(root, 'release', folder, rid)
  const { error, status } = spawnSync('dotnet', [
    'publish', resolve(root, project), '--configuration', 'Release', '--runtime', rid, '--self-contained',
    '-p:RestoreLockedMode=true', '--output', output,
  ], { cwd: root, stdio: 'inherit', windowsHide: true })
  if (error) console.error(error.message)
  process.exitCode = status ?? 1
}
