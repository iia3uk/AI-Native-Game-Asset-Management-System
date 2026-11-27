import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readBoundedText } from '../../files/asset-files.mjs'
import { describeUnityMaterial } from '../../materials/unity/describe.mjs'
import { guidPattern } from './policy.mjs'

const materialPath = id => 'Materials/' + id + '/bindings.json'
const sha256 = data => createHash('sha256').update(data).digest('hex')

export async function writeMaterialOutputs(root, byId, materials, importers, maximumBytes, signal) {
  const summary = { written: 0, knownShader: 0, unresolvedTextures: 0 }
  let remainingBytes = maximumBytes
  for (const [id, material] of materials) {
    signal?.throwIfAborted()
    const entry = byId.get(id)
    const description = describeUnityMaterial(material, {
      guid: id, path: entry.output, sha256: entry.hash,
    }, reference => {
      const target = byId.get(reference.guid ?? id)
      if (!target) return null
      const converted = target.exports?.find(artifact => artifact.path && artifact.status === 'converted' &&
        artifact.role === 'texture' && artifact.unityGUID === target.id && artifact.unityFileID === reference.fileID)
      const status = converted ? 'object-resolved' : !target.output ? target.status :
        target.kind !== 'texture' ? 'unsupported-texture-object' :
          reference.fileID === '2800000' ? 'file-resolved' : 'subasset-unverified'
      return { status, guid: target.id, path: target.output, sha256: target.hash, importer: importers.get(target.id) ?? null,
        ...(converted && { converted: { path: converted.path, sha256: converted.sha256, colorSpace: converted.colorSpace } }) }
    })
    const json = JSON.stringify(description, null, 2) + '\n'
    const size = Buffer.byteLength(json)
    if (size > remainingBytes) {
      entry.issues.push('unity-material-output-limit')
      continue
    }
    remainingBytes -= size
    const path = materialPath(id)
    await mkdir(join(root, dirname(path)), { recursive: true })
    await writeFile(join(root, path), json, { flag: 'wx', signal })
    entry.materialDescription = { path, size, sha256: sha256(json), shader: description.shader.profile }
    summary.written++
    if (description.shader.profile) summary.knownShader++
    summary.unresolvedTextures += description.textures.filter(texture => !['file-resolved', 'object-resolved', 'unassigned'].includes(texture.status)).length
  }
  return summary
}

export async function verifyMaterialOutputs(root, entries, expected, limit, signal) {
  if (!Array.isArray(entries)) return false
  let count = 0
  let budget = limit
  for (const { id, materialDescription: material } of entries) {
    if (material === undefined) continue
    if (!material || !guidPattern.test(id) || material.path !== materialPath(id) ||
        !Number.isSafeInteger(material.size) || material.size < 1 || material.size > budget) return false
    signal?.throwIfAborted()
    const text = await readBoundedText(root, material.path, material.size)
    if (!text || Buffer.byteLength(text) !== material.size || sha256(text) !== material.sha256) return false
    budget -= material.size
    count++
  }
  return count === expected
}
