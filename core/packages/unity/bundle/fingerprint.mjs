import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { artifactHash } from '../../../conversion/artifacts.mjs'

export async function bundleFingerprint(workspace, source, signal) {
  const contentsSha256 = await artifactHash(join(workspace, 'input.bundle'), signal)
  if (!source.resources.length) return { sha256: contentsSha256 }
  const resources = []
  for (const { name, role, staged, file } of source.resources) {
    resources.push({ name, role: role === 'texture' ? 'texture' : 'audio', size: file.info.size,
      sha256: await artifactHash(join(workspace, staged), signal) })
  }
  const sha256 = createHash('sha256')
    .update(JSON.stringify(['unity-serialized-companions-v1', source.name, contentsSha256, resources]))
    .digest('hex')
  return { sha256, contentsSha256, resources }
}
