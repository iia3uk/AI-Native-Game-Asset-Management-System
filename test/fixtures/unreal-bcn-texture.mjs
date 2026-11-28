function channel(first, second, indices) {
  const block = Buffer.alloc(8)
  block[0] = first
  block[1] = second
  const packed = indices.reduce((bits, value, i) => bits | BigInt(value) << BigInt(i * 3), 0n)
  block.writeUIntLE(Number(packed), 2, 6)
  return block
}

const mask = Buffer.concat([channel(210, 0, [0, 1, 2, 7, 7, 2, 1, 0]), channel(20, 100, [7, 0, 0, 0, 6])])
const vector = Buffer.concat([channel(128, 64, [0, 1]), channel(128, 255, [0, 0, 1, 6])])
const maskRow = values => values.flatMap(value => [value, value, value, 255])

export const blockTextures = [
  { name: 'MaskBC4', format: 'PF_BC4', width: 5, height: 2, pixels: mask,
    rows: [maskRow([210, 0, 180, 30, 255]), maskRow([30, 180, 0, 210, 0])] },
  { name: 'VectorBC5', format: 'PF_BC5', width: 4, height: 1, pixels: vector,
    rows: [[128, 128, 0, 255, 64, 128, 0, 255, 128, 255, 0, 255, 128, 0, 0, 255]] },
  { name: 'NormalBC5', format: 'PF_BC5', width: 4, height: 1, pixels: vector, normalMap: true,
    rows: [[128, 128, 255, 255, 64, 128, 238, 255, 128, 255, 128, 255, 128, 0, 128, 255]] },
]
