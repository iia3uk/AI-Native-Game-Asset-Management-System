import { Box3, Matrix4, Quaternion, Vector3 } from 'three'
import { isCollisionName } from '../../public/model-names.js'

const array = value => Array.isArray(value) ? value : []
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const index = value => count(value) !== null ? value : -1
const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite)
const lodName = /(?:^|[\s_.-])lod[\s_.-]*\d+(?:$|[\s_.-])/i
export const isLodName = value => lodName.test(value)
const invalid = (code = 'invalid-document') => ({ status: 'invalid', issues: [code], metrics: {} })

function boxMetrics(box, kind) {
  if (!box || box.isEmpty() || ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)) return null
  const size = box.getSize(new Vector3()).toArray()
  return size.every(Number.isFinite) ? { min: box.min.toArray(), max: box.max.toArray(), size, kind } : null
}

function triangleCount(primitive, position, accessors) {
  const mode = primitive.mode ?? 4
  if ([0, 1, 2, 3].includes(mode)) return 0
  const vertices = primitive.indices === undefined ? position?.count : accessors[index(primitive.indices)]?.count
  if (count(vertices) === null || vertices < 3) return null
  if (mode === 4) return vertices % 3 === 0 ? vertices / 3 : null
  return mode === 5 || mode === 6 ? vertices - 2 : null
}

function positionBox(accessor) {
  const { min, max, normalized, type } = accessor ?? {}
  if (!vector(min, 3) || !vector(max, 3) || normalized || type !== 'VEC3' ||
      min.some((value, axis) => value > max[axis])) return null
  return new Box3(new Vector3(...min), new Vector3(...max))
}

function localMatrix(node) {
  if (node.matrix !== undefined) {
    const m = node.matrix
    return vector(m, 16) && m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1
      ? new Matrix4().fromArray(m) : null
  }
  const { translation = [0, 0, 0], rotation = [0, 0, 0, 1], scale = [1, 1, 1] } = node
  if (!vector(translation, 3) || !vector(rotation, 4) || !vector(scale, 3)) return null
  const quaternion = new Quaternion(...rotation)
  if (Math.abs(quaternion.lengthSq() - 1) > 0.001) return null
  return new Matrix4().compose(new Vector3(...translation), quaternion, new Vector3(...scale))
}

function sceneBounds(document, meshBounds) {
  const scenes = array(document.scenes)
  const scene = scenes[index(document.scene ?? (scenes.length === 1 ? 0 : null))]
  const nodes = array(document.nodes)
  if (!Array.isArray(scene?.nodes)) return null
  const stack = scene.nodes.map(id => ({ id, parent: new Matrix4() }))
  const visited = new Set()
  const box = new Box3()
  while (stack.length) {
    const { id, parent } = stack.pop()
    const node = nodes[index(id)]
    // A valid scene is a forest. Reject cycles and multiple parents in the selected scene.
    if (!node || visited.has(id)) return null
    visited.add(id)
    const matrix = localMatrix(node)
    if (!matrix) return null
    matrix.premultiply(parent)
    if (node.mesh !== undefined) {
      const bounds = meshBounds[index(node.mesh)]
      if (!bounds || node.skin !== undefined || node.extensions?.EXT_mesh_gpu_instancing) return null
      box.union(bounds.clone().applyMatrix4(matrix))
    }
    for (const child of array(node.children)) stack.push({ id: child, parent: matrix })
  }
  return boxMetrics(box, 'scene-aabb')
}

