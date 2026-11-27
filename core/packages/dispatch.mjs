import { packageExportFormats } from '../conversion/formats.mjs'
import { unityImportOptions } from '../engines/unity/options.mjs'
import { IndexInputError } from '../index/index-errors.mjs'
import { detectPackage } from './detect.mjs'
import { processUnityBundle } from './unity/bundle/import.mjs'
import { stageUnityPackage } from './unity/import.mjs'
import { inspectUnityPackage } from './unity/inspect.mjs'

function bundleError(issue) {
  const messages = {
    'unity-bundle-worker-unavailable': 'Не найден независимый декодер UnityFS.',
    'unity-bundle-input-size': 'Размер UnityFS вне допустимого диапазона (48 байт — 128 МиБ).',
    'unity-bundle-space-limit': 'Недостаточно места для обработки UnityFS.',
    'unity-bundle-source-changed': 'UnityFS изменился после анализа. Проанализируйте файл снова.',
  }
  return new IndexInputError(messages[issue] ?? ('Ошибка декодирования UnityFS (' + issue + ').'))
}

export async function inspectPackage(source, { signal } = {}) {
  const format = await detectPackage(source)
  if (format === 'unitypackage') return inspectUnityPackage(source, { signal })
  const result = await processUnityBundle(source, { inspectOnly: true, signal })
  if (result.status !== 'completed') throw bundleError(result.issue)
  const { format: containerVersion, ...details } = result
  return { ...details, format, containerVersion }
}

export function packageOptions(format, input) {
  const options = unityImportOptions(input?.mode, input?.editorVersion)
  const formats = packageExportFormats(input?.formats)
  if (format === 'unityfs') {
    if (options.mode === 'engine-assisted' || options.editorVersion) {
      throw new IndexInputError('Для UnityFS выберите независимое декодирование.')
    }
    return { mode: 'engineless', formats: formats.includes('fbx') ? 'fbx,glb' : 'glb' }
  }
  return { ...options, formats: formats || (options.mode === 'engineless' ? '' : 'fbx,glb') }
}

export async function stagePackage(directory, source, job, { signal, onProgress, publish }) {
  const format = await detectPackage(source)
  if (format === 'unitypackage') {
    return stageUnityPackage(directory, source, job.sourceKey, {
      signal, onProgress, formats: job.exportFormats, mode: job.engineMode, editorVersion: job.editorVersion,
      publish: (result, move) => publish(result, move, Boolean(result.report.written)),
    })
  }
  packageOptions(format, { mode: job.engineMode, editorVersion: job.editorVersion, formats: job.exportFormats })
  const result = await processUnityBundle(source, {
    directory, expectedHash: job.sourceKey, withFbx: job.exportFormats?.includes('fbx') ?? false, signal, onProgress,
    publish: ({ output, sourceName, reused, ...report }, move) => publish({ directory: output, source: output,
      report: { ...report, packageFormat: format }, reused }, move, report.converted > 0),
  })
  if (result?.issue) throw bundleError(result.issue)
  return result
}
