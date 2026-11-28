import { encodePngScanlines } from '../../../files/png.mjs'

export function invertNormalGreen({ width, height, channels, rows, rowBytes }, signal) {
  for (let y = 0; y < height; y++) {
    signal?.throwIfAborted()
    const start = y * rowBytes
    for (let pixel = start + 2; pixel < start + rowBytes; pixel += channels) rows[pixel] = 255 - rows[pixel]
  }
  return encodePngScanlines(width, height, rows, { alpha: channels === 4, linear: true })
}
