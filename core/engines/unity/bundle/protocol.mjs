const issuePattern = /^unity-bundle-[a-z0-9-]{1,64}$/
const versionPattern = /^\d{1,4}\.\d{1,3}\.\d{1,4}[abfp]\d{1,4}$/
const memberPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/
const pixelDimension = value => Number.isInteger(value) && value >= 1 && value <= 2048

export function bundleResult(report, inspectOnly) {
  if (report?.protocol !== 1) return null
  if (report.status === 'failed') return typeof report.issue === 'string' && issuePattern.test(report.issue)
    ? { status: 'failed', issue: report.issue } : null
  if (report.status !== 'completed' || ![6, 7, 8].includes(report.format) ||
      typeof report.unityVersion !== 'string' || !versionPattern.test(report.unityVersion) ||
      !Array.isArray(report.assets) || report.assets.length > 10_000) return null
  const seen = new Set()
  const assets = []
  for (const [index, asset] of report.assets.entries()) {
    if (!asset || typeof asset.member !== 'string' || !memberPattern.test(asset.member) ||
        typeof asset.pathId !== 'string' || !/^-?\d{1,19}$/.test(asset.pathId) ||
        !Number.isInteger(asset.classId)) return null
    const id = asset.member.toLowerCase() + ':' + asset.pathId
    if (seen.has(id)) return null
    seen.add(id)
    const { member, pathId, classId, status, issue, name, width, height, output } = asset
    const row = { member, pathId, classId, status }
    if (status === 'unsupported' && output === null && typeof issue === 'string' && issuePattern.test(issue)) {
      assets.push({ ...row, issue })
      continue
    }
    if (classId !== 28 || typeof name !== 'string' || name.length > 160 || issue !== null ||
        !pixelDimension(width) || !pixelDimension(height) ||
        (inspectOnly ? status !== 'available' || output !== null : status !== 'decoded' || output !== index)) return null
    assets.push({ ...row, name, width, height, ...(inspectOnly ? {} : { file: output + '.rgba' }) })
  }
  return { status: 'completed', format: report.format, unityVersion: report.unityVersion, assets }
}
