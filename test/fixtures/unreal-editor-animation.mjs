import { editorFixture } from './unreal-editor-package.mjs'

export const demoSkeletonGuid = '1023456789abcdeffedcba9876543210'

export function editorAnimationFixture({ clip = 'Attack', skeleton = '/Game/Characters/Character_Skeleton', corrupt,
  skeletonGuid = demoSkeletonGuid, duration = 2 } = {}) {
  return editorFixture(({ i32, name, tag, array, object, none }) => {
    function floats(values) {
      const bytes = Buffer.alloc(values.length * 4)
      for (const [index, value] of values.entries()) bytes.writeFloatLE(value, index * 4)
      return bytes
    }
    function keys(width, values, stride = width) {
      return Buffer.concat([i32(stride * 4), i32(values.length / width), floats(values)])
    }
    const data = Buffer.concat([
      tag('NumFrames', 'IntProperty', i32(3)),
      tag('SequenceLength', 'FloatProperty', floats([duration])),
      array('TrackToSkeletonMapTable', 'TrackToSkeletonMap', 2, Buffer.concat(
        [1, corrupt === 'mapping' ? 1 : 0].flatMap(index => [tag('BoneTreeIndex', 'IntProperty', i32(index)), none]))),
      tag('AnimationTrackNames', 'ArrayProperty', Buffer.concat([i32(2), name('Spine'), name('Root')]), name('NameProperty')),
      object('Skeleton', -4), none,
      i32(0), Buffer.from(skeletonGuid, 'hex'), Buffer.alloc(2), i32(2),
      keys(3, [0, 0, 25], corrupt === 'stride' ? 4 : 3),
      keys(4, [0, 0, 0, 1]),
      keys(3, [1, 1, 1, 2, 3, 4, 1, 1, 1]),
      keys(3, [0, 0, 0, 25, 50, 100, 0, 0, 0]),
      keys(4, [0, 0, 0, 1, 0, 0, -Math.SQRT1_2, -Math.SQRT1_2, 0, 0, 0, 1]),
      keys(3, []), i32(0), i32(corrupt === 'compressed' ? 1 : 0),
    ])
    return { imports: [['Package', '/Script/Engine'], ['Class', 'AnimSequence', -1],
      ['Package', skeleton], ['Skeleton', skeleton.split('/').at(-1), -3]], objects: [[-2, clip, 0, data]] }
  }, { legacy: true, customVersions: [['cffc743f43b04480939114df171d2073', 30]] })
}
