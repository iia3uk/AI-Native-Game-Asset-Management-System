import { taggedProperties } from '../editor-package/properties.mjs'
import { importedGameObject, softGameObject } from '../editor-package/references.mjs'
import { editorPackage, requireLayout } from '../editor-package/tables.mjs'
import { cueArray, cueObjectIndex, cueSettings } from './cue-properties.mjs'

export const sourceSoundCueRevision = 1
export const soundCueFileLimit = 2 * 1024 ** 2
export const soundCueVersions = new Set([518, 522])
const cues = new Set(['SoundCue'])
const waves = new Set(['SoundWave'])
const cueFields = {
  Duration: 'FloatProperty', MaxDistance: 'FloatProperty', VolumeMultiplier: 'FloatProperty',
  PitchMultiplier: 'FloatProperty', bOverrideAttenuation: 'BoolProperty',
}
const nodeFields = new Map([
  ['SoundNodeWavePlayer', { bLooping: 'BoolProperty' }],
  ['SoundNodeRandom', { Weights: 'ArrayProperty', bRandomizeWithoutReplacement: 'BoolProperty',
    PreselectAtLevelLoad: 'IntProperty' }],
  ['SoundNodeDelay', { DelayMin: 'FloatProperty', DelayMax: 'FloatProperty' }],
])

function importWaves(table) {
  const paths = new Set()
  for (let index = -1; table.imported(index); index--) {
    const path = importedGameObject(table.imported, index, waves)
    if (path) paths.add(path)
  }
  return paths
}

function wavePath(bytes, table, properties, paths) {
  const soft = properties.get('SoundWaveAssetPtr')
  const hard = properties.get('SoundWave')
  const index = hard ? cueObjectIndex(bytes, hard) : 0
  const hardPath = index ? importedGameObject(table.imported, index, waves) : null
  if (!soft) return hardPath
  if (soft.type !== 'SoftObjectProperty' || soft.size !== 12 || bytes.readInt32LE(soft.start + 8) !== 0) return null
  const path = softGameObject(table.nameAt(soft.start))
  return path && paths.has(path) && (!index || path === hardPath) ? path : null
}

function cueGraph(bytes, table, cue) {
  const { properties } = taggedProperties(bytes, cue.start, cue.end, table.nameAt)
  const first = properties.get('FirstNode')
  const root = first ? cueObjectIndex(bytes, first) : 0
  const settings = cueSettings(bytes, properties, cueFields)
  const paths = importWaves(table)
  const nodes = new Map()
  const visited = new Set()
  const issues = new Set()

  function addNode(index, depth) {
    requireLayout(index > 0 && depth <= 64 && !visited.has(index))
    if (nodes.has(index)) return
    requireLayout(nodes.size < 256)
    const node = table.exported(index)
    requireLayout(node?.type.startsWith('SoundNode') && node.outer === cue.index)
    const { properties: tags } = taggedProperties(bytes, node.start, node.end, table.nameAt)
    const childNodes = tags.has('ChildNodes') ? cueArray(bytes, tags.get('ChildNodes'), 'ObjectProperty') : []
    const fields = nodeFields.get(node.type)
    const data = { id: index, type: node.type, name: node.name, children: childNodes.map(child => child || null) }
    if (fields) data.settings = cueSettings(bytes, tags, fields)
    else issues.add('unreal-sound-cue-unsupported-node')
    if (node.type === 'SoundNodeWavePlayer') {
      requireLayout(childNodes.every(child => child === 0))
      data.wave = wavePath(bytes, table, tags, paths)
      if (!data.wave) issues.add('unreal-sound-cue-wave-reference')
    }
    if (data.settings?.Weights) requireLayout(data.settings.Weights.length === childNodes.length)
    nodes.set(index, data)
    visited.add(index)
    for (const child of childNodes) if (child) addNode(child, depth + 1)
    visited.delete(index)
  }

  if (root) addNode(root, 0)
  else issues.add('unreal-sound-cue-no-root')
  if (properties.has('AttenuationSettings') || properties.has('AttenuationOverrides') ||
      properties.has('SoundClassObject') || settings.bOverrideAttenuation) issues.add('unreal-sound-cue-external-settings')
  return { name: cue.name, root: root || null, settings, nodes: [...nodes.values()], issues: [...issues] }
}

export function readSourceSoundCue(bytes, version) {
  if (!soundCueVersions.has(version) || bytes.length > soundCueFileLimit) return null
  const table = editorPackage(bytes, version)
  const cue = table?.topLevel(cues)
  if (!cue) return null
  try {
    return cueGraph(bytes, table, cue)
  } catch (error) {
    if (!(error instanceof RangeError)) throw error
    return { issue: 'unreal-sound-cue-layout' }
  }
}
