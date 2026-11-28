import { fileInfo } from '../../files/asset-files.mjs'
import { readVerifiedFile } from '../../files/read-verified.mjs'
import { validPackageSegment, packageHashPattern } from '../source.mjs'

export const relativeSourcePath = path => typeof path === 'string' && path.length <= 4096 &&
  path.split('/').every(segment => validPackageSegment(segment, 255))
const changed = () => new Error('Файл изменился во время проверки.')

export async function verifiedCleanupFile(root, path, { size, sha256 }, signal) {
  if (!relativeSourcePath(path) || !packageHashPattern.test(sha256 ?? '') ||
      (size !== undefined && (!Number.isSafeInteger(size) || size <= 0))) return null
  try {
    const file = await fileInfo(root, path)
    if (!file?.info.size || (size !== undefined && file.info.size !== size)) return null
    const verified = await readVerifiedFile(root, file, { signal, changed })
    return verified.hash === sha256 ? file : null
  } catch {
    signal.throwIfAborted()
    return null
  }
}
