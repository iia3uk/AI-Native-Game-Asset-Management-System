import { basename, dirname, extname, join } from 'node:path'
import { fileInfo } from '../../../files/asset-files.mjs'
import { validPackageSegment } from '../../../packages/source.mjs'

const MiB = 1024 ** 2

export function serializedCompanionNames(primary) {
  const name = basename(primary)
  const stem = basename(primary, extname(primary))
  return [
    { name: name + '.resS', role: 'texture', staged: 'input.resS' },
    { name: name + '.resource', role: 'audio', staged: 'input.resource' },
    ...(stem !== name ? [{ name: stem + '.resource', role: 'audioStem', staged: 'input-stem.resource' }] : []),
  ].filter(candidate => validPackageSegment(candidate.name))
}

export async function findSerializedCompanions(root, primary) {
  const resources = []
  for (const candidate of serializedCompanionNames(primary)) {
    const file = await fileInfo(root, join(dirname(primary), candidate.name))
    if (file) resources.push({ ...candidate, file })
  }
  return resources
}

export function companionSizeAllowed(resources) {
  return resources.every(resource => resource.file.info.size <= 256 * MiB) &&
    resources.reduce((size, resource) => size + resource.file.info.size, 0) <= 512 * MiB
}
