import { constants } from 'node:fs'
import { copyFile, mkdir, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileInfo } from '../../../files/asset-files.mjs'

const MiB = 1024 ** 2
const eligible = row => row.output && row.type === 'uasset' && row.ue4 >= 397 && row.ue5 === 0 &&
  ['editor', 'cooked'].includes(row.storage) && !row.issue

export async function stageViewerInputs(records, output, input, signal) {
  const targets = records.assets.filter(eligible)
  if (!targets.length) return { targets, issue: 'unreal-viewer-no-versioned-ue4-inputs' }
  const ids = new Set(targets.map(asset => asset.id))
  const byId = new Map(records.assets.map(asset => [asset.id, asset]))
  const files = new Set(targets)
  for (const dependency of records.dependencies) {
    if (dependency.type !== 'unreal-package-companion' || !ids.has(dependency.source)) continue
    const related = byId.get(dependency.target)
    if (related?.output) files.add(related)
  }
  await mkdir(input)
  const space = await statfs(input, { bigint: true })
  if (space.bavail * space.bsize < BigInt([...files].reduce((sum, file) => sum + file.size, 640 * MiB))) {
    return { targets: [], issue: 'unreal-viewer-space-limit' }
  }
  for (const row of files) {
    signal?.throwIfAborted()
    const file = await fileInfo(output, row.output)
    if (!file || file.info.size !== row.size) return { targets: [], issue: 'unreal-viewer-stage-changed' }
    const target = join(input, row.sourcePath)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(file.path, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
  }
  return { targets }
}
