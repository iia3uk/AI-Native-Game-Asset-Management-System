import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VTKLoader } from 'three/addons/loaders/VTKLoader.js'
import { geometryModel, parseOff } from '../public/extra-models.js'
import { blenderModels, browserImages, browserModels, formatOrder, imageFormats, modelFormats } from '../core/files/formats.mjs'

test('preview format registry covers direct models, Blender conversion and raster files', () => {
  assert.ok(browserModels.has('3dm') && browserModels.has('bvh') && browserModels.has('vrm'))
  assert.ok(blenderModels.has('usd') && blenderModels.has('usdz') && blenderModels.has('abc'))
  assert.ok(browserImages.has('svg') && imageFormats.has('hdr') && imageFormats.has('ktx2'))
  assert.ok(formatOrder.every(ext => modelFormats.has(ext)))
  assert.equal(formatOrder.length, modelFormats.size)
})

test('OFF triangulates concave polygons and preserves clockwise and counterclockwise winding', () => {
  const vertices = '0 0 0\n2 0 0\n2 2 0\n1 1 0\n0 2 0\n'
  for (const [polygon, sign] of [['5 0 1 2 3 4', 1], ['5 4 3 2 1 0', -1]]) {
    const geometry = parseOff('OFF 5 1 0\n' + vertices + polygon)
    assert.equal(geometry.index.count, 9)
    const model = geometryModel(geometry)
    assert.equal(model.geometry.getAttribute('normal').getZ(1), sign)
    model.geometry.dispose()
    model.material.dispose()
  }
})

test('COFF can display colored points and rejects invalid face references', () => {
  const geometry = parseOff('COFF\n2 0 0\n0 0 0 255 0 0 255\n1 1 1 0 0 255 255\n')
  assert.deepEqual([...geometry.getAttribute('color').array], [1, 0, 0, 0, 0, 1])
  const model = geometryModel(geometry, true)
  assert.equal(model.isPoints, true)
  assert.throws(() => parseOff('OFF\n3 1 0\n0 0 0\n1 0 0\n0 1 0\n3 0 1 3\n'), /грань OFF/)
  model.geometry.dispose()
  model.material.dispose()
})

test('legacy ASCII VTK also accepts headers and geometry shorter than 250 bytes', () => {
  const source = new TextEncoder().encode('# vtk DataFile Version 3.0\nTriangle\nASCII\nDATASET POLYDATA\n' +
    'POINTS 3 float\n0 0 0 2 0 0 0 2 0\nPOLYGONS 1 4\n3 0 1 2\n')
  const geometry = new VTKLoader().parse(source.buffer)
  assert.equal(geometry.index.count, 3)
  geometry.dispose()
})
