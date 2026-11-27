import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AssetIndex } from '../core/asset-index.mjs'
import { ProcessingWorker } from '../core/processing-worker.mjs'
import { ThumbnailCache } from '../core/thumbnail-cache.mjs'
import { testDirectory } from './server-fixture.mjs'

test('stdio MCP exposes bounded read-only tools and filters the configured libraries', { timeout: 15000 }, async t => {
  const directory = await testDirectory(t)
  const data = join(directory, 'data')
  const index = await AssetIndex.open(join(data, 'index.sqlite'))
  let allowed, hiddenAsset
  try {
    for (const place of ['visible', 'hidden']) {
      const folder = join(directory, place)
      await mkdir(folder)
      await writeFile(join(folder, 'sample.obj'), 'mtllib first.mtl second.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')
      const { id } = await index.connect(folder)
      await index.scan(id)
      const asset = index.search({ libraryId: id }).assets[0]
      if (place === 'visible') {
        allowed = id
        const job = index.jobs.enqueueThumbnail(index.thumbnailSource(asset.id))
        const cache = new ThumbnailCache(join(data, 'cache', 'thumbnails'))
        const worker = new ProcessingWorker(index, { type: 'thumbnail', cache })
        try { assert.equal((await worker.wait(job.id, AbortSignal.timeout(5000))).status, 'completed') }
        finally { await worker.stop() }
      } else hiddenAsset = asset
    }
  } finally {
    await index.close()
  }
  const client = new Client({ name: 'asset-viewer-test', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../scripts/asset-viewer.mjs', import.meta.url)), 'mcp'],
    env: { ASSET_VIEWER_DATA_DIR: data, ASSET_VIEWER_MCP_LIBRARIES: allowed },
    stderr: 'pipe',
  })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    assert.equal(tools.length, 10)
    assert.ok(tools.every(tool => tool.annotations.readOnlyHint))
    const call = async (name, args = {}) => {
      const response = await client.callTool({ name, arguments: args })
      assert.equal(response.isError, undefined, JSON.stringify(response.content))
      return JSON.parse(response.content[0].text)
    }
    const { libraries: [library, ...other] } = await call('list_libraries')
    assert.equal(library.id, allowed)
    assert.equal(library.root, undefined)
    assert.deepEqual(other, [])
    const { assets: [asset] } = await call('search_assets', { q: 'sample' })
    assert.equal(asset.libraryId, allowed)
    assert.equal((await call('get_asset_metadata', { id: asset.id })).root, undefined)
    const { profiles } = await call('list_quality_profiles')
    assert.equal(profiles.length, 6)
    const analysis = await call('get_asset_analysis', { id: asset.id, profileId: 'mobile-game', limit: 1 })
    assert.equal(analysis.metrics.vertices, 3)
    assert.deepEqual(analysis.dependencies.map(item => item.path), ['first.mtl'])
    assert.equal(analysis.nextOffset, 1)
    assert.equal(analysis.validation.status, 'fail')
    assert.equal(analysis.validation.checks.find(check => check.key === 'requireVerifiedDependencies').actual, 2)
    const remaining = await call('get_asset_analysis', { id: asset.id, offset: analysis.nextOffset })
    assert.deepEqual(remaining.dependencies.map(item => item.path), ['second.mtl'])
    assert.equal(remaining.nextOffset, null)
    const preview = await client.callTool({ name: 'get_asset_preview', arguments: { id: asset.id } })
    assert.equal(JSON.parse(preview.content[0].text).status, 'available')
    assert.equal(preview.content[1].mimeType, 'image/png')
    assert.equal(Buffer.from(preview.content[1].data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.deepEqual((await call('list_duplicate_groups')).groups, [])
    assert.equal((await call('find_identical_assets', { hash: asset.hash })).assets.length, 1)
    const denied = await client.callTool({ name: 'get_asset', arguments: { id: hiddenAsset.id } })
    assert.equal(denied.isError, true)
    assert.equal((await client.callTool({ name: 'get_asset_analysis', arguments: { id: hiddenAsset.id } })).isError, true)
    assert.equal((await client.callTool({ name: 'get_asset_preview', arguments: { id: hiddenAsset.id } })).isError, true)
    const invalid = await client.callTool({ name: 'list_assets', arguments: { limit: 200 } })
    assert.equal(invalid.isError, true)
  } finally { await client.close() }
})
