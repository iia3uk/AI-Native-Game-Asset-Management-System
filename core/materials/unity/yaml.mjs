const materialHeader = /^--- !u!21 &(-?\d{1,20})(?:[ \t]+stripped)?[ \t]*\r?\nMaterial:[ \t]*$/m
const numberPattern = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i
export const unquote = value => value.trim().replace(/^(['"])(.*)\1$/, '$2')

export function unityReference(mapping) {
  const fileID = mapping?.match(/[{,][ \t]*fileID:[ \t]*(-?\d{1,20})(?=[ \t]*[,}])/)?.[1]
  if (!fileID) return null
  const guid = mapping.match(/[{,][ \t]*guid:[ \t]*([a-f\d]{32})(?=[ \t]*[,}])/i)?.[1]?.toLowerCase()
  return { fileID, guid: guid ?? null }
}

const finite = value => numberPattern.test(value) && Number.isFinite(Number(value)) ? Number(value) : null
const mappingNumber = (value, key) => finite(value.match(new RegExp(`[{,][ \\t]*${key}:[ \\t]*([^,}]+)`))?.[1]?.trim() ?? '')

function vector(value, keys) {
  const result = keys.map(key => mappingNumber(value, key))
  return result.every(Number.isFinite) ? result : null
}

function field(body, key) {
  return body.match(new RegExp(`^  ${key}:[ \\t]*([^\\r\\n]*)`, 'm'))?.[1]?.trim()
}

function collection(body, key) {
  const header = new RegExp(`^( +)${key}:[ \\t]*\\r?\\n`, 'm').exec(body)
  if (!header) return ''
  const rest = body.slice(header.index + header[0].length)
  const end = new RegExp(`^ {0,${header[1].length}}[^\\t\\r\\n -]`, 'm').exec(rest)
  return end ? rest.slice(0, end.index) : rest
}

export function parseUnityMaterial(source, { legacy = false } = {}) {
  const header = materialHeader.exec(source)
  if (!header && !legacy) return null
  const start = header ? header.index + header[0].length : 0
  const body = source.slice(start).split(/^--- !u!/m, 1)[0]
  if (!header && !/^Material:[ \t]*\r?$/m.test(body)) return null
  const textureSection = collection(body, 'm_TexEnvs')
  const textures = []
  for (const [, property, fields] of textureSection.matchAll(/^ +-[ \t]+([\w.-]{1,128}):[ \t]*\r?\n((?:[ \t]+m_(?:Texture|Scale|Offset):[^\r\n]*(?:\r?\n|$))+)/gm)) {
    const getField = name => fields.match(new RegExp(`m_${name}:[ \\t]*([^\\r\\n]+)`))?.[1] ?? ''
    textures.push({ property, reference: unityReference(getField('Texture')),
      scale: vector(getField('Scale'), ['x', 'y']), offset: vector(getField('Offset'), ['x', 'y']) })
  }

  const numberEntries = []
  for (const section of ['m_Ints', 'm_Floats']) {
    for (const [, key, value] of collection(body, section).matchAll(/^ +-[ \t]+([\w.-]{1,128}):[ \t]*([^\r\n]+)/gm)) {
      const number = finite(value.trim())
      if (number !== null) numberEntries.push([key, number])
    }
  }
  const colorEntries = []
  for (const [, key, value] of collection(body, 'm_Colors').matchAll(/^ +-[ \t]+([\w.-]{1,128}):[ \t]*(\{[^\r\n]+\})/gm)) {
    const color = vector(value, ['r', 'g', 'b', 'a'])
    if (color) colorEntries.push([key, color])
  }
  const keywords = new Set((field(body, 'm_ShaderKeywords') ?? '').match(/[A-Z][A-Z\d_]{1,127}|_[A-Z][A-Z\d_]{1,127}/g) ?? [])
  for (const [, keyword] of collection(body, 'm_ValidKeywords').matchAll(/^ +-[ \t]+([\w]{1,128})[ \t]*\r?$/gm)) keywords.add(keyword)
  return {
    name: unquote(field(body, 'm_Name') ?? ''), fileID: header?.[1] ?? null,
    shader: unityReference(field(body, 'm_Shader')),
    parent: unityReference(field(body, 'm_Parent')),
    textures, numbers: Object.fromEntries(numberEntries),
    colors: Object.fromEntries(colorEntries), keywords: [...keywords],
  }
}
