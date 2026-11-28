import { constants } from 'node:fs'
import { copyFile, mkdir, statfs, writeFile } from 'node:fs/promises'
import { extname, join, posix } from 'node:path'
import { fileInfo, readBoundedText } from '../../../files/asset-files.mjs'

const MiB = 1024 ** 2
const maxText = 32 * MiB
const classIDs = {
  prefab: new Set([1, 4, 20, 21, 23, 33, 43, 65, 74, 81, 95, 108, 111, 135, 136, 137, 143, 205, 224, 1001]),
  asset: new Set([21, 28, 43, 74, 90]),
  controller: new Set([91, 206, 1101, 1102, 1107, 1109]),
  overridecontroller: new Set([221]),
  anim: new Set([74]),
  mat: new Set([21]),
}
const targetFormats = new Set(['prefab', 'asset', 'anim', 'mat'])
const textureFormats = new Set(['png', 'jpg', 'jpeg', 'bmp', 'tga', 'tif', 'tiff', 'exr', 'hdr', 'psd'])
const guid = /^[0-9a-f]{32}$/
const builtInImporters = {
  prefab: 'PrefabImporter', asset: 'NativeFormatImporter', anim: 'NativeFormatImporter', mat: 'NativeFormatImporter',
  controller: 'NativeFormatImporter', overridecontroller: 'NativeFormatImporter', fbx: 'ModelImporter',
}

const eligiblePath = (path, includePackageAssets) => path.startsWith('Assets/') ||
  (includePackageAssets && path.startsWith('Packages/'))

export function isUnityExportTarget(entry, includePackageAssets = false) {
  return Boolean(entry.output && eligiblePath(entry.sourcePath, includePackageAssets) &&
    targetFormats.has(extname(entry.sourcePath).slice(1).toLowerCase()))
}

export function validateUnityText(text, ext) {
  if (typeof text !== 'string' || !/^\uFEFF?%YAML[ \t]+1\.1\r?\n%TAG !u! tag:unity3d\.com,2011:\r?\n/.test(text) ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f]|^\s*m_Script\s*:/m.test(text)) return false
  const allowed = classIDs[ext]
  if (!allowed) return false
  let documents = 0
  for (const [header] of text.matchAll(/^---[^\r\n]*/gm)) {
    const id = /^--- !u!(\d{1,6}) &-?\d{1,20}(?: stripped)?[ \t]*$/.exec(header)?.[1]
    if (!allowed.has(Number(id)) || ++documents > 100_000) return false
  }
  return documents > 0
}

// Preserve source GUID references and the main subasset identifier without copying importer settings.
async function cleanMeta(root, entry, ext) {
  const importer = builtInImporters[ext] ?? 'TextureImporter'
  const source = entry.metadata && await readBoundedText(root, entry.metadata, 2 * MiB)
  const mainFileID = source && /^  mainObjectFileID: (-?\d{1,20})\r?$/m.exec(source)?.[1]
  const settings = mainFileID && importer === 'NativeFormatImporter' ? '  mainObjectFileID: ' + mainFileID + '\n' : ''
  return 'fileFormatVersion: 2\nguid: ' + entry.id + '\n' + importer + ':\n' +
    '  externalObjects: {}\n' + settings + '  userData: \n  assetBundleName: \n  assetBundleVariant: \n'
}

export async function stageUnityInputs(output, project, entries, signal, includePackageAssets = false) {
  const targets = []
  const rejected = new Map()
  const root = join(project, 'Assets', 'BridgeInput')
  await mkdir(root, { recursive: true })
  let bytes = 0
  let count = 0
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (!entry.output || !guid.test(entry.id) || !eligiblePath(entry.sourcePath, includePackageAssets)) continue
    const ext = extname(entry.sourcePath).slice(1).toLowerCase()
    if (!classIDs[ext] && ext !== 'fbx' && !textureFormats.has(ext)) continue
    const target = isUnityExportTarget(entry, includePackageAssets)
    const file = await fileInfo(output, entry.output)
    let issue
    if (!file) issue = 'unity-input-unavailable'
    else if (count >= 4000 || bytes + file.info.size > 2 * 1024 * MiB) issue = 'unity-input-limit'
    else if (classIDs[ext]) {
      const text = await readBoundedText(output, entry.output, maxText)
      if (!validateUnityText(text, ext)) issue = 'unity-serialization-excluded'
    }
    if (issue) {
      if (target) rejected.set(entry.id, issue)
      continue
    }
    const space = await statfs(root, { bigint: true })
    if (space.bavail * space.bsize < BigInt(file.info.size + 768 * MiB)) {
      if (target) rejected.set(entry.id, 'unity-space-limit')
      continue
    }
    const name = posix.basename(entry.sourcePath)
    const directory = join(root, entry.id)
    await mkdir(directory)
    const destination = join(directory, name)
    await copyFile(file.path, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    await writeFile(destination + '.meta', await cleanMeta(output, entry, ext), { flag: 'wx', signal })
    bytes += file.info.size
    count++
    if (target) targets.push({ id: entry.id, path: 'Assets/BridgeInput/' + entry.id + '/' + name, kind: ext })
  }
  return { targets, rejected }
}
