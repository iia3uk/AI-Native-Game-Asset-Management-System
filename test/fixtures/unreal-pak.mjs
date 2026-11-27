import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

const sha1 = data => createHash('sha1').update(data).digest()

function unrealString(text) {
  const value = Buffer.from(text + '\0', 'utf8')
  const size = Buffer.alloc(4)
  size.writeInt32LE(value.length)
  return Buffer.concat([size, value])
}

// Write a stock Pak v4 containing the generated input files and both sets of checksums.
export function makePak(files, { encryptedIndex = false } = {}) {
  const payloads = []
  const indexRows = []
  let offset = 0
  for (const { path, content, encrypted = false } of files) {
    const header = Buffer.alloc(53)
    header.writeBigInt64LE(BigInt(content.length), 8)
    header.writeBigInt64LE(BigInt(content.length), 16)
    sha1(content).copy(header, 28)
    header[48] = Number(encrypted)
    payloads.push(header, content)
    const indexHeader = Buffer.from(header)
    indexHeader.writeBigInt64LE(BigInt(offset))
    indexRows.push(unrealString(path), indexHeader)
    offset += header.length + content.length
  }
  const count = Buffer.alloc(4)
  count.writeInt32LE(files.length)
  const index = Buffer.concat([unrealString('../../../Fixture/Content/'), count, ...indexRows])
  const footer = Buffer.alloc(45)
  footer[0] = Number(encryptedIndex)
  footer.writeUInt32LE(0x5a6f12e1, 1)
  footer.writeInt32LE(4, 5)
  footer.writeBigInt64LE(BigInt(offset), 9)
  footer.writeBigInt64LE(BigInt(index.length), 17)
  sha1(index).copy(footer, 25)
  return Buffer.concat([...payloads, index, footer])
}

export function wavTone() {
  const rate = 22050
  const samples = 2204
  const buf = Buffer.alloc(44 + samples)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(buf.length - 8, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate, 28)
  buf.writeUInt16LE(1, 32)
  buf.writeUInt16LE(8, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples, 40)
  for (let i = 0; i < samples; i++) buf[44 + i] = 128 + Math.round(40 * Math.sin(i * 2 * Math.PI * 440 / rate))
  return buf
}

function u32(value) {
  const bytes = Buffer.alloc(4)
  bytes.writeUInt32LE(value >>> 0)
  return bytes
}

function pathHash(path, seed) {
  let hash = BigInt.asUintN(64, 0xcbf29ce484222325n + seed)
  for (const byte of Buffer.from(path.toLowerCase(), 'utf16le')) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  }
  return hash
}

// Stock v11 with the encoded-entry table, path-hash map and full directory index.
export function makeModernPak(files) {
  const payloads = []
  const encoded = []
  const paths = []
  const directories = new Map()
  const seed = 0x81282023n
  let offset = 0
  let location = 0
  for (const { path, content, compressed = false } of files) {
    const stored = compressed ? deflateSync(content) : content
    const header = Buffer.alloc(compressed ? 73 : 53)
    header.writeBigInt64LE(BigInt(stored.length), 8)
    header.writeBigInt64LE(BigInt(content.length), 16)
    header.writeUInt32LE(compressed ? 1 : 0, 24)
    sha1(stored).copy(header, 28)
    const bits = compressed ? 0xe0800040 : 0xe0000000
    encoded.push(u32(bits), u32(offset), u32(content.length))
    if (compressed) {
      header.writeUInt32LE(1, 48)
      header.writeBigInt64LE(BigInt(header.length), 52)
      header.writeBigInt64LE(BigInt(header.length + stored.length), 60)
      header.writeUInt32LE(content.length, 69)
      encoded.push(u32(stored.length))
    }

    const separator = path.lastIndexOf('/')
    const directory = separator < 0 ? '/' : path.slice(0, separator + 1)
    if (!directories.has(directory)) directories.set(directory, [])
    directories.get(directory).push(unrealString(path.slice(separator + 1)), u32(location))
    const index = Buffer.alloc(12)
    index.writeBigUInt64LE(pathHash(path, seed))
    index.writeUInt32LE(location, 8)
    paths.push(index)
    payloads.push(header, stored)
    offset += header.length + stored.length
    location += compressed ? 16 : 12
  }

  const pathIndex = Buffer.concat([u32(paths.length), ...paths, u32(0)])
  const directoryIndex = Buffer.concat([u32(directories.size), ...[...directories].flatMap(([name, entries]) =>
    [unrealString(name), u32(entries.length / 2), ...entries])])
  const mount = unrealString('../../../Fixture/Content/')
  const primary = Buffer.concat([mount, u32(files.length), Buffer.alloc(8 + 40 + 40),
    u32(location), ...encoded, u32(0)])
  let at = mount.length + 4
  primary.writeBigUInt64LE(seed, at)
  at += 8
  let secondaryOffset = offset + primary.length
  for (const index of [pathIndex, directoryIndex]) {
    primary.writeUInt32LE(1, at)
    primary.writeBigInt64LE(BigInt(secondaryOffset), at + 4)
    primary.writeBigInt64LE(BigInt(index.length), at + 12)
    sha1(index).copy(primary, at + 20)
    secondaryOffset += index.length
    at += 40
  }
  const footer = Buffer.alloc(221)
  footer.writeUInt32LE(0x5a6f12e1, 17)
  footer.writeUInt32LE(11, 21)
  footer.writeBigInt64LE(BigInt(offset), 25)
  footer.writeBigInt64LE(BigInt(primary.length), 33)
  sha1(primary).copy(footer, 41)
  footer.write('Zlib', 61)
  return Buffer.concat([...payloads, primary, pathIndex, directoryIndex, footer])
}