function summarizeGltf(document) {
  const { meshes, accessors, materials, textures, nodes, skins, animations } = Object.fromEntries(
    ['meshes', 'accessors', 'materials', 'textures', 'nodes', 'skins', 'animations'].map(key => [key, array(document[key])]))
  const positions = new Set()
  const joints = new Set()
  let missingPositions = false
  let missingTopology = false
  let invalidMaterial = false
  let vertices = 0
  let triangles = 0
  let hasUV = false
  const meshBounds = meshes.map(mesh => {
    const bounds = new Box3()
    let completeBounds = true
    const primitives = array(mesh?.primitives)
    if (!primitives.length) missingPositions = missingTopology = true
    for (const primitive of primitives) {
      const attributes = primitive?.attributes
      const positionId = index(attributes?.POSITION)
      const position = accessors[positionId]
      if (position?.type !== 'VEC3' || count(position.count) === null) missingPositions = true
      else if (!positions.has(positionId)) {
        positions.add(positionId)
        vertices += position.count
      }
      const faces = primitive ? triangleCount(primitive, position, accessors) : null
      if (faces === null) missingTopology = true
      else triangles += faces
      hasUV ||= Boolean(attributes && typeof attributes === 'object' && Object.entries(attributes).some(([name, id]) =>
        /^TEXCOORD_\d+$/.test(name) && accessors[index(id)]?.type === 'VEC2'))
      invalidMaterial ||= primitive?.material !== undefined && !materials[index(primitive.material)]
      const primitiveBounds = primitive?.targets?.length ? null : positionBox(position)
      if (primitiveBounds) bounds.union(primitiveBounds)
      else completeBounds = false
    }
    return completeBounds && !bounds.isEmpty() ? bounds : null
  })
  let invalidJoints = false
  for (const skin of skins) {
    if (!Array.isArray(skin?.joints) || !skin.joints.length) invalidJoints = true
    for (const joint of array(skin?.joints)) {
      if (nodes[index(joint)]) joints.add(joint)
      else invalidJoints = true
    }
  }
  const issues = []
  if (missingPositions || missingTopology) issues.push('incomplete-geometry')
  if (invalidMaterial) issues.push('invalid-material-reference')
  if (invalidJoints) issues.push('invalid-skin-reference')
  const names = [...meshes, ...nodes].map(item => item?.name).filter(name => typeof name === 'string')
  return {
    status: issues.length ? 'partial' : 'analyzed', issues,
    metrics: {
      vertices: missingPositions ? null : count(vertices), triangles: missingTopology ? null : count(triangles),
      meshes: meshes.length, materials: materials.length, textures: textures.length, hasUV,
      skins: skins.length, bones: invalidJoints ? null : joints.size, animations: animations.length,
      bounds: sceneBounds(document, meshBounds),
      lod: nodes.some(node => Array.isArray(node?.extensions?.MSFT_lod?.ids)) || names.some(isLodName),
      collisionNamed: names.some(isCollisionName),
    },
  }
}

export function analyzeGltf(document, hasBinary, reference) {
  if (document?.asset?.version !== '2.0' || (document.asset.minVersion && document.asset.minVersion !== '2.0')) {
    return invalid('unsupported-gltf-version')
  }
  for (const [i, buffer] of array(document.buffers).entries()) {
    reference('buffer', buffer?.uri, { uri: true, slot: i, embedded: i === 0 && hasBinary && buffer?.uri === undefined })
  }
  for (const [i, image] of array(document.images).entries()) {
    const imageView = index(image?.bufferView)
    const embedded = image?.uri === undefined && Boolean(document.bufferViews?.[imageView])
    reference('image', image?.uri, { uri: true, slot: i, embedded, imageView: embedded ? imageView : undefined })
  }
  return summarizeGltf(document)
}

function* records(text) {
  let continuation = ''
  for (let start = 0; start < text.length;) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = text.length
    let line = text.slice(start, end).split('#', 1)[0].trim()
    start = end + 1
    if (continuation.length + line.length > 65_536) throw new RangeError('OBJ or MTL record exceeds analysis limit.')
    if (line.endsWith('\\')) {
      continuation += line.slice(0, -1) + ' '
      continue
    }
    line = (continuation + line).trim()
    continuation = ''
    const record = /^(\S+)(?:\s+(.+))?$/.exec(line)
    if (record) yield [record[1].toLowerCase(), record[2] ?? '']
  }
}

const words = value => value.match(/"[^"]+"|'[^']+'|\S+/g)?.map(token => token.replace(/^(["'])(.*)\1$/, '$2')) ?? []
const numberToken = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

function objIndex(token, countAtFace, countAtEnd) {
  if (!/^[+-]?\d+$/.test(token)) return false
  const i = Number(token)
  return Number.isSafeInteger(i) && (i < 0 ? -i <= countAtFace : i > 0 && i <= countAtEnd)
}

