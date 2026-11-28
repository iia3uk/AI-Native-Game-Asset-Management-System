// Bit ordering and endpoint fields follow the BC7 mode layouts documented by Microsoft.
function block(fields) {
  const bytes = Buffer.alloc(16)
  let offset = 0
  for (const [value, width] of fields) {
    for (let i = 0; i < width; i++, offset++) bytes[offset >> 3] |= ((value >> i) & 1) << (offset & 7)
  }
  if (offset !== 128) throw new Error('A BC7 block has 128 bits')
  return bytes
}

const endpointFields = (first, last, width) => first.flatMap((value, channel) => [[value, width], [last[channel], width]])
const indexFields = (indices, width) => indices.map((value, i) => [value, i ? width : width - 1])
const zeros = Array(16).fill(0)

export function bc7Mode6(first, last = first, indices = zeros) {
  return block([[0x40, 7], ...endpointFields(first.map(value => value >> 1), last.map(value => value >> 1), 7),
    [first[0] & 1, 1], [last[0] & 1, 1], ...indexFields(indices, 4)])
}

function mode5(firstAlpha, lastAlpha, indices = zeros) {
  return block([[0x20, 6], [0, 2], ...endpointFields([32, 50, 75], [32, 50, 75], 7),
    [firstAlpha, 8], [lastAlpha, 8], ...indexFields(zeros, 2), ...indexFields(indices, 2)])
}

const first = [20, 40, 70, 100]
const last = [180, 200, 230, 244]
const lower = [34, 88, 152, 180]
const middleLow = [95, 115, 145, 168]
const middleHigh = [105, 125, 155, 177]
const side = alpha => [64, 100, 151, alpha]

export const bc7Texture = {
  name: 'ColorBC7', format: 'PF_BC7', width: 5, height: 5,
  pixels: Buffer.concat([
    bc7Mode6(first, last, [0, 15, 7, 8, 15, 0, 8, 7, 7, 8, 0, 15, 8, 7, 15, 0]),
    mode5(32, 200, [0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0]),
    bc7Mode6(lower), mode5(254, 254),
  ]),
  rows: [
    [...first, ...last, ...middleLow, ...middleHigh, ...side(32)],
    [...last, ...first, ...middleHigh, ...middleLow, ...side(200)],
    [...middleLow, ...middleHigh, ...first, ...last, ...side(32)],
    [...middleHigh, ...middleLow, ...last, ...first, ...side(200)],
    [...lower, ...lower, ...lower, ...lower, ...side(254)],
  ],
}
