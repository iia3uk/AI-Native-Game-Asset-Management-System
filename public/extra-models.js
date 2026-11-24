import * as THREE from 'three'

const objectLoaders = {
  amf: 'AMFLoader', gcode: 'GCodeLoader', kmz: 'KMZLoader', lwo: 'LWOLoader',
  wrl: 'VRMLLoader', vrml: 'VRMLLoader', pcd: 'PCDLoader', ldr: 'LDrawLoader', mpd: 'LDrawLoader',
}
const geometryLoaders = {
  md2: 'MD2Loader', vtk: 'VTKLoader', vtp: 'VTKLoader', xyz: 'XYZLoader', pdb: 'PDBLoader',
}

export function geometryModel(geometry, points = false) {
  const vertexColors = geometry.hasAttribute('color')
  const color = vertexColors ? 0xffffff : 0xc3cfb0
  if (points) {
    return new THREE.Points(geometry, new THREE.PointsMaterial({ vertexColors, color, size: 2, sizeAttenuation: false }))
  }
  if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals()
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors, color, roughness: .78 }))
}

export function parseOff(source) {
  const lines = source.split(/\r?\n/).map(line => line.split('#', 1)[0].trim()).filter(Boolean)
  const [header, ...inlineCounts] = (lines.shift() ?? '').split(/\s+/)
  const [vertices, faces] = (inlineCounts.length ? inlineCounts : (lines.shift() ?? '').split(/\s+/)).map(Number)
  if (!['OFF', 'COFF', 'NOFF'].includes(header) || !Number.isSafeInteger(vertices) || vertices < 1 ||
      !Number.isSafeInteger(faces) || faces < 0 || (vertices + faces) > lines.length) {
    throw new Error('Некорректный заголовок OFF')
  }
  const positions = [], colors = [], normals = [], indices = []
  for (let index = 0; index < vertices; index++) {
    const values = lines[index].split(/\s+/).map(Number)
    const [x, y, z, a, b, c] = values
    if (![x, y, z].every(Number.isFinite)) throw new Error('Некорректная вершина OFF')
    positions.push(x, y, z)
    if (header === 'NOFF' && [a, b, c].every(Number.isFinite)) normals.push(a, b, c)
    if (header === 'COFF' && [a, b, c].every(Number.isFinite)) {
      const divisor = Math.max(a, b, c, values[6] ?? 0) > 1 ? 255 : 1
      colors.push(...new THREE.Color().setRGB(a / divisor, b / divisor, c / divisor, THREE.SRGBColorSpace))
    }
  }
  const point = new THREE.Vector3()
  const next = new THREE.Vector3()
  const normal = new THREE.Vector3()
  for (let face = 0; face < faces; face++) {
    const [count, ...values] = lines[vertices + face].split(/\s+/).map(Number)
    const polygon = values.slice(0, count)
    if (!Number.isSafeInteger(count) || count < 3 || polygon.length !== count ||
        !polygon.every(vertex => Number.isSafeInteger(vertex) && vertex >= 0 && vertex < vertices)) {
      throw new Error('Некорректная грань OFF')
    }
    if (count === 3) { indices.push(...polygon); continue }
    normal.set(0, 0, 0)
    for (let index = 0; index < count; index++) {
      point.fromArray(positions, polygon[index] * 3)
      next.fromArray(positions, polygon[(index + 1) % count] * 3)
      normal.x += (point.y - next.y) * (point.z + next.z)
      normal.y += (point.z - next.z) * (point.x + next.x)
      normal.z += (point.x - next.x) * (point.y + next.y)
    }
    const x = Math.abs(normal.x), y = Math.abs(normal.y), z = Math.abs(normal.z)
    const axis = x >= y && x >= z ? 0 : y >= z ? 1 : 2
    const contour = polygon.map(vertex => new THREE.Vector2(
      positions[vertex * 3 + (axis + 1) % 3], positions[vertex * 3 + (axis + 2) % 3]))
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, [])) {
      const first = contour[a], second = contour[b], third = contour[c]
      const winding = (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x)
      if (winding * normal.getComponent(axis) < 0) indices.push(polygon[a], polygon[c], polygon[b])
      else indices.push(polygon[a], polygon[b], polygon[c])
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  if (colors.length === positions.length) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  if (normals.length === positions.length) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  if (indices.length) geometry.setIndex(indices)
  return geometry
}

