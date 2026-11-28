import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { wavTone } from './unreal-pak.mjs'
import { zenFixtureId, zenTexturePackage } from './unreal-zen-texture.mjs'

const end = 0xffffffff
const blockSize = 512
const partitionSize = 8192
const words = (...values) => {
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((value, i) => bytes.writeUInt32LE(value, i * 4))
  return bytes
}

function unrealString(text, wide = false) {
  const bytes = Buffer.from(text + '\0', wide ? 'utf16le' : 'utf8')
  return Buffer.concat([words(wide ? (-bytes.length / 2) >>> 0 : bytes.length), bytes])
}

export function ioStorePayloads() {
  const audio = wavTone()
  for (let i = 44; i < audio.length; i++) audio[i] = i % 64 < 32 ? 170 : 85
  // A minimal Zen package header with a local name table and no export objects.
  const name = Buffer.from('/Game/Vérification/Sample', 'utf8')
  const nameMap = Buffer.concat([words(1, name.length, 0xc1640000, 0, 0, 0), Buffer.from([0, name.length]), name])
  const headerEnd = 52 + nameMap.length + 16
  const asset = Buffer.concat([
    words(0, headerEnd, 0, 0, 0x2000, headerEnd, headerEnd - 8, headerEnd - 8, headerEnd - 8, headerEnd - 8,
      headerEnd - 8, headerEnd - 8, headerEnd - 8), nameMap, Buffer.alloc(16),
  ])
  const bulk = Buffer.from('000000000000000000000000000000ffffffffffffffffffffffffffffff', 'hex')
  return { audio, asset, bulk }
}

const digests = {
  audio: '910eb1e63dbb63c88b7f3cc7eb6e3bd7da452b8f',
  asset: 'a1ae18bc4ff89b9874adf795f9195f33430242e9',
  bulk: 'b65a643fb272bf481a01ce14408f987a5de068f9',
}
const textureDigests = {
  inline: '104b725a32b3ea27cc1755a2034077432ed97f1c',
  external: 'ac00bca73d5e9f97217515e409bed2748d74c919',
  broken: '4217cdd0a155f69174b97efa3d34c67d2810b15c',
  bulk: '4a46cfa5f7fa028f90e6b62e4dc490525bd139a1',
}

export function makeIoStore({ version = 8, flags = 9, soundName = 'IoStore-Tone.wav', cycle = false,
  secondPartition = version >= 3, unsupportedCodec = false, audioOffset = 27, texture } = {}) {
  const { audio, ...original } = ioStorePayloads()
  const { asset, bulk } = texture ? zenTexturePackage({ mode: texture }) : original
  const packageId = texture ? zenFixtureId : 2n
  const files = [
    { content: audio, digest: digests.audio, id: 1n, type: 7, offset: audioOffset, compressed: true },
    { content: asset, digest: texture ? textureDigests[texture] : digests.asset, id: packageId,
      type: version >= 4 ? 1 : 2, offset: 5 * blockSize, compressed: false },
    { content: bulk, digest: texture ? textureDigests.bulk : digests.bulk, id: packageId,
      type: version >= 4 ? 2 : 3, offset: (5 + Math.ceil(asset.length / blockSize)) * blockSize, compressed: true },
  ]
  const offsets = []
  const ids = []
  const table = []
  const data = [[], []]
  const sizes = [0, 0]
  const metadata = []
  for (const [i, { content, digest, id, type, offset, compressed }] of files.entries()) {
    const range = Buffer.alloc(10)
    range.writeUIntBE(offset, 0, 5)
    range.writeUIntBE(content.length, 5, 5)
    offsets.push(range)
    const chunkId = Buffer.alloc(12)
    chunkId.writeBigUInt64LE(id)
    chunkId[11] = type
    ids.push(chunkId)
    const meta = Buffer.alloc(version >= 8 ? 24 : 33)
    Buffer.from(digest, 'hex').copy(meta)
    meta[version >= 8 ? 20 : 32] = Number(compressed)
    metadata.push(meta)
    const prefix = offset % blockSize
    const bytes = Buffer.concat([Buffer.alloc(prefix), content])
    for (let at = 0; at < bytes.length; at += blockSize) {
      const segment = bytes.subarray(at, at + blockSize)
      const useCompression = compressed && (at !== 0 || i !== 0)
      const stored = useCompression ? deflateSync(segment) : segment
      const partition = secondPartition && (i > 0 || at > 0) ? 1 : 0
      const block = Buffer.alloc(12)
      block.writeUIntLE(partition * partitionSize + sizes[partition], 0, 5)
      block.writeUIntLE(stored.length, 5, 3)
      block.writeUIntLE(segment.length, 8, 3)
      block[11] = Number(useCompression)
      table.push(block)
      const padding = Buffer.alloc((16 - stored.length % 16) % 16)
      data[partition].push(stored, padding)
      sizes[partition] += stored.length + padding.length
    }
  }
  const directory = Buffer.concat([
    unrealString('../../../Fixture/Content/'), words(2),
    words(end, 1, end, 0), words(0, cycle ? 1 : end, end, 1),
    words(3), words(1, end, 0), words(2, 2, 1), words(3, end, 2),
    words(4), unrealString(texture ? 'Verification' : 'Vérification', true), unrealString(soundName),
    unrealString('Sample.uasset'), unrealString('Sample.ubulk'),
  ])
  const header = Buffer.alloc(144)
  header.write('-==--==--==--==-')
  header[16] = version
  words(144, files.length, table.length, 12, 1, 32, blockSize, directory.length, secondPartition ? 2 : 1).copy(header, 20)
  header[80] = flags
  header.writeBigUInt64LE(BigInt(partitionSize), 88)
  const codec = Buffer.alloc(32)
  codec.write(unsupportedCodec ? 'Oodle' : 'Zlib')
  return {
    toc: Buffer.concat([header, ...ids, ...offsets, ...table, codec, directory, ...metadata]),
    data: (secondPartition ? data : data.slice(0, 1)).map(parts => Buffer.concat(parts)),
    payloads: { audio, asset, bulk },
  }
}

export async function writeIoStoreFixture(root, name, options) {
  const fixture = makeIoStore(options)
  const path = join(root, name + '.utoc')
  const partitionPaths = fixture.data.map((_, index) => join(root, name + (index ? '_s' + index : '') + '.ucas'))
  await Promise.all([writeFile(path, fixture.toc), ...partitionPaths.map((file, index) => writeFile(file, fixture.data[index]))])
  return { ...fixture, path, partitionPaths }
}
