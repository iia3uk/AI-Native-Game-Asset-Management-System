import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { BoxGeometry, ConeGeometry, CylinderGeometry, DodecahedronGeometry, Quaternion, Vector3 } from 'three'
import { checkedPath, folderPath } from '../core/asset-files.mjs'

function glb(parts, animate = false) {
  const document = { asset: { version: '2.0', generator: 'Asset Viewer fixtures' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ children: [] }], meshes: [], materials: [], accessors: [],
    bufferViews: [], buffers: [{ byteLength: 0 }] }
  const buffers = []
  function accessor(array, type, componentType, count, bounds) {
    const byteOffset = document.buffers[0].byteLength
    const buffer = Buffer.from(array.buffer, array.byteOffset, array.byteLength)
    const padding = (4 - buffer.length % 4) % 4
    buffers.push(buffer, Buffer.alloc(padding))
    document.buffers[0].byteLength += buffer.length + padding
    const bufferView = document.bufferViews.push({ buffer: 0, byteOffset, byteLength: buffer.length }) - 1
    return document.accessors.push({ bufferView, componentType, count, type, ...bounds }) - 1
  }
  for (const [name, geometry, color, translation, rotation] of parts) {
    geometry.computeBoundingBox()
    const { position, normal, uv } = geometry.attributes
    const attributes = {
      POSITION: accessor(position.array, 'VEC3', 5126, position.count, {
        min: geometry.boundingBox.min.toArray(), max: geometry.boundingBox.max.toArray(),
      }),
      NORMAL: accessor(normal.array, 'VEC3', 5126, normal.count),
      TEXCOORD_0: accessor(uv.array, 'VEC2', 5126, uv.count),
    }
    const indices = geometry.index && accessor(geometry.index.array, 'SCALAR', 5123, geometry.index.count)
    const material = document.materials.push({ name,
      pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: .83 } }) - 1
    const mesh = document.meshes.push({ name, primitives: [{ attributes, material, ...(indices !== null && { indices }) }] }) - 1
    document.nodes[0].children.push(document.nodes.push({ name, translation, rotation, mesh }) - 1)
    geometry.dispose()
  }
  if (animate) {
    const input = accessor(new Float32Array([0, 1, 2, 3, 4]), 'SCALAR', 5126, 5, { min: [0], max: [4] })
    const axis = new Vector3(0, 1, 0)
    const turn = [0, .5, 1, 1.5, 2].flatMap(angle => new Quaternion().setFromAxisAngle(axis, Math.PI * angle).toArray())
    const output = accessor(new Float32Array(turn), 'VEC4', 5126, 5)
    document.animations = [{ name: 'Turntable', samplers: [{ input, output }],
      channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }] }]
  }
  const json = Buffer.from(JSON.stringify(document))
  const paddedJson = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)])
  const prefix = Buffer.alloc(20)
  prefix.write('glTF')
  prefix.writeUInt32LE(2, 4)
  prefix.writeUInt32LE(28 + paddedJson.length + document.buffers[0].byteLength, 8)
  prefix.writeUInt32LE(paddedJson.length, 12)
  prefix.write('JSON', 16)
  const binary = Buffer.alloc(8)
  binary.writeUInt32LE(document.buffers[0].byteLength)
  binary.write('BIN\0', 4)
  return Buffer.concat([prefix, paddedJson, binary, ...buffers])
}

