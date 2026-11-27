import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, mkdir, open, rename, statfs } from 'node:fs/promises'
import { basename, dirname, extname, join, posix } from 'node:path'
import { analyzeAsset } from '../analysis/asset-analysis.mjs'
import { fileInfo } from '../files/asset-files.mjs'

const MiB = 1024 ** 2
const fbxMagic = Buffer.from('Kaydara FBX Binary  \0\x1a\0', 'latin1')
export const exportFolders = ['Models', 'Textures', 'Materials', 'Animations', 'Audio', 'Previews', 'Metadata']
const folders = { texture: 'Textures', material: 'Materials', animation: 'Animations', audio: 'Audio' }

export async function modelArtifact(root, path, ext, signal) {
  const file = await fileInfo(root, path)
  if (!file || !file.info.size || file.info.size > 512 * MiB) return null
  if (ext === 'fbx') {
    const handle = await open(file.path, 'r')
    try {
      const bytes = Buffer.alloc(52)
      if ((await handle.read(bytes)).bytesRead !== bytes.length) return null
      const version = bytes.readUInt32LE(23)
      if (!bytes.subarray(0, 23).equals(fbxMagic) || version < 7100 || version >= 10_000) return null
      const end = version >= 7500 ? bytes.readBigUInt64LE(27) : BigInt(bytes.readUInt32LE(27))
      if (end <= BigInt(bytes.length) || end > BigInt(file.info.size)) return null
    } finally {
      await handle.close()
    }
    return file
  }
  const analysis = await analyzeAsset(root, { absolute: file.path, path: basename(path), info: file.info, ext }, signal)
  return analysis.metrics.triangles > 0 && !analysis.dependenciesTruncated &&
    analysis.dependencies.every(item => item.location === 'embedded') ? file : null
}

export async function isWaveArtifact(file) {
  if (file.info.size < 44) return false
  const handle = await open(file.path, 'r')
  try {
    const prefix = Buffer.alloc(12)
    const { bytesRead } = await handle.read(prefix)
    return bytesRead === 12 && prefix.toString('ascii', 0, 4) === 'RIFF' &&
      prefix.toString('ascii', 8, 12) === 'WAVE' && prefix.readUInt32LE(4) + 8 === file.info.size
  } finally {
    await handle.close()
  }
}

export function artifactPath(entry, format) {
  const original = posix.basename(entry.sourcePath)
  const directory = format === 'fbx' ? 'Models' : format === 'glb' ? 'Previews' : format === 'meta' ? 'Metadata' : folders[entry.kind]
  if (!directory) return null
  const name = format === 'original' ? original : format === 'meta' ? original + '.meta' :
    basename(original, extname(original)) + '.' + format
  return [directory, entry.id, name].join('/')
}

export async function artifactHash(path, signal) {
  const hash = createHash('sha256')
  for await (const data of createReadStream(path, { signal })) hash.update(data)
  return hash.digest('hex')
}

export class ExportArtifacts {
  #bytes = 0

  constructor(root, signal) {
    this.root = root
    this.signal = signal
  }

  async preflight(bytes) {
    this.signal?.throwIfAborted()
    if (this.#bytes + bytes > 4 * 1024 * MiB) return 'export-size-limit'
    const space = await statfs(this.root, { bigint: true })
    if (space.bavail * space.bsize < BigInt(bytes + 160 * MiB)) return 'export-space-limit'
    return null
  }

  async save(relative, file, details) {
    const size = file.info.size
    const error = await this.preflight(size)
    if (error) return { ...details, status: 'failed', issue: error }
    const target = join(this.root, relative)
    await mkdir(dirname(target), { recursive: true })
    if (details.method === 'original-copy') {
      await copyFile(file.path, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    } else {
      await rename(file.path, target)
    }
    this.#bytes += size
    const { sha256 = await artifactHash(target, this.signal), ...fields } = details
    return { ...fields, path: relative, size, sha256 }
  }
}
