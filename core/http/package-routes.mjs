import { IndexInputError } from '../index/index-errors.mjs'
import { detectPackage } from '../packages/detect.mjs'
import { inspectPackage, packageOptions } from '../packages/dispatch.mjs'
import { packageHashPattern, packageSource } from '../packages/source.mjs'

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
        return json(response, 200, { package: await inspectPackage(source, { signal }) })
      } catch (error) {
        if (response.destroyed) return
        if (timeout.aborted) return json(response, 408, { error: 'Истекло время анализа пакета.' })
        throw error
      } finally {
        response.off('close', abort)
        inspecting = false
      }
    }
    if (typeof input?.hash !== 'string' || !packageHashPattern.test(input.hash)) {
      throw new IndexInputError('Сначала проанализируйте пакет.')
    }
    const { formats, ...options } = packageOptions(await detectPackage(source), input)
    const job = index.jobs.enqueueImport(source.path, input.hash, formats, options)
    wake()
    return json(response, 202, { job })
  }
}
