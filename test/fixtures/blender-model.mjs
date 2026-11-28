import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { locateBatchBlender } from '../../core/engines/blender/batch.mjs'

export async function readFbxGeometry(paths) {
  const blender = await locateBatchBlender()
  assert.ok(blender)
  const script = `
import bpy, json, sys
rows = []
for path in sys.argv[sys.argv.index('--') + 1:]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=path)
    meshes = [obj.data for obj in bpy.context.scene.objects if obj.type == 'MESH']
    for mesh in meshes:
        mesh.calc_loop_triangles()
    rows.append([sum(len(mesh.loop_triangles) for mesh in meshes), max(len(mesh.uv_layers) for mesh in meshes),
                 max(len(mesh.color_attributes) for mesh in meshes), sum(len(mesh.materials) for mesh in meshes)])
print('FBX_GEOMETRY ' + json.dumps(rows))
`
  const { stdout } = await promisify(execFile)(blender.executable, ['--background', '--factory-startup', '--disable-autoexec',
    '--python-exit-code', '1', '--python-expr', script, '--', ...paths], { timeout: 20_000, windowsHide: true })
  return JSON.parse(stdout.match(/^FBX_GEOMETRY (.*)$/m)[1])
}
