import { encodeSourceMesh } from '../source-mesh/gltf.mjs'

export function encodeCookedMesh(bytes, product, name) {
  const { vertices, colors, uvs, indices, sections } = product
  if (bytes.length !== product.size) return null
  const vertexIds = new Int32Array(vertices)
  const positions = new Float32Array(vertices * 3)
  const normals = new Float32Array(vertices * 3)
  const tangents = new Float32Array(vertices * 3)
  const signs = new Float32Array(vertices)
  const color = colors && new Float32Array(vertices * 4)
  const uv = Array.from({ length: uvs }, () => ({ values: new Float32Array(vertices * 2) }))
  let offset = 0
  function readFloat() {
    const value = bytes.readFloatLE(offset)
    offset += 4
    if (!Number.isFinite(value)) throw new RangeError('Invalid cooked mesh vertex attribute')
    return value
  }
  for (let index = 0; index < vertices; index++) {
    vertexIds[index] = index
    for (const field of [positions, normals, tangents]) {
      for (let axis = 0; axis < 3; axis++) field[index * 3 + axis] = readFloat()
    }
    signs[index] = readFloat()
    if (Math.abs(signs[index]) !== 1) return null
    for (const { values } of uv) {
      values[index * 2] = readFloat()
      values[index * 2 + 1] = readFloat()
    }
    if (color) for (let channel = 0; channel < 4; channel++) color[index * 4 + channel] = bytes[offset++] / 255
  }
  const triangleCount = sections.reduce((sum, section) => sum + section.triangles, 0)
  const triangles = new Int32Array(triangleCount)
  const groups = new Int32Array(triangleCount)
  const corners = new Int32Array(triangleCount * 3)
  const firstIndex = offset
  let face = 0
  for (const [group, section] of sections.entries()) {
    for (let start = section.firstIndex; start < section.endIndex; start += 3) {
      triangles[face] = face
      groups[face] = group
      for (let corner = 0; corner < 3; corner++) {
        const vertex = bytes.readUInt32LE(firstIndex + (start + corner) * 4)
        if (vertex >= vertices) return null
        corners[face * 3 + corner] = vertex
      }
      face++
    }
  }
  if (firstIndex + indices * 4 !== bytes.length) return null
  const vertexInstanceAttributes = new Map([
    ['Normal', { components: 3, values: normals }],
    ['Tangent', { components: 3, values: tangents }],
    ['BinormalSign', { components: 1, values: signs }],
    ...(color ? [['Color', { components: 4, values: color }]] : []),
  ])
  return encodeSourceMesh({ validVertexInstanceIds: vertexIds, validTriangleIds: triangles, vertexInstanceVertices: vertexIds,
    trianglePolygons: triangles, triangleVertexInstances: corners, polygonGroups: groups, vertexSlots: vertices,
    vertexAttributes: new Map([['Position', { components: 3, values: positions }]]), vertexInstanceAttributes, uvs: uv,
    sections: sections.map(section => ({ ...section, path: section.material })) },
  { name, bin: name + '.bin', materials: [], generator: 'Asset Viewer Unreal cooked static mesh' })
}
