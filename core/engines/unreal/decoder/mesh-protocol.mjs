export const looseMeshRevision = 1
const MiB = 1024 ** 2
const issueCode = value => typeof value === 'string' && /^unreal-[a-z0-9-]{1,70}$/.test(value)
const natural = (value, min, max) => Number.isInteger(value) && value >= min && value <= max
const lodIndex = value => natural(value, 0, 7)
const control = /[\x00-\x1f\x7f-\x9f]/u
const boundedText = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max && !control.test(value)
const packagePath = value => boundedText(value, 320) && value.startsWith('/') &&
  value.slice(1).split('/').every(part => part && part !== '.' && part !== '..' && !part.includes('\\'))

function meshLod(row, prefix) {
  if (!lodIndex(row?.lod) || !natural(row.vertices, 3, 1_000_000) || !natural(row.indices, 3, 3_000_000) ||
      !natural(row.uvs, 1, 8) || typeof row.colors !== 'boolean' || typeof row.tangentsQuantized !== 'boolean' ||
      !Array.isArray(row.sections) || !natural(row.sections.length, 1, 128) ||
      row.size !== row.vertices * (40 + row.uvs * 8 + (row.colors ? 4 : 0)) + row.indices * 4 ||
      row.size > 96 * MiB) return null
  const sections = []
  for (const section of row.sections) {
    if (!natural(section?.slot, 0, 127) || !natural(section.firstIndex, 0, row.indices - 3) ||
        section.firstIndex % 3 || !natural(section.triangles, 1, 1_000_000) || typeof section.collision !== 'boolean' ||
        (section.name !== null && !boundedText(section.name, 128)) ||
        (section.material !== null && !packagePath(section.material))) return null
    const endIndex = section.firstIndex + 3 * section.triangles
    if (endIndex > row.indices || sections.some(other => section.firstIndex < other.endIndex && other.firstIndex < endIndex)) return null
    const { slot, firstIndex, triangles, name, material, collision } = section
    sections.push({ slot, firstIndex, endIndex, triangles, name, material, collision })
  }
  const { lod, vertices, indices, uvs, colors, size, tangentsQuantized } = row
  return { lod, vertices, indices, uvs, colors, size, tangentsQuantized, sections, file: prefix + '-' + lod + '.mesh' }
}

export function looseMeshResult(raw, count) {
  if (raw?.protocol !== 1) return null
  if (raw.status === 'failed' && issueCode(raw.issue)) return { status: 'failed', issue: raw.issue }
  if (raw.status !== 'completed' || raw.meshDecoder !== looseMeshRevision || !Array.isArray(raw.entries) ||
      raw.entries.length !== count) return null
  const entries = []
  let bytes = 0
  for (const [index, row] of raw.entries.entries()) {
    if (row?.index !== index || (row.issue !== null && (!issueCode(row.issue) || !row.issue.startsWith('unreal-cooked-mesh-')))) return null
    if (row.mesh === null) {
      entries.push({ issue: row.issue })
      continue
    }
    const { lods, missing } = row.mesh ?? {}
    if (row.issue || !Array.isArray(lods) || !Array.isArray(missing) || !natural(lods.length, 1, 8) ||
        lods.length + missing.length > 8 || !missing.every(lodIndex)) return null
    const levels = new Set(missing)
    if (levels.size !== missing.length) return null
    const products = []
    for (const lod of lods) {
      const product = meshLod(lod, String(index).padStart(5, '0'))
      if (!product || levels.has(product.lod)) return null
      levels.add(product.lod)
      bytes += product.size
      if (bytes > 256 * MiB) return null
      products.push(product)
    }
    if ([...levels].some(level => level >= levels.size)) return null
    entries.push({ lods: products, missing })
  }
  return { status: 'completed', entries }
}
