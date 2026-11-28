import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { inflateSync } from 'node:zlib'
import { bc7Texture } from './fixtures/unreal-bc7-texture.mjs'
import { blockTextures } from './fixtures/unreal-bcn-texture.mjs'
import { cookedTexture } from './fixtures/unreal-cooked-texture.mjs'
import { writeIoStoreFixture } from './fixtures/unreal-iostore.mjs'
import { makePak } from './fixtures/unreal-pak.mjs'
import { zenTexturePackage } from './fixtures/unreal-zen-texture.mjs'
import { testDirectory } from './server-fixture.mjs'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))

async function inspectPng(directory, product, expected) {
  assert.equal(product.status, 'converted')
  assert.equal(product.pixelFormat, expected.format)
  assert.equal(product.srgb, expected.srgb ?? false)
  assert.equal(product.normalZReconstructed, expected.normalMap)
  const png = await readFile(join(directory, product.path))
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [expected.width, expected.height])
  assert.equal(png.toString('ascii', 37, 41), expected.srgb ? 'sRGB' : 'gAMA')
  if (!expected.srgb) assert.equal(png.readUInt32BE(41), 100000)
  const idat = 45 + png.readUInt32BE(33)
  assert.equal(png.toString('ascii', idat + 4, idat + 8), 'IDAT')
  const rows = inflateSync(png.subarray(idat + 8, idat + 8 + png.readUInt32BE(idat)))
  assert.deepEqual([...rows], expected.rows.flatMap(row => [0, ...row]))
  return png
}

function createQuery(root) {
  const env = { ...process.env, ASSET_VIEWER_DATA_DIR: join(root, 'data') }
  return async (...args) => {
    const { stdout } = await run(process.execPath, [cli, ...args, '--json'], { env, windowsHide: true })
    return JSON.parse(stdout)
  }
}

async function importPath(query, path) {
  const { job, scan } = await query('package-import', path)
  assert.equal(job.status, 'completed', job.error)
  assert.equal(scan.status, 'completed', scan.error)
  const { directory, report, reused } = job.result
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json')))
  return { jobId: job.id, rows: manifest.entries ?? manifest.assets, directory, report, reused }
}

test('loose, Pak and IoStore imports publish linear BC4 masks and distinguish BC5 vectors from normals',
  { skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 30_000 }, async t => {
    const root = await testDirectory(t)
    const loose = join(root, 'Content')
    await mkdir(loose)
    const files = blockTextures.flatMap(texture => cookedTexture({ ...texture, external: true }))
    const normal = blockTextures[2]
    files.push(...cookedTexture({ ...normal, name: 'MalformedBC5', pixels: normal.pixels.subarray(0, -1), external: true }))
    await Promise.all(files.map(file => writeFile(join(loose, file.path), file.content)))
    const pak = join(root, 'TextureBlocks.pak')
    await writeFile(pak, makePak(files))
    const query = createQuery(root)
    for (const path of [loose, pak]) {
      const { rows, directory, report } = await importPath(query, path)
      const texture = name => rows.find(row => (row.sourcePath ?? row.path).split('/').at(-1) === name + '.uasset').exports[0]
      assert.deepEqual(report.unrealCooked?.textures ?? report.textures, { converted: 3, skipped: 1, failed: 0 })
      for (const expected of blockTextures) await inspectPng(directory, texture(expected.name), expected)
      assert.equal(texture('MalformedBC5').issue, 'unreal-cooked-texture-mip')
    }
    const digests = ['39f47aff2676233d4322ab627a4e0ce5c9f5e095', '73231bc2dfac0b1ad3ef7d42671f4d9dc0bef821']
    const fixture = await writeIoStoreFixture(root, 'TextureBlocks', {
      primary: { ...zenTexturePackage({ mode: 'external', ...normal }), digests },
    })
    const { rows, directory, report } = await importPath(query, fixture.path)
    const [product] = rows.find(row => row.kind === 'package').exports
    assert.deepEqual(report.textures, { converted: 1, skipped: 0, failed: 0 }, product.issue)
    await inspectPng(directory, product, normal)
  })

