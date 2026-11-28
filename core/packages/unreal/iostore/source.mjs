import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { checkedPath, fileInfo, pathKey, sameFile } from '../../../files/asset-files.mjs'
import { ioStoreHeader } from '../containers.mjs'

const MiB = 1024 ** 2
export const isIoStorePath = path => /\.(utoc|ucas)$/i.test(path)

export async function ioStoreToc(source) {
  if (/\.utoc$/i.test(source.path)) return fileInfo(source.root, source.path)
  const name = basename(source.path)
  if (!/\.ucas$/i.test(name)) return null
  const stem = name.slice(0, -5)
  const folder = dirname(source.path)
  const unpartitioned = await fileInfo(source.root, join(folder, stem + '.utoc'))
  if (unpartitioned) return unpartitioned
  const main = stem.replace(/_s[1-7]$/i, '')
  return main !== stem ? fileInfo(source.root, join(folder, main + '.utoc')) : null
}

export async function ioStoreSource(source, signal) {
  const toc = await ioStoreToc(source)
  if (!toc) return { issue: 'unreal-iostore-toc-missing' }
  if (toc.info.size > 32 * MiB) return { issue: 'unreal-iostore-size-limit' }
  const bytes = Buffer.alloc(144)
  signal?.throwIfAborted()
  const handle = await open(toc.path, 'r')
  try {
    if (!sameFile(toc.info, await handle.stat()) || !await checkedPath(source.root, toc.path) ||
        (await handle.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length ||
        !sameFile(toc.info, await handle.stat())) return { issue: 'unreal-iostore-layout' }
  } finally {
    await handle.close()
  }
  const header = ioStoreHeader(bytes, toc.info.size)
  if (!header) return { issue: 'unreal-iostore-layout' }
  if (header.encrypted) return { issue: 'unreal-iostore-encrypted' }
  if (header.flags & 4) return { issue: 'unreal-iostore-signed' }
  if (header.version < 2 || header.version > 8 || (header.flags & ~9)) return { issue: 'unreal-iostore-version' }
  if (!(header.flags & 8)) return { issue: 'unreal-iostore-no-directory' }
  const partitions = header.version < 3 ? 1 : bytes.readUInt32LE(52)
  if (!partitions || partitions > 8) return { issue: 'unreal-iostore-partition' }
  const name = basename(toc.path)
  const sourceDirectory = dirname(toc.path)
  const files = [{ file: toc, stageName: 'input.utoc', name }]
  let size = toc.info.size
  for (let index = 0; index < partitions; index++) {
    const suffix = index ? '_s' + index + '.ucas' : '.ucas'
    const part = name.slice(0, -5) + suffix
    const file = await fileInfo(source.root, join(sourceDirectory, part))
    if (!file) return { issue: 'unreal-iostore-companion-missing' }
    if (!file.info.size || (size += file.info.size) > 8 * 1024 * MiB) {
      return { issue: 'unreal-iostore-size-limit' }
    }
    files.push({ file, name: part, stageName: 'input' + suffix })
  }
  if (!files.some(({ file }) => pathKey(file.path) === pathKey(source.path))) {
    return { issue: 'unreal-iostore-companion-missing' }
  }
  return { files, size, name, root: source.root, ...header, partitions }
}

export function ioStoreFingerprint(files) {
  return createHash('sha256').update(JSON.stringify(['unreal-iostore-v1', files.map(({ name, size, sha256 }) =>
    [name, size, sha256])])).digest('hex')
}
