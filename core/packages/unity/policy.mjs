import { IndexInputError } from '../../index/index-errors.mjs'

export const unityPackageVersion = 1
export const packageLimits = Object.freeze({
  compressed: 1024 ** 3, unpacked: 4 * 1024 ** 3, entry: 512 * 1024 ** 2, entries: 30_000,
  pathname: 4096, metadata: 2 * 1024 ** 2, preview: 4 * 1024 ** 2, dependencyBytes: 64 * 1024 ** 2,
  dependencies: 100_000,
})
export const guidPattern = /^[0-9a-f]{32}$/i
export const hashPattern = /^[0-9a-f]{64}$/
export const invalid = detail => new IndexInputError('Пакет Unity: ' + detail)
export const MiB = 1024 ** 2
