import { unrealPackageSummary } from '../../../packages/unreal/package-summary.mjs'
import { texturePngSource } from '../../../engines/unreal/source-texture/png-source.mjs'
import { bulkMagic, inflateSourceChunks } from './chunks.mjs'
import { swapPngRedBlue } from '../../../files/png-channel-order.mjs'
import { embeddedPng, pngMagic } from '../../../files/png-structure.mjs'
import { embeddedWave, waveMagic } from './wave.mjs'

const signature = Buffer.from('c1832a9e', 'hex')
const scanSize = 1024 ** 2
const classMarker = value => Buffer.concat([Buffer.from([value.length + 1, 0, 0, 0]), Buffer.from(value + '\0')])
const soundClass = classMarker('SoundWave')
const textureClass = classMarker('Texture2D')
const sourcePngTypes = new Map([
  ['TSF_BGRA8', 0x0806], ['TSF_RGBA8', 0x0806], ['TSF_RGBA16', 0x1006], ['TSF_G8', 0x0800], ['TSF_G16', 0x1000],
])

function* candidates(bytes, signature, begin, end) {
  const bounded = bytes.subarray(begin, end)
  let cursor = 0
  for (let i = 0; i < 64; i++) {
    const offset = bounded.indexOf(signature, cursor)
    if (offset < 0) return
    yield begin + offset
    cursor = offset + signature.length
  }
}

function findWave(bytes, headerSize, end) {
  for (const offset of candidates(bytes, waveMagic, headerSize, headerSize + scanSize)) {
    const { end: waveEnd, ...metadata } = embeddedWave(bytes, offset) ?? {}
    if (waveEnd === end) return { format: 'wav', role: 'audio', bytes: bytes.subarray(offset, end), ...metadata }
  }
  return null
}

function readSourceImage(bytes, source, signal) {
  const { start, end, length, zlib, sourceFormat, width, height } = source
  const png = zlib ? inflateSourceChunks(bytes, start, end, signal) : bytes.subarray(start, end)
  if (png?.length !== length) return null
  const image = embeddedPng(png, 0)
  if (image?.end !== length || image.width !== width || image.height !== height ||
      sourcePngTypes.get(sourceFormat) !== png.readUInt16BE(24)) return null
  const changeOrder = sourceFormat === 'TSF_BGRA8'
  const data = changeOrder ? swapPngRedBlue(png, signal) : png
  return data && { format: 'png', role: 'texture', bytes: data, width, height, sourceFormat,
    ...(changeOrder && { channelOrder: 'bgra-to-rgba' }) }
}

function findImage(bytes, version, headerSize, end, signal) {
  const source = texturePngSource(bytes, version, end)
  if (source !== undefined) return source && readSourceImage(bytes, source, signal)
  for (const offset of candidates(bytes, pngMagic, headerSize, headerSize + scanSize)) {
    const { end: imageEnd, ...metadata } = embeddedPng(bytes, offset) ?? {}
    if (imageEnd === end || imageEnd === end - 4) {
      return { format: 'png', role: 'texture', bytes: bytes.subarray(offset, imageEnd), ...metadata }
    }
  }
  for (const offset of candidates(bytes, bulkMagic, headerSize, headerSize + scanSize)) {
    const decoded = inflateSourceChunks(bytes, offset, end, signal)
    if (!decoded) continue
    const { end: imageEnd, ...metadata } = embeddedPng(decoded, 0) ?? {}
    if (imageEnd === decoded.length) return { format: 'png', role: 'texture', bytes: decoded, ...metadata }
  }
  return null
}

export function unrealSourceMedia(bytes, signal) {
  const { storage, ue4, ue5, issue, headerSize, nameOffset } = unrealPackageSummary(bytes.subarray(0, 48 * 1024),
    bytes.length, { details: true })
  if (storage !== 'editor' || ue5 !== 0 || issue || !nameOffset || headerSize > 2 * scanSize ||
      !bytes.subarray(-4).equals(signature)) return null
  const end = bytes.length - signature.length
  const header = bytes.subarray(nameOffset, headerSize)
  if (header.includes(soundClass)) {
    const wave = findWave(bytes, headerSize, end)
    if (wave) return wave
  }
  if (header.includes(textureClass)) return findImage(bytes, ue4, headerSize, end, signal)
  return null
}
