import { editorFixture } from './unreal-editor-package.mjs'

const texture = '/Game/Example/T_Colors'

export function sourceMaterialFixture({ badObject = false, uv = 0, entries = 1, legacy = false, modernParameter = false } = {}) {
  return editorFixture(({ i32, name, tag, struct, array, none, object, enumValue, streaming }) => {
    const info = legacy && !modernParameter ? tag('ParameterName', 'NameProperty', name('BaseColor')) :
      struct('ParameterInfo', 'MaterialParameterInfo', Buffer.concat([
      tag('Name', 'NameProperty', name('BaseColor')),
      enumValue('Association', 'EMaterialParameterAssociation', 'GlobalParameter'),
      tag('Index', 'IntProperty', i32(-1)), none,
    ]))
    const serialized = Buffer.concat([
      object('Parent', -3),
      array('TextureParameterValues', 'TextureParameterValue', entries,
        Buffer.concat([info, object('ParameterValue', -5), none])),
      streaming(texture, uv), none,
    ])
    return { imports: [
      ['Class', 'MaterialInstanceConstant', -2], ['Package', '/Script/Engine'],
      ['Material', 'M_Master', -4], ['Package', '/Game/Example/M_Master'],
      [badObject ? 'Material' : 'Texture2D', 'T_Colors', -6], ['Package', texture],
    ], objects: [[-1, 'MI_Example', 0, serialized]] }
  }, { legacy })
}

export function sourceNormalGraph({ tangent = true, customCoordinates = false, uv = 0, classOwner = 1 } = {}) {
  return editorFixture(({ name, tag, struct, none, object, enumValue, bool, streaming }) => {
    const input = Buffer.alloc(52)
    input.writeInt32LE(2)
    for (const offset of [16, 20, 24, 28]) input.writeInt32LE(1, offset)
    const material = Buffer.concat([struct('Normal', 'VectorMaterialInput', input), bool('bTangentSpaceNormal', tangent),
      streaming(texture, uv), none])
    const sample = Buffer.concat([
      tag('ParameterName', 'NameProperty', name('SurfaceDetail')), object('Texture', -4), object('Material', 1),
      enumValue('SamplerType', 'EMaterialSamplerType', 'SAMPLERTYPE_Normal'),
      ...(customCoordinates ? [struct('Coordinates', 'ExpressionInput', Buffer.alloc(36))] : []), none,
    ])
    return { imports: [
      ['Class', 'Material', -2], ['Package', '/Script/Engine'], ['Class', 'MaterialExpressionTextureSampleParameter2D', -2],
      ['Texture2D', 'T_Colors', -5], ['Package', texture],
    ], objects: [[-1, 'M_Master', 0, material], [-3, 'TextureSample', classOwner, sample]] }
  })
}

export function sourceNormalTexture({ flip, srgb = false, png, legacy = false }) {
  return editorFixture(({ none, enumValue, bool }) => {
    const properties = Buffer.concat([
      enumValue('CompressionSettings', 'TextureCompressionSettings', 'TC_Normalmap'), bool('SRGB', srgb),
      ...(flip === undefined ? [] : [bool('bFlipGreenChannel', flip)]), none, png,
    ])
    return { imports: [['Class', 'Texture2D', -2], ['Package', '/Script/Engine']],
      objects: [[-1, 'T_Colors', 0, properties]] }
  }, { legacy })
}

export function sourceOpacityGraph({ separate = false, customCoordinates = false, uv = 0 } = {}) {
  return editorFixture(({ name, tag, struct, none, object, enumValue, bool, streaming }) => {
    const input = (index, alpha) => {
      const bytes = Buffer.alloc(44)
      const mask = alpha ? [4, 1, 0, 0, 0, 1] : [0, 1, 1, 1, 1, 0]
      bytes.writeInt32LE(index)
      for (const [position, offset] of [4, 16, 20, 24, 28, 32].entries()) bytes.writeInt32LE(mask[position], offset)
      return bytes
    }
    const cutoff = Buffer.alloc(4)
    cutoff.writeFloatLE(0.25)
    const material = Buffer.concat([struct('OpacityMask', 'ScalarMaterialInput', input(2, !separate)),
      struct('BaseColor', 'ColorMaterialInput', input(separate ? 3 : 2, false)),
      enumValue('BlendMode', 'EBlendMode', 'BLEND_Masked'), bool('TwoSided', true),
      tag('OpacityMaskClipValue', 'FloatProperty', cutoff), streaming(texture, uv), none])
    const sample = (index, parameter, custom) => Buffer.concat([
      tag('ParameterName', 'NameProperty', name(parameter)), object('Texture', index), object('Material', 1),
      ...(custom ? [struct('Coordinates', 'ExpressionInput', Buffer.alloc(36))] : []), none,
    ])
    return { imports: [
      ['Class', 'Material', -2], ['Package', '/Script/Engine'], ['Class', 'MaterialExpressionTextureSampleParameter2D', -2],
      ['Texture2D', 'T_Colors', -5], ['Package', texture],
      ['Texture2D', 'T_Base', -7], ['Package', '/Game/Example/T_Base'],
    ], objects: [[-1, 'M_Master', 0, material], [-3, 'Mask', 1, sample(-4, 'Opacity', customCoordinates)],
      ...(separate ? [[-3, 'Color', 1, sample(-6, 'BaseColor', false)]] : [])] }
  })
}

export function sourceSurfaceInstance({ override, cutoff = 0.75, blend = 'BLEND_Masked' }) {
  return editorFixture(({ tag, struct, none, object, enumValue, bool }) => {
    const value = Buffer.alloc(4)
    value.writeFloatLE(cutoff)
    const serialized = Buffer.concat([object('Parent', -3), struct('BasePropertyOverrides', 'MaterialInstanceBasePropertyOverrides',
      Buffer.concat([bool('bOverride_OpacityMaskClipValue', override), bool('bOverride_TwoSided', override),
        bool('bOverride_BlendMode', override), bool('TwoSided', false),
        enumValue('BlendMode', 'EBlendMode', blend), tag('OpacityMaskClipValue', 'FloatProperty', value), none])), none])
    return { imports: [
      ['Class', 'MaterialInstanceConstant', -2], ['Package', '/Script/Engine'],
      ['Material', 'M_Master', -4], ['Package', '/Game/Example/M_Master'],
    ], objects: [[-1, 'MI_Example', 0, serialized]] }
  })
}

export function sourceOpacityTexture({ label, png, discardAlpha = false }) {
  return editorFixture(({ none, bool }) => ({ imports: [['Class', 'Texture2D', -2], ['Package', '/Script/Engine']],
    objects: [[-1, label, 0, Buffer.concat([bool('CompressionNoAlpha', discardAlpha), none, png])]] }))
}
