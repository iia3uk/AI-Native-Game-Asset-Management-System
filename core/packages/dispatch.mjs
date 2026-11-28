import { packageExportFormats } from '../conversion/formats.mjs'
import { unityImportOptions } from '../engines/unity/options.mjs'
import { validateUnrealVersion } from '../engines/unreal/bridge/selection.mjs'
import { IndexInputError } from '../index/index-errors.mjs'
import { detectPackage } from './detect.mjs'
import { processUnityBundle } from './unity/bundle/import.mjs'
import { stageUnityPackage } from './unity/import.mjs'
import { inspectUnityPackage } from './unity/inspect.mjs'
import { inspectUnityFolder } from './unity/folder/inspect.mjs'
import { processUnrealPak } from './unreal/pak/import.mjs'
import { isUnrealArchive } from './unreal/containers.mjs'
import { processIoStore } from './unreal/iostore/import.mjs'
import { inspectUnrealLoose } from './unreal/loose/inspect.mjs'
import { stageUnrealLoose } from './unreal/loose/import.mjs'
import { isUnrealLoose, unrealLooseSource } from './unreal/loose/source.mjs'

function bundleError(issue, serialized) {
  const name = serialized ? 'Бинарный файл Unity' : 'UnityFS'
  const messages = {
    'unity-bundle-worker-unavailable': 'Не найден независимый декодер Unity.',
    'unity-bundle-worker-revision': 'Версия декодера Unity несовместима с приложением. Обновите декодер.',
    'unity-bundle-input-size': 'Файл Unity должен занимать от 48 байт до 128 МиБ.',
    'unity-bundle-companion-size': 'Файл данных Unity превышает 256 МиБ или общий размер файлов данных превышает 512 МиБ.',
    'unity-bundle-space-limit': 'Недостаточно места для обработки файла Unity.',
    'unity-bundle-source-changed': 'Файл Unity или один из файлов данных изменился после анализа. Проанализируйте файл снова.',
  }
  return new IndexInputError(messages[issue] ?? (name + ' · ошибка декодирования (' + issue + ').'))
}

function pakError(issue) {
  const messages = {
    'unreal-pak-changed': 'Unreal Pak изменился после анализа. Проанализируйте файл снова.',
    'unreal-pak-encrypted': 'Индекс Unreal Pak зашифрован.',
    'unreal-pak-size-limit': 'Размер Unreal Pak превышает 2 ГиБ.',
    'unreal-pak-space-limit': 'Недостаточно места для обработки Unreal Pak.',
    'unreal-worker-unavailable': 'Не найден декодер Unreal Pak. Укажите абсолютный путь в ASSET_VIEWER_CUE4PARSE.',
  }
  return new IndexInputError(messages[issue] ?? ('Ошибка извлечения Unreal Pak (' + issue + ').'))
}

function ioStoreError(issue) {
  const messages = {
    'unreal-iostore-toc-missing': 'Рядом с .ucas отсутствует соответствующий .utoc.',
    'unreal-iostore-companion-missing': 'Рядом с .utoc должны находиться все части .ucas.',
    'unreal-iostore-encrypted': 'Контейнер IoStore зашифрован.',
    'unreal-iostore-signed': 'Контейнер IoStore подписан. Проверка подписи пока не поддерживается.',
    'unreal-iostore-changed': 'Файл .utoc или одна из частей .ucas изменилась после анализа. Проанализируйте контейнер снова.',
    'unreal-iostore-space-limit': 'Недостаточно места для обработки Unreal IoStore.',
    'unreal-iostore-no-directory': 'В контейнере IoStore отсутствует индекс путей.',
    'unreal-iostore-version': 'Версия или тип контейнера IoStore пока не поддерживается.',
    'unreal-iostore-chunk-hash': 'Контрольная сумма извлечённого блока IoStore не совпала.',
    'unreal-worker-unavailable': 'Не найден декодер Unreal. Укажите абсолютный путь в ASSET_VIEWER_CUE4PARSE.',
  }
  return new IndexInputError(messages[issue] ?? ('Ошибка извлечения Unreal IoStore (' + issue + ').'))
}

const unrealDecoder = format => format === 'unreal-pak' ? processUnrealPak : processIoStore
const unrealArchiveError = (format, issue) => format === 'unreal-pak' ? pakError(issue) : ioStoreError(issue)

