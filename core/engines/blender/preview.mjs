import { execFile } from 'node:child_process'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { fileInfo } from '../../files/asset-files.mjs'
import { discoverBlender } from './discovery.mjs'

const runFile = promisify(execFile)
const bundledExportScript = fileURLToPath(new URL('../../../scripts/export-blend.py', import.meta.url))
const previewAbort = new AbortController()
let cacheDirectory
let conversionTail = Promise.resolve()
let pendingConversions = 0

async function blenderCommands() {
  if (process.env.ASSET_VIEWER_BLENDER) return [process.env.ASSET_VIEWER_BLENDER]
  return (await discoverBlender()).map(candidate => candidate.executable)
}

async function convertWithBlender(library, file) {
  previewAbort.signal.throwIfAborted()
  const inputFile = await fileInfo(library.root, file.path)
  if (!inputFile) throw new Error('Исходный файл недоступен.')
  if (inputFile.info.size > 512 * 1024 ** 2) throw new Error('Исходный файл превышает лимит преобразования 512 МиБ.')
  const { path: source } = inputFile
  cacheDirectory ??= mkdtemp(join(tmpdir(), 'asset-viewer-'))
  const target = join(await cacheDirectory, library.id + '-' + file.id + '.glb')
  const partial = target + '.partial.glb'
  const exportScript = process.env.ASSET_VIEWER_BLEND_SCRIPT ?? bundledExportScript
  const commands = await blenderCommands()
  for (const executable of commands) {
    try {
      const input = file.ext === 'blend' ? [source] : []
      await runFile(executable, ['--background', '--factory-startup', '--disable-autoexec', ...input, '--python-exit-code', '1',
        '--python', exportScript, '--', partial, library.root, ...(input.length ? [] : [source])],
      { timeout: 500_000, windowsHide: true, maxBuffer: 2 * 1024 ** 2, signal: previewAbort.signal })
      await rename(partial, target)
      return target
    } catch (error) {
      if (error.code === 'ENOENT') continue
      console.error('Blender preview:', file.name, error.stderr?.slice(-1200) || error.message)
      throw new Error('Blender не смог подготовить GLB-предпросмотр этого файла.')
    } finally {
      await rm(partial, { force: true })
    }
  }
  throw new Error('Для предпросмотра этого формата нужен Blender в PATH или путь в ASSET_VIEWER_BLENDER.')
}

export async function blenderPreview(library, file) {
  if (!library.previews.has(file.id)) {
    if (pendingConversions >= 8) throw new Error('Очередь Blender заполнена. Повторите позже.')
    pendingConversions++
    const operation = conversionTail.then(() => convertWithBlender(library, file)).catch(error => {
      library.previews.delete(file.id)
      throw error
    }).finally(() => {
      pendingConversions--
    })
    conversionTail = operation.catch(() => undefined)
    library.previews.set(file.id, operation)
  }
  return library.previews.get(file.id)
}

export async function closePreviews() {
  previewAbort.abort()
  await conversionTail
  if (cacheDirectory) await rm(await cacheDirectory, { recursive: true, force: true })
}
