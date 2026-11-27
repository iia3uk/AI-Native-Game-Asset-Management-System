import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { startServer, testDirectory } from './server-fixture.mjs'

test('loopback policy, asset types and byte ranges', { timeout: 15000 }, async t => {
  const directory = await testDirectory(t)
  const server = await startServer(directory)
  try {
    const page = await server.request('/')
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
    assert.equal((await server.request('/api/library', { headers: { Origin: 'https://example.test' } })).status, 403)
    assert.equal((await server.post('/api/folder', { path: directory }, { Origin: '' })).status, 403)
    assert.equal((await server.post('/api/folder', { path: directory }, { 'Content-Type': 'text/plain' })).status, 403)

    const hostStatus = await new Promise((resolve, reject) => {
      const req = request(server.origin, { headers: { Host: 'example.test' } }, response => {
        response.resume()
        resolve(response.statusCode)
      })
      req.on('error', reject).end()
    })
    assert.equal(hostStatus, 403)

    const assets = join(directory, 'assets')
    await mkdir(assets)
    await writeFile(join(assets, 'sample.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const added = await server.post('/api/folder', { path: assets })
    assert.equal(added.status, 200)
    const { resources: [file] } = await added.json()
    const partial = await server.request(file.url, { headers: { Range: 'bytes=0-3' } })
    assert.equal(partial.status, 206)
    assert.equal(await partial.text(), '<svg')
    assert.match(partial.headers.get('content-security-policy'), /^sandbox;/)
    assert.equal((await server.request(file.url, { headers: { Range: 'bytes=999-1000' } })).status, 416)
  } finally {
    await server.close()
  }
})

test('Fab reviews remain compatible and linked metadata and assets stay outside the catalog', { timeout: 15000 }, async t => {
  const directory = await testDirectory(t)
  const packs = join(directory, 'fab', 'Viewer', 'packs')
  const assets = join(directory, 'assets')
  const untargeted = join(directory, 'untargeted')
  await Promise.all([mkdir(packs, { recursive: true }), mkdir(assets), mkdir(untargeted)])
  const id = '01234567-0123-0123-0123-012345678901'
  const fileId = '0123456789abcdef01234567'
  const pack = { id, title: 'Synthetic pack', files: [{ id: fileId, path: 'cube.glb' }] }
  await writeFile(join(packs, id + '.json'), JSON.stringify(pack))
  await writeFile(join(untargeted, 'cube.glb'), 'test fixture')
  await symlink(untargeted, join(assets, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(untargeted, join(packs, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const server = await startServer(directory)
  try {
    const added = await server.post('/api/folder', { path: assets })
    assert.equal(added.status, 200)
    assert.deepEqual((await added.json()).resources, [])
    const result = await server.post('/api/review', { pack: id, file: fileId, status: 'later', note: 'Synthetic note' })
    assert.equal(result.status, 200)
    const selection = JSON.parse(await readFile(join(server.fab, 'Viewer', 'selections.json'), 'utf8'))
    assert.equal(selection.entries[id + ':' + fileId].note, 'Synthetic note')
    const fetched = await server.request('/api/review')
    assert.deepEqual(await fetched.json(), selection)

    const linkedFab = join(directory, 'other-fab')
    await mkdir(linkedFab)
    await symlink(join(server.fab, 'Viewer'), join(linkedFab, 'Viewer'), process.platform === 'win32' ? 'junction' : 'dir')
    const blocked = await startServer(directory, { FAB_ASSETS_ROOT: linkedFab })
    try {
      assert.equal((await blocked.request('/api/packs/' + id)).status, 404)
      assert.equal((await blocked.post('/api/review', { pack: id, file: fileId, status: 'excluded', note: '' })).status, 404)
      const unchanged = JSON.parse(await readFile(join(server.fab, 'Viewer', 'selections.json'), 'utf8'))
      assert.deepEqual(unchanged, selection)
    } finally {
      await blocked.close()
    }
  } finally {
    await server.close()
  }
})
