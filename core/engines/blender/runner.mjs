import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
let tail = Promise.resolve()

export function runBlender(executable, parameters, { signal, timeout, cwd }) {
  const result = tail.then(async () => {
    signal?.throwIfAborted()
    const process = execute(executable, ['--background', '--factory-startup', '--disable-autoexec', ...parameters], {
      signal, timeout, cwd, windowsHide: true, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 ** 2,
    })
    const closed = new Promise(resolve => process.child.once('close', resolve))
    try {
      return await process
    } finally {
      await closed
    }
  })
  tail = result.catch(() => undefined)
  return result
}
