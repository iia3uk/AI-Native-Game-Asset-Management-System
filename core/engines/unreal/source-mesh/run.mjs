import { Worker } from 'node:worker_threads'

export const sourceMeshRevision = '0.1.26/2'
export const sourceMeshFileLimit = 48 * 1024 ** 2

export async function decodeSourceMesh(bytes, stem, { signal, timeout, render = true }) {
  signal?.throwIfAborted()
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
    workerData: { bytes, stem, render }, transferList: [bytes.buffer],
    resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 },
  })
  let abort, timer
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason)
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => resolve({ issue: 'unreal-source-mesh-timeout' }), timeout)
      worker.once('message', resolve)
      worker.once('error', () => resolve({ issue: 'unreal-source-mesh-worker-failed' }))
      worker.once('exit', () => resolve({ issue: 'unreal-source-mesh-worker-failed' }))
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    await worker.terminate()
  }
}
