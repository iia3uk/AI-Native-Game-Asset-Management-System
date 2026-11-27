import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const names = ['Asset Viewer-' + version + '-x64-Setup.exe', 'Asset Viewer-' + version + '-x64-Portable.exe']
const sums = []
for (const name of names) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(join('release', name))) hash.update(chunk)
  sums.push(hash.digest('hex') + '  ' + name)
}
await writeFile(join('release', 'SHA256SUMS.txt'), sums.join('\n') + '\n')
