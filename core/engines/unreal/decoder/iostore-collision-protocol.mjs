export const ioStoreCollisionRevision = 1
export const ioStoreCollisionBudget = 32768

const component = value => typeof value === 'number' && Math.abs(value) <= 1e8
const vector = (value, size = 3) => Array.isArray(value) && value.length === size && value.every(component)
const positive = value => component(value) && value >= 1e-6
const name = value => typeof value === 'string' && /^[^/\\.:\u0000-\u001f\u007f-\u009f]{1,256}$/u.test(value)
const optionalName = value => value == null || name(value)
const optionalEnum = value => {
  if (value == null) return true
  if (typeof value !== 'string' || value.length > 256) return false
  const parts = value.split('::')
  return parts.length <= 2 && parts.every(name)
}
const optionalBool = value => value == null || typeof value === 'boolean'

function validShape(shape) {
  if (!shape || !optionalName(shape.name) || !optionalEnum(shape.collisionEnabled) || !component(shape.restOffset) ||
      !optionalBool(shape.generated) || !optionalBool(shape.contributesToMass)) return false
  if (shape.type === 'convex') {
    const { vertices, indices, transform } = shape
    return Array.isArray(vertices) && vertices.length >= 4 && vertices.length <= 256 && vertices.every(row => vector(row)) &&
      (indices == null || (Array.isArray(indices) && indices.length >= 12 && indices.length <= 1536 &&
        indices.length % 3 === 0 && indices.every(index => Number.isInteger(index) && index >= 0 && index < vertices.length))) &&
      vector(transform?.rotation, 4) && Math.abs(Math.hypot(...transform.rotation) - 1) <= 0.001 &&
      vector(transform.translation) && vector(transform.scale) &&
      transform.scale.every(value => Math.abs(value) >= 1e-6 && Math.abs(value) <= 1e4)
  }
  if (!vector(shape.center)) return false
  if (shape.type === 'sphere') return positive(shape.radius)
  if (!vector(shape.rotation)) return false
  if (shape.type === 'box') return vector(shape.dimensions) && shape.dimensions.every(positive)
  return shape.type === 'capsule' && positive(shape.radius) && component(shape.length) && shape.length >= 0
}

export function zenCollisionCost(value) {
  if (!value || !name(value.body) || !optionalEnum(value.traceMode) || !optionalBool(value.doubleSided) ||
      !vector(value.buildScale) || !Array.isArray(value.shapes) || value.shapes.length > 128 ||
      !Array.isArray(value.omitted) || value.omitted.length > 128 ||
      !value.omitted.every(row => name(row?.field) &&
        (row.index == null || (Number.isInteger(row.index) && row.index >= 0 && row.index < 128))) ||
      !value.shapes.every(validShape)) return 0
  return 1 + value.omitted.length + value.shapes.reduce((cost, shape) =>
    cost + 8 + (shape.type === 'convex' ? 3 * shape.vertices.length + (shape.indices?.length ?? 0) : 0), 0)
}
