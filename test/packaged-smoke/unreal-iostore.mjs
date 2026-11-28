import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { writeIoStoreFixture } from '../fixtures/unreal-iostore.mjs'
import { testDirectory } from '../server-fixture.mjs'

const run = promisify(execFile)
const packaged = resolve(process.env.ASSET_VIEWER_TEST_PACKAGED_DIR || 'release/win-unpacked')
const executable = join(packaged, 'Asset Viewer.exe')
const script = join(packaged, 'resources', 'app.asar', 'scripts', 'asset-viewer.mjs')

test('The packaged Windows importer verifies and indexes a multi-partition Unreal IoStore', { timeout: 35_000 }, async t => {
  const root = await testDirectory(t)
  const source = join(root, 'Incoming IoStore')
  await mkdir(source)
  const { path, partitionPaths, payloads } = await writeIoStoreFixture(source, 'Installed')
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ASSET_VIEWER_CUE4PARSE: '',
    ASSET_VIEWER_DATA_DIR: join(root, 'data') }
  const cli = async (...args) => JSON.parse((await run(executable, [script, ...args, '--json'],
    { env, windowsHide: true, timeout: 10_000 })).stdout)
  const plan = await cli('package-inspect', path)
  assert.equal(plan.format, 'unreal-iostore')
  assert.equal(plan.partitions, 2)
  const { job, scan } = await cli('package-import', partitionPaths[1])
  assert.equal(job.status, 'completed', job.error)
  assert.equal(scan.status, 'completed', scan.error)
  assert.equal(job.sourceKey, plan.hash)
  const { directory, report } = job.result
  assert.deepEqual(report.extractedTypes, { package: 1, bulk: 1, file: 1, registry: 0 })
  const { entries } = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const sound = entries.find(row => row.kind === 'file')
  assert.deepEqual(await readFile(join(directory, sound.artifact.path)), payloads.audio)
  const cached = await cli('package-import', path)
  assert.equal(cached.job.result.reused, true)
  assert.equal(cached.job.result.directory, directory)
})
