import { requireLayout } from '../../../engines/unreal/editor-package/tables.mjs'

const componentType = { FLOAT: 5126, UNSIGNED_SHORT: 5123, UNSIGNED_INT: 5125 }
const elementType = ['SCALAR', 'SCALAR', 'VEC2', 'VEC3', 'VEC4']
const maximumVertices = 1_000_000
const maximumTriangles = 1_000_000

function floatAttribute(attributes, name, components, slots) {
  const field = attributes.get(name)
  if (!(field?.values instanceof Float32Array) || field.components !== components ||
      field.values.length !== slots * components) return null
  return field.values
}

function xyz(values, slot) {
  const at = slot * 3
  return [values[at], values[at + 2], values[at + 1]]
}

function unit(vector) {
  const length = Math.hypot(...vector)
  return Number.isFinite(length) && length > 0.000001 ? vector.map(value => value / length) : null
}

function slotMaterial(name, materials) {
  if (!name || name === 'None') return null
  const imported = materials.filter(slot => slot.imported === name)
  if (imported.length) return imported.length === 1 ? imported[0] : null
  const named = materials.filter(slot => slot.name === name)
  return named.length === 1 ? named[0] : null
}

function geometry(data) {
  const { validVertexInstanceIds, validTriangleIds, vertexInstanceVertices, trianglePolygons,
    triangleVertexInstances, polygonGroups, vertexSlots, vertexAttributes, vertexInstanceAttributes } = data
  const count = validVertexInstanceIds.length
  const slots = vertexInstanceVertices.length
  requireLayout(count > 0 && count <= maximumVertices && slots <= maximumVertices &&
    validTriangleIds.length > 0 && validTriangleIds.length <= maximumTriangles)
  const sourcePositions = floatAttribute(vertexAttributes, 'Position', 3, vertexSlots)
  requireLayout(sourcePositions)
  const sourceNormals = floatAttribute(vertexInstanceAttributes, 'Normal', 3, slots)
  const sourceTangents = floatAttribute(vertexInstanceAttributes, 'Tangent', 3, slots)
  const signs = floatAttribute(vertexInstanceAttributes, 'BinormalSign', 1, slots)
  const sourceUV = floatAttribute(vertexInstanceAttributes, 'TextureCoordinate', 2, slots)
  const sourceColor = floatAttribute(vertexInstanceAttributes, 'Color', 4, slots)
  const positions = new Float32Array(count * 3)
  let normals = sourceNormals && new Float32Array(count * 3)
  let tangent = normals && sourceTangents && signs && new Float32Array(count * 4)
  let uv = sourceUV && new Float32Array(count * 2)
  let color = sourceColor && new Float32Array(count * 4)
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  const dense = new Int32Array(slots).fill(-1)
  for (const [index, slot] of validVertexInstanceIds.entries()) {
    dense[slot] = index
    const point = xyz(sourcePositions, vertexInstanceVertices[slot])
    for (let axis = 0; axis < 3; axis++) {
      const value = Math.fround(point[axis] * 0.01) // Unreal centimeters to glTF meters.
      requireLayout(Number.isFinite(value))
      positions[index * 3 + axis] = value
      min[axis] = Math.min(min[axis], value)
      max[axis] = Math.max(max[axis], value)
    }
    if (normals) {
      const normal = unit(xyz(sourceNormals, slot))
      if (normal) normals.set(normal, index * 3)
      else normals = null
    }
    if (tangent) {
      const direction = unit(xyz(sourceTangents, slot))
      if (normals && direction && Math.abs(signs[slot]) === 1) {
        tangent.set([...direction, -signs[slot]], index * 4)
      } else tangent = null
    }
    if (uv) {
      const values = sourceUV.subarray(slot * 2, slot * 2 + 2)
      if (values.every(Number.isFinite)) uv.set(values, index * 2)
      else uv = null
    }
    if (color) {
      const values = sourceColor.subarray(slot * 4, slot * 4 + 4)
      if (values.every(value => value >= 0 && value <= 1)) color.set(values, index * 4)
      else color = null
    }
  }
  const triangles = new Map()
  for (const face of validTriangleIds) {
    const group = polygonGroups[trianglePolygons[face]]
    const start = face * 3
    const a = dense[triangleVertexInstances[start]]
    const b = dense[triangleVertexInstances[start + 1]]
    const c = dense[triangleVertexInstances[start + 2]]
    requireLayout(group >= 0 && a >= 0 && b >= 0 && c >= 0)
    if (!triangles.has(group)) {
      requireLayout(triangles.size < 128)
      triangles.set(group, [])
    }
    // The Y/Z reflection converts Unreal's clockwise faces to glTF's counterclockwise faces.
    triangles.get(group).push(a, b, c)
  }
  return { count, triangles, min, max, fields: { POSITION: positions, NORMAL: normals, TANGENT: tangent,
    TEXCOORD_0: uv, COLOR_0: color } }
}

export function encodeSourceMesh(data, { name, bin, materials: slots }) {
  const { count, triangles, min, max, fields } = geometry(data)
  const parts = []
  const bufferViews = []
  const accessors = []
  const materials = []
  const primitives = []
  const materialPaths = new Set()
  let size = 0
  function append(values, components, type, target, bounds) {
    const bytes = Buffer.from(values.buffer, values.byteOffset, values.byteLength)
    const index = bufferViews.length
    bufferViews.push({ buffer: 0, byteOffset: size, byteLength: bytes.length, target })
    accessors.push({ bufferView: index, componentType: type, count: values.length / components,
      type: elementType[components], ...bounds })
    parts.push(bytes)
    size += bytes.length
    const padding = (4 - size % 4) % 4
    if (padding) parts.push(Buffer.alloc(padding))
    size += padding
    return index
  }
  const attributes = {}
  for (const [semantic, values] of Object.entries(fields)) {
    if (!values) continue
    attributes[semantic] = append(values, values.length / count, componentType.FLOAT, 34962,
      semantic === 'POSITION' ? { min, max } : undefined)
  }
  const labels = data.polygonGroupAttributes.get('ImportedMaterialSlotName')?.values
  for (const [group, indices] of triangles) {
    const label = Array.isArray(labels) ? labels[group] : null
    const path = slotMaterial(label, slots)?.path
    const material = materials.length
    if (path) materialPaths.add(path)
    materials.push({ name: label || 'Section ' + group, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.5 },
      ...(path && { extras: { unrealMaterial: path } }) })
    const wide = count > 65536
    const accessor = append(wide ? Uint32Array.from(indices) : Uint16Array.from(indices), 1,
      wide ? componentType.UNSIGNED_INT : componentType.UNSIGNED_SHORT, 34963)
    primitives.push({ attributes, indices: accessor, material })
  }
  const document = { asset: { version: '2.0', generator: 'Asset Viewer Unreal source mesh' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name }], meshes: [{ name, primitives }],
    materials, accessors, bufferViews, buffers: [{ uri: bin, byteLength: size }] }
  // allocUnsafeSlow keeps the backing buffer transferable even for small meshes.
  const buffer = Buffer.allocUnsafeSlow(size)
  let offset = 0
  for (const part of parts) offset += part.copy(buffer, offset)
  return { document, buffer, materialPaths: [...materialPaths] }
}
