import { IndexInputError } from '../index/index-errors.mjs'
import { inspectUnityPackage } from '../packages/unity/inspect.mjs'
import { packageSource } from '../packages/unity/paths.mjs'
import { hashPattern as packageHash } from '../packages/unity/policy.mjs'
import { packageExportFormats } from '../conversion/formats.mjs'
import { unityImportOptions } from '../engines/unity/options.mjs'

export function packageRoutes({ json, body, shutdown, wake }) {
  let inspecting = false
  return async (index, request, response, action) => {
    const input = await body(request).catch(() => null)
    const source = await packageSource(input?.path)
    if (action === 'inspect') {
      if (inspecting) return json(response, 409, { error: 'Другой пакет уже анализируется.' })
      inspecting = true
      const client = new AbortController()
      const abort = () => client.abort()
      response.once('close', abort)
      const timeout = AbortSignal.timeout(120_000)
      try {
        const signal = AbortSignal.any([shutdown, client.signal, timeout])
        return json(response, 200, { package: await inspectUnityPackage(source, { signal }) })
      } catch (error) {
        if (response.destroyed) return
        if (timeout.aborted) return json(response, 408, { error: 'Истекло время анализа пакета.' })
        throw error
      } finally {
        response.off('close', abort)
        inspecting = false
      }
    }
    if (typeof input?.hash !== 'string' || !packageHash.test(input.hash)) {
      throw new IndexInputError('Сначала проанализируйте пакет.')
    }
    const options = unityImportOptions(input.mode, input.editorVersion)
    const formats = packageExportFormats(input.formats) || (options.mode === 'engineless' ? '' : 'fbx,glb')
    const job = index.jobs.enqueueImport(source.path, input.hash, formats, options)
    wake()
    return json(response, 202, { job })
  }
}
