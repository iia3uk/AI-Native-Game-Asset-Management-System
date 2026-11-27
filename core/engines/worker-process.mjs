import { execFile } from 'node:child_process'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { fileInfo } from '../files/asset-files.mjs'

const execute = promisify(execFile)
const release = fileURLToPath(new URL('../../release/', import.meta.url))
const platforms = { win32: 'win', linux: 'linux' }

export async function findWorker(directory, executable, variable) {
  const override = process.env[variable]
  if (override && !isAbsolute(override)) throw new Error(variable + ' must be an absolute path.')
  const name = executable + (process.platform === 'win32' ? '.exe' : '')
  const platform = platforms[process.platform]
  const bundled = process.resourcesPath && join(process.resourcesPath, directory, name)
  const local = platform && join(release, directory, platform + '-' + process.arch, name)
  for (const path of override ? [override] : [bundled, local].filter(Boolean)) {
    const file = await fileInfo(dirname(path), path)
    if (file && file.info.size > 0) return file.path
  }
  return null
}

export async function runJsonWorker(executable, cwd, { timeout, failure, timedOut, signal }) {
  signal?.throwIfAborted()
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(?:dotnet_|coreclr_|cor_|complus_|ld_preload$|dyld_)/i.test(key)))
  const child = execute(executable, ['--decode'], {
    cwd, timeout, signal, windowsHide: true,
    killSignal: 'SIGKILL', maxBuffer: 16 * 1024 ** 2, env,
  })
  const closed = new Promise(resolve => child.child.once('close', resolve))
  try {
    return JSON.parse((await child).stdout)
  } catch (error) {
    signal?.throwIfAborted()
    try {
      if (error.code === 1) return JSON.parse(error.stdout)
    } catch {}
    return { protocol: 1, status: 'failed', issue: error.killed ? timedOut : failure }
  } finally {
    await closed
  }
}
