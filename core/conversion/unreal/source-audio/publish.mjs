import { mkdir, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { unrealGameAssetResolver } from '../../../engines/unreal/editor-package/game-path.mjs'
import { readSourceSoundCue, soundCueFileLimit, soundCueVersions, sourceSoundCueRevision } from '../../../engines/unreal/source-audio/cues.mjs'
import { fileInfo } from '../../../files/asset-files.mjs'
import { readVerifiedFile } from '../../../files/read-verified.mjs'
import { ExportArtifacts } from '../../artifacts.mjs'

const method = 'unreal-editor-sound-cue'

async function readCue(output, asset, signal) {
  const changed = () => new Error('Staged Unreal package changed during SoundCue decoding')
  const file = await fileInfo(output, asset.output)
  if (!file || file.info.size !== asset.size) throw changed()
  const { prefix, hash } = await readVerifiedFile(output, file, { capture: asset.size, changed, signal })
  if (hash !== asset.hash) throw changed()
  try {
    return readSourceSoundCue(prefix, asset.ue4)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return null
  }
}

function linkWaves(cue, resolve, outputPath) {
  const links = new Map()
  for (const { wave } of cue.nodes) {
    if (!wave || links.has(wave)) continue
    const target = resolve(wave)
    const known = target?.exports.find(item => item.role === 'audio' && item.format === 'wav' &&
      item.status === 'converted' && item.path)
    links.set(wave, { package: wave, target: target?.id ?? null, sourcePath: target?.sourcePath ?? null,
      status: known ? 'resolved' : target ? 'unavailable' : 'missing',
      ...(known && { wav: { path: known.path, uri: posix.relative(posix.dirname(outputPath), known.path),
        sha256: known.sha256, size: known.size } }) })
  }
  return [...links.values()]
}

export async function publishSourceSoundCues({ records, output, workspace, source, signal }) {
  const summary = { converterVersion: sourceSoundCueRevision, graphs: 0, ready: 0, linkedWaves: 0, incomplete: 0 }
  const resolve = unrealGameAssetResolver(records.assets, source.root)
  const scratch = join(workspace, 'unreal-sound-cue')
  const store = new ExportArtifacts(output, signal, 64 * 1024 ** 2)
  const deadline = performance.now() + 30_000
  await mkdir(scratch)
  for (const asset of records.assets) {
    signal?.throwIfAborted()
    if (!asset.output || asset.issue || asset.type !== 'uasset' || asset.storage !== 'editor' ||
        asset.layout !== -7 || asset.ue5 !== 0 || !soundCueVersions.has(asset.ue4) || asset.size > soundCueFileLimit) continue
    if (performance.now() >= deadline) {
      summary.issue = 'unreal-sound-cue-time-budget'
      break
    }
    const cue = await readCue(output, asset, signal)
    if (!cue) continue
    if (cue.issue) {
      asset.issues.push(cue.issue)
      summary.incomplete++
      continue
    }
    const outputPath = 'Audio/Cues/' + asset.sourcePath.replace(/\.uasset$/i, '.soundcue.json')
    const waves = linkWaves(cue, path => resolve(path, asset), outputPath)
    const linked = waves.filter(wave => wave.status === 'resolved').length
    const issues = [...cue.issues]
    if (waves.some(wave => wave.status === 'missing')) issues.push('unreal-sound-cue-wave-missing')
    if (waves.some(wave => wave.status === 'unavailable')) issues.push('unreal-sound-cue-wave-unavailable')
    if (!waves.length && !issues.length) issues.push('unreal-sound-cue-no-waves')
    const description = { version: 1, method, converterVersion: sourceSoundCueRevision,
      source: { id: asset.id, path: asset.sourcePath, sha256: asset.hash, ue4: asset.ue4, license: asset.license },
      ...cue, waves, issues }
    const bytes = Buffer.from(JSON.stringify(description, null, 2) + '\n')
    const identity = { status: 'converted', format: 'json', role: 'sound-cue', method, converterVersion: sourceSoundCueRevision,
      from: asset.output, name: cue.name, issues }
    const preflight = await store.preflight(bytes.length)
    if (preflight) {
      asset.exports.push({ ...identity, status: 'failed', issue: preflight })
      summary.issue = preflight
      break
    }
    const temporary = join(scratch, asset.id + '.json')
    await writeFile(temporary, bytes, { flag: 'wx', signal })
    const artifact = await store.save(outputPath, { path: temporary, info: { size: bytes.length } }, identity)
    asset.exports.push(artifact)
    if (!artifact.path) {
      summary.issue = artifact.issue
      break
    }
    summary.graphs++
    summary.linkedWaves += linked
    asset.soundCue = { path: artifact.path, linkedWaves: linked, status: issues.length ? 'partial' : 'ready' }
    if (issues.length) {
      summary.incomplete++
      asset.issues.push(...issues)
    } else {
      summary.ready++
      asset.status = 'converted'
    }
    for (const wave of waves) {
      records.dependencies.push({ source: asset.id, target: wave.target, path: wave.package,
        type: 'unreal-sound-cue-wave', status: wave.status })
    }
  }
  return summary
}
