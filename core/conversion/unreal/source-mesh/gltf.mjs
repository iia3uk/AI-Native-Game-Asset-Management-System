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

function perpendicular([x, y, z]) {
  return unit(Math.abs(x) < 0.9 ? [0, z, -y] : [-z, 0, x])
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
  const sourceUVs = data.uvs ?? (sourceUV ? [{ values: sourceUV }] : [])
  const sourceColor = floatAttribute(vertexInstanceAttributes, 'Color', 4, slots)
  const [xScale, yScale, zScale] = data.buildScale ?? [1, 1, 1]
  const scale = [xScale, zScale, yScale]
  const reverse = xScale * yScale * zScale < 0
  const positions = new Float32Array(count * 3)
  let normals = sourceNormals && new Float32Array(count * 3)
  let tangent = normals && sourceTangents && signs && new Float32Array(count * 4)
  let validTangents = 0
  const uvs = sourceUVs.map(() => new Float32Array(count * 2))
  let color = sourceColor && new Float32Array(count * 4)
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  const dense = new Int32Array(slots).fill(-1)
  for (const [index, slot] of validVertexInstanceIds.entries()) {
    dense[slot] = index
    const point = xyz(sourcePositions, vertexInstanceVertices[slot])
    for (let axis = 0; axis < 3; axis++) {
      const value = Math.fround(point[axis] * scale[axis] * 0.01) + 0 // Unreal centimeters to glTF meters.
      requireLayout(Number.isFinite(value))
      positions[index * 3 + axis] = value
      min[axis] = Math.min(min[axis], value)
      max[axis] = Math.max(max[axis], value)
    }
    if (normals) {
      const normal = unit(xyz(sourceNormals, slot).map((value, axis) => value / scale[axis]))
      if (normal) normals.set(normal, index * 3)
      else normals = null
    }
    if (tangent) {
      const direction = unit(xyz(sourceTangents, slot).map((value, axis) => value * scale[axis]))
      if (normals && direction && Math.abs(signs[slot]) === 1) {
        tangent.set([...direction, reverse ? signs[slot] : -signs[slot]], index * 4)
        validTangents++
      } else if (normals && data.rawMesh) {
        tangent.set([...perpendicular(normals.subarray(index * 3, index * 3 + 3)), 1], index * 4)
      } else tangent = null
    }
    for (let channel = 0; channel < uvs.length; channel++) {
      if (!uvs[channel]) continue
      const values = sourceUVs[channel].values.subarray(slot * 2, slot * 2 + 2)
      if (values.every(Number.isFinite)) uvs[channel].set(values, index * 2)
      else uvs[channel] = null
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
      triangles.set(group, { indices: [], masks: data.smoothing?.length ? [] : null })
    }
    const { indices, masks } = triangles.get(group)
    // The Y/Z reflection converts clockwise faces to counterclockwise faces. A negative build scale can reverse it.
    indices.push(a, reverse ? c : b, reverse ? b : c)
    masks?.push(data.smoothing[face])
  }
  const fields = { POSITION: positions, NORMAL: normals, TANGENT: validTangents ? tangent : null, COLOR_0: color }
  for (const [channel, uv] of uvs.entries()) fields['TEXCOORD_' + channel] = uv
  return { count, triangles, min, max, fields, missingTangents: tangent && validTangents ? count - validTangents : 0 }
}

export function encodeSourceMesh(data, { name, bin, materials: slots, generator = 'Asset Viewer Unreal source mesh' }) {
  const { count, triangles, min, max, fields, missingTangents } = geometry(data)
  const parts = []
  const bufferViews = []
  const accessors = []
  const materials = []
  const primitives = []
  const materialPaths = new Set()
  let size = 0
  function appendView(values, target) {
    const bytes = Buffer.from(values.buffer, values.byteOffset, values.byteLength)
    const index = bufferViews.length
    bufferViews.push({ buffer: 0, byteOffset: size, byteLength: bytes.length, ...(target && { target }) })
    parts.push(bytes)
    size += bytes.length
    const padding = (4 - size % 4) % 4
    if (padding) parts.push(Buffer.alloc(padding))
    size += padding
    return index
  }
  function append(values, components, type, target, bounds) {
    const bufferView = appendView(values, target)
    return accessors.push({ bufferView, componentType: type, count: values.length / components,
      type: elementType[components], ...bounds }) - 1
  }
  const attributes = {}
  for (const [semantic, values] of Object.entries(fields)) {
    if (!values) continue
    attributes[semantic] = append(values, values.length / count, componentType.FLOAT, 34962,
      semantic === 'POSITION' ? { min, max } : undefined)
  }
  const labels = data.polygonGroupAttributes?.get('ImportedMaterialSlotName')?.values
  for (const [group, { indices, masks }] of triangles) {
    const section = data.sections?.[group]
    const slot = section ?? (data.rawMesh ? slots[group] : null)
    const label = slot ? slot.name : Array.isArray(labels) ? labels[group] : null
    const path = slot ? slot.path : slotMaterial(label, slots)?.path
    const material = materials.length
    if (path) materialPaths.add(path)
    const importIndex = data.importIndices?.[group]
    const extras = { ...(path && { unrealMaterial: path }), ...(section && { unrealMaterialSlot: section.slot }),
      ...(data.rawMesh && { unrealMaterialSlot: group }),
      ...(importIndex !== undefined && { unrealImportMaterialIndex: importIndex }) }
    materials.push({ name: label && (!data.rawMesh || label !== 'None') ? label : 'Section ' + group,
      pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.5 },
      ...(Object.keys(extras).length && { extras }) })
    const wide = count > 65536
    const accessor = append(wide ? Uint32Array.from(indices) : Uint16Array.from(indices), 1,
      wide ? componentType.UNSIGNED_INT : componentType.UNSIGNED_SHORT, 34963)
    const smoothingMasks = masks && appendView(Uint32Array.from(masks))
    primitives.push({ attributes, indices: accessor, material,
      ...(masks && { extras: { unrealFaceSmoothingMasks: { bufferView: smoothingMasks, componentType: 5125 } } }),
      ...(section && { extras: { unrealSection: group, unrealCollisionEnabled: section.collision } }) })
  }
  const tangentAxes = {}
  for (const [axis, values] of Object.entries(data.rawTangentAxes ?? {})) {
    if (values.length) tangentAxes[axis] = appendView(values)
  }
  const unrealRawMesh = data.rawMesh && { ...data.rawMesh,
    ...(Object.keys(tangentAxes).length && { tangentAxes: { ...tangentAxes, componentType: 5126 } }),
    ...(missingTangents > 0 && { generatedTangentCorners: missingTangents }) }
  const document = { asset: { version: '2.0', generator }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name }], meshes: [{ name, primitives,
      ...(unrealRawMesh && { extras: { unrealRawMesh } }) }],
    materials, accessors, bufferViews, buffers: [{ uri: bin, byteLength: size }] }
  // allocUnsafeSlow keeps the backing buffer transferable even for small meshes.
  const buffer = Buffer.allocUnsafeSlow(size)
  let offset = 0
  for (const part of parts) offset += part.copy(buffer, offset)
  return { document, buffer, materialPaths: [...materialPaths] }
}
