import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverBlender } from './discovery.mjs'
import { runBlender } from './runner.mjs'

const bundledScript = fileURLToPath(new URL('./scripts/batch.py', import.meta.url))

export async function locateBatchBlender() {
  const [candidate] = await discoverBlender()
  if (!candidate) return null
  const binary = await stat(candidate.executable).catch(() => null)
  if (!binary?.isFile()) return null
  return { ...candidate, identity: [candidate.executable, binary.size, binary.mtimeMs] }
}

export async function convertBatchModel(blender, { source, root, workspace, formats, signal }) {
  const script = process.env.ASSET_VIEWER_BLENDER_BATCH_SCRIPT ?? bundledScript
  const reportPath = join(workspace, 'result.json')
  try {
    await runBlender(blender.executable, ['--threads', '2', '--python-exit-code', '1', '--python', script, '--',
      root, source, workspace, formats.join(',')], { signal, timeout: 120_000, cwd: workspace })
    signal?.throwIfAborted()
    const result = JSON.parse(await readFile(reportPath, 'utf8'))
    if (typeof result.version !== 'string' || !/^[\w. -]{1,80}$/.test(result.version)) throw new Error('Invalid Blender report')
    return result
  } catch (error) {
    signal?.throwIfAborted()
    // Blender's logs can contain arbitrary model names and paths. Keep diagnostics structured.
    if (error.killed || error.code === 'ABORT_ERR') return { error: 'converter-timeout' }
    return { error: 'converter-failed' }
  }
}
