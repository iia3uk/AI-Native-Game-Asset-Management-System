import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { IndexInputError } from '../../core/index/index-errors.mjs'
import { exportPackageResult } from '../../core/packages/export/publish.mjs'

export async function runPackageExport(index, paths, jobId, destination, { asset, 'plan-key': key }) {
  if (asset !== undefined && !/^\d+$/.test(asset)) throw new IndexInputError('Invalid asset offset.')
  const project = fileURLToPath(new URL('../../', import.meta.url))
  const environment = process.env.FAB_ASSETS_ROOT === undefined ?
    await readFile(resolve(project, '.env'), 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error
      return ''
    }) : ''
  const fab = resolve(project, (process.env.FAB_ASSETS_ROOT ?? parseEnv(environment).FAB_ASSETS_ROOT) || '../FAB_ASSETS')
  const roots = [paths.data, paths.cache, paths.config, fab, ...index.libraries().map(library => library.root)]
  const stop = new AbortController()
  const abort = () => stop.abort()
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, abort)
  try {
    const result = await exportPackageResult(paths.imports, roots, index.jobs.get(jobId), {
      destination, asset: asset === undefined ? undefined : Number(asset), key,
    }, { preview: key === undefined, signal: stop.signal })
    if (!result) throw new IndexInputError('Completed package import unavailable.')
    return result
  } finally {
    for (const event of ['SIGINT', 'SIGTERM']) process.off(event, abort)
  }
}
