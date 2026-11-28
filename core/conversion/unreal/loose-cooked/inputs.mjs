import { fileInfo } from '../../../files/asset-files.mjs'

const cookedSidecars = new Set(['uexp', 'ubulk', 'uptnl'])
const key = path => path.normalize('NFC').toLowerCase()
const maxFile = 64 * 1024 ** 2
const maxBatch = 1024 ** 3

export function boundedCookedBatch(inputs, maximum) {
  let size = 0
  let limited = false
  const selected = []
  const files = []
  for (const input of inputs) {
    const members = [...input.files.values()]
    const bytes = members.reduce((sum, file) => sum + file.info.size, 0)
    if (selected.length >= maximum || size + bytes > maxBatch || members.some(file => file.info.size > maxFile)) {
      limited = true
      continue
    }
    const prefix = String(selected.length).padStart(5, '0') + '.'
    for (const [type, file] of input.files) files.push({ stageName: prefix + type, file })
    selected.push(input)
    size += bytes
  }
  return { selected, files, size, limited }
}

export async function looseCookedInputs(assets, output, signal) {
  const byPath = new Map(assets.filter(asset => asset.output && cookedSidecars.has(asset.type))
    .map(asset => [key(asset.sourcePath), asset]))
  const inputs = []
  for (const asset of assets) {
    signal?.throwIfAborted()
    if (!asset.output || asset.type !== 'uasset' || asset.storage !== 'cooked' || asset.layout !== -7 ||
        asset.ue4 !== 522 || asset.ue5 !== 0) continue
    const files = new Map()
    const header = await verifiedInput(output, asset)
    const stem = key(asset.sourcePath).slice(0, -7)
    for (const type of cookedSidecars) {
      const sidecar = byPath.get(stem + '.' + type)
      if (sidecar) files.set(type, await verifiedInput(output, sidecar))
    }
    inputs.push({ asset, path: asset.sourcePath, header, companion: files.get('uexp'),
      files: new Map([['uasset', header], ...files]) })
  }
  return inputs
}

async function verifiedInput(output, asset) {
  const file = await fileInfo(output, asset.output)
  if (!file || file.info.size !== asset.size) throw new Error('Staged Unreal package changed')
  return file
}
