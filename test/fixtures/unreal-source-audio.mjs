const integers = (...values) => {
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => bytes.writeInt32LE(value, 4 * index))
  return bytes
}

const floats = (...values) => {
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => bytes.writeFloatLE(value, 4 * index))
  return bytes
}

// Stock UE4 522 summary, class imports, tagged properties and bounded export payloads.
export function soundCueFixture({ wave = '/Game/Fixture/Sounds/Step', reference = wave, cycle = false,
  unknown = false, external = false, conflicting = false } = {}) {
  const names = new Map()
  const key = name => {
    if (!names.has(name)) names.set(name, names.size)
    return names.get(name)
  }
  const name = value => integers(key(value), 0)
  const type = (property, kind, data, meta = Buffer.alloc(0)) =>
    Buffer.concat([name(property), name(kind), integers(data.length, 0), meta, Buffer.from([0]), data])
  const int = (property, value) => type(property, 'ObjectProperty', integers(value))
  const decimal = (property, value) => type(property, 'FloatProperty', floats(value))
  const bool = (property, value) => type(property, 'BoolProperty', Buffer.alloc(0), Buffer.from([value]))
  const array = (property, inner, size, data) =>
    type(property, 'ArrayProperty', Buffer.concat([integers(size), data]), name(inner))
  const object = (...tags) => Buffer.concat([...tags, name('None'), integers(0)])
  const delayClass = unknown ? 'SoundNodeOscillator' : 'SoundNodeDelay'
  const imports = [
    ['Class', -5, 'SoundCue'], ['Class', -5, 'SoundNodeRandom'], ['Class', -5, 'SoundNodeWavePlayer'],
    ['Class', -5, delayClass], ['Package', 0, '/Script/Engine'],
    ['SoundWave', -7, wave.split('/').at(-1)], ['Package', 0, wave],
    ['SoundWave', -9, 'Rival'], ['Package', 0, '/Game/Fixture/Sounds/Rival'],
  ].map(([kind, owner, label]) => {
    const row = Buffer.alloc(36)
    row.writeInt32LE(key(kind), 8)
    row.writeInt32LE(owner, 16)
    row.writeInt32LE(key(label), 20)
    return row
  })
  const externalSettings = external ? [bool('bOverrideAttenuation', 1)] : []
  const hard = conflicting ? [int('SoundWave', -8)] : []
  const payloads = [
    object(int('FirstNode', 2), decimal('VolumeMultiplier', 0.75), decimal('Duration', 2.5), ...externalSettings),
    object(array('ChildNodes', 'ObjectProperty', 2, integers(3, 4)),
      array('Weights', 'FloatProperty', 2, floats(0.25, 0.75)), bool('bRandomizeWithoutReplacement', 1)),
    object(type('SoundWaveAssetPtr', 'SoftObjectProperty',
      Buffer.concat([name(reference + '.' + reference.split('/').at(-1)), integers(0)])), bool('bLooping', 1), ...hard),
    object(array('ChildNodes', 'ObjectProperty', 1, integers(cycle ? 2 : 3)),
      decimal('DelayMin', 0.25), decimal('DelayMax', 0.5)),
  ]
  const exports = ['FixtureCue', 'SoundNodeRandom', 'SoundNodeWavePlayer', delayClass].map((label, index) => {
    const row = Buffer.alloc(104)
    row.writeInt32LE(-1 - index)
    row.writeInt32LE(index ? 1 : 0, 12)
    row.writeInt32LE(key(label), 16)
    row.writeBigInt64LE(BigInt(payloads[index].length), 28)
    return row
  })
  const nameTable = Buffer.concat([...names.keys()].map(label => {
    const value = Buffer.from(label + '\0')
    return Buffer.concat([integers(value.length), value, integers(0)])
  }))
  const summary = Buffer.alloc(220)
  const importStart = summary.length + nameTable.length
  const exportStart = importStart + imports.length * 36
  const headerSize = exportStart + exports.length * 104
  let position = headerSize
  for (const [index, row] of exports.entries()) {
    row.writeBigInt64LE(BigInt(position), 36)
    position += payloads[index].length
  }
  summary.writeUInt32LE(0x9e2a83c1)
  summary.writeInt32LE(-7, 4)
  summary.writeInt32LE(864, 8)
  summary.writeInt32LE(522, 12)
  summary.writeInt32LE(1, 20)
  Buffer.from('ed68b0e4e94294f40bda31a241bb462e', 'hex').copy(summary, 24)
  for (const [offset, value] of [[40, 40], [44, headerSize], [56, names.size], [60, summary.length],
    [76, exports.length], [80, exportStart], [84, imports.length], [88, importStart], [92, headerSize]]) {
    summary.writeInt32LE(value, offset)
  }
  summary.writeBigInt64LE(BigInt(position), 196)
  return Buffer.concat([summary, nameTable, ...imports, ...exports, ...payloads, Buffer.from('c1832a9e', 'hex')])
}
