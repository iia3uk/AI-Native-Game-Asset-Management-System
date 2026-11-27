import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runBundleWorker } from '../../core/engines/unity/bundle/run.mjs'
import { readTexture } from './png.mjs'

export async function verifyStandaloneUnity(root, data, query, worker, version) {
  const originals = join(root, 'BundleProject', 'Assets', 'BundleFixture')
  const folder = join(root, 'standalone')
  await mkdir(folder)
  const mesh = join(originals, 'Triangle.asset')
  const meshBytes = await readFile(mesh)
  const assets = join(folder, 'mesh.assets')
  await copyFile(mesh, assets)
  await copyFile(join(originals, 'Albedo.asset'), join(folder, 'portrait.sharedAssets'))
  await writeFile(join(folder, 'editor.asset'), '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n')
  assert.deepEqual((await query('package-folder', folder)).packages, [
    { path: 'mesh.assets', format: 'unity-serialized' }, { path: 'portrait.sharedAssets', format: 'unity-serialized' },
  ])
  const plan = await query('package-inspect', mesh)
  assert.equal(plan.format, 'unity-serialized')
  assert.equal(plan.unityVersion, version)
  assert.equal(plan.containerVersion, meshBytes.readUInt32BE(8))
  assert.deepEqual(plan.assets.map(({ name, pathId, vertices, triangles }) => [name, pathId, vertices, triangles]),
    [['Triangle', '4300000', 6, 2]])
  await assert.rejects(readdir(data), { code: 'ENOENT' })
  const imported = await query('package-folder', folder, '--import')
  assert.equal(imported.results.length, 2)
  const [{ job: meshJob, scan: meshScan }, { job: textureJob, scan: textureScan }] = imported.results
  assert.deepEqual([meshScan.status, textureScan.status], ['completed', 'completed'])
  for (const [job, name, extension] of [[meshJob, 'Triangle', 'glb'], [textureJob, 'Albedo', 'png']]) {
    const { directory, library, report } = job.result
    assert.equal(report.packageFormat, 'unity-serialized')
    assert.equal(report.method, 'assetstools-unity-serialized')
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.assets.map(row => row.status), ['converted'])
    const { assets } = await query('search', name, '--library', library.id)
    assert.deepEqual(assets.map(asset => asset.ext), [extension])
    if (extension === 'glb') {
      const glb = await readFile(join(directory, manifest.assets[0].artifact.path))
      assert.equal(glb.toString('ascii', 0, 4), 'glTF')
      assert.equal(manifest.assets[0].artifact.method, 'assetstools-unity-serialized-static-mesh')
    } else {
      const { pixel } = await readTexture(manifest, directory, name, report.method)
      assert.deepEqual([pixel(0, 0), pixel(1, 3)], [[0, 96, 96, 255], [32, 0, 96, 255]])
    }
  }
  const repeated = await query('package-import', mesh)
  assert.equal(repeated.job.result.reused, true)
  assert.equal(repeated.job.result.directory, meshJob.result.directory)
  assert.deepEqual(await readFile(mesh), meshBytes)
  assert.deepEqual(await readFile(assets), meshBytes)

  const workspace = join(root, 'standalone-invalid')
  const invalid = Buffer.from(meshBytes)
  invalid.writeBigUInt64BE(BigInt(invalid.length + 1), 32)
  await mkdir(workspace)
  await writeFile(join(workspace, 'request.json'), '{"protocol":1,"inspectOnly":true,"outputLimit":0,"serialized":true}')
  await writeFile(join(workspace, 'input.bundle'), invalid)
  assert.deepEqual(await runBundleWorker(worker, workspace), {
    protocol: 1, status: 'failed', issue: 'unity-bundle-serialized-header',
  })
}
