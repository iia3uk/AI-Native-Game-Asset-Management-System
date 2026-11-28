import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { artifactHash } from '../../../conversion/artifacts.mjs'

export function companionDigest({ name, role, file }, sha256) {
  return { name, role: role === 'audioStem' ? 'audio' : role, size: file.info.size, sha256 }
}

export function unitySourceFingerprint(name, contentsSha256, resources) {
  if (!resources.length) return { sha256: contentsSha256 }
  const sha256 = createHash('sha256')
    .update(JSON.stringify([resources[0].role === 'bundle' ? 'unity-bundle-dependencies-v1' : 'unity-serialized-companions-v1',
      name, contentsSha256, resources]))
    .digest('hex')
  return { sha256, contentsSha256, resources }
}

export async function bundleFingerprint(workspace, source, signal) {
  const contentsSha256 = await artifactHash(join(workspace, 'input.bundle'), signal)
  const resources = []
  for (const resource of source.resources) {
    const hash = await artifactHash(join(workspace, resource.staged), signal)
    resources.push(companionDigest(resource, hash))
  }
  return unitySourceFingerprint(source.name, contentsSha256, resources)
}
