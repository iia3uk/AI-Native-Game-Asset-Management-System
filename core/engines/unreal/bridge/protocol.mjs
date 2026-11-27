import { readBoundedText } from '../../../files/asset-files.mjs'
import { unrealBridgeVersion } from './project.mjs'

const productTypes = { StaticMesh: ['model', 'fbx'], SkeletalMesh: ['skeletal-model', 'fbx'],
  AnimSequence: ['animation', 'fbx'], Texture2D: ['texture', 'png'], SoundWave: ['audio', 'wav'],
  Material: ['material', 'json'], MaterialInstanceConstant: ['material', 'json'], Skeleton: ['skeleton', 'json'] }
const issueCode = value => typeof value === 'string' && /^unreal-[a-z0-9-]{1,70}$/.test(value) ? value : null
const name = (value, limit = 1024) => typeof value === 'string' && /^[^\x00-\x1f\x7f]+$/.test(value) && value.length <= limit ? value : null

export async function readUnrealResults(root, targets, editor) {
  const raw = await readBoundedText(root, 'bridge-result.json', 32 * 1024 ** 2)
  let data
  try { data = JSON.parse(raw) } catch { return null }
  const engineVersion = name(data?.engineVersion, 128)
  if (data?.version !== unrealBridgeVersion || engineVersion?.split('-')[0] !== editor.version ||
      !Array.isArray(data.results) || data.results.length !== targets.length) return null
  const ids = new Set(targets.map(target => target.id))
  const results = new Map()
  for (const row of data.results) {
    if (!ids.has(row?.id) || results.has(row.id) || !Array.isArray(row.products) || row.products.length > 64 ||
        !Array.isArray(row.dependencies) || row.dependencies.length > 512) return null
    const numbers = new Set()
    const products = []
    for (const product of row.products) {
      if (!Number.isSafeInteger(product?.number) || product.number < 0 || product.number >= 64 || numbers.has(product.number) ||
          !Object.hasOwn(productTypes, product.className)) return null
      numbers.add(product.number)
      const [role, format] = productTypes[product.className]
      if (!issueCode(product.issue) && (role !== product.role || format !== product.format)) return null
      products.push({
        role, format, number: product.number, className: product.className, name: name(product.name, 180),
        objectPath: name(product.objectPath), issue: issueCode(product.issue),
        ...(role === 'texture' && {
          width: Number.isSafeInteger(product.width) ? product.width : null,
          height: Number.isSafeInteger(product.height) ? product.height : null,
          colorSpace: ['linear', 'srgb'].includes(product.colorSpace) ? product.colorSpace : null,
        }),
      })
    }
    const dependencies = row.dependencies.filter(dep => name(dep?.package) && ['hard', 'soft'].includes(dep.kind) &&
      ['staged', 'missing', 'excluded', 'builtin'].includes(dep.status))
      .map(({ package: packageName, kind, status }) => ({ package: packageName, kind, status }))
    if (dependencies.length !== row.dependencies.length) return null
    const blockedDependencies = Array.isArray(row.blockedDependencies) ? row.blockedDependencies.slice(0, 256).filter(value => name(value)) : []
    results.set(row.id, { products, dependencies, blockedDependencies, issue: issueCode(row.issue) })
  }
  return { engineVersion, results }
}
