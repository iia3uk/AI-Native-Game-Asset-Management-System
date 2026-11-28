import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileInfo } from '../../../files/asset-files.mjs'
import { bundleIdentity } from '../bundle-names.mjs'

export const bundleObjectKey = (member, pathId) => member + ':' + pathId

export function bundlePointer(member, reference) {
  if (!reference) return null
  const target = reference.targetMember ?? (reference.fileId === 0 ? member : null)
  return target ? { member: target, pathId: reference.pathId } : null
}

export function bundleTarget(objects, member, reference, classId) {
  const pointer = bundlePointer(member, reference)
  if (!pointer) return null
  const target = objects.get(bundleObjectKey(pointer.member, pointer.pathId))
  return target?.classId === classId && target.status === 'converted' && target.artifact?.path ? target : null
}

export async function saveBundleMaterial(asset, stage, store, decoder, objects, signal) {
  const { id, label } = bundleIdentity(asset)
  const { profile, shader, numbers, color } = asset.material
  const textures = asset.material.textures.map(binding => {
    const target = bundleTarget(objects, asset.member, binding.texture, 28)
    const status = target ? 'resolved' : bundlePointer(asset.member, binding.texture) ? 'missing' : 'external'
    const roles = []
    if (profile === 'standard' && binding.property === '_MainTex') {
      roles.push({ role: 'baseColor', channels: 'rgb', colorSpace: 'srgb' })
      if (numbers._Mode === 1) roles.push({ role: 'opacity', channels: 'a', colorSpace: 'linear' })
    }
    return { ...binding, roles, status, ...(target && {
      target: { path: target.artifact.path, sha256: target.artifact.sha256, colorSpace: target.textureColorSpace ?? null },
    }) }
  })
  const document = { version: 1, source: { member: asset.member, pathId: asset.pathId }, name: asset.name,
    shader, profile, numbers, color, textures }
  const staged = join(stage, id + '.json')
  await writeFile(staged, JSON.stringify(document, null, 2) + '\n', { flag: 'wx', signal })
  const artifact = await store.save('Materials/' + id + '/Material' + (label ? '-' + label : '') + '.json',
    await fileInfo(stage, staged), { status: 'converted', format: 'json',
      method: decoder.method + '-material-bindings', converterVersion: decoder.converterVersion })
  return { ...asset, id, status: artifact.status, artifact }
}
