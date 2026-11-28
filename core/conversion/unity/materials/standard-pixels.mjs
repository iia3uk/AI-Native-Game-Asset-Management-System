import { encodePngScanlines } from '../../../files/png.mjs'
import { unit } from './standard-slots.mjs'

const u8 = value => Math.round(unit(value) * 255)
const unorm = value => value * 2 / 255 - 1
const snorm = value => u8(value * .5 + .5)

function rgbImage(image, linear, signal, sample) {
  const { width, height, rowBytes, channels, rows } = image
  const stride = width * 3 + 1
  const scanlines = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    signal?.throwIfAborted()
    let source = y * rowBytes + 1
    let target = y * stride + 1
    for (let x = 0; x < width; x++, source += channels, target += 3) {
      sample(scanlines, target, rows, source, x, y)
    }
  }
  return encodePngScanlines(width, height, scanlines, { linear, srgb: !linear })
}

export function withoutAlpha(image, signal) {
  return rgbImage(image, false, signal, (out, at, rows, offset) => {
    out[at] = rows[offset]
    out[at + 1] = rows[offset + 1]
    out[at + 2] = rows[offset + 2]
  })
}

export function occlusionRed(image, signal) {
  return rgbImage(image, true, signal, (out, at, rows, offset) => {
    out[at] = out[at + 1] = out[at + 2] = rows[offset + 1]
  })
}

export function metalRoughness(metal, smooth, scale, signal) {
  return rgbImage(metal ?? smooth, true, signal, (out, at, rows, offset, x, y) => {
    out[at] = 255
    out[at + 1] = smooth ? 255 - u8(smooth.rows[y * smooth.rowBytes + 1 + x * smooth.channels + 3] * scale / 255) : 255
    out[at + 2] = metal ? rows[offset] : 255
  })
}

export function tangentNormal(image, scale, signal) {
  return rgbImage(image, true, signal, (out, at, rows, offset) => {
    const x = (2 * rows[offset] * rows[offset + 3] / (255 * 255) - 1) * scale
    // The GLB reflects the mesh's Z axis and flips V. The resulting bitangent points opposite the source bitangent.
    const y = -unorm(rows[offset + 1]) * scale
    const xy = x * x + y * y
    const length = xy > 1 ? Math.sqrt(xy) : 1
    out[at] = snorm(x / length)
    out[at + 1] = snorm(y / length)
    out[at + 2] = snorm(Math.sqrt(Math.max(0, 1 - xy)))
  })
}
