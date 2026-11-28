import { constants } from 'node:fs'
import { copyFile, mkdir, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileInfo, sameFile } from '../../../files/asset-files.mjs'
import { findWorker, runJsonWorker } from '../../worker-process.mjs'

const MiB = 1024 ** 2
export const cue4parseVersion = '1.2.2.202611'

export function locateUnrealDecoder() {
  return findWorker('cue4parse', 'AssetViewer.UnrealDecode', 'ASSET_VIEWER_CUE4PARSE')
}

export async function stagePak(source, workspace, inspectOnly, signal) {
  return stageUnrealInputs({ root: source.root, size: source.file.info.size,
    files: [{ file: source.file, stageName: 'input.pak' }] }, 'pak', workspace, inspectOnly, signal)
}

export async function stageUnrealInputs({ root, size, files, count }, format, workspace, inspectOnly, signal) {
  const space = await statfs(workspace, { bigint: true })
  const available = space.bavail * space.bsize - BigInt(size + 160 * MiB)
  if (available < 0n || (!inspectOnly && available === 0n)) return 'unreal-' + format + '-space-limit'
  const capacity = 1024n ** 3n
  const maxOutputBytes = inspectOnly ? 0 : Number(available < capacity ? available : capacity)
  for (const { file, stageName } of files) {
    signal?.throwIfAborted()
    const before = await fileInfo(root, file.path)
    if (!before || !sameFile(before.info, file.info)) return 'unreal-' + format + '-changed'
    await copyFile(before.path, join(workspace, stageName), constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    signal?.throwIfAborted()
    const after = await fileInfo(root, file.path)
    if (!after || !sameFile(before.info, after.info)) return 'unreal-' + format + '-changed'
  }
  await mkdir(join(workspace, 'output'))
  await writeFile(join(workspace, 'request.json'), JSON.stringify({ protocol: 1, format, inspectOnly, maxOutputBytes, count }),
    { flag: 'wx', signal })
  return null
}

export function runUnrealDecoder(executable, workspace, signal) {
  return runJsonWorker(executable, workspace, {
    timeout: 150_000, failure: 'unreal-worker-failed', timedOut: 'unreal-worker-timeout', signal,
  })
}
