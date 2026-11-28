import { cookedPackageFixture } from './unreal-cooked-package.mjs'

const int = value => {
  const bytes = Buffer.alloc(4)
  bytes.writeInt32LE(value)
  return bytes
}
const ints = (...values) => Buffer.concat(values.map(int))
const floats = values => {
  const bytes = Buffer.alloc(values.length * 4)
  for (const [index, value] of values.entries()) bytes.writeFloatLE(value, index * 4)
  return bytes
}
const i16s = (...values) => {
  const bytes = Buffer.alloc(values.length * 2)
  for (const [index, value] of values.entries()) bytes.writeInt16LE(value, index * 2)
  return bytes
}
const bulk = (width, bytes) => Buffer.concat([ints(width, bytes.length / width), bytes])
const skeleton = Array.from({ length: 8 }, (_, index) => index)

function lod({ level, corrupt, external }) {
  const reverse = [...skeleton].reverse()
  const count = level ? 3 : 6
  const section = (start, bones) => Buffer.concat([
    Buffer.from([1, 1]), i16s(0), ints(start, 1, 0), Buffer.from([0]), ints(1, start, 0),
    int(bones.length), i16s(...bones), ints(3, level ? 4 : 8), i16s(-1), Buffer.alloc(20), int(0),
  ])
  const sections = [section(0, skeleton)]
  if (!level) sections.push(section(3, reverse))
  const indices = level ? ints(0, 2, 1) : i16s(0, 2, corrupt === 'index' ? 4 : 1, 3, 5, 4)
  const triple = [0, 0, 0, 80, 0, 0, 0, 90, 0]
  const tangents = Buffer.concat(Array.from({ length: count }, () => Buffer.from([127, 0, 0, 0, 0, 0, 127, 127])))
  const uvs = Buffer.concat(Array.from({ length: count }, () => floats([0.25, 0.75, 0.5, 0.25])))
  const vertexWeights = Buffer.from(level ? [0, 1, 2, 3, 140, 60, 40, 15] :
    [0, 1, 2, 3, 4, 5, 6, 7, corrupt === 'weight' ? 79 : 80, 50, 40, 30, 20, 15, 10, 10])
  const weights = Buffer.concat(Array.from({ length: count }, () => vertexWeights))
  // LOD 0 stores a variable lookup into grouped local indices and weights.
  // LOD 1 uses the fixed four-influence layout.
  const lookup = level ? Buffer.alloc(0) : ints(...Array.from({ length: count }, (_, index) => (index * 16 << 8) | 8))
  const colors = Buffer.concat(Array.from({ length: count }, () => Buffer.from([60, 40, 20, 255])))
  const render = Buffer.concat([
    Buffer.from([1, 1, level ? 4 : 2]), bulk(level ? 4 : 2, indices),
    ints(12, count), bulk(12, floats(level ? triple : [...triple, ...triple.map((value, axis) => axis % 3 ? value : value + 120)])),
    Buffer.from([1, 0]), ints(2, count, 1, 0), bulk(8, tangents), bulk(8, uvs),
    Buffer.from([1, 0]), ints(level ? 0 : 1, level ? 4 : 8, count * (level ? 4 : 8), count, 0), bulk(1, weights),
    Buffer.from([1, 0]), int(count), bulk(4, lookup),
    Buffer.from([1, 0]), ints(4, count), bulk(4, colors), ints(0, 0),
  ])
  const availability = Buffer.concat([Buffer.from([2]), ints(6, 2, count, 1, 0, 12, count, 4, count,
    1, 8, count * 8, count, 0, count, 0)])
  const payload = external ? Buffer.concat([ints(0x101, render.length, render.length, 0, 0), availability]) : render
  return {
    data: Buffer.concat([
      Buffer.from([1, 1]), ints(0, Number(!external)), int(skeleton.length), i16s(...skeleton),
      int(sections.length), ...sections, int(skeleton.length), i16s(...skeleton), int(render.length), payload,
    ]),
    ...(external && { ubulk: render }),
  }
}

export function cookedSkeletalMeshFixture({ name = 'SK_Test', corrupt, split = true, external = false } = {}) {
  const primary = lod({ level: 0, corrupt, external })
  const secondary = lod({ level: 1 })
  const files = cookedPackageFixture(({ name: fname, none, object }) => {
    const bones = skeleton.map(index => fname(index === 0 ? 'Root' : 'Bone' + index))
    const rig = Buffer.concat([
      int(bones.length), ...bones.flatMap((bone, index) => [bone, int(index === 0 ? -1 : 0)]),
      int(bones.length), ...bones.map((_, index) => floats([0, 0, 0, 1, 0, 0, index * 10, 1, 1, 1])),
      int(bones.length), ...bones.flatMap((bone, index) => [bone, int(index)]),
    ])
    const colors = Buffer.concat([fname('bHasVertexColors'), fname('BoolProperty'), ints(0, 0), Buffer.from([1, 0])])
    const data = Buffer.concat([
      object('Skeleton', -4), colors, none, int(0),
      Buffer.from([1, 0]), floats([120, 50, 0, 120, 50, 1, 130]),
      ints(1, -6), fname('Paint'), int(0), Buffer.alloc(24), rig,
      ints(1, 2), primary.data, secondary.data,
      Buffer.from([external ? 1 : 2, 2]), int(0),
    ])
    return { imports: [
      ['Package', '/Script/Engine'], ['Class', 'SkeletalMesh', -1],
      ['Package', '/Game/Characters/Character_Skeleton'], ['Skeleton', 'Character_Skeleton', -3],
      ['Package', '/Game/Characters/MI_Paint'], ['MaterialInstanceConstant', 'MI_Paint', -5],
    ], objects: [[-2, name, 0, data]] }
  }, { split })
  return { ...files, ...(primary.ubulk && { ubulk: primary.ubulk }) }
}
