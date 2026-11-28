import { readCookedMaterial } from '../../../engines/unreal/cooked-package/material.mjs'

export async function readCookedMaterials(inputs, root, signal) {
  const results = new Map()
  const deadline = Date.now() + 30_000
  let parameters = 0
  for (const { path, header, companion } of inputs) {
    signal?.throwIfAborted()
    if (Date.now() >= deadline || results.size >= 1024) return { results, incomplete: true }
    const result = await readCookedMaterial(root, header, companion, signal)
    if (!result) continue
    const { material } = result
    if (material) parameters += material.textures.length + material.scalars.length + material.vectors.length + material.streaming.length
    if (parameters > 16_384) return { results, incomplete: true }
    results.set(path, result)
  }
  return { results, incomplete: false }
}
