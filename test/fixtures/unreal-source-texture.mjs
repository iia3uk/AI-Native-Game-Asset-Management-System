import { deflateSync } from 'node:zlib'
import { pngChunk } from '../../core/files/png.mjs'
import { pngMagic } from '../../core/files/png-structure.mjs'
import { editorFixture } from './unreal-editor-package.mjs'
import { ue4CompressedSource } from './unreal-source-media.mjs'

export const rgbaSourceRows = Buffer.from([
  0, 10, 20, 30, 40, 40, 50, 60, 80,
  0, 33, 34, 35, 10, 3, 25, 90, 255,
])

export function sourceArtPng({ depth = 8, colorType = 6, rows = Buffer.from([
  1, 30, 20, 10, 40, 30, 30, 30, 40,
  2, 5, 14, 23, 226, 30, 231, 219, 175,
]) } = {}) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2)
  header.writeUInt32BE(2, 4)
  header.set([depth, colorType], 8)
  const compressed = deflateSync(rows)
  return Buffer.concat([pngMagic, pngChunk('IHDR', header), pngChunk('sRGB', Buffer.from([0])),
    pngChunk('IDAT', compressed.subarray(0, 4)), pngChunk('IDAT', compressed.subarray(4)),
    pngChunk('IEND', Buffer.alloc(0))])
}

export function sourceArtPackage(png, { format = 'TSF_BGRA8', compressed = false, width = 2, offset = 0,
  pngCompressed = true, legacy = false, earlyTexture = false } = {}) {
  return editorFixture(({ i32, tag, struct, none, enumValue, bool }) => {
    const source = struct('Source', 'TextureSource', Buffer.concat([
      tag('SizeX', 'IntProperty', i32(width)), tag('SizeY', 'IntProperty', i32(2)),
      tag('NumSlices', 'IntProperty', i32(1)), tag('NumMips', 'IntProperty', i32(1)),
      bool('bPNGCompressed', pngCompressed), enumValue('Format', 'ETextureSourceFormat', format), none,
    ]))
    const data = compressed ? ue4CompressedSource(png) : png
    const bulkHeader = Buffer.alloc(20)
    bulkHeader.writeUInt32LE(compressed ? 3 : 1)
    bulkHeader.writeInt32LE(png.length, 4)
    bulkHeader.writeInt32LE(data.length, 8)
    bulkHeader.writeBigInt64LE(BigInt(offset), 12)
    const texture = Buffer.concat([source, none, Buffer.alloc(6), bulkHeader, Buffer.alloc(6)])
    return { imports: [['Class', 'Texture2D', -2], ['Package', '/Script/Engine']],
      objects: [[-1, 'T_SourceArt', 0, texture]], bulk: data }
  }, { legacy, earlyTexture })
}
