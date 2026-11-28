function words(values, setter = 'writeInt32LE') {
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => bytes[setter](value, index * 4))
  return bytes
}

export function unrealBodySetup(ref, { badIndex = false, withUnsupported = false, pointOnly = false, flat = false } = {}) {
  const tag = (name, type, data, extra = Buffer.alloc(0)) =>
    Buffer.concat([ref(name), ref(type), words([data.length, 0]), extra, Buffer.alloc(1), data])
  const bag = (...fields) => Buffer.concat([...fields, ref('None')])
  const struct = (name, type, data) => tag(name, 'StructProperty', data, Buffer.concat([ref(type), Buffer.alloc(16)]))
  const vector = (name, type, values) => struct(name, type, words(values, 'writeFloatLE'))
  const scalar = (name, value) => tag(name, 'FloatProperty', words([value], 'writeFloatLE'))
  const array = (name, type, count, rows) => tag(name, 'ArrayProperty',
    Buffer.concat([words([count]), struct(name, type, rows)]), ref('StructProperty'))

  const box = bag(vector('Center', 'Vector', [100, 200, 300]), vector('Rotation', 'Rotator', [0, 90, 0]),
    scalar('X', 200), scalar('Y', 400), scalar('Z', 600))
  const sphere = bag(vector('Center', 'Vector', [0, 100, 0]), scalar('Radius', 50))
  const capsule = bag(vector('Rotation', 'Rotator', [90, 0, 0]), scalar('Radius', 50), scalar('Length', 200))
  const faceIndices = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, badIndex ? 4 : 3, 0, 0, 1]
  const hull = bag(array('VertexData', 'Vector', 4, words(
    [0, 0, 0, 100, 0, 0, 0, 100, 0, flat ? 50 : 0, flat ? 50 : 0, flat ? 0 : 100], 'writeFloatLE')),
    ...(pointOnly && !badIndex ? [] : [tag('IndexData', 'ArrayProperty', words([faceIndices.length, ...faceIndices]), ref('IntProperty'))]),
    struct('Transform', 'Transform', bag(vector('Translation', 'Vector', [300, 0, 0]), vector('Scale3D', 'Vector', [-1, 1, 1]))))
  const aggregate = struct('AggGeom', 'KAggregateGeom', bag(array('BoxElems', 'KBoxElem', 1, box),
    array('SphereElems', 'KSphereElem', 1, sphere), array('SphylElems', 'KSphylElem', 1, capsule),
    array('ConvexElems', 'KConvexElem', 1, hull),
    ...(withUnsupported ? [array('TaperedCapsuleElems', 'KTaperedCapsuleElem', 1, bag())] : [])))
  return bag(aggregate, tag('CollisionTraceFlag', 'ByteProperty', ref('CTF_UseSimpleAndComplex'), ref('ECollisionTraceFlag')))
}