export function analyzeObj(text, reference) {
  const materials = new Set()
  const box = new Box3()
  const names = new Set()
  let vertexCount = 0
  let uvCount = 0
  let meshes = 0
  let segmentEmpty = true
  let invalidVertex = false
  let badUV = false
  let unsupportedGeometry = false
  for (const [key, value] of records(text)) {
    if (key === 'v') {
      vertexCount++
      const xyz = value.split(/\s+/, 3)
      if (xyz.length !== 3 || !xyz.every(term => numberToken.test(term) && Number.isFinite(Number(term)))) invalidVertex = true
      else box.expandByPoint(new Vector3(...xyz.map(Number)))
    } else if (key === 'vt') {
      uvCount++
      const coordinates = value.split(/\s+/, 4)
      if (coordinates.length > 3 || !coordinates.every(term => numberToken.test(term) && Number.isFinite(Number(term)))) badUV = true
    }
    else if (key === 'o' || key === 'g') {
      names.add(value)
      segmentEmpty = true
    } else if (key === 'f') {
      if (segmentEmpty) meshes++
      segmentEmpty = false
    } else if (key === 'mtllib') {
      for (const filename of words(value)) reference('material-library', filename)
    } else if (key === 'usemtl' && value) materials.add(value)
    else if (['curv', 'curv2', 'surf'].includes(key)) unsupportedGeometry = true
  }
  if (!vertexCount) return invalid()
  let triangles = 0
  let hasUV = false
  let badFace = false
  let verticesSeen = 0
  let uvsSeen = 0
  for (const [key, value] of records(text)) {
    if (key === 'v') verticesSeen++
    if (key === 'vt') uvsSeen++
    if (key !== 'f') continue
    const corners = value.split(/\s+/)
    triangles += Math.max(0, corners.length - 2)
    badFace ||= corners.length < 3
    for (const corner of corners) {
      const [vertex, uv] = corner.split('/', 3)
      badFace ||= !objIndex(vertex, verticesSeen, vertexCount)
      if (uv) {
        if (objIndex(uv, uvsSeen, uvCount)) hasUV = true
        else badUV = true
      }
    }
  }
  const issues = []
  if (invalidVertex || badFace) issues.push('invalid-geometry-reference')
  if (badUV) issues.push('invalid-uv-reference')
  if (unsupportedGeometry) issues.push('unsupported-obj-surfaces')
  return {
    status: issues.length ? 'partial' : 'analyzed', issues,
    metrics: {
      vertices: invalidVertex ? null : vertexCount,
      triangles: invalidVertex || badFace || unsupportedGeometry ? null : triangles,
      meshes: unsupportedGeometry ? null : meshes, materials: materials.size, hasUV: hasUV || (badUV ? null : false),
      skins: 0, bones: 0, animations: 0, bounds: invalidVertex ? null : boxMetrics(box, 'authored-positions'),
      lod: [...names].some(isLodName), collisionNamed: [...names].some(isCollisionName),
    },
  }
}

const mapOptions = new Map([
  ['-blendu', 1], ['-blendv', 1], ['-boost', 1], ['-cc', 1], ['-clamp', 1], ['-texres', 1],
  ['-bm', 1], ['-imfchan', 1], ['-type', 1], ['-colorspace', 1], ['-mm', 2], ['-o', 3], ['-s', 3], ['-t', 3],
])

function mapFile(value) {
  const tokens = words(value)
  let at = 0
  while (tokens[at]?.startsWith('-')) {
    const flag = tokens[at++].toLowerCase()
    const max = mapOptions.get(flag)
    if (!max) return null
    if (max !== 3) at += max
    else {
      let used = 0
      while (used < max && numberToken.test(tokens[at] ?? '')) { used++; at++ }
      if (!used) return null
    }
  }
  return tokens.slice(at).join(' ') || null
}

export function analyzeMtl(text, reference) {
  const materials = new Set()
  let badMap = false
  for (const [key, value] of records(text)) {
    if (key === 'newmtl' && value) materials.add(value)
    if (/^(map_\S+|bump|disp|decal|refl|norm)$/.test(key)) {
      const file = mapFile(value)
      if (file) reference('image', file)
      else badMap = true
    }
  }
  if (!materials.size) return invalid()
  return { status: badMap ? 'partial' : 'analyzed', issues: badMap ? ['unreadable-texture-reference'] : [],
    metrics: { materials: materials.size } }
}
