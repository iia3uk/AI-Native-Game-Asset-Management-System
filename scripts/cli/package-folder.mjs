import { AssetIndex, IndexInputError } from '../../core/index/asset-index.mjs'
import { inspectPackage, packageOptions } from '../../core/packages/dispatch.mjs'
import { folderPackageSource, scanPackageFolder } from '../../core/packages/folder.mjs'

export async function runPackageFolder(input, paths, values, waitForImport) {
  const ignoredPaths = [paths.cache, paths.backups, paths.imports]
  const options = { mode: values.mode, editorVersion: values['unity-version'], formats: values.export?.split(',') }
  if (values.import) packageOptions('unitypackage', options)
  else if (Object.values(options).some(value => value !== undefined)) {
    throw new IndexInputError('Use --import to set export or engine options.')
  }

  const stop = new AbortController()
  const abort = () => stop.abort()
  const events = ['SIGINT', 'SIGTERM']
  for (const event of events) process.once(event, abort)
  try {
    const report = await scanPackageFolder(input, {
      ignoredPaths, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(120_000)]),
    })
    if (!values.import) return report
    if (report.truncated) throw new IndexInputError('Folder search reached its limit. Select a smaller subfolder for import.')
    const results = []
    if (!report.packages.length) return { ...report, results }
    const index = await AssetIndex.open(paths.database)
    try {
      for (const { path } of report.packages) {
        stop.signal.throwIfAborted()
        try {
          const source = await folderPackageSource(report.root, path, ignoredPaths)
          const by = AbortSignal.timeout(120_000)
          const plan = await inspectPackage(source, { signal: AbortSignal.any([stop.signal, by]) })
          const recipe = packageOptions(plan.format, plan.format === 'unitypackage' ? options :
            plan.format === 'unityfs' ? { formats: options.formats } : {})
          const queued = index.jobs.enqueueImport(source.path, plan.hash, recipe.formats, recipe)
          results.push({ path, ...await waitForImport(index, queued.id, paths.imports, stop.signal) })
        } catch (error) {
          stop.signal.throwIfAborted()
          if (!(error instanceof IndexInputError) && error.name !== 'TimeoutError' &&
              !['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)) throw error
          results.push({ path, error: error.message })
        }
      }
    } finally {
      await index.close()
    }
    return { ...report, results }
  } finally {
    for (const event of events) process.off(event, abort)
  }
}
