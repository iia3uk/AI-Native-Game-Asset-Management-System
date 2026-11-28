import { deflateSync } from 'node:zlib'
import { encodePngScanlines } from '../../core/files/png.mjs'

const tag = Buffer.from('c1832a9e', 'hex')
export const sourcePng = encodePngScanlines(2, 2,
  Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]))

export function sourceWave() {
  const wave = Buffer.alloc(52)
  wave.write('RIFF', 0)
  wave.writeUInt32LE(44, 4)
  wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16)
  wave.writeUInt16LE(1, 20)
  wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(44100, 24)
  wave.writeUInt32LE(88200, 28)
  wave.writeUInt16LE(2, 32)
  wave.writeUInt16LE(16, 34)
  wave.write('data', 36)
  wave.writeUInt32LE(8, 40)
  wave.writeInt16LE(16000, 46)
  return wave
}

export function ue4SourceFixture(className, payload, { legacy = false, flags = 0, footer = tag } = {}) {
  // Only the header, name table marker and media payload are represented.
  const header = Buffer.alloc(512)
  tag.copy(header)
  header.writeInt32LE(legacy ? -3 : -7, 4)
  header.writeInt32LE(legacy ? 397 : 522, 12)
  if (legacy) {
    header.writeInt32LE(1, 20)
    header.writeInt32LE(4, 44)
    header.write('old\0', 48)
  }
  const summary = legacy ? 52 : 24
  header.writeInt32LE(header.length, summary)
  header.writeUInt32LE(flags, summary + 8)
  header.writeInt32LE(1, summary + 12)
  header.writeInt32LE(128, summary + 16)
  header.writeUInt32LE(className.length + 1, 128)
  header.write(className + '\0', 132)
  sourcePng.copy(header, 192)
  return Buffer.concat([header, payload, footer])
}

export function ue4CompressedSource(bytes) {
  const compressed = deflateSync(bytes)
  const frame = Buffer.alloc(48)
  tag.copy(frame)
  frame.writeBigUInt64LE(128n * 1024n, 8)
  frame.writeBigUInt64LE(BigInt(compressed.length), 16)
  frame.writeBigUInt64LE(BigInt(bytes.length), 24)
  frame.writeBigUInt64LE(BigInt(compressed.length), 32)
  frame.writeBigUInt64LE(BigInt(bytes.length), 40)
  return Buffer.concat([frame, compressed])
}
