import { long, words, zenName, zenPackage } from './unreal-zen-package.mjs'
import { zenStaticMeshPackage } from './unreal-zen-static-mesh.mjs'
import { zenTexturePackage } from './unreal-zen-texture.mjs'

const root = '/Game/Verification/'
const paint = root + 'MI_Paint'
const base = root + 'M_Base'
const color = root + 'T_Color'
const hashes = { paint: 0x3c9bf12b64a51991n, base: 0x9f8ad2b389cca851n, color: 0xff1799b118bf3a68n }
const digests = {
  ue53: ['65b2a71a67c28247857c2bcb37de64cdead909dc', 'd377b0731d0c0b031e14e0f0e6c8f42acbb2e400',
    '08c14ec7889dfffcd687230111a6912527299b8f'],
  ue54: ['1f338c63f53c8600c44e9a3056898c9c64a7a4eb', '0939f609fe72256c552262dd8b33b6b2344c9b49',
    '98f4844b0c1342469b454a8a119c89611f6053b3'],
}
const packageImport = (packageIndex, hashIndex) => (2n << 62n) | (BigInt(packageIndex) << 32n) | BigInt(hashIndex)
const floats = (...values) => {
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4))
  return bytes
}

function materialPackage(ue54, { instance, wrongHash = false }) {
  const label = instance ? 'MI_Paint' : 'M_Base'
  const names = [root + label, label, 'None']
  const name = value => {
    if (!names.includes(value)) names.push(value)
    return zenName(names, value)
  }
  const none = name('None')
  const tag = (field, type, data, inner, struct) => {
    const head = name(field)
    const kind = name(type)
    if (ue54) {
      const nodes = [kind, words(inner ? 1 : 0)]
      if (inner) nodes.push(name(inner), words(struct ? 1 : 0))
      if (struct) nodes.push(name(struct), words(0))
      return Buffer.concat([head, ...nodes, words(data.length), Buffer.from([0]), data])
    }
    const extra = inner ? [name(inner), ...(type === 'StructProperty' ? [Buffer.alloc(16)] : [])] : []
    return Buffer.concat([head, kind, words(data.length, 0), ...extra, Buffer.from([0]), data])
  }
  const array = (field, type, ...rows) => {
    const data = Buffer.concat(rows)
    const payload = Buffer.concat([words(rows.length), ue54 ? data : tag(field, 'StructProperty', data, type)])
    return tag(field, 'ArrayProperty', payload, 'StructProperty', type)
  }
  const parameter = (label, kind, value) => {
    const info = Buffer.concat([
      tag('Name', 'NameProperty', name(label)),
      tag('Index', 'IntProperty', words(0xffffffff)),
      none,
    ])
    return Buffer.concat([tag('ParameterInfo', 'StructProperty', info, 'MaterialParameterInfo'),
      tag('ParameterValue', kind, value, kind === 'StructProperty' ? 'LinearColor' : undefined), none])
  }
  const properties = instance ? [
    tag('Parent', 'ObjectProperty', words(0xfffffffe)),
    array('TextureParameterValues', 'TextureParameterValue', parameter('BaseColor', 'ObjectProperty', words(0xfffffffd))),
    array('ScalarParameterValues', 'ScalarParameterValue', parameter('Roughness', 'FloatProperty', floats(.375))),
    array('VectorParameterValues', 'VectorParameterValue', parameter('Tint', 'StructProperty', floats(.25, .5, .75, 1))),
    array('TextureStreamingData', 'MaterialTextureInfo', Buffer.concat([
      tag('TextureReference', 'SoftObjectProperty', Buffer.concat([name(color), name('T_Color'), words(0)])),
      tag('UVChannelIndex', 'IntProperty', words(0)),
      tag('SamplingScale', 'FloatProperty', floats(1)),
      none,
    ])),
  ] : []
  const object = Buffer.concat([...(ue54 ? [Buffer.alloc(1)] : []), ...properties, none, words(0)])
  return zenPackage({ ue54, names, classId: instance ? 0x7f7253ab5570e48fn : 0x7d87c25136227324n,
    bulkMap: Buffer.alloc(0), object, label, publicHash: instance ? hashes.paint : hashes.base,
    ...(instance && { importedNames: [base, color], importedHashes: [hashes.base, wrongHash ? hashes.color + 1n : hashes.color],
      importedObjects: [packageImport(0, 0), packageImport(1, 1)] }) })
}

export function zenMaterialFixture(mode) {
  const ue54 = mode !== 'ue53'
  const mesh = zenStaticMeshPackage(ue54 ? 'ue54' : 'ue53', { publicHash: 0x9d6134c281fc1612n,
    material: paint, materialHash: hashes.paint })
  const { asset: texture } = zenTexturePackage({ mode: 'inline', packageName: color, label: 'T_Color', publicHash: hashes.color })
  const [meshHash, paintHash, baseHash] = digests[ue54 ? 'ue54' : 'ue53']
  return {
    primary: { ...mesh, digests: [meshHash, 'eddf47f7559b099b3035392037c831beacb709fb'] },
    packages: [
      { name: 'MI_Paint.uasset', content: materialPackage(ue54, { instance: true, wrongHash: mode === 'wrongHash' }),
        id: 0xc083b2f142fbe2fcn, digest: mode === 'wrongHash' ? 'dd7e00fa33f8097eefdf83e07da60c218eeda50c' : paintHash },
      { name: 'M_Base.uasset', content: materialPackage(ue54, { instance: false }), id: 0xb7bc04da19b4d049n, digest: baseHash },
      { name: 'T_Color.uasset', content: texture, id: 0x6d951ffb52ce0566n, digest: 'bd567feeab5ea5086a0d05db85ede261fd60f06d' },
    ],
  }
}
