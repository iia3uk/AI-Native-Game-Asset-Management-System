import { cookedMaterial } from './unreal-cooked-material.mjs'
import { cookedSkeletalMeshFixture } from './unreal-cooked-skeletal-mesh.mjs'
import { cookedTexture } from './unreal-cooked-texture.mjs'
import { unrealSkeletonFixture } from './unreal-skeleton.mjs'

export const cookedPbrNormalBlock = Buffer.from([100, 100, 0, 0, 0, 0, 0, 0, 180, 180, 0, 0, 0, 0, 0, 0])
export const cookedPbrMask = Buffer.from([10, 72, 150, 255])

export function cookedPbrFixture() {
  const path = name => '/Game/Characters/' + name
  const value = (parameter, name) => ({ parameter, value: path(name) })
  const stream = (name, uv = 0) => ({ path: path(name), uv })
  const instance = (name, textures, streaming, parent = 'M_Base') => cookedMaterial({
    name, parent: [path(parent), parent === 'M_Base' ? 'Material' : 'MaterialInstanceConstant'], textures, streaming,
  })
  const mask = (name, srgb) => cookedTexture({ name, format: 'PF_R8G8B8A8', width: 1, height: 1, pixels: cookedPbrMask, srgb })
  const normal = normalMap => cookedTexture({ name: normalMap ? 'T_Bump' : 'T_Untyped', format: 'PF_BC5', width: 2, height: 1,
    pixels: cookedPbrNormalBlock, normalMap })
  const files = (name, parts) => Object.entries(parts).map(([ext, content]) => ({ path: name + '.' + ext, content }))
  return [
    ...files('SK_Test', cookedSkeletalMeshFixture()),
    ...files('Character_Skeleton', unrealSkeletonFixture({ cooked: true, split: false })),
    ...cookedMaterial({ name: 'M_Base', split: false }),
    ...instance('MI_Paint', [value('BaseColor', 'T_Color'), value('MRA', 'T_Data'), value('NormalMap', 'T_Bump')],
      ['T_Color', 'T_Data', 'T_Bump'].map(name => stream(name))),
    ...instance('MI_Inherited', [], ['T_Color', 'T_Data', 'T_Bump'].map(name => stream(name)), 'MI_Paint'),
    ...instance('MI_ORM', [value('ORM', 'T_Data')], [stream('T_Data')]),
    ...instance('MI_RMA', [value('RMA', 'T_Data')], [stream('T_Data')]),
    ...instance('MI_Unsafe', [value('ORM', 'T_ColorMask'), value('Normal', 'T_Untyped')], [stream('T_ColorMask'), stream('T_Untyped')]),
    ...instance('MI_WrongUv', [value('ORM', 'T_Data'), value('Normal', 'T_Bump')], [stream('T_Data', 1), stream('T_Bump', 1)]),
    ...instance('MI_Conflict', [value('MRA', 'T_Data'), value('RMA', 'T_Data')], [stream('T_Data')]),
    ...cookedTexture({ name: 'T_Color', format: 'PF_G8', width: 1, height: 1, pixels: Buffer.from([90]) }),
    ...mask('T_Data', false), ...mask('T_ColorMask', true), ...normal(true), ...normal(false),
  ].map(file => ({ ...file, path: 'Characters/' + file.path }))
}
