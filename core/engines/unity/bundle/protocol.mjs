const issuePattern = /^unity-bundle-[a-z0-9-]{1,64}$/
const versionPattern = /^\d{1,4}\.\d{1,3}\.\d{1,4}[abfp]\d{1,4}$/
const memberPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/
const pathIdPattern = /^-?\d{1,19}$/
export const bundleDecoderRevision = 4
const pixelDimension = value => Number.isInteger(value) && value >= 1 && value <= 2048
const validCount = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max
const cropCoordinate = (value, length) => Number.isInteger(value) && value >= 0 && value + length <= 2048

export function bundleResult(report, inspectOnly) {
  if (report?.protocol !== 1) return null
  if (report.status === 'failed') return typeof report.issue === 'string' && issuePattern.test(report.issue)
    ? { status: 'failed', issue: report.issue } : null
  if (report.status !== 'completed' || report.decoderRevision !== bundleDecoderRevision || ![6, 7, 8].includes(report.format) ||
      typeof report.unityVersion !== 'string' || !versionPattern.test(report.unityVersion) ||
      !Array.isArray(report.assets) || report.assets.length > 10_000) return null
  const classes = new Map()
  const assets = []
  for (const [index, asset] of report.assets.entries()) {
    if (!asset || typeof asset.member !== 'string' || !memberPattern.test(asset.member) ||
        typeof asset.pathId !== 'string' || !pathIdPattern.test(asset.pathId) ||
        !Number.isInteger(asset.classId)) return null
    const id = asset.member.toLowerCase() + ':' + asset.pathId
    if (classes.has(id)) return null
    classes.set(id, asset.classId)
    const { member, pathId, classId, status, issue, name, width, height, vertices, triangles, output,
      textureEncoding, textureStorage, sprite, audio } = asset
    const row = { member, pathId, classId, status }
    if (status === 'unsupported' && output === null && typeof issue === 'string' && issuePattern.test(issue)) {
      assets.push({ ...row, ...(typeof name === 'string' && name.length <= 160 && { name }), issue })
      continue
    }
    let format, metrics, size
    if ([28, 213].includes(classId) && asset.format === 'rgba' && pixelDimension(width) && pixelDimension(height) &&
        ['rgba32', 'dxt1', 'dxt5'].includes(textureEncoding) && ['inline', 'bundle-member'].includes(textureStorage)) {
      format = 'rgba'
      metrics = { width, height, textureEncoding, textureStorage }
      size = width * height * 4
      if (!inspectOnly && asset.bytes !== size) return null
      if (classId === 213) {
        if (typeof sprite?.texturePathId !== 'string' || !pathIdPattern.test(sprite.texturePathId) ||
            !cropCoordinate(sprite.x, width) || !cropCoordinate(sprite.y, height)) return null
        metrics.sprite = { texturePathId: sprite.texturePathId, x: sprite.x, y: sprite.y }
      }
    } else if (classId === 43 && asset.format === 'glb' && validCount(vertices, 200_000) &&
        validCount(triangles, 200_000)) {
      format = 'glb'
      metrics = { vertices, triangles }
      size = asset.bytes
      if (!inspectOnly && (!validCount(size, 16 * 1024 ** 2) || size < 52)) return null
    } else if (classId === 83 && asset.format === 'wav' && [1, 2].includes(audio?.channels) &&
        validCount(audio.frames, 32 * 1024 ** 2 / 2) && Number.isInteger(audio.sampleRate) &&
        audio.sampleRate >= 4000 && audio.sampleRate <= 96000) {
      const { channels, sampleRate, frames } = audio
      format = 'wav'
      metrics = { audio: { channels, sampleRate, frames } }
      size = 44 + channels * frames * 2
      if (size > 32 * 1024 ** 2 || (!inspectOnly && asset.bytes !== size)) return null
    } else return null
    if (typeof name !== 'string' || name.length > 160 || issue !== null ||
        (inspectOnly ? status !== 'available' || output !== null : status !== 'decoded' || output !== index)) return null
    const product = inspectOnly ? {} : { file: output + '.' + format, size }
    assets.push({ ...row, name, ...metrics, ...product, format: format === 'rgba' ? 'png' : format })
  }
  if (assets.some(asset => asset.sprite &&
      classes.get(asset.member.toLowerCase() + ':' + asset.sprite.texturePathId) !== 28)) return null
  return { status: 'completed', format: report.format, unityVersion: report.unityVersion,
    decoderRevision: report.decoderRevision, assets }
}