test('cooked BC7 textures preserve RGB, alpha, color space and clipped blocks in loose, Pak and IoStore imports',
  { skip: process.env.ASSET_VIEWER_TEST_CUE4PARSE !== '1', timeout: 40_000 }, async t => {
    const root = await testDirectory(t)
    const loose = join(root, 'Content')
    const destination = join(root, 'Export')
    await Promise.all([mkdir(loose), mkdir(destination)])
    const query = createQuery(root)
    const expectedColor = { ...bc7Texture, srgb: true }
    const expectedLinear = { ...bc7Texture, name: 'DataBC7', srgb: false }
    const damaged = Buffer.from(bc7Texture.pixels)
    damaged[48] = 0
    const files = [
      ...cookedTexture(expectedColor),
      ...cookedTexture({ ...expectedLinear, external: true }),
      ...cookedTexture({ ...expectedColor, name: 'InvalidBC7', pixels: damaged }),
      ...cookedTexture({ ...expectedColor, name: 'ShortBC7', pixels: bc7Texture.pixels.subarray(0, -1) }),
    ]
    await Promise.all(files.map(file => writeFile(join(loose, file.path), file.content)))
    const pak = join(root, 'BC7.pak')
    const pakBytes = makePak(files)
    await writeFile(pak, pakBytes)
    for (const source of [loose, pak]) {
      const { jobId, rows, directory, report } = await importPath(query, source)
      const entry = name => rows.find(row => (row.sourcePath ?? row.path).split('/').at(-1) === name + '.uasset')
      assert.deepEqual(report.unrealCooked?.textures ?? report.textures, { converted: 2, skipped: 2, failed: 0 })
      await inspectPng(directory, entry(expectedColor.name).exports[0], expectedColor)
      const mask = entry(expectedLinear.name)
      const [product] = mask.exports
      const png = await inspectPng(directory, product, expectedLinear)
      assert.equal(entry('InvalidBC7').exports[0].issue, 'unreal-cooked-texture-bc7-mode')
      assert.equal(entry('ShortBC7').exports[0].issue, 'unreal-cooked-texture-mip')
      const args = ['package-export', jobId, destination, '--asset', String(rows.indexOf(mask))]
      const plan = await query(...args)
      const exported = await query(...args, '--plan-key', plan.key)
      assert.deepEqual(await readFile(join(exported.directory, product.path)), png)
      assert.equal((await importPath(query, source)).reused, true)
    }
    for (const [index, [pixels, bulkDigest]] of [
      [bc7Texture.pixels, '637bddd7b15e245831ea5c74ad85d58254e74efb'],
      [damaged, 'a0a3393cc8a1dbb7e97861fd4a9393fccee816d2'],
    ].entries()) {
      const fixture = await writeIoStoreFixture(root, 'BC7-' + index, {
        primary: { ...zenTexturePackage({ mode: 'external', ...bc7Texture, pixels }),
          digests: ['e3617bab7b185ed540b6e9cccc18fe0e10fbe0f9', bulkDigest] },
      })
      const { directory, rows, report } = await importPath(query, fixture.path)
      const [product] = rows.find(row => row.kind === 'package').exports
      if (index === 0) {
        assert.deepEqual(report.textures, { converted: 1, skipped: 0, failed: 0 }, product.issue)
        await inspectPng(directory, product, expectedLinear)
        assert.equal((await importPath(query, fixture.path)).reused, true)
      } else {
        assert.equal(product.issue, 'unreal-iostore-texture-bc7-mode')
      }
      assert.deepEqual(await readFile(fixture.path), fixture.toc)
      assert.deepEqual(await readFile(fixture.partitionPaths[1]), fixture.data[1])
    }
    assert.deepEqual(await readFile(pak), pakBytes)
    for (const file of files) assert.deepEqual(await readFile(join(loose, file.path)), file.content)
  })