export async function inspectPackage(source, { signal } = {}) {
  const format = await detectPackage(source, { signal })
  if (isUnrealLoose(format)) return inspectUnrealLoose(await checkedUnrealSource(source, format, signal), { signal })
  if (source.directory) return inspectUnityFolder(source, { signal })
  if (format === 'unitypackage') return inspectUnityPackage(source, { signal })
  if (isUnrealArchive(format)) {
    const { entries: assets, ...report } = await unrealDecoder(format)(source, { inspectOnly: true, signal })
    if (report.status !== 'completed') throw unrealArchiveError(format, report.issue)
    return { ...report, format, assets }
  }
  const serialized = format === 'unity-serialized'
  const result = await processUnityBundle(source, { inspectOnly: true, serialized, signal })
  if (result.status !== 'completed') throw bundleError(result.issue, serialized)
  const { format: containerVersion, ...details } = result
  return { ...details, format, containerVersion }
}

async function checkedUnrealSource(source, format, signal) {
  const loose = await unrealLooseSource(source, signal)
  if (loose?.format !== format) throw new IndexInputError('Источник Unreal изменился. Проанализируйте его снова.')
  return loose
}

export function packageOptions(format, input) {
  const formats = packageExportFormats(input?.formats)
  if (isUnrealLoose(format)) {
    const { mode } = unityImportOptions(input?.mode)
    const { editorVersion = '' } = input ?? {}
    if (typeof editorVersion !== 'string') throw new IndexInputError('Укажите версию редактора Unreal.')
    if (format === 'unreal-asset' && mode !== 'engineless') {
      throw new IndexInputError('Для Unreal Editor выберите весь проект или папку Content.')
    }
    if (mode === 'engineless') {
      if (editorVersion) throw new IndexInputError('Для выбора версии Unreal нужен режим с редактором.')
      return { mode, editorVersion: '', formats }
    }
    validateUnrealVersion(editorVersion === '' ? undefined : editorVersion)
    return { mode, editorVersion, formats: formats || 'fbx,glb' }
  }
  const options = unityImportOptions(input?.mode, input?.editorVersion)
  if (isUnrealArchive(format)) {
    if (options.mode === 'engine-assisted' || options.editorVersion || (format === 'unreal-iostore' && formats)) {
      throw new IndexInputError('Для контейнера Unreal выберите независимое извлечение.')
    }
    return { mode: 'engineless', formats: format === 'unreal-pak' ? (formats.includes('fbx') ? 'fbx,glb' : 'glb') : '' }
  }
  if (format === 'unityfs' || format === 'unity-serialized') {
    if (options.mode === 'engine-assisted' || options.editorVersion) {
      throw new IndexInputError('Для бинарных файлов Unity выберите независимое декодирование.')
    }
    return { mode: 'engineless', formats: formats.includes('fbx') ? 'fbx,glb' : 'glb' }
  }
  return { ...options, formats: formats || (options.mode === 'engineless' ? '' : 'fbx,glb') }
}

export async function stagePackage(directory, source, job, { signal, onProgress, publish, expectedFormat }) {
  const format = await detectPackage(source, { signal })
  if (expectedFormat && expectedFormat !== format) {
    throw new IndexInputError('Содержимое файла не соответствует формату автоимпорта (' + expectedFormat + ').')
  }
  if (isUnrealLoose(format)) {
    packageOptions(format, { mode: job.engineMode, editorVersion: job.editorVersion, formats: job.exportFormats })
    return stageUnrealLoose(directory, await checkedUnrealSource(source, format, signal), job, { signal, onProgress, publish })
  }
  if (format === 'unitypackage' || source.directory) {
    return stageUnityPackage(directory, source, job.sourceKey, {
      signal, onProgress, formats: job.exportFormats, mode: job.engineMode, editorVersion: job.editorVersion,
      publish: (result, move) => publish(result, move, Boolean(result.report.written)),
    })
  }
  packageOptions(format, { mode: job.engineMode, editorVersion: job.editorVersion, formats: job.exportFormats })
  if (isUnrealArchive(format)) {
    const result = await unrealDecoder(format)(source, {
      directory, expectedHash: job.sourceKey, withFbx: job.exportFormats?.includes('fbx') ?? false, signal, onProgress,
      publish: ({ output, sourceName, reused, entries, ...report }, move) => publish({ directory: output, source: output,
        report: { ...report, packageFormat: format }, reused }, move, report.extracted > 0),
    })
    if (result?.issue) throw unrealArchiveError(format, result.issue)
    return result
  }
  const serialized = format === 'unity-serialized'
  const result = await processUnityBundle(source, {
    directory, expectedHash: job.sourceKey, withFbx: job.exportFormats?.includes('fbx') ?? false, serialized, signal, onProgress,
    publish: ({ output, sourceName, reused, ...report }, move) => publish({ directory: output, source: output,
      report: { ...report, packageFormat: format }, reused }, move, report.converted > 0),
  })
  if (result?.issue) throw bundleError(result.issue, serialized)
  return result
}
