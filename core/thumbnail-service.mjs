import { thumbnailCurrent } from './thumbnail-input.mjs'

export async function assetThumbnail(index, cache, id, { enqueue = false, libraryIds } = {}) {
  const plan = index.thumbnailSource(id, libraryIds)
  if (!plan) return null
  if (plan.status !== 'ready') return { status: plan.status }
  if (!await thumbnailCurrent(plan)) return { status: 'stale' }
  const { key } = plan
  const cached = await cache.get(key)
  if (cached) return { status: 'available', key, format: 'png', ...cached }
  const existing = index.jobs.latestThumbnail(id, key)
  const job = enqueue ? index.jobs.enqueueThumbnail(plan) : existing
  if (job && job.status !== 'completed') return { status: job.status, key, job }
  return { status: 'missing', key }
}
