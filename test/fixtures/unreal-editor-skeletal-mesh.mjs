import { editorFixture } from './unreal-editor-package.mjs'

const customVersions = [
  ['d78a4a00e8584697baa819b5487d46b4', 10],
  ['12f88b9f88754afca67cd90c383abd29', 20],
  ['5579f886933a4c1f83ba087b6361b92f', 1],
]

export function editorSkeletalMeshFixture({ name: meshName = 'SK_Test', indexWidth = 2, corrupt, lods = 1 } = {}) {
  return editorFixture(({ i32, name, bool, object, none }) => {
    const u16 = value => {
      const bytes = Buffer.alloc(2)
      bytes.writeUInt16LE(value)
      return bytes
    }
    const meshHeader = Buffer.alloc(34)
    meshHeader.writeInt32LE(1, 30)
    const materials = Buffer.concat([i32(-6), name('Paint'), name('ImportedPaint'), Buffer.alloc(24)])
    const boneNames = ['Root', 'Spine', 'Neck', 'Head', 'Ear'].map(name)
    const pose = (_, index) => {
      const bytes = Buffer.alloc(40)
      const scale = index ? 1 : 0.5
      const values = [0, 0, 0, 1, 0, 0, 25 * index, scale, scale, scale]
      values.forEach((value, component) =>
        bytes.writeFloatLE(value, component * 4))
      return bytes
    }
    const rig = Buffer.concat([i32(5), ...boneNames.map((bone, index) =>
      Buffer.concat([bone, i32(index - 1), i32(0)])),
    i32(5), ...boneNames.map(pose), i32(5), ...boneNames.map((bone, index) => Buffer.concat([bone, i32(index)]))])
    function section(first) {
      const head = Buffer.alloc(32)
      head.writeInt32LE(first, 4)
      head.writeInt32LE(1, 8)
      head.writeInt16LE(-1, 17)
      head.writeInt32LE(1, 24)
      head.writeInt32LE(first, 28)
      const vertices = [[0, 0], [0, 100], [100, 0]].map(([x, y]) => {
        const vertex = Buffer.alloc(76)
        vertex.writeFloatLE(x + first * 100)
        vertex.writeFloatLE(y, 4)
        vertex.set([255, 128, 128, 128, 128, 255, 128, 128, 128, 128, 255, 128], 12)
        vertex.writeFloatLE(x / 100, 24)
        vertex.writeFloatLE(y / 100, 28)
        vertex.writeFloatLE(0.25, 32)
        vertex.writeFloatLE(0.75, 36)
        vertex.set([56, 34, 12, 255], 56)
        vertex.set([0, 1, 2, 3, corrupt === 'joint' ? 5 : 4], 60)
        vertex.set([100, 60, 45, 35, corrupt === 'weight' ? 14 : 15], 68)
        return vertex
      })
      const bones = first ? [4, 3, 2, 1, 0] : [0, 1, 2, 3, 4]
      return Buffer.concat([head, i32(3), ...vertices, i32(5), ...bones.map(u16),
        i32(3), i32(5), Buffer.alloc(30), i32(-1)])
    }
    const indices = [0, 1, corrupt === 'index' ? 3 : 2, 3, 4, 5]
    const lod = Buffer.concat([i32(lods), Buffer.alloc(2), i32(2), section(0), section(3),
      Buffer.of(indexWidth), i32(indexWidth), i32(indices.length), ...indices.map(indexWidth === 2 ? u16 : i32),
      i32(5), ...boneNames.map((_, index) => u16(index)), i32(0), i32(6),
      i32(5), ...boneNames.map((_, index) => u16(index)),
      i32(1), Buffer.alloc(16), i32(0), i32(0), i32(2)])
    return {
      imports: [['Package', '/Script/Engine'], ['Class', 'SkeletalMesh', -1],
        ['Package', '/Game/Characters/Character_Skeleton'], ['Skeleton', 'Character_Skeleton', -3],
        ['Package', '/Game/Characters/MI_Paint'], ['MaterialInstanceConstant', 'MI_Paint', -5]],
      objects: [[-2, meshName, 0, Buffer.concat([object('Skeleton', -4), bool('bHasVertexColors', true), none,
        i32(0), meshHeader, materials, rig, lod])]],
    }
  }, { legacy: true, customVersions })
}
