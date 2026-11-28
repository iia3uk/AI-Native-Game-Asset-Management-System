import { basename } from 'node:path'
import { ScanChangeError } from '../../../files/asset-files.mjs'
import { hashFile, sameSource } from '../../../files/hash.mjs'
import { companionDigest, unitySourceFingerprint } from './fingerprint.mjs'
import { readBundleSource } from './source.mjs'

export async function watchUnityBinarySource(root, file, hash, previousResources, signal, serialized) {
  const name = basename(file.absolute)
  const source = await readBundleSource({ root, path: file.absolute, name }, serialized, signal)
  if (source.issue === 'unity-bundle-source-changed' || source.file && !sameSource(source.file.info, file.info)) {
    throw new ScanChangeError('Бинарный файл Unity изменился во время индексации.')
  }
  if (source.status) return null
  const previous = JSON.parse(previousResources ?? '[]')
  const resources = []
  const digests = []
  for (const resource of source.resources) {
    const { size, mtimeMs, ctimeMs, dev, ino } = resource.file.info
    const cached = previous.find(entry => entry.name === resource.name && sameSource(entry, resource.file.info))
    const sha256 = cached?.sha256 ?? await hashFile(root, resource.file.path, resource.file.info, signal)
    resources.push({ name: resource.name, size, mtimeMs, ctimeMs, dev, ino, sha256 })
    digests.push(companionDigest(resource, sha256))
  }
  return { key: unitySourceFingerprint(name, hash, digests).sha256, resources: JSON.stringify(resources) }
}
