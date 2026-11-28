import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { boundedCookedBatch } from '../../../engines/unreal/decoder/budget.mjs'
import { looseTextureResult, looseTextureRevision } from '../../../engines/unreal/decoder/protocol.mjs'
import { cue4parseVersion, runUnrealDecoder, stageUnrealInputs } from '../../../engines/unreal/decoder/run.mjs'
import { publishContainerTexture } from '../container-texture.mjs'

const format = 'loose-textures'
const options = { method: 'cue4parse-cooked-texture', converterVersion: cue4parseVersion + '-loose-' + looseTextureRevision,
  outputIssue: 'unreal-cooked-texture-output' }

export async function publishLooseCookedTextures(inputs, { decoder, output, workspace, store, signal }) {
  const summary = { converted: 0, skipped: 0, failed: 0 }
  if (!decoder) return { ...summary, issue: 'unreal-loose-textures-unavailable' }
  const ready = inputs.filter(({ asset }) => !asset.exports.some(item => item.role === 'texture' && item.status === 'converted'))
  const { selected, size, files, limited } = boundedCookedBatch(ready, 512)
  const count = selected.length
  if (limited) summary.issue = 'unreal-loose-textures-budget'
  if (!count) return summary
  const scratch = join(workspace, 'loose-textures')
  await mkdir(scratch)
  try {
    const issue = await stageUnrealInputs({ root: output, size, files, count }, format, scratch, false, signal)
    if (issue) return { ...summary, issue }
    const result = looseTextureResult(await runUnrealDecoder(decoder, scratch, signal), count)
    if (result?.status !== 'completed') return { ...summary, issue: result?.issue ?? 'unreal-loose-textures-protocol' }
    for (const [index, row] of result.entries.entries()) {
      signal?.throwIfAborted()
      if (!row) continue
      const { asset, path } = selected[index]
      const exported = await publishContainerTexture(join(scratch, 'output'), store, { ...row, path }, { path: asset.output },
        asset.id, options, signal)
      asset.exports.push(exported)
      summary[exported.status]++
    }
    return summary
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 })
  }
}
