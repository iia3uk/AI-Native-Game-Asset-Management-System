import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { AssetIndex } from '../core/index/asset-index.mjs'

const sizes = process.argv.slice(2).map(Number)
if (!sizes.length) sizes.push(100, 1000, 10000)
if (sizes.some(size => !Number.isInteger(size) || size < 1 || size > 50000)) {
  throw new Error('Supply synthetic library sizes from 1 to 50000.')
}
const directory = await mkdtemp(join(tmpdir(), 'asset-viewer-benchmark-'))
try {
  const index = await AssetIndex.open(join(directory, 'index.sqlite'))
  try {
    for (const [run, size] of sizes.entries()) {
      const library = join(directory, 'library-' + run)
      await mkdir(library)
      for (let start = 0; start < size; start += 64) {
        await Promise.all(Array.from({ length: Math.min(64, size - start) }, (_, offset) => {
          const id = start + offset
          return writeFile(join(library, 'bench-' + id + '.obj'), 'o fixture_' + id + '\nv 0 0 0\n')
        }))
      }
      const { id } = await index.connect(library)
      const started = performance.now()
      const first = await index.scan(id)
      const rescanning = performance.now()
      const second = await index.scan(id)
      console.log(JSON.stringify({ files: size, firstScanMs: Math.round(rescanning - started),
        unchangedScanMs: Math.round(performance.now() - rescanning), hashed: first.hashed, reused: second.reused }))
    }
  } finally { await index.close() }
} finally { await rm(directory, { recursive: true, force: true }) }
