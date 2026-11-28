import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { boundedCookedBatch } from '../../../engines/unreal/decoder/budget.mjs'
import { runUnrealDecoder, stageUnrealInputs } from '../../../engines/unreal/decoder/run.mjs'

export async function publishLooseBatch(inputs, { decoder, output, workspace, store, signal },
  { type, validate, publish, options }) {
  const format = 'loose-' + type
  const issue = 'unreal-' + format
  const summary = { converted: 0, skipped: 0, failed: 0 }
  if (!decoder) return { ...summary, issue: issue + '-unavailable' }
  const { selected, size, files, limited } = boundedCookedBatch(inputs, 512)
  const count = selected.length
  if (limited) summary.issue = issue + '-budget'
  if (!count) return summary
  const scratch = join(workspace, format)
  await mkdir(scratch)
  try {
    const problem = await stageUnrealInputs({ root: output, size, files, count }, format, scratch, false, signal)
    if (problem) return { ...summary, issue: problem }
    const result = validate(await runUnrealDecoder(decoder, scratch, signal), count)
    if (result?.status !== 'completed') return { ...summary, issue: result?.issue ?? issue + '-protocol' }
    for (const [index, row] of result.entries.entries()) {
      signal?.throwIfAborted()
      if (!row) continue
      const { asset, path } = selected[index]
      const exported = await publish(join(scratch, 'output'), store, { ...row, path }, { path: asset.output },
        asset.id, options, signal)
      asset.exports.push(exported)
      summary[exported.status]++
    }
    return summary
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 })
  }
}
