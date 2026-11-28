import { words, zenName } from './unreal-zen-package.mjs'
import { zenStaticMeshPackage } from './unreal-zen-static-mesh.mjs'

const bodyClass = 0x6623523def01a2f7n
const digests = {
  ue53: 'eb57f14fe8c5702cbe8a3e6f4d890eeb25f6f29c',
  ue54: '8ef20dfa6589f3040c837768e5f387ba0e2621ee',
  'bad-shape': 'b687bf47f770618f8450ae9c1f80cc2f7a0892b9',
  'wrong-owner': '71cac007be3ad845cac525e62de043faa01396b4',
  'wrong-class': '09177e45f837052ee3a7580aa281ffca25744ef6',
  overlap: '21d5d9bb4de0c942d56d706b4dca2c30ff3ff62e',
  'no-render': 'f812aed15ac1078b5f4612f0e83c260e7cb7fc4d',
}
const bulkDigest = 'eddf47f7559b099b3035392037c831beacb709fb'
const doubles = (...values) => {
  const output = Buffer.alloc(values.length * 8)
  values.forEach((value, index) => output.writeDoubleLE(value, index * 8))
  return output
}

function bodySetup(names, ue54, mode) {
  const name = value => {
    if (!names.includes(value)) names.push(value)
    return zenName(names, value)
  }
  const none = name('None')
  const tag = (field, type, data, { inner, struct, truth, native = false } = {}) => {
    const property = name(field)
    const kind = name(type)
    if (ue54) {
      const nodes = [kind, words(inner ? 1 : 0)]
      if (inner) nodes.push(name(inner), words(struct ? 1 : 0))
      if (struct) nodes.push(name(struct), words(0))
      return Buffer.concat([property, ...nodes, words(data.length), Buffer.from([native ? 8 : truth ? 16 : 0]), data])
    }
    const extra = type === 'BoolProperty' ? [Buffer.from([Number(truth)])] :
      inner ? [name(inner), ...(type === 'StructProperty' ? [Buffer.alloc(16)] : [])] : []
    return Buffer.concat([property, kind, words(data.length, 0), ...extra, Buffer.from([0]), data])
  }
  const scalar = (field, value) => {
    const bytes = Buffer.alloc(4)
    bytes.writeFloatLE(value)
    return tag(field, 'FloatProperty', bytes)
  }
  const vector = (field, type, ...values) => tag(field, 'StructProperty', doubles(...values), { inner: type, native: true })
  const bool = (field, truth) => tag(field, 'BoolProperty', Buffer.alloc(0), { truth })
  const struct = (field, type, ...fields) => tag(field, 'StructProperty', Buffer.concat([...fields, none]), { inner: type })
  const array = (field, type, ...rows) => {
    const data = Buffer.concat(rows)
    const payload = Buffer.concat([words(rows.length), ue54 ? data : tag(field, 'StructProperty', data, { inner: type })])
    return tag(field, 'ArrayProperty', payload, { inner: 'StructProperty', struct: type })
  }
  const tetra = [[0, 0, 0], [60, 0, 0], [0, 50, 0], [0, 0, 80]]
  const indices = mode === 'bad-shape' ? [0, 2, 1, 0, 1, 3, 1, 2, 4, 2, 0, 3] :
    ue54 ? [] : [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3]
  const props = [
    struct('AggGeom', 'KAggregateGeom',
      array('BoxElems', 'KBoxElem', Buffer.concat([
        tag('Name', 'NameProperty', name('WalkCollision')),
        tag('CollisionEnabled', 'ByteProperty', name('ECollisionEnabled::QueryAndPhysics'), { inner: 'ECollisionEnabled' }),
        vector('Center', 'Vector', 75.125, -25, 0), vector('Rotation', 'Rotator', 0, 30, 0),
        scalar('X', 100), scalar('Y', 40), scalar('Z', 30), bool('bContributeToMass', false), none,
      ])),
      array('SphereElems', 'KSphereElem', Buffer.concat([vector('Center', 'Vector', 25, 125, 0),
        scalar('Radius', 25.5), none])),
      array('SphylElems', 'KSphylElem', Buffer.concat([scalar('Radius', 20), scalar('Length', 90), none])),
      array('ConvexElems', 'KConvexElem', Buffer.concat([
        array('VertexData', 'Vector', ...tetra.map(vertex => doubles(...vertex))),
        tag('IndexData', 'ArrayProperty', words(indices.length, ...indices), { inner: 'IntProperty' }),
        ue54 && mode === 'ue54' ? vector('Transform', 'Transform', 0, 0, 0, 1, 200, 300, 0, 1, 2, 1) :
          struct('Transform', 'Transform', vector('Translation', 'Vector', 200, 300, 0), vector('Scale3D', 'Vector', 1, 2, 1)),
        none,
      ])),
    ),
    tag('CollisionTraceFlag', 'ByteProperty', name('CTF_UseSimpleAndComplex'), { inner: 'ECollisionTraceFlag' }),
    bool('bDoubleSidedGeometry', true),
  ]
  const label = 'BodySetup'
  name(label)
  return { label, classId: mode === 'wrong-class' ? bodyClass + 1n : bodyClass,
    outer: mode === 'wrong-owner' ? 1n : 0n,
    ...(mode === 'overlap' && { offset: 1 }),
    bytes: Buffer.concat([...(ue54 ? [Buffer.alloc(1)] : []), ...props, none, words(0)]) }
}

export function zenCollisionFixture(mode = 'ue54') {
  const primary = zenStaticMeshPackage(mode === 'ue53' ? 'ue53' : 'ue54', {
    bodySetup: (names, ue54) => bodySetup(names, ue54, mode), withoutRender: mode === 'no-render',
  })
  return { primary: { ...primary, digests: [digests[mode], bulkDigest] } }
}
