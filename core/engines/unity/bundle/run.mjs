import { mkdir, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileInfo } from '../../../files/asset-files.mjs'
import { findWorker, runJsonWorker } from '../../worker-process.mjs'
import { findSerializedCompanions, serializedCompanionNames } from '../serialized/companions.mjs'
import { sameSource, stageFile } from './stage-file.mjs'

const MiB = 1024 ** 2
export const inputLimit = 128 * MiB
export const assetsToolsVersion = '3.0.5'

export function locateBundleWorker() {
  return findWorker('unity-bundle', 'AssetViewer.UnityBundle', 'ASSET_VIEWER_UNITY_BUNDLE')
}

export async function stageBundle(source, workspace, inspectOnly, signal) {
  const resources = source.resources
  const available = await statfs(workspace, { bigint: true })
  const required = resources.reduce((size, resource) => size + resource.file.info.size, source.file.info.size)
  const remaining = available.bavail * available.bsize - BigInt(required + 160 * MiB)
  if (remaining < 0n || (!inspectOnly && remaining < 2n)) return 'unity-bundle-space-limit'
  const budget = remaining / 2n
  const outputLimit = inspectOnly ? 0 : Number(budget > 128n * BigInt(MiB) ? 128n * BigInt(MiB) : budget)
  for (const { file, staged } of [{ file: source.file, staged: 'input.bundle' }, ...resources]) {
    if (!await stageFile(source.root, file, join(workspace, staged), signal)) return 'unity-bundle-source-changed'
  }
  if (source.serialized) {
    const current = await findSerializedCompanions(source.root, source.file.path)
    const primary = await fileInfo(source.root, source.file.path)
    if (!primary || !sameSource(primary.info, source.file.info) || current.length !== resources.length || current.some((resource, index) =>
      resource.name !== resources[index].name || !sameSource(resource.file.info, resources[index].file.info))) {
      return 'unity-bundle-source-changed'
    }
  }
  await mkdir(join(workspace, 'output'))
  const companions = source.serialized &&
    Object.fromEntries(serializedCompanionNames(source.file.path).map(({ role, name }) => [role, name]))
  await writeFile(join(workspace, 'request.json'), JSON.stringify({ protocol: 1, inspectOnly, outputLimit,
    serialized: source.serialized, ...(companions && { companions }) }),
    { flag: 'wx', signal })
  return null
}

export function runBundleWorker(executable, workspace, signal) {
  return runJsonWorker(executable, workspace, {
    timeout: 90_000, failure: 'unity-bundle-worker-failed', timedOut: 'unity-bundle-worker-timeout', signal,
  })
}
