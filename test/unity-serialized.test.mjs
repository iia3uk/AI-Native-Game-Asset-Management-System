import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bundleDecoderRevision, bundleResult } from '../core/engines/unity/bundle/protocol.mjs'
import { isSerializedUnity, serializedProbeSize } from '../core/engines/unity/serialized/header.mjs'

test('standalone Unity probing checks the declared file size, metadata, endianness and version', () => {
  const prefix = Buffer.alloc(serializedProbeSize)
  prefix.writeUInt32BE(22, 8)
  prefix.writeUInt32BE(72, 20)
  prefix.writeBigUInt64BE(500n, 24)
  prefix.writeBigUInt64BE(128n, 32)
  prefix.write('6000.3.10f1', 48, 'ascii')
  assert.equal(isSerializedUnity(prefix, 500), true)
  prefix.writeUInt32BE(23, 8)
  assert.equal(isSerializedUnity(prefix, 500), true)
  assert.equal(isSerializedUnity(prefix, 501), false)
  assert.equal(isSerializedUnity(prefix.subarray(0, 59), 500), false)
  assert.equal(isSerializedUnity(Buffer.from('%YAML 1.1\n'), 500), false)
  for (const [offset, value] of [[11, 21], [11, 24], [16, 1], [20, 0xff], [39, 64], [48, 0]]) {
    const changed = Buffer.from(prefix)
    changed[offset] = value
    assert.equal(isSerializedUnity(changed, 500), false)
  }
})

test('standalone decoder reports cannot claim output from an archive member', () => {
  const texture = { member: 'input.assets', pathId: '2800000', classId: 28, name: 'Albedo',
    status: 'decoded', issue: null, width: 4, height: 4, output: 0, format: 'rgba', bytes: 64,
    textureStorage: 'inline', textureEncoding: 'rgba32' }
  const report = { protocol: 1, decoderRevision: bundleDecoderRevision, status: 'completed',
    format: 22, unityVersion: '6000.3.10f1', assets: [texture] }
  assert.equal(bundleResult(report, false, true).assets[0].file, '0.rgba')
  assert.equal(bundleResult({ ...report, format: 23 }, false, true).assets[0].file, '0.rgba')
  assert.equal(bundleResult(report, false), null)
  assert.equal(bundleResult({ ...report, format: 8 }, false, true), null)
  for (const changed of [{ member: 'CAB-123' }, { textureStorage: 'bundle-member' }]) {
    assert.equal(bundleResult({ ...report, assets: [{ ...texture, ...changed }] }, false, true), null)
  }
})
