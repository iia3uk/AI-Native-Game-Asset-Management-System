import { parentPort, workerData } from 'node:worker_threads'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { dependencyLocation } from './asset-analysis.mjs'
import { readThumbnailSource } from './thumbnail-input.mjs'
import { renderThumbnail } from './thumbnail-raster.mjs'

const invalid = () => new Error('Некорректная геометрия glTF.')
const limit = () => new Error('Модель слишком сложна для миниатюры.')
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max
const array = (value, max = 4096) => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalid()
  if (value.length > max) throw limit()
  return value
}
const tuple = (value, size) => Array.isArray(value) && value.length === size && value.every(Number.isFinite)
  ? value : undefined
const aligned = length => Math.ceil(length / 4) * 4

function unpack(bytes, ext) {
  if (ext === 'gltf') return { json: bytes }
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2 ||
      bytes.readUInt32LE(8) !== bytes.length || bytes.toString('ascii', 16, 20) !== 'JSON') throw invalid()
  const end = bytes.readUInt32LE(12) + 20
  if (end > bytes.length || end % 4) throw invalid()
  if (end === bytes.length) return { json: bytes.subarray(20, end) }
  if (end + 8 > bytes.length || bytes.toString('latin1', end + 4, end + 8) !== 'BIN\0') throw invalid()
  const binEnd = end + 8 + bytes.readUInt32LE(end)
  if (binEnd > bytes.length) throw invalid()
  return { json: bytes.subarray(20, end), binary: bytes.subarray(end + 8, binEnd) }
}

async function geometryBuffers(doc, binary, plan) {
  const dependencies = new Map(plan.dependencies.map(file => [file.reference, file]))
  const buffers = []
  let offset = 0
  for (const { uri, byteLength } of array(doc.buffers, 16)) {
    if (!integer(byteLength, 32 * 1024 ** 2)) throw limit()
    let data
    if (uri === undefined && buffers.length === 0) data = binary
    else if (typeof uri === 'string' && /^data:application\/(?:octet-stream|gltf-buffer);base64,/i.test(uri)) {
      data = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64')
    } else {
      const { path } = dependencyLocation(plan.path, uri, { uri: true })
      const file = dependencies.get(path)
      if (file) data = await readThumbnailSource(plan.root, file)
    }
    if (!data || data.length < byteLength) throw new Error('Геометрический буфер отсутствует или не поддерживается.')
    buffers.push({ data: data.subarray(0, byteLength), offset })
    offset += aligned(byteLength)
    if (offset > 32 * 1024 ** 2) throw limit()
  }
  return { buffers, length: offset }
}

function geometryNodes(doc, meshCount) {
  const entries = array(doc.nodes, 10_000)
  const parents = new Uint8Array(entries.length)
  const nodes = entries.map(({ mesh, children, matrix, translation, rotation, scale }) => {
    if (mesh !== undefined && !integer(mesh, meshCount - 1)) throw invalid()
    children = array(children, entries.length)
    for (const child of children) {
      if (!integer(child, entries.length - 1) || parents[child]) throw invalid()
      parents[child] = 1
    }
    return { mesh, children, matrix: tuple(matrix, 16), translation: tuple(translation, 3),
      rotation: tuple(rotation, 4), scale: tuple(scale, 3) }
  })
  const stack = nodes.flatMap((_, i) => parents[i] ? [] : [[i, 1]])
  let visited = 0
  while (stack.length) {
    const [index, depth] = stack.pop()
    if (depth > 128) throw limit()
    visited++
    for (const child of nodes[index].children) stack.push([child, depth + 1])
  }
  if (visited !== nodes.length) throw invalid()
  return { nodes, parents }
}

