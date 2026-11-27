import { IndexConflictError, IndexInputError } from '../index/index-errors.mjs'
import { transaction } from '../index/index-schema.mjs'

export const qualityFields = {
  maxVertices: { type: 'integer', min: 1, max: 1_000_000_000 },
  maxTriangles: { type: 'integer', min: 1, max: 1_000_000_000 },
  maxMeshes: { type: 'integer', min: 1, max: 1_000_000 },
  maxMaterials: { type: 'integer', min: 1, max: 1_000_000 },
  maxTextureEdge: { type: 'integer', min: 1, max: 1_000_000 },
  minExtent: { type: 'number', min: 0, max: 1_000_000_000 },
  maxExtent: { type: 'number', min: 0, max: 1_000_000_000 },
  requireUV: { type: 'boolean' },
  requireVerifiedDependencies: { type: 'boolean' },
  requireValidStructure: { type: 'boolean' },
}

const geometryLimits = [
  ['mobile-game', 'Mobile Game', 30_000, 20_000, 4, 2048],
  ['desktop-game', 'Desktop Game', 150_000, 100_000, 16, 4096],
  ['stylized-game', 'Stylized Game', 45_000, 30_000, 8, 2048],
  ['realistic-game', 'Realistic Game', 250_000, 180_000, 24, 8192],
  ['vr', 'VR', 55_000, 35_000, 8, 2048],
]
const presets = new Map(geometryLimits.map(([id, name, maxVertices, maxTriangles, maxMaterials, maxTextureEdge]) =>
  [id, { id, name, limits: { maxVertices, maxTriangles, maxMaterials, maxTextureEdge,
    requireVerifiedDependencies: true, requireValidStructure: true } }]))
presets.set('custom-project', { id: 'custom-project', name: 'Custom Project', limits: {} })

function presetFor(id) {
  const preset = presets.get(id)
  if (!preset) throw new IndexInputError('Неизвестный профиль качества.')
  return preset
}

function validateLimits(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new IndexInputError('Укажите пороги профиля.')
  const limits = {}
  for (const [key, value] of Object.entries(input)) {
    const field = Object.hasOwn(qualityFields, key) && qualityFields[key]
    if (!field) throw new IndexInputError('Неизвестная настройка профиля.')
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw new IndexInputError('Некорректное значение настройки профиля.')
      if (value) limits[key] = true
    } else {
      if (!Number.isFinite(value) || (field.type === 'integer' && !Number.isSafeInteger(value)) ||
          value < field.min || value > field.max) throw new IndexInputError('Некорректный порог профиля.')
      limits[key] = value
    }
  }
  if (limits.minExtent > limits.maxExtent) throw new IndexInputError('Минимальный габарит больше максимального.')
  return limits
}

function profile(preset, saved) {
  return { id: preset.id, name: preset.name, limits: saved?.limits == null ? { ...preset.limits } : JSON.parse(saved.limits),
    customized: saved?.limits != null, revision: saved?.revision ?? 0 }
}

export class QualityProfiles {
  #db

  constructor(db) {
    this.#db = db
  }

  get(id) {
    const preset = presetFor(id)
    const saved = this.#db.prepare('SELECT limits, revision FROM quality_profiles WHERE profile_id = ?').get(id)
    return profile(preset, saved)
  }

  list() {
    const saved = new Map(this.#db.prepare('SELECT profile_id, limits, revision FROM quality_profiles').all()
      .map(row => [row.profile_id, row]))
    return [...presets.values()].map(preset => profile(preset, saved.get(preset.id)))
  }

