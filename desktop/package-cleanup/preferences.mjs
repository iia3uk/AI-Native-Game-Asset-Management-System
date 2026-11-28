import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readBoundedText } from '../../core/files/asset-files.mjs'

const name = 'package-cleanup.json'

export async function cleanupPreferences(directory) {
  const json = await readBoundedText(directory, name, 4096)
  let data
  try { data = JSON.parse(json) } catch { data = null }
  return { unity: data?.unity === true, unreal: data?.unreal === true }
}

export async function saveCleanupPreferences(directory, values) {
  const temporary = join(directory, 'package-cleanup-' + randomUUID() + '.tmp')
  try {
    await writeFile(temporary, JSON.stringify(values), { flag: 'wx', mode: 0o600 })
    await rename(temporary, join(directory, name))
  } finally {
    await rm(temporary, { force: true })
  }
}
