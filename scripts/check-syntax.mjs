import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const files = ['server.mjs']
for (const folder of ['core', 'desktop', 'public', 'scripts', 'test']) {
  for (const file of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (file.isFile() && /\.(?:cjs|mjs|js)$/.test(file.name)) files.push(join(file.parentPath, file.name))
  }
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status) process.exit(result.status)
}
console.log('Syntax checked ' + files.length + ' JavaScript files.')
