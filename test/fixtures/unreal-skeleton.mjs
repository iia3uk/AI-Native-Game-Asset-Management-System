import { cookedPackageFixture } from './unreal-cooked-package.mjs'
import { editorFixture } from './unreal-editor-package.mjs'

export function unrealSkeletonFixture({ mesh = false, duplicate = false, invalidIndex = false, wrongClass = false, cooked = false, split,
  skeletonName = 'Character_Skeleton', objectName = mesh ? 'SK_Character' : skeletonName, guid } = {}) {
  const makePackage = cooked ? cookedPackageFixture : editorFixture
  return makePackage(({ i32, name, none, object }) => {
    const bones = [name('Root'), name(duplicate ? 'root' : 'Spine')]
    const bone = (name, parent) => Buffer.concat([name, i32(parent), ...(cooked ? [] : [i32(0)])])
    const pose = (z, scale) => {
      const transform = Buffer.alloc(40)
      const values = [0, 0, 0, 1, 0, 0, z, scale, scale, scale]
      values.forEach((value, index) => transform.writeFloatLE(value, index * 4))
      return transform
    }
    const rig = Buffer.concat([i32(2), bone(bones[0], -1), bone(bones[1], 0), i32(2),
      pose(0, mesh ? 0.5 : 1), pose(25, 1), i32(2),
      bones[1], i32(invalidIndex ? 0 : 1), bones[0], i32(0)])
    const imports = [
      ['Package', wrongClass ? '/Game/Other' : '/Script/Engine'],
      ['Class', mesh ? 'SkeletalMesh' : 'Skeleton', -1],
      ['Package', '/Game/Characters/' + skeletonName],
      ['Skeleton', skeletonName, -3],
    ]
    const meshHeader = Buffer.alloc(34)
    if (cooked) meshHeader[0] = 1
    const data = Buffer.concat([...(mesh ? [object('Skeleton', -4)] : []), none, i32(0), ...(mesh ? [meshHeader] : []), rig,
      ...(guid ? [i32(0), Buffer.from(guid, 'hex')] : [])])
    return { imports, objects: [[-2, objectName, 0, data]] }
  }, { split, ...(guid && { legacy: true, customVersions: [['cffc743f43b04480939114df171d2073', 30]] }) })
}
