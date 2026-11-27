import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { testDirectory } from './server-fixture.mjs'

const run = promisify(execFile)
const script = fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url))

test('CLI uses the shared index and dry runs leave the database unchanged', async t => {
  const directory = await testDirectory(t)
  const library = join(directory, 'samples')
  const data = join(directory, 'data')
  await mkdir(library)
  await writeFile(join(library, 'test.obj'), 'o fixture\nv 0 0 0')
  const cli = async (...args) => {
    const { stdout } = await run(process.execPath, [script, ...args, '--json'], {
      env: { ...process.env, ASSET_VIEWER_DATA_DIR: data }, windowsHide: true,
    })
    return JSON.parse(stdout)
  }
  assert.equal((await cli('doctor')).initialized, false)
  assert.equal((await cli('connect', library, '--dry-run')).dryRun, true)
  await assert.rejects(stat(data), { code: 'ENOENT' })
  assert.equal((await cli('connect', library, '--dry-run')).root, library)
  const { id } = await cli('connect', library)
  assert.equal((await cli('scan', id, '--dry-run')).files, 1)
  assert.equal((await cli('libraries'))[0].assets, 0)
  assert.equal((await cli('scan', id)).hashed, 1)
  const hit = (await cli('search', 'test', '--kind', 'model')).assets[0]
  assert.equal(hit.name, 'test.obj')
  assert.equal((await cli('inspect', hit.id)).versions.length, 1)
  assert.equal((await cli('export', '--library', id)).assets[0].id, hit.id)
  assert.equal((await cli('doctor')).ok, true)
  assert.ok((await stat((await cli('backup')).path)).size > 0)
  await assert.rejects(cli('search', '--unknown', 'bad'), { code: 2 })
})
