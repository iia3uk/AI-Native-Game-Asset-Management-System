import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { packageExportFormats } from '../../conversion/formats.mjs'
import { unityImportOptions } from '../../engines/unity/options.mjs'
import { checkedPath, folderPath, inside } from '../../files/asset-files.mjs'
import { IndexConflictError, IndexInputError } from '../../index/index-errors.mjs'
import { folderPackageSource, scanPackageFolder } from '../folder.mjs'
import { exportDestination } from '../export/plan.mjs'

export async function prepareFolderRun(input, protectedRoots, ignoredPaths) {
  const path = typeof input?.path === 'string' && input.path.length <= 4096 && await folderPath(input.path).catch(() => null)
  if (!path) throw new IndexInputError('Выберите существующую папку исходников.')
  if (ignoredPaths.some(root => inside(root, path))) throw new IndexInputError('Выберите папку за пределами служебных папок Asset Viewer.')
  const { dev, ino } = await stat(path)
  const source = { path, dev, ino }
  const destination = input.destination ? await exportDestination(input.destination, [...protectedRoots, path]) : null
  const { mode } = unityImportOptions(input.mode)
  const formats = packageExportFormats(input.formats).split(',').filter(Boolean)
  const { unityVersion = '', unrealVersion = '' } = input
  if ([unityVersion, unrealVersion].some(version => typeof version !== 'string' || version.length > 32)) {
    throw new IndexInputError('Укажите версию редактора.')
  }
  return { source, destination, options: { mode, formats, unityVersion, unrealVersion } }
}

async function verifySource({ path, dev, ino }) {
  const info = await checkedPath(path, path) && await stat(path).catch(() => null)
  if (!info?.isDirectory() || info.dev !== dev || info.ino !== ino) {
    throw new IndexConflictError('Папка исходников изменилась. Выберите её снова.')
  }
}

const directSource = path => ({ root: path, path, name: basename(path), directory: true })

export async function discoverFolderRun(source, ignoredPaths, signal) {
  await verifySource(source)
  const report = await scanPackageFolder(source.path, { ignoredPaths, signal, structured: true })
  if (report.truncated) throw new IndexInputError('Папка превышает лимит поиска. Выберите вложенную папку.')
  if (!report.packages.length) throw new IndexInputError('В папке нет поддерживаемых пакетов Unity или Unreal.')
  return report.packages.map(({ path }) => ({ path }))
}

export async function folderRunSource(source, item, ignoredPaths) {
  await verifySource(source)
  return item.direct ? directSource(source.path) : folderPackageSource(source.path, item.path, ignoredPaths)
}
