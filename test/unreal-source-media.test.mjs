import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { unrealSourceMedia } from '../core/conversion/unreal/source-media/payload.mjs'
import { readPngRgb } from '../core/files/png-rgb.mjs'
import { sourcePng, sourceWave, ue4CompressedSource, ue4SourceFixture } from './fixtures/unreal-source-media.mjs'
import { rgbaSourceRows, sourceArtPackage, sourceArtPng } from './fixtures/unreal-source-texture.mjs'
import { testDirectory } from './server-fixture.mjs'

test('UE4 source media skips thumbnails and rejects corrupt PNG, chunks and non-PCM WAV', () => {
  assert.equal(unrealSourceMedia(ue4SourceFixture('Texture2D', Buffer.alloc(12))), null)
  const png = unrealSourceMedia(ue4SourceFixture('Texture2D', ue4CompressedSource(sourcePng), { legacy: true }))
  assert.deepEqual(png, { format: 'png', role: 'texture', bytes: sourcePng, width: 2, height: 2 })
  assert.deepEqual(unrealSourceMedia(ue4SourceFixture('Texture2D', sourcePng)), png)
  assert.equal(unrealSourceMedia(ue4SourceFixture('Texture2D', sourcePng, { flags: 0x200 })), null)
  const badPng = Buffer.from(sourcePng)
  badPng[badPng.length - 1] ^= 1
  assert.equal(unrealSourceMedia(ue4SourceFixture('Texture2D', badPng)), null)
  const chunks = ue4CompressedSource(sourcePng)
  chunks.writeBigUInt64LE(64n * 1024n ** 2n + 1n, 24)
  assert.equal(unrealSourceMedia(ue4SourceFixture('Texture2D', chunks)), null)
  const wave = sourceWave()
  assert.deepEqual(unrealSourceMedia(ue4SourceFixture('SoundWave', wave)),
    { format: 'wav', role: 'audio', bytes: wave, audio: { channels: 1, sampleRate: 44100, bits: 16, frames: 4 } })
  assert.equal(unrealSourceMedia(ue4SourceFixture('SoundWave', wave, { footer: Buffer.alloc(4) })), null)
  wave.writeUInt32LE(0xffffffff, 40)
  assert.equal(unrealSourceMedia(ue4SourceFixture('SoundWave', wave)), null)
})

test('UE4 source Texture2D checks its native payload and reverses BGRA storage losslessly', () => {
  const png = sourceArtPng()
  for (const options of [{}, { compressed: true, legacy: true }, { compressed: true, earlyTexture: true }]) {
    const image = unrealSourceMedia(sourceArtPackage(png, options))
    assert.equal(image.sourceFormat, 'TSF_BGRA8')
    assert.equal(image.channelOrder, 'bgra-to-rgba')
    assert.match(image.bytes.toString('latin1'), /sRGB/)
    assert.deepEqual(readPngRgb(image.bytes).rows, rgbaSourceRows)
  }
  const color = unrealSourceMedia(sourceArtPackage(png, { format: 'TSF_RGBA8' }))
  assert.deepEqual(color.bytes, png)
  assert.equal(color.channelOrder, undefined)
  for (const [depth, colorType, size, format] of [[8, 0, 6, 'TSF_G8'], [16, 6, 34, 'TSF_RGBA16']]) {
    const original = sourceArtPng({ depth, colorType, rows: Buffer.alloc(size) })
    assert.deepEqual(unrealSourceMedia(sourceArtPackage(original, { format })).bytes, original)
  }
  for (const options of [{ width: 4 }, { offset: 1 }, { pngCompressed: false }, { format: 'TSF_G8' }]) {
    assert.equal(unrealSourceMedia(sourceArtPackage(png, options)), null)
  }
  assert.equal(unrealSourceMedia(sourceArtPackage(sourceArtPng({ rows: Buffer.alloc(17) }))), null)
})

test('a loose Unreal asset pack without a descriptor indexes PCM and correctly ordered source textures', async t => {
  const root = await testDirectory(t)
  const pack = join(root, 'UE4 standalone assets')
  await mkdir(join(pack, 'Nested'), { recursive: true })
  const wave = sourceWave()
  await writeFile(join(pack, 'Step.uasset'), ue4SourceFixture('SoundWave', wave))
  await writeFile(join(pack, 'Nested/Wall.uasset'), ue4SourceFixture('Texture2D', sourcePng))
  const sourceArt = sourceArtPackage(sourceArtPng(), { compressed: true })
  await writeFile(join(pack, 'Nested/SourceArt.uasset'), sourceArt)
  const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))
  const exec = promisify(execFile)
  const run = async (...args) => JSON.parse((await exec(process.execPath, [cli, ...args, '--json'], {
    env: { ...process.env, ASSET_VIEWER_DATA_DIR: join(root, 'app') }, windowsHide: true,
  })).stdout)
  const { job, scan } = await run('package-import', pack)
  assert.equal(job.status, 'completed')
  assert.equal(scan.result.assets, 6)
  assert.equal(job.result.report.packageFormat, 'unreal-content')
  assert.deepEqual(job.result.report.media, { wav: 1, png: 2 })
  const directory = job.result.directory
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const artifacts = manifest.assets.flatMap(entry => entry.exports)
  assert.deepEqual(artifacts.map(artifact => artifact.path).sort(),
    ['Audio/Step.wav', 'Textures/Nested/SourceArt.png', 'Textures/Nested/Wall.png'])
  for (const artifact of artifacts) {
    assert.equal(artifact.method, 'unreal-editor-source-media')
    const content = await readFile(join(directory, artifact.path))
    if (artifact.path.endsWith('SourceArt.png')) {
      assert.equal(artifact.channelOrder, 'bgra-to-rgba')
      assert.equal(artifact.converterVersion, 1)
      assert.deepEqual(readPngRgb(content).rows, rgbaSourceRows)
    } else {
      assert.deepEqual(content, artifact.format === 'wav' ? wave : sourcePng)
    }
  }
  assert.deepEqual(await readFile(join(pack, 'Nested/SourceArt.uasset')), sourceArt)
  assert.equal((await run('package-import', pack)).job.result.reused, true)
})
