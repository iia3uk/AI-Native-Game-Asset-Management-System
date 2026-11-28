import { BoxGeometry, CapsuleGeometry, Euler, Quaternion, SphereGeometry, Vector3 } from 'three'

const radians = Math.PI / 180
const palette = { box: [0.25, 0.52, 0.95], sphere: [0.88, 0.54, 0.18], capsule: [0.28, 0.72, 0.34],
  convex: [0.68, 0.37, 0.91] }

function sourceToGltf(point) {
  return [point.x, point.z, point.y].map(value => Math.fround(value * 0.01))
}

function convexMesh(shape) {
  const rotation = new Quaternion(...shape.transform.rotation).normalize()
  const scale = new Vector3(...shape.transform.scale)
  const translation = new Vector3(...shape.transform.translation)
  const points = shape.vertices.map(point =>
    sourceToGltf(new Vector3(...point).multiply(scale).applyQuaternion(rotation).add(translation)))
  const vertices = points.map(point => new Vector3(...point))
  const centroid = vertices.reduce((sum, position) => sum.add(position), new Vector3()).divideScalar(vertices.length)
  const normal = new Vector3()
  const edge = new Vector3()
  const indices = []
  for (let at = 0; at < shape.indices.length; at += 3) {
    const a = shape.indices[at]
    const b = shape.indices[at + 1]
    const c = shape.indices[at + 2]
    normal.subVectors(vertices[b], vertices[a]).cross(edge.subVectors(vertices[c], vertices[a]))
    if (normal.lengthSq() === 0) continue
    const side = normal.dot(edge.subVectors(vertices[a], centroid))
    if (side === 0) return null
    if (side > 0) indices.push(a, b, c)
    else indices.push(a, c, b)
  }
  return indices.length >= 12 ? { points, indices, degenerate: (shape.indices.length - indices.length) / 3 } : null
}

function primitiveMesh(shape) {
  const geometry = shape.type === 'box' ? new BoxGeometry(...shape.dimensions) :
    shape.type === 'sphere' || shape.length === 0 ? new SphereGeometry(shape.radius, 16, 12) :
      new CapsuleGeometry(shape.radius, shape.length, 6, 16).rotateX(Math.PI / 2)
  const [pitch, yaw, roll] = shape.rotation ?? [0, 0, 0]
  const rotation = new Quaternion().setFromEuler(new Euler(-roll * radians, -pitch * radians, yaw * radians, 'ZYX'))
  const center = new Vector3(...shape.center)
  const positions = geometry.getAttribute('position')
  const points = []
  const point = new Vector3()
  for (let index = 0; index < positions.count; index++) {
    points.push(sourceToGltf(point.fromBufferAttribute(positions, index).applyQuaternion(rotation).add(center)))
  }
  const indices = Array.from(geometry.index.array)
  for (let at = 0; at < indices.length; at += 3) [indices[at + 1], indices[at + 2]] = [indices[at + 2], indices[at + 1]]
  geometry.dispose()
  return { points, indices }
}

function glb(document, buffers, binarySize) {
  const json = Buffer.from(JSON.stringify(document))
  const jsonSize = Math.ceil(json.length / 4) * 4
  const total = 28 + jsonSize + binarySize
  const result = Buffer.allocUnsafeSlow(total)
  result.write('glTF', 0, 'ascii')
  result.writeUInt32LE(2, 4)
  result.writeUInt32LE(total, 8)
  result.writeUInt32LE(jsonSize, 12)
  result.write('JSON', 16, 'ascii')
  json.copy(result, 20)
  result.fill(0x20, 20 + json.length, 20 + jsonSize)
  result.writeUInt32LE(binarySize, 20 + jsonSize)
  result.write('BIN\0', 24 + jsonSize, 'ascii')
  let at = 28 + jsonSize
  for (const bytes of buffers) at += bytes.copy(result, at)
  return result
}

export function collisionPreview(shapes) {
  const omitted = []
  const document = { asset: { version: '2.0', generator: 'Asset Viewer Unreal collision' }, scene: 0,
    scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [] }
  const materials = new Map()
  const buffers = []
  let size = 0
  let degenerateTriangles = 0
  function append(values, count, type, componentType, target, bounds) {
    const bytes = Buffer.from(values.buffer)
    const index = document.bufferViews.length
    document.bufferViews.push({ buffer: 0, byteOffset: size, byteLength: bytes.length, target })
    document.accessors.push({ bufferView: index, count, type, componentType, ...bounds })
    buffers.push(bytes)
    const padding = (4 - bytes.length % 4) % 4
    if (padding) buffers.push(Buffer.alloc(padding))
    size += bytes.length + padding
    return index
  }
  for (const [index, shape] of shapes.entries()) {
    const mesh = shape.type === 'convex' ? convexMesh(shape) : primitiveMesh(shape)
    if (!mesh) {
      omitted.push(index)
      continue
    }
    const { points, indices } = mesh
    degenerateTriangles += mesh.degenerate ?? 0
    const min = [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis])))
    const max = [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis])))
    const position = append(Float32Array.from(points.flat()), points.length, 'VEC3', 5126, 34962, { min, max })
    const triangles = append(Uint16Array.from(indices), indices.length, 'SCALAR', 5123, 34963)
    const name = shape.name && shape.name !== 'None' ? shape.name : shape.type + ' ' + (index + 1)
    const id = document.meshes.length
    if (!materials.has(shape.type)) {
      materials.set(shape.type, document.materials.length)
      document.materials.push({ name: shape.type, pbrMetallicRoughness: { baseColorFactor: [...palette[shape.type], 1],
        metallicFactor: 0, roughnessFactor: 0.8 } })
    }
    document.scenes[0].nodes.push(id)
    document.nodes.push({ name, mesh: id, extras: { collisionShape: shape.type, sourceIndex: index } })
    document.meshes.push({ name, primitives: [{ attributes: { POSITION: position }, indices: triangles,
      material: materials.get(shape.type) }] })
  }
  document.buffers.push({ byteLength: size })
  return { omitted, degenerateTriangles, buffer: size ? glb(document, buffers, size) : null }
}