  update(id, change) {
    const preset = presetFor(id)
    if (!change || typeof change !== 'object' || Array.isArray(change) ||
        !Number.isSafeInteger(change.revision) || change.revision < 0 ||
        Object.keys(change).some(key => !['limits', 'reset', 'revision'].includes(key)) ||
        (change.reset !== undefined && (change.reset !== true || change.limits !== undefined))) {
      throw new IndexInputError('Некорректное изменение профиля.')
    }
    const limits = change.reset === true ? null : JSON.stringify(validateLimits(change.limits))
    return transaction(this.#db, () => {
      const saved = this.#db.prepare('SELECT revision FROM quality_profiles WHERE profile_id = ?').get(id)
      if ((saved?.revision ?? 0) !== change.revision) {
        throw new IndexConflictError('Профиль уже изменился. Откройте редактор снова, чтобы загрузить сохранённую версию.')
      }
      const revision = change.revision + 1
      this.#db.prepare(`
        INSERT INTO quality_profiles (profile_id, limits, revision) VALUES (?, ?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET limits = excluded.limits, revision = excluded.revision
      `).run(id, limits, revision)
      return profile(preset, { limits, revision })
    })
  }
}

const geometry = new Map([
  ['maxVertices', 'vertices'], ['maxTriangles', 'triangles'], ['maxMeshes', 'meshes'], ['maxMaterials', 'materials'],
])
const broken = new Set(['invalid-document', 'invalid-glb-header', 'invalid-glb-chunk', 'invalid-material-reference',
  'invalid-material-library', 'invalid-skin-reference', 'invalid-geometry-reference', 'invalid-uv-reference'])
const localStatuses = new Set(['available', 'embedded'])
const missingStatuses = new Set(['unavailable', 'outside'])
const result = (status, reason, actual = null, evidence = null) => ({ status, reason, actual, evidence })
const irrelevant = () => result('not-applicable', 'asset-kind')
const unknown = () => result('unknown', 'metric-unknown')

function budget(actual, limit, isMinimum = false) {
  if (!Number.isFinite(actual)) return unknown()
  const passes = isMinimum ? actual >= limit : actual <= limit
  return result(passes ? 'pass' : 'fail', passes ? 'within-budget' : 'outside-budget', actual)
}

function textureBudget(analysis, kind, limit) {
  if (kind === 'image') return budget(Math.max(analysis.metrics.width, analysis.metrics.height), limit)
  if (kind !== 'model') return irrelevant()
  const images = analysis.dependencies.filter(item => item.role === 'image')
  const largest = images.reduce((current, item) => {
    const edge = Math.max(item.dimensions?.width, item.dimensions?.height)
    return edge > current.edge ? { edge, path: item.path } : current
  }, { edge: 0, path: null })
  if (largest.edge > limit) return result('fail', 'outside-budget', largest.edge, largest.path)
  if (!analysis.dependenciesComplete || images.some(item => !item.dimensions) ||
      (images.length === 0 && analysis.metrics.textures !== 0)) {
    return result('unknown', 'texture-size-unknown', largest.edge || null, largest.path)
  }
  if (!images.length) return result('not-applicable', 'no-textures')
  return result('pass', 'within-budget', largest.edge, largest.path)
}

function dependencyCheck(analysis, kind) {
  if (kind === 'image') return irrelevant()
  const missing = analysis.dependencies.filter(item => missingStatuses.has(item.status))
  if (missing.length) return result('fail', 'missing-dependencies', missing.length, missing.find(item => item.path)?.path ?? null)
  if (!analysis.dependenciesComplete || analysis.dependencies.some(item => !localStatuses.has(item.status))) {
    return result('unknown', 'dependencies-unverified')
  }
  return result('pass', 'dependencies-verified', analysis.dependencies.length)
}

function structureCheck(analysis) {
  const issues = analysis.issues.filter(issue => broken.has(issue))
  if (issues.length) return result('fail', 'structure-issues', issues.length)
  return analysis.status === 'analyzed' ? result('pass', 'structure-checked') : result('unknown', 'structure-unverified')
}

function evaluate(key, limit, asset, analysis) {
  if (asset.missingSince) return result('unknown', 'source-missing')
  const model = asset.kind === 'model'
  if (geometry.has(key)) return model ? budget(analysis.metrics[geometry.get(key)], limit) : irrelevant()
  switch (key) {
    case 'maxTextureEdge': return textureBudget(analysis, asset.kind, limit)
    case 'minExtent':
    case 'maxExtent': return model
      ? budget(analysis.metrics.bounds ? Math.max(...analysis.metrics.bounds.size) : null, limit, key === 'minExtent')
      : irrelevant()
    case 'requireUV': {
      if (!model) return irrelevant()
      const uv = analysis.metrics.hasUV
      if (uv === true) return result('pass', 'uv-found', true)
      if (uv === false && analysis.status === 'analyzed') return result('fail', 'uv-missing', false)
      return unknown()
    }
    case 'requireVerifiedDependencies': return dependencyCheck(analysis, asset.kind)
    case 'requireValidStructure': return asset.kind === 'image' ? irrelevant() : structureCheck(analysis)
  }
}

export function validateQuality(asset, analysis, profile) {
  const checks = []
  for (const key of Object.keys(qualityFields)) {
    if (Object.hasOwn(profile.limits, key)) {
      const limit = profile.limits[key]
      checks.push({ key, limit, ...evaluate(key, limit, asset, analysis) })
    }
  }
  const status = ['fail', 'unknown', 'pass'].find(value => checks.some(check => check.status === value)) ?? 'not-applicable'
  return { profile, status, checks }
}
