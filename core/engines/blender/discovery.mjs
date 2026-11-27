import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { absolutePath, configuredPaths, directories, executable, registryValues, smallText, verifyCandidates } from '../discovery-files.mjs'

const steamKey = 'HKCU\\Software\\Valve\\Steam'
const versionPattern = /^Blender (\d{1,3}\.\d{1,3}(?:\.\d{1,3})?)$/i

async function steamLibraries(env, home, readRegistry) {
  const installs = []
  if (process.platform === 'win32') {
    const steam = absolutePath(env['ProgramFiles(x86)'])
    if (steam) installs.push(join(steam, 'Steam'))
    for (const { name, path } of await readRegistry(env, steamKey)) {
      if (name.toLowerCase() === 'steampath' && absolutePath(path)) installs.push(path)
    }
  } else if (process.platform === 'darwin') installs.push(join(home, 'Library/Application Support/Steam'))
  else installs.push(join(home, '.local/share/Steam'), join(home, '.steam/steam'))
  const libraries = new Set(installs)
  for (const install of installs) {
    const manifest = await smallText(join(install, 'steamapps/libraryfolders.vdf'))
    if (!manifest) continue
    for (const [, path] of [...manifest.matchAll(/^\s*"path"\s*"([^"]{1,1024})"/gm)].slice(0, 32)) {
      const decoded = absolutePath(path.replace(/\\\\/g, '\\'))
      if (decoded) libraries.add(decoded)
    }
  }
  return [...libraries]
}

export async function discoverBlender(env = process.env, home = homedir(), readRegistry = registryValues) {
  const filename = process.platform === 'win32' ? 'blender.exe' : 'blender'
  const candidates = []
  const override = absolutePath(env.ASSET_VIEWER_BLENDER)
  if (override) candidates.push({ path: override, source: 'configured' })
  for (const directory of configuredPaths(env.PATH)) candidates.push({ path: join(directory, filename), source: 'path' })
  if (process.platform === 'win32') {
    for (const install of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(absolutePath)) {
      const base = join(install, 'Blender Foundation')
      const names = await directories(base, name => /^Blender(?: |$)/i.test(name))
      names.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      for (const name of names) candidates.push({ path: join(base, name, filename), source: 'standard' })
    }
  } else if (process.platform === 'darwin') {
    for (const base of ['/Applications', join(home, 'Applications')]) {
      candidates.push({ path: join(base, 'Blender.app/Contents/MacOS/Blender'), source: 'standard' })
    }
  } else {
    for (const base of ['/usr/bin', '/usr/local/bin', '/opt/blender']) {
      candidates.push({ path: join(base, filename), source: 'standard' })
    }
  }
  for (const library of await steamLibraries(env, home, readRegistry)) {
    const root = join(library, 'steamapps/common/Blender')
    const path = process.platform === 'darwin' ? join(root, 'Blender.app/Contents/MacOS/Blender') : join(root, filename)
    candidates.push({ path, source: 'steam' })
  }
  if (process.platform === 'win32') {
    const priority = { configured: 0, path: 1, steam: 2, standard: 3 }
    candidates.sort((a, b) => priority[a.source] - priority[b.source])
  }
  return verifyCandidates(candidates, async ({ path, source }) => {
    const found = await executable(path)
    if (!found) return null
    const root = dirname(found)
    const namedVersion = basename(root).match(versionPattern)?.[1]
    const dataVersions = namedVersion ? [] : await directories(root, name => /^\d{1,3}\.\d{1,3}$/.test(name))
    const version = namedVersion ?? (dataVersions.length === 1 ? dataVersions[0] : null)
    return { executable: found, source, version }
  })
}
