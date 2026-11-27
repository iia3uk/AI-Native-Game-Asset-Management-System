import { createHash } from 'node:crypto'
import { open, statfs } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { modelFormats, imageFormats, audioFormats, unityDataFormats as unityData } from '../../files/formats.mjs'
import { unityTar } from '../archive/package-tar.mjs'
import { checkPathTree, logicalPath, segments } from './paths.mjs'
import { guidPattern, invalid, MiB, packageLimits } from './policy.mjs'

const attributes = new Set(['pathname', 'asset', 'asset.meta', 'preview.png'])

function classification(path, folder) {
  if (folder) return { kind: 'folder', status: 'ready' }
  const ext = extname(path).slice(1).toLowerCase()
  if (modelFormats.has(ext)) return { kind: 'model', status: 'extracted' }
  if (imageFormats.has(ext) && ext !== 'svg') return { kind: 'texture', status: 'extracted' }
  if (audioFormats.has(ext)) return { kind: 'audio', status: 'extracted' }
  if (unityData.has(ext)) {
    const kind = ({ mat: 'material', anim: 'animation', prefab: 'prefab', unity: 'scene' })[ext] ?? 'unity-data'
    return { kind, status: ['mat', 'anim'].includes(ext) ? 'extracted' : 'requires-engine' }
  }
  if (['bin', 'mtl', 'txt', 'md', 'pdf'].includes(ext)) return { kind: 'support', status: 'extracted' }
  return { kind: 'unsupported', status: 'unsupported' }
}

async function smallEntry(consume, size) {
  const bytes = Buffer.alloc(size)
  let offset = 0
  await consume(chunk => { offset += chunk.copy(bytes, offset) })
  return bytes
}

export async function readPackage(source, { staging, signal, onProgress, limits }) {
  const entries = new Map()
  let written = 0
  let nextSpaceCheck = 0
  const metadataPrefix = 16 * 1024
  const archive = await unityTar(source.path, source.root, limits, async ({ name, size, type }, consume) => {
    const plain = name.replace(/^(?:\.\/)+/, '').replace(/\/$/, '')
    if (type === '5' && ['', '.'].includes(plain)) return
    const [guid, attribute, ...rest] = segments(plain)
    if (!guidPattern.test(guid) || rest.length || (type === '0' && !attribute) || (type === '5' && attribute)) {
      throw invalid('неверная структура записей GUID.')
    }
    const id = guid.toLowerCase()
    if (!entries.has(id)) entries.set(id, { id, attributes: new Map() })
    const item = entries.get(id)
    if (type === '5') return
    if (!attributes.has(attribute)) return
    if (item.attributes.has(attribute)) throw invalid('запись GUID повторяется.')
    const limit = ({ pathname: limits.pathname, 'asset.meta': limits.metadata, 'preview.png': limits.preview })[attribute]
    if (limit !== undefined && size > limit) throw invalid('слишком большая запись ' + attribute + '.')
    const record = { size }
    item.attributes.set(attribute, record)
    if (attribute === 'pathname') {
      record.path = logicalPath(await smallEntry(consume, size))
    } else if (attribute === 'asset.meta' && !staging) {
      const prefix = Buffer.alloc(Math.min(size, metadataPrefix))
      let offset = 0
      await consume(bytes => { offset += bytes.copy(prefix, offset) })
      recordMetadata(record, prefix, id)
    } else if (staging) {
      // The archive name never becomes a filesystem path. Both components come from fixed formats.
      record.temp = join(staging, id + '-' + attribute)
      if (written + size > nextSpaceCheck) {
        const space = await statfs(staging, { bigint: true })
        if (space.bavail * space.bsize < BigInt(size + 160 * MiB)) throw invalid('недостаточно свободного места.')
        nextSpaceCheck = written + size + 32 * MiB
      }
      written += size
      const handle = await open(record.temp, 'wx')
      const hash = createHash('sha256')
      const prefix = attribute === 'asset.meta' ? Buffer.alloc(Math.min(size, metadataPrefix)) : null
      let sampled = 0
      try {
        await consume(async bytes => {
          if (prefix) sampled += bytes.copy(prefix, sampled)
          hash.update(bytes)
          let offset = 0
          while (offset < bytes.length) offset += (await handle.write(bytes, offset, bytes.length - offset, null)).bytesWritten
        })
      } finally {
        await handle.close()
      }
      if (prefix) recordMetadata(record, prefix, id)
      record.hash = hash.digest('hex')
    }
  }, { signal, progress: onProgress })

  const seen = new Set()
  const tree = new Map()
  const assets = []
  for (const item of entries.values()) {
    const path = item.attributes.get('pathname')?.path
    if (!path) {
      if (item.attributes.size) throw invalid('отсутствует pathname для записи GUID.')
      continue
    }
    const payload = item.attributes.get('asset')
    const meta = item.attributes.get('asset.meta')
    const preview = item.attributes.get('preview.png')
    const folder = !payload && Boolean(meta?.folder)
    const key = path.normalize('NFC').toLowerCase()
    if (seen.has(key) || (!folder && ['Assets', 'Packages'].includes(path))) throw invalid('конфликт путей pathname.')
    seen.add(key)
    checkPathTree(tree, path, folder)
    if (meta) checkPathTree(tree, path + '.meta', false)
    const info = classification(path, folder)
    if (!payload && !folder) info.status = 'failed'
    assets.push({ id: item.id, sourcePath: path, ...info, size: payload?.size ?? 0, hasMeta: Boolean(meta),
      hasPreview: Boolean(preview), payload, meta, preview })
  }
  if (!assets.length) throw invalid('записи GUID с pathname отсутствуют.')
  assets.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath, 'en'))
  return { format: 'unitypackage', ...archive, assets }
}

function recordMetadata(record, prefix, id) {
  const text = prefix.toString('utf8')
  if (text.match(/^guid:[ \t]*([0-9a-f]{32})[ \t]*\r?$/im)?.[1]?.toLowerCase() !== id) {
    throw invalid('GUID в asset.meta не совпадает с записью архива.')
  }
  record.folder = /^folderAsset:[ \t]*(?:yes|true|1)[ \t]*\r?$/im.test(text)
}

function summary({ assets, ...archive }) {
  return { ...archive, total: assets.length, assets: assets.slice(0, 500).map(({ payload, meta, preview, ...publicFields }) => publicFields) }
}

export async function inspectUnityPackage(source, { signal, limits = packageLimits } = {}) {
  return summary(await readPackage(source, { signal, limits }))
}
