import { IndexInputError } from '../index/index-errors.mjs'
import { detectPackage } from '../packages/detect.mjs'
import { inspectPackage, packageOptions } from '../packages/dispatch.mjs'
import { folderPackageSource, scanPackageFolder } from '../packages/folder.mjs'
import { packageHashPattern, packageSource } from '../packages/source.mjs'

export function packageRoutes({ json, body, shutdown, wake, ignoredPaths }) {
  let inspecting = false
  return async (index, request, response, action) => {
    const input = await body(request).catch(() => null)
    const source = () => input?.root === undefined ? packageSource(input?.path) :
      folderPackageSource(input.root, input.path, ignoredPaths)
    if (action === 'inspect' || action === 'folder') {
      if (inspecting) return json(response, 409, { error: 'Уже выполняется анализ пакета или папки.' })
      inspecting = true
      const client = new AbortController()
      const abort = () => client.abort()
      response.once('close', abort)
      const timeout = AbortSignal.timeout(120_000)
      try {
        const signal = AbortSignal.any([shutdown, client.signal, timeout])
        const result = action === 'folder' ? await scanPackageFolder(input?.path, { ignoredPaths, signal }) :
          { package: await inspectPackage(await source(), { signal }) }
        return json(response, 200, result)
      } catch (error) {
        if (response.destroyed) return
        if (timeout.aborted) return json(response, 408, { error: 'Истекло время анализа пакета или папки.' })
        throw error
      } finally {
        response.off('close', abort)
        inspecting = false
      }
    }
    if (typeof input?.hash !== 'string' || !packageHashPattern.test(input.hash)) {
      throw new IndexInputError('Сначала проанализируйте пакет.')
    }
    const file = await source()
    const { formats, ...options } = packageOptions(await detectPackage(file), input)
    const job = index.jobs.enqueueImport(file.path, input.hash, formats, options)
    wake()
    return json(response, 202, { job })
  }
}
