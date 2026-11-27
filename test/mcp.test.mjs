import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { AssetIndex } from '../core/asset-index.mjs'
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
      await writeFile(join(folder, 'sample.obj'), 'synthetic model')
      const { id } = await index.connect(folder)
      await index.scan(id)
      if (place === 'visible') allowed = id
      else hiddenAsset = index.search({ libraryId: id }).assets[0]
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
    assert.equal(tools.length, 7)
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
    assert.deepEqual((await call('list_duplicate_groups')).groups, [])
    assert.equal((await call('find_identical_assets', { hash: asset.hash })).assets.length, 1)
    const denied = await client.callTool({ name: 'get_asset', arguments: { id: hiddenAsset.id } })
    assert.equal(denied.isError, true)
    const invalid = await client.callTool({ name: 'list_assets', arguments: { limit: 200 } })
    assert.equal(invalid.isError, true)
  } finally { await client.close() }
})
