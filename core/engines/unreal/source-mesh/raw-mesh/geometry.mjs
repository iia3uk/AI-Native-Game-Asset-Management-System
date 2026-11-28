import { requireLayout } from '../../editor-package/tables.mjs'

const maximumCorners = 1_000_000
const maximumFaces = Math.floor(maximumCorners / 3)
const maximumMaterials = 128
const uvChannelCount = 8

function tangentSigns(x, y, z) {
  const signs = new Float32Array(x.length / 3)
  for (let index = 0; index < signs.length; index++) {
    const at = index * 3
    const crossX = z[at + 1] * x[at + 2] - z[at + 2] * x[at + 1]
    const crossY = z[at + 2] * x[at] - z[at] * x[at + 2]
    const crossZ = z[at] * x[at + 1] - z[at + 1] * x[at]
    signs[index] = Math.sign(crossX * y[at] + crossY * y[at + 1] + crossZ * y[at + 2])
  }
  return signs
}

export function parseRawMesh(input, settings = {}) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  requireLayout(bytes.length >= 8 && bytes.readInt32LE(0) === 1 && bytes.readInt32LE(4) === 0)
  let cursor = 8
  function array(rows, components, read, width = 4) {
    requireLayout(cursor + 4 <= bytes.length)
    const count = bytes.readInt32LE(cursor)
    cursor += 4
    const length = count * components
    const end = cursor + length * width
    requireLayout(count >= 0 && count <= rows && end <= bytes.length)
    const values = read(bytes, cursor, length)
    cursor = end
    return values
  }

  const signed = (data, at, length) => Int32Array.from({ length }, (_, index) => data.readInt32LE(at + index * 4))
  const unsigned = (data, at, length) => Uint32Array.from({ length }, (_, index) => data.readUInt32LE(at + index * 4))
  const floats = (data, at, length) => Float32Array.from({ length }, (_, index) => data.readFloatLE(at + index * 4))
  const groups = array(maximumFaces, 1, signed)
  const smoothing = array(maximumFaces, 1, unsigned)
  const positions = array(maximumCorners, 3, floats)
  const corners = array(maximumCorners, 1, unsigned)
  const faceCount = corners.length / 3
  const vertexCount = positions.length / 3
  requireLayout(corners.length > 0 && corners.length % 3 === 0 && vertexCount > 0 &&
    groups.length === faceCount && groups.every(group => group >= 0 && group < maximumMaterials) &&
    (!smoothing.length || smoothing.length === faceCount) && corners.every(index => index < vertexCount) &&
    positions.every(Number.isFinite))
  function optionalAttribute(components) {
    const values = array(corners.length, components, floats)
    requireLayout(!values.length || (values.length === corners.length * components && values.every(Number.isFinite)))
    return values
  }
  const tangentX = optionalAttribute(3)
  const tangentY = optionalAttribute(3)
  const tangentZ = optionalAttribute(3)
  const uvs = []
  for (let channel = 0; channel < uvChannelCount; channel++) {
    const values = optionalAttribute(2)
    if (values.length) uvs.push({ channel, values })
  }
  const bgra = [2, 1, 0, 3]
  const colors = array(corners.length, 4, (data, at, length) => Float32Array.from({ length },
    (_, index) => data[at + (index & ~3) + bgra[index % 4]] / 255), 1)
  const importIndices = array(maximumMaterials, 1, signed)
  requireLayout(cursor === bytes.length && (!colors.length || colors.length === corners.length * 4))
  const vertexInstanceAttributes = new Map()
  if (tangentZ.length) vertexInstanceAttributes.set('Normal', { components: 3, values: tangentZ })
  if (tangentX.length && tangentY.length && tangentZ.length) {
    vertexInstanceAttributes.set('Tangent', { components: 3, values: tangentX })
    vertexInstanceAttributes.set('BinormalSign', { components: 1, values: tangentSigns(tangentX, tangentY, tangentZ) })
  }
  if (colors.length) vertexInstanceAttributes.set('Color', { components: 4, values: colors })

  // A raw wedge is one vertex instance and every wedge belongs to exactly one face.
  const wedges = Uint32Array.from({ length: corners.length }, (_, index) => index)
  const faces = Uint32Array.from({ length: faceCount }, (_, index) => index)
  return {
    validVertexInstanceIds: wedges, validTriangleIds: faces, vertexSlots: vertexCount,
    vertexInstanceVertices: corners, triangleVertexInstances: wedges, trianglePolygons: faces, polygonGroups: groups,
    vertexAttributes: new Map([['Position', { components: 3, values: positions }]]), vertexInstanceAttributes,
    uvs, buildScale: settings.scale, smoothing, importIndices, rawTangentAxes: { x: tangentX, y: tangentY },
    rawMesh: { format: 'FRawMesh', version: 1, settings, uvChannels: uvs.map(({ channel }) => channel) },
  }
}
