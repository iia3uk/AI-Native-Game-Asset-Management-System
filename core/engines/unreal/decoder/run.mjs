import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, mkdir, statfs, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { fileInfo, sameFile } from '../../../files/asset-files.mjs'

const run = promisify(execFile)
const MiB = 1024 ** 2
const development = fileURLToPath(new URL('../../../../release/cue4parse/', import.meta.url))
export const cue4parseVersion = '1.2.2.202611'

export async function locateUnrealDecoder() {
  const override = process.env.ASSET_VIEWER_CUE4PARSE
  if (override && !isAbsolute(override)) throw new Error('ASSET_VIEWER_CUE4PARSE must be an absolute path.')
  const name = 'AssetViewer.UnrealDecode' + (process.platform === 'win32' ? '.exe' : '')
  const bundled = process.resourcesPath && join(process.resourcesPath, 'cue4parse', name)
  const platform = { win32: 'win', linux: 'linux' }[process.platform]
  const local = platform && join(development, platform + '-' + process.arch, name)
  for (const path of override ? [override] : [bundled, local].filter(Boolean)) {
    const file = await fileInfo(dirname(path), path)
    if (file && file.info.size > 0) return file.path
  }
  return null
}

export async function stagePak(source, workspace, inspectOnly, signal) {
  const size = source.file.info.size
  const space = await statfs(workspace, { bigint: true })
  const available = space.bavail * space.bsize - BigInt(size + 160 * MiB)
  if (available < 0n || (!inspectOnly && available === 0n)) return 'unreal-pak-space-limit'
  const capacity = 1024n ** 3n
  const maxOutputBytes = inspectOnly ? 0 : Number(available < capacity ? available : capacity)
  const stage = join(workspace, 'input.pak')
  const before = await fileInfo(source.root, source.file.path)
  if (!before || !sameFile(before.info, source.file.info)) return 'unreal-pak-changed'
  signal?.throwIfAborted()
  await copyFile(before.path, stage, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
  signal?.throwIfAborted()
  const after = await fileInfo(source.root, source.file.path)
  if (!after || !sameFile(before.info, after.info)) return 'unreal-pak-changed'
  await mkdir(join(workspace, 'output'))
  await writeFile(join(workspace, 'request.json'), JSON.stringify({ protocol: 1, format: 'pak', inspectOnly, maxOutputBytes }),
    { flag: 'wx', signal })
  return null
}

export async function runUnrealDecoder(executable, workspace, signal) {
  signal?.throwIfAborted()
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(?:dotnet_|coreclr_|cor_|complus_|ld_preload$|dyld_)/i.test(key)))
  const processHandle = run(executable, ['--decode'], {
    cwd: workspace, timeout: 150_000, signal, windowsHide: true,
    killSignal: 'SIGKILL', maxBuffer: 16 * MiB, env,
  })
  const closed = new Promise(resolve => processHandle.child.once('close', resolve))
  try {
    return JSON.parse((await processHandle).stdout)
  } catch (error) {
    signal?.throwIfAborted()
    try {
      if (error.code === 1) return JSON.parse(error.stdout)
    } catch {}
    return { protocol: 1, status: 'failed', issue: error.killed ? 'unreal-worker-timeout' : 'unreal-worker-failed' }
  } finally {
    await closed
  }
}
