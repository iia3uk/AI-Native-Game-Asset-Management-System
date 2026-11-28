import { posix } from 'node:path'
import { validPackageSegment } from '../../packages/source.mjs'

const groups = new Set(['TextureParameterValues', 'CollectedTextureParameters', 'ScalarParameterValues', 'CollectedScalarParameters'])
const number = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i
const identifier = /^[\p{L}\p{N}_][\p{L}\p{N}_ -]{0,127}$/u

function reference(value, classes) {
  const match = /^(\w+)'([^']+)'$/.exec(value ?? '')
  if (!match || !classes.includes(match[1])) return null
  const [path, object, extra] = match[2].replace(/^\/Game\//i, '').split('.')
  if (extra !== undefined || !object || object !== posix.basename(path) ||
      path.split('/').some(segment => !validPackageSegment(segment))) return null
  return path + '.uasset'
}

export function viewerMaterialProperties(text) {
  const textures = []
  const scalars = []
  let parent = null
  let group = null
  let row = null
  const record = () => {
    if (!row || row.group !== group) return
    const name = [row.ParameterName, row.Name, row.ParameterInfo?.match(/\bName=([^,}]+)/)?.[1]?.trim()]
      .find(value => value && value !== 'None' && identifier.test(value))
    const value = row.ParameterValue ?? row.Texture ?? row.Value
    if (!name || !value) return
    const path = reference(value, ['Texture2D'])
    if (path && /Texture/.test(group) && textures.length < 256) textures.push({ name, path })
    if (number.test(value) && /Scalar/.test(group) && Number.isFinite(Number(value)) && scalars.length < 256) {
      scalars.push({ name, value: Number(value) })
    }
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    if (/^\w/.test(line)) {
      const key = /^(\w+)\[/.exec(line)?.[1]
      group = groups.has(key) ? key : null
      row = null
      if (line.startsWith('Parent = ')) parent = reference(line.slice(9).trim(), ['Material', 'Material3', 'MaterialInstanceConstant'])
      continue
    }
    if (!group) continue
    const item = /^ {4}(\w+)\[\d+\]\s*=\s*(?:\{(.*)\})?\s*$/.exec(line)
    if (item) {
      row = { group }
      if (item[2]) {
        for (const field of item[2].split(',')) {
          const match = /^\s*(Name|Value)\s*=\s*(.+?)\s*$/.exec(field)
          if (match) row[match[1]] = match[2]
        }
        record()
        row = null
      }
    } else if (line === '    }') {
      record()
      row = null
    } else if (row) {
      const field = /^ {8}(ParameterInfo|ParameterName|ParameterValue|Name|Value|Texture)\s*=\s*(.+?)\s*$/.exec(line)
      if (field) row[field[1]] = field[2]
    }
  }
  return { parent, textures, scalars }
}

export function viewerMaterialSlots(text) {
  const slots = Object.create(null)
  for (const line of text.split(/\r?\n/)) {
    const field = /^([A-Za-z]+(?:\[\d{1,4}\])?)=(.{1,255})$/.exec(line)
    if (!field || !validPackageSegment(field[2]) || Object.keys(slots).length >= 256) continue
    slots[field[1]] = Object.hasOwn(slots, field[1]) ? null : field[2]
  }
  return slots
}
