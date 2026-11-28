import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { inflateSync } from 'node:zlib'
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
  assert.equal(product.srgb, false)
  assert.equal(product.normalZReconstructed, expected.normalMap)
  const png = await readFile(join(directory, product.path))
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [expected.width, expected.height])
  assert.equal(png.toString('ascii', 37, 41), 'gAMA')
  assert.equal(png.readUInt32BE(41), 100000)
  assert.equal(png.toString('ascii', 53, 57), 'IDAT')
  const rows = inflateSync(png.subarray(57, 57 + png.readUInt32BE(49)))
  assert.deepEqual([...rows], expected.rows.flatMap(row => [0, ...row]))
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
    const env = { ...process.env, ASSET_VIEWER_DATA_DIR: join(root, 'data') }
    const importPath = async path => {
      const { stdout } = await run(process.execPath, [cli, 'package-import', path, '--json'], { env })
      const { job, scan } = JSON.parse(stdout)
      assert.equal(job.status, 'completed', job.error)
      assert.equal(scan.status, 'completed', scan.error)
      const { directory } = job.result
      const manifest = JSON.parse(await readFile(join(directory, 'manifest.json')))
      return { rows: manifest.entries ?? manifest.assets, directory, report: job.result.report }
    }
    for (const path of [loose, pak]) {
      const { rows, directory, report } = await importPath(path)
      const texture = name => rows.find(row => (row.sourcePath ?? row.path).split('/').at(-1) === name + '.uasset').exports[0]
      assert.deepEqual(report.unrealCooked?.textures ?? report.textures, { converted: 3, skipped: 1, failed: 0 })
      for (const expected of blockTextures) await inspectPng(directory, texture(expected.name), expected)
      assert.equal(texture('MalformedBC5').issue, 'unreal-cooked-texture-mip')
    }
    const digests = ['39f47aff2676233d4322ab627a4e0ce5c9f5e095', '73231bc2dfac0b1ad3ef7d42671f4d9dc0bef821']
    const fixture = await writeIoStoreFixture(root, 'TextureBlocks', {
      primary: { ...zenTexturePackage({ mode: 'external', ...normal }), digests },
    })
    const { rows, directory, report } = await importPath(fixture.path)
    const [product] = rows.find(row => row.kind === 'package').exports
    assert.deepEqual(report.textures, { converted: 1, skipped: 0, failed: 0 }, product.issue)
    await inspectPng(directory, product, normal)
  })
