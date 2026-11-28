import { createHash } from 'node:crypto'
import { readBoundedText } from '../../files/asset-files.mjs'
import { validPackageSegment } from '../../packages/source.mjs'

export async function catalogJson(root, path, limit, digest) {
  const content = await readBoundedText(root, path, limit)
  if (!content || (digest && createHash('sha256').update(content).digest('hex') !== digest)) return null
  try { return JSON.parse(content) } catch { return null }
}

export function catalogArtifactPath(path) {
  return typeof path === 'string' && path.length <= 1024 && path.split('/').every(segment => validPackageSegment(segment))
}
