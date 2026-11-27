import { Box3, Matrix4, Vector3 } from 'three'
import { encodePngScanlines } from '../files/png.mjs'
import { thumbnailSize as size } from './thumbnail-input.mjs'

const faceLimit = 75_000
const rasterLimit = 30_000_000
const camera = new Matrix4().lookAt(new Vector3(3, 2, 4), new Vector3(), new Vector3(0, 1, 0)).transpose()
const light = new Vector3(-.35, .65, .65).normalize()
const toByte = value => Math.round(255 * Math.min(1, Math.max(0, value)))

function geometry(scene) {
  const bounds = new Box3()
  const point = new Vector3()
  const meshes = []
  let faces = 0
  scene.updateMatrixWorld(true)
  scene.traverseVisible(mesh => {
    const positions = mesh.geometry?.getAttribute('position')
    if (!mesh.isMesh || !positions) return
    const { index } = mesh.geometry
    const count = Math.floor((index?.count ?? positions.count) / 3)
    faces += count
    if (faces > faceLimit || positions.count > faceLimit * 3) throw new Error('Слишком много граней для миниатюры.')
    const transform = new Matrix4().multiplyMatrices(camera, mesh.matrixWorld)
    const vertices = new Float64Array(positions.count * 3)
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(transform)
      if (![point.x, point.y, point.z].every(Number.isFinite)) throw new Error('Некорректные координаты вершин.')
      point.toArray(vertices, i * 3)
      bounds.expandByPoint(point)
    }
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const color = material?.color?.clone().convertLinearToSRGB().toArray() ?? [.76, .80, .86]
    meshes.push({ vertices, index, count, color })
  })
  return { bounds, meshes, faces }
}

export function renderThumbnail(scene) {
  const { bounds, meshes, faces } = geometry(scene)
  const span = bounds.getSize(new Vector3())
  const extent = Math.max(span.x, span.y)
  if (!faces || !Number.isFinite(extent) || extent <= 0) throw new Error('В модели нет граней для миниатюры.')
  const center = bounds.getCenter(new Vector3())
  const scale = size * .8 / extent
  const stride = size * 3 + 1
  const pixels = Buffer.alloc(stride * size)
  const depth = new Float64Array(size ** 2).fill(-Infinity)
  let budget = rasterLimit
  let painted = false

  for (let y = 0; y < size; y++) {
    const row = y * stride
    const fade = Math.round(y * 12 / size)
    for (let x = 0; x < size; x++) pixels.set([31 - fade, 42 - fade, 48 - fade], row + x * 3 + 1)
  }

  for (const { vertices, index, count, color } of meshes) {
    const vertex = i => {
      const offset = (index ? index.getX(i) : i) * 3
      if (offset >= vertices.length) throw new Error('Индекс вершины выходит за границы геометрии.')
      return [(vertices[offset] - center.x) * scale + size / 2,
        (center.y - vertices[offset + 1]) * scale + size / 2, (vertices[offset + 2] - center.z) * scale]
    }
    for (let face = 0; face < count; face++) {
      const [ax, ay, az] = vertex(face * 3)
      const [bx, by, bz] = vertex(face * 3 + 1)
      const [cx, cy, cz] = vertex(face * 3 + 2)
      const ux = bx - ax, uy = by - ay, uz = bz - az
      const vx = cx - ax, vy = cy - ay, vz = cz - az
      const area = ux * vy - uy * vx
      if (Math.abs(area) < 1e-6) continue
      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
      const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, cx)))
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)))
      const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, cy)))
      budget -= (maxX - minX + 1) * (maxY - minY + 1)
      if (budget < 0) throw new Error('Модель слишком сложна для фоновой растеризации.')
      const normal = new Vector3(uy * vz - uz * vy, uz * vx - ux * vz, area).normalize()
      const shade = .42 + .58 * Math.abs(normal.dot(light))
      const rgb = color.map(channel => toByte(channel * shade))
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const dx = x + .5 - ax, dy = y + .5 - ay
        const b = (dx * vy - dy * vx) / area
        const c = (ux * dy - uy * dx) / area
        if (b < 0 || c < 0 || b + c > 1) continue
        const z = az + b * uz + c * vz
        const offset = y * size + x
        if (z <= depth[offset]) continue
        depth[offset] = z
        pixels.set(rgb, y * stride + x * 3 + 1)
        painted = true
      }
    }
  }
  if (!painted) throw new Error('Грани модели не видны с ракурса миниатюры.')
  return encodePngScanlines(size, size, pixels)
}
