import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const platform = { win32: 'win', linux: 'linux' }[process.platform]
const rid = process.argv[2] || (platform && process.arch === 'x64' ? platform + '-x64' : '')
if (!['win-x64', 'linux-x64'].includes(rid) || process.argv.length > 3) {
  console.error('Use npm run build:cue4parse -- [win-x64|linux-x64].')
  process.exit(2)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const project = resolve(root, 'core/engines/unreal/decoder/worker/AssetViewer.UnrealDecode.csproj')
const output = resolve(root, 'release/cue4parse', rid)
const { error, status } = spawnSync('dotnet', [
  'publish', project, '--configuration', 'Release', '--runtime', rid, '--self-contained',
  '-p:RestoreLockedMode=true', '--output', output,
], { cwd: root, stdio: 'inherit', windowsHide: true })
if (error) console.error(error.message)
process.exitCode = status ?? 1