export async function loadExtraModel(type, url, manager) {
  const name = Object.hasOwn(objectLoaders, type) ? objectLoaders[type] :
    Object.hasOwn(geometryLoaders, type) ? geometryLoaders[type] : null
  if (name) {
    const loaders = await import('three/addons/loaders/' + name + '.js')
    const loader = new loaders[name](manager)
    if (name === 'LDrawLoader') {
      const { LDrawConditionalLineMaterial } = await import('three/addons/materials/LDrawConditionalLineMaterial.js')
      loader.setConditionalLineMaterial(LDrawConditionalLineMaterial)
    }
    const result = await loader.loadAsync(url)
    if (type === 'kmz') return { model: result.scene }
    if (type === 'lwo') return { model: new THREE.Group().add(...result.meshes) }
    if (type === 'pcd') {
      result.material.size = 2
      result.material.sizeAttenuation = false
    }
    if (type === 'pdb') {
      const { geometryAtoms, geometryBonds } = result
      const model = new THREE.Group().add(geometryModel(geometryAtoms, true),
        new THREE.LineSegments(geometryBonds, new THREE.LineBasicMaterial({ color: 0xd2dbc7 })))
      return { model }
    }
    if (Object.hasOwn(geometryLoaders, type)) {
      return { model: geometryModel(result, type !== 'md2' && !result.index?.count), animations: result.animations }
    }
    return { model: result }
  }
  if (type === 'off') {
    const geometry = parseOff(await new THREE.FileLoader(manager).loadAsync(url))
    return { model: geometryModel(geometry, !geometry.index) }
  }
  if (type === 'bvh') {
    const { BVHLoader } = await import('three/addons/loaders/BVHLoader.js')
    const { skeleton, clip } = await new BVHLoader(manager).loadAsync(url)
    const model = new THREE.Group()
    model.skeleton = skeleton
    model.add(...skeleton.bones.filter(bone => !bone.parent))
    return { model, animations: [clip] }
  }
  if (type === 'vox') {
    const { VOXLoader, buildMesh } = await import('three/addons/loaders/VOXLoader.js')
    const { scene, chunks } = await new VOXLoader(manager).loadAsync(url)
    return { model: scene ?? new THREE.Group().add(...chunks.map(buildMesh)) }
  }
  if (type === 'drc') {
    const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js')
    const loader = new DRACOLoader(manager).setDecoderPath('/vendor/three/examples/jsm/libs/draco/')
    try {
      const geometry = await loader.loadAsync(url)
      return { model: geometryModel(geometry, !geometry.index) }
    } finally { loader.dispose() }
  }
  if (type === '3dm') {
    const { Rhino3dmLoader } = await import('three/addons/loaders/3DMLoader.js')
    class ViewerRhinoLoader extends Rhino3dmLoader {
      _initLibrary() {
        this.libraryPending ??= new THREE.FileLoader(this.manager).setResponseType('arraybuffer')
          .loadAsync('/vendor/rhino3dm/rhino3dm.wasm').then(binary => {
            this.libraryConfig.wasmBinary = binary
            this.workerSourceURL = '/vendor/rhino3dm/worker.js'
          })
        return this.libraryPending
      }
    }
    const loader = new ViewerRhinoLoader(manager)
    try { return { model: await loader.loadAsync(url) } } finally { loader.dispose() }
  }
  throw new Error('Для этого формата нужно отдельное приложение')
}
