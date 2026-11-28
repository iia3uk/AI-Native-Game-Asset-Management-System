import { nativeStructArray, structArray, taggedProperties } from '../editor-package/properties.mjs'
import { requireLayout } from '../editor-package/tables.mjs'
import { convexHullIndices } from './convex-hull.mjs'

const fields = new Map([
  ['BoxElems', ['KBoxElem', 'box']],
  ['SphereElems', ['KSphereElem', 'sphere']],
  ['SphylElems', ['KSphylElem', 'capsule']],
  ['ConvexElems', ['KConvexElem', 'convex']],
])
const maxShapes = 128
const maxVertices = 256
const maxIndices = 1536
const maximumComponent = 1e8

function floats(bytes, start, count) {
  const values = Array.from({ length: count }, (_, index) => bytes.readFloatLE(start + index * 4))
  requireLayout(values.every(value => Math.abs(value) <= maximumComponent))
  return values
}

function taggedVector(bytes, field, type, defaults) {
  if (!field) return defaults
  requireLayout(field.type === 'StructProperty' && field.inner === type && field.size === defaults.length * 4)
  return floats(bytes, field.start, defaults.length)
}

function scalar(bytes, field, minimum, fallback) {
  if (!field && fallback !== undefined) return fallback
  requireLayout(field?.type === 'FloatProperty' && field.size === 4)
  const [value] = floats(bytes, field.start, 1)
  requireLayout(value >= minimum)
  return value
}

function nameValue(field, nameAt, type, inner = null) {
  if (!field) return undefined
  requireLayout(field.type === type && field.inner === inner && field.size === 8)
  return nameAt(field.start)
}

function booleanValue(field) {
  if (!field) return undefined
  requireLayout(field.type === 'BoolProperty' && field.size === 0 && (field.value === 0 || field.value === 1))
  return Boolean(field.value)
}

function structProperties(bytes, field, nameAt, type) {
  requireLayout(field.type === 'StructProperty' && field.inner === type)
  const tags = taggedProperties(bytes, field.start, field.end, nameAt)
  requireLayout(tags.end === field.end)
  return tags.properties
}

function convex(bytes, row, nameAt, deriveHull) {
  const { count, start } = nativeStructArray(bytes, row.get('VertexData'), nameAt, 'Vector', 12, maxVertices)
  requireLayout(count >= 4)
  const vertices = Array.from({ length: count }, (_, index) => floats(bytes, start + index * 12, 3))
  const faces = row.get('IndexData')
  const generated = deriveHull && !faces
  let indices
  if (generated) indices = convexHullIndices(vertices)
  else {
    requireLayout(faces?.type === 'ArrayProperty' && faces.inner === 'IntProperty' && faces.size >= 4)
    const length = bytes.readInt32LE(faces.start)
    requireLayout(length >= 12 && length <= maxIndices && length % 3 === 0 && 4 + length * 4 === faces.size)
    indices = Array.from({ length }, (_, index) => bytes.readInt32LE(faces.start + 4 + index * 4))
    requireLayout(indices.every(index => index >= 0 && index < count))
  }
  const transform = row.get('Transform')
  const properties = transform ? structProperties(bytes, transform, nameAt, 'Transform') : new Map()
  const rotation = taggedVector(bytes, properties.get('Rotation'), 'Quat', [0, 0, 0, 1])
  const translation = taggedVector(bytes, properties.get('Translation'), 'Vector', [0, 0, 0])
  const scale = taggedVector(bytes, properties.get('Scale3D'), 'Vector', [1, 1, 1])
  requireLayout(Math.abs(Math.hypot(...rotation) - 1) <= 0.001 &&
    scale.every(value => Math.abs(value) >= 1e-6 && Math.abs(value) <= 1e4))
  return { vertices, indices, ...(generated && { indexSource: 'convex-hull' }), transform: { rotation, translation, scale } }
}

function primitive(bytes, row, type) {
  const center = taggedVector(bytes, row.get('Center'), 'Vector', [0, 0, 0])
  if (type === 'sphere') return { center, radius: scalar(bytes, row.get('Radius'), 1e-6) }
  const rotation = taggedVector(bytes, row.get('Rotation'), 'Rotator', [0, 0, 0])
  if (type === 'box') return { center, rotation, dimensions: ['X', 'Y', 'Z'].map(axis => scalar(bytes, row.get(axis), 1e-6)) }
  return { center, rotation, radius: scalar(bytes, row.get('Radius'), 1e-6), length: scalar(bytes, row.get('Length'), 0) }
}

function parseShape(bytes, row, type, nameAt, deriveHull) {
  const data = type === 'convex' ? convex(bytes, row, nameAt, deriveHull) : primitive(bytes, row, type)
  return { type, ...data, name: nameValue(row.get('Name'), nameAt, 'NameProperty'),
    collisionEnabled: nameValue(row.get('CollisionEnabled'), nameAt, 'ByteProperty', 'ECollisionEnabled'),
    restOffset: scalar(bytes, row.get('RestOffset'), -maximumComponent, 0),
    generated: booleanValue(row.get('bIsGenerated')), contributesToMass: booleanValue(row.get('bContributeToMass')) }
}

export function ownedBodySetup(mesh, bodyIndex) {
  const body = mesh.exported(bodyIndex)
  requireLayout(body?.type === 'BodySetup' && body.outer === mesh.index &&
    (body.end <= mesh.start || body.start >= mesh.end))
  return body
}

export function readBodySetup(bytes, body, nameAt, { deriveHull = false } = {}) {
  const { properties } = taggedProperties(bytes, body.start, body.end, nameAt)
  const traceMode = nameValue(properties.get('CollisionTraceFlag'), nameAt, 'ByteProperty', 'ECollisionTraceFlag')
  const doubleSided = booleanValue(properties.get('bDoubleSidedGeometry'))
  const buildScale = taggedVector(bytes, properties.get('BuildScale3D'), 'Vector', [1, 1, 1])
  const aggregate = properties.get('AggGeom')
  const shapes = []
  const omitted = []
  const arrays = aggregate ? structProperties(bytes, aggregate, nameAt, 'KAggregateGeom') : new Map()
  let remaining = maxShapes
  for (const [field, tag] of arrays) {
    const info = fields.get(field)
    if (!info) {
      if (tag.type !== 'ArrayProperty' || tag.size < 4 || bytes.readInt32LE(tag.start) !== 0) omitted.push({ field })
      continue
    }
    const [descriptor, type] = info
    try {
      const rows = structArray(bytes, tag, nameAt, descriptor, remaining)
      remaining -= rows.length
      for (const [index, row] of rows.entries()) {
        try {
          shapes.push(parseShape(bytes, row, type, nameAt, deriveHull))
        } catch (error) {
          if (!(error instanceof RangeError)) throw error
          omitted.push({ field, index })
        }
      }
    } catch (error) {
      if (!(error instanceof RangeError)) throw error
      omitted.push({ field })
    }
  }
  if (!shapes.length && !omitted.length && !traceMode && !doubleSided && buildScale.every(value => value === 1)) return null
  return { body: body.name, traceMode, doubleSided, buildScale, shapes, omitted }
}