const cabin = () => {
  const box = (name, size, color, place, roll = 0) => [name, new BoxGeometry(...size), color, place,
    new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), roll).toArray()]
  const wood = [.34, .16, .066]
  const frame = [.075, .038, .021]
  const stone = [.19, .23, .24]
  const roof = [.19, .073, .043]
  return glb([
    box('Stone foundation', [2.75, .24, 2.25], stone, [0, .12, 0]),
    box('Cabin walls', [2.4, 1.48, 1.86], wood, [0, .96, 0]),
    box('Left roof', [1.74, .13, 2.22], roof, [-.64, 1.97, 0], .57),
    box('Right roof', [1.74, .13, 2.22], roof, [.64, 1.97, 0], -.57),
    box('Ridge', [.21, .15, 2.27], roof, [0, 2.43, 0]),
    box('Chimney', [.38, .88, .4], stone, [.65, 2.19, -.45]),
    box('Door frame', [.7, 1.09, .1], frame, [0, .76, .96]),
    box('Door', [.48, .91, .09], [.085, .19, .135], [0, .72, 1.02]),
    box('Step', [.92, .16, .51], stone, [0, .08, 1.31]),
    ...[-.78, .78].flatMap(x => [
      box('Window frame', [.5, .55, .1], frame, [x, 1.03, .96]),
      box('Window glass', [.36, .39, .07], [.79, .43, .115], [x, 1.03, 1.02]),
      box('Window crossbar', [.39, .05, .085], frame, [x, 1.05, 1.06]),
    ]),
    ...[.43, .64, .85, 1.06, 1.27, 1.48].map(y =>
      box('Plank seam', [2.42, .025, 1.89], frame, [0, y, 0])),
  ], true)
}

const tree = () => glb([
  ['Trunk', new CylinderGeometry(.075, .12, 1.5, 7), [.24, .096, .038], [0, .75, 0]],
  ...[[.78, 1.35], [.61, 1.82], [.45, 2.25]].map(([width, y], i) =>
    ['Boughs', new ConeGeometry(width, 1.1, 8), [.043, .137 + i * .045, .071], [0, y, 0]]),
])

const rock = () => glb([
  ['Granite', new DodecahedronGeometry(.67), [.25, .28, .31], [.1, .47, 0]],
  ['Mossy granite', new DodecahedronGeometry(.4), [.21, .29, .14], [-.53, .25, .2]],
])

const pennantTexture = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><path fill="#304b79" d="M0 0h128v128H0z"/><path fill="#d1b26a" d="m64 18 25 46-25 46-25-46z"/></svg>'
const pennant = 'mtllib pennant.mtl\no Pennant\nv -0.5 1 0\nv -0.5 0 0\nv 0.7 0.5 0\nvt 0 1\nvt 0 0\nvt 1 0.5\nusemtl Fabric\nf 1/1 2/2 3/3\n'

export async function generateFixtures(directory, { includeErrors = false } = {}) {
  await mkdir(directory, { recursive: true })
  const root = await folderPath(directory)
  const rockFile = rock()
  const files = new Map([
    ['Architecture/woodland-cabin.glb', cabin()],
    ['Environment/pine-tree.glb', tree()],
    ['Environment/granite-boulders.glb', rockFile],
    ['Props/pennant.obj', pennant],
    ['Props/pennant.mtl', 'newmtl Fabric\nKd 1 1 1\nmap_Kd pennant.svg\n'],
    ['Props/pennant.svg', pennantTexture],
  ])
  if (includeErrors) {
    files.set('Test cases/different-name.glb', rockFile)
    files.set('Test cases/damaged.glb', Buffer.from('Invalid GLB fixture'))
    files.set('Test cases/missing-texture.obj', pennant.replace('pennant.mtl', 'missing-texture.mtl'))
    files.set('Test cases/missing-texture.mtl', 'newmtl Fabric\nKd 1 1 1\nmap_Kd absent.png\n')
  }
  for (const [relative, data] of files) {
    const path = join(root, relative)
    await mkdir(dirname(path), { recursive: true })
    if (!await checkedPath(root, dirname(path))) throw new Error('Fixture subfolder must stay within the output directory.')
    await writeFile(path, data, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
  }
  return files.size
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { positionals: [directory, ...extra], values } = parseArgs({
    allowPositionals: true, options: { 'include-errors': { type: 'boolean' } },
  })
  if (!directory || extra.length) {
    console.error('Usage: node scripts/generate-fixtures.mjs <output-directory> [--include-errors]')
    process.exitCode = 2
  } else {
    console.log('Fixture paths: ' + await generateFixtures(resolve(directory), { includeErrors: values['include-errors'] }))
  }
}
