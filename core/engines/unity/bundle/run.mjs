import { constants } from 'node:fs'
import { copyFile, mkdir, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileInfo, sameFile } from '../../../files/asset-files.mjs'
import { findWorker, runJsonWorker } from '../../worker-process.mjs'

const MiB = 1024 ** 2
export const inputLimit = 128 * MiB
export const assetsToolsVersion = '3.0.5'

export function locateBundleWorker() {
  return findWorker('unity-bundle', 'AssetViewer.UnityBundle', 'ASSET_VIEWER_UNITY_BUNDLE')
}

export async function stageBundle(source, workspace, inspectOnly, signal) {
  const available = await statfs(workspace, { bigint: true })
  const remaining = available.bavail * available.bsize - BigInt(source.file.info.size + 160 * MiB)
  if (remaining < 0n || (!inspectOnly && remaining < 2n)) return 'unity-bundle-space-limit'
  const budget = remaining / 2n
  const outputLimit = inspectOnly ? 0 : Number(budget > 128n * BigInt(MiB) ? 128n * BigInt(MiB) : budget)
  const before = await fileInfo(source.root, source.file.path)
  if (!before || !sameFile(before.info, source.file.info)) return 'unity-bundle-source-changed'
  signal?.throwIfAborted()
  await copyFile(before.path, join(workspace, 'input.bundle'), constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
  signal?.throwIfAborted()
  const after = await fileInfo(source.root, source.file.path)
  if (!after || !sameFile(after.info, source.file.info)) return 'unity-bundle-source-changed'
  await mkdir(join(workspace, 'output'))
  await writeFile(join(workspace, 'request.json'), JSON.stringify({ protocol: 1, inspectOnly, outputLimit }),
    { flag: 'wx', signal })
  return null
}

export function runBundleWorker(executable, workspace, signal) {
  return runJsonWorker(executable, workspace, {
    timeout: 90_000, failure: 'unity-bundle-worker-failed', timedOut: 'unity-bundle-worker-timeout', signal,
  })
}