function geometryDocument(doc, buffers, length) {
  if (doc?.asset?.version !== '2.0') throw invalid()
  const views = array(doc.bufferViews).map(({ buffer, byteOffset = 0, byteLength, byteStride, extensions }) => {
    if (extensions?.EXT_meshopt_compression || extensions?.KHR_meshopt_compression) {
      throw new Error('Сжатые буферы meshopt для миниатюр пока не поддерживаются.')
    }
    const source = buffers[buffer]
    if (!source || !integer(byteOffset, source.data.length) || !integer(byteLength, source.data.length - byteOffset)) throw invalid()
    return { buffer: 0, byteOffset: source.offset + byteOffset, byteLength, byteStride }
  })
  const rawAccessors = array(doc.accessors, 8192)
  const accessors = rawAccessors.map(
    ({ bufferView, byteOffset, componentType, count, type, min, max, normalized }) =>
      ({ bufferView, byteOffset, componentType, count, type, min: tuple(min, 3), max: tuple(max, 3), normalized }))
  const accessor = (id, type, components) => {
    const value = accessors[id]
    if (!value || value.type !== type || !components.includes(value.componentType) ||
        !integer(value.count, 225_000) || !integer(value.bufferView, views.length - 1)) throw invalid()
    if (rawAccessors[id].sparse !== undefined) throw new Error('Разреженная геометрия glTF пока не поддерживается для миниатюр.')
    return id
  }
  const materials = array(doc.materials).map(material => ({
    pbrMetallicRoughness: { baseColorFactor: tuple(material?.pbrMetallicRoughness?.baseColorFactor, 4) ?? [.54, .61, .7, 1] },
  }))
  const meshes = array(doc.meshes).map(({ primitives }) => ({
    primitives: array(primitives, 512).filter(({ mode = 4 }) => [4, 5, 6].includes(mode)).map(primitive => {
      if (primitive.extensions?.KHR_draco_mesh_compression) throw new Error('Сжатие Draco для миниатюр пока не поддерживается.')
      const attributes = { POSITION: accessor(primitive.attributes?.POSITION, 'VEC3', [5126, 5120, 5121, 5122, 5123]) }
      const indices = primitive.indices === undefined ? undefined : accessor(primitive.indices, 'SCALAR', [5121, 5123, 5125])
      if (primitive.material !== undefined && !integer(primitive.material, materials.length - 1)) throw invalid()
      return { attributes, indices, material: primitive.material, mode: primitive.mode }
    }),
  }))
  const { nodes, parents } = geometryNodes(doc, meshes.length)
  const scenes = array(doc.scenes, 32).map(scene => {
    const roots = array(scene.nodes, nodes.length)
    if (new Set(roots).size !== roots.length || roots.some(root => !integer(root, nodes.length - 1) || parents[root])) throw invalid()
    return { nodes: roots }
  })
  if (!scenes.length) scenes.push({ nodes: nodes.flatMap((_, i) => parents[i] ? [] : [i]) })
  const scene = doc.scene ?? 0
  if (!integer(scene, scenes.length - 1)) throw invalid()
  return { asset: { version: '2.0' }, buffers: [{ byteLength: length }], bufferViews: views,
    accessors, materials, meshes, nodes, scenes, scene }
}

async function loadModel(bytes, plan) {
  if (plan.ext === 'obj') return new OBJLoader().parse(bytes.toString('utf8'))
  const { json, binary } = unpack(bytes, plan.ext)
  if (json.length > 8 * 1024 ** 2) throw limit()
  let doc
  try { doc = JSON.parse(json.toString('utf8').replace(/^\uFEFF/, '')) } catch { throw invalid() }
  if (doc?.asset?.version !== '2.0') throw invalid()
  const { buffers, length } = await geometryBuffers(doc, binary, plan)
  const description = JSON.stringify(geometryDocument(doc, buffers, length))
  const jsonLength = aligned(Buffer.byteLength(description))
  const glb = new ArrayBuffer(28 + jsonLength + length)
  const data = Buffer.from(glb)
  data.write('glTF')
  data.writeUInt32LE(2, 4)
  data.writeUInt32LE(data.length, 8)
  data.writeUInt32LE(jsonLength, 12)
  data.write('JSON', 16)
  data.fill(0x20, 20, 20 + jsonLength)
  data.write(description, 20, 'utf8')
  data.writeUInt32LE(length, 20 + jsonLength)
  data.write('BIN\0', 24 + jsonLength)
  for (const buffer of buffers) buffer.data.copy(data, 28 + jsonLength + buffer.offset)
  return (await new GLTFLoader().parseAsync(glb, '')).scene
}

try {
  const source = await readThumbnailSource(workerData.root, workerData)
  const model = await loadModel(source, workerData)
  parentPort.postMessage({ image: renderThumbnail(model) })
} catch (error) {
  const message = /^\p{Script=Cyrillic}/u.test(error.message) ? error.message : 'Не удалось прочитать геометрию модели.'
  parentPort.postMessage({ error: message })
}
