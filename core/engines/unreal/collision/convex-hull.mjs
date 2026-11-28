import { Box3, Vector3 } from 'three'
import { ConvexHull } from 'three/addons/math/ConvexHull.js'
import { requireLayout } from '../editor-package/tables.mjs'

const hullTolerance = 1e-7

export function convexHullIndices(vertices) {
  const points = vertices.map(vertex => new Vector3(...vertex))
  const bounds = new Box3().setFromPoints(points)
  const center = bounds.getCenter(new Vector3())
  const extent = bounds.getSize(new Vector3()).length()
  requireLayout(extent > 0)
  for (const point of points) point.sub(center).divideScalar(extent)

  // QuickHull needs an initial tetrahedron with nonzero volume.
  const first = points[0]
  const farthest = points.reduce((best, point) => point.distanceToSquared(first) > best.distanceToSquared(first) ? point : best)
  const line = farthest.clone().sub(first).normalize()
  const normal = new Vector3()
  const perpendicular = new Vector3()
  for (const point of points) {
    perpendicular.subVectors(point, first).cross(line)
    if (perpendicular.lengthSq() > normal.lengthSq()) normal.copy(perpendicular)
  }
  requireLayout(normal.length() > hullTolerance)
  normal.normalize()
  requireLayout(points.some(point => Math.abs(normal.dot(perpendicular.subVectors(point, first))) > hullTolerance))

  const positions = new Map(points.map((point, index) => [point, index]))
  const hull = new ConvexHull().setFromPoints(points)
  const faces = hull.faces
  requireLayout(faces.length >= 4 && faces.length <= points.length * 2 - 4)
  const indices = []
  const edges = new Set()
  const pointCount = points.length
  for (const face of faces) {
    const { edge } = face
    const a = positions.get(edge.tail().point)
    const b = positions.get(edge.head().point)
    const c = positions.get(edge.next.head().point)
    requireLayout(a !== undefined && b !== undefined && c !== undefined && a !== b && b !== c && a !== c &&
      edge.next.next.next === edge && face.area > 0 && points.every(point => face.distanceToPoint(point) <= hullTolerance))
    for (const id of [a * pointCount + b, b * pointCount + c, c * pointCount + a]) {
      requireLayout(!edges.has(id))
      edges.add(id)
    }
    indices.push(a, b, c)
  }
  requireLayout([...edges].every(id => edges.has((id % pointCount) * pointCount + Math.floor(id / pointCount))))
  return indices
}
