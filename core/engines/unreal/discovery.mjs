import { basename, join } from 'node:path'
import { absolutePath, configuredPaths, directories, executable, registryValues, smallJson, verifyCandidates } from '../discovery-files.mjs'

const launcherKey = 'HKCU\\Software\\Epic Games\\Unreal Engine\\Builds'
const associationPattern = /^(?:\{[0-9a-f-]{36}\}|\d{1,3}\.\d{1,3}(?:\.\d{1,3})?)$/i
const number = value => Number.isSafeInteger(value) && value >= 0 && value <= 10_000

function editorFiles(root) {
  const base = join(root, 'Engine', 'Binaries')
  if (process.platform === 'win32') {
    return ['UnrealEditor-Cmd.exe', 'UE4Editor-Cmd.exe'].map(name => join(base, 'Win64', name))
  }
  if (process.platform === 'darwin') {
    return ['UnrealEditor', 'UE4Editor'].map(name => join(base, 'Mac', name + '.app', 'Contents/MacOS', name))
  }
  return ['UnrealEditor', 'UE4Editor'].map(name => join(base, 'Linux', name))
}

async function installation(root, source, association) {
  for (const path of editorFiles(root)) {
    const found = await executable(path)
    if (!found) continue
    const metadata = await smallJson(join(root, 'Engine/Build/Build.version'))
    const parts = [metadata?.MajorVersion, metadata?.MinorVersion, metadata?.PatchVersion]
    const version = parts.every(number) ? parts.join('.') : null
    const changelist = Number.isSafeInteger(metadata?.Changelist) ? metadata.Changelist : null
    const associations = [association, version && parts.slice(0, 2).join('.'), version].filter(Boolean)
    return { executable: found, root, source, version, changelist, associations: [...new Set(associations)] }
  }
  return null
}

export async function discoverUnreal(env, home, readRegistry = registryValues) {
  const roots = configuredPaths(env.ASSET_VIEWER_UNREAL_ROOTS).map(root => ({ root, source: 'configured-root' }))
  const launcherFolders = []
  if (process.platform === 'win32') {
    for (const install of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(absolutePath)) {
      launcherFolders.push(join(install, 'Epic Games'))
    }
    const programData = absolutePath(env.ProgramData)
    if (programData) {
      const launcher = await smallJson(join(programData, 'Epic/UnrealEngineLauncher/LauncherInstalled.dat'))
      for (const item of (Array.isArray(launcher?.InstallationList) ? launcher.InstallationList.slice(0, 512) : [])) {
        if (!/^UE_\d/i.test(item?.AppName) || !absolutePath(item?.InstallLocation)) continue
        roots.push({ root: item.InstallLocation, source: 'epic-launcher', association: item.AppName.slice(3) })
      }
    }
    for (const { name, path } of await readRegistry(env, launcherKey)) {
      if (associationPattern.test(name) && absolutePath(path)) roots.push({ root: path, source: 'registry', association: name })
    }
  } else if (process.platform === 'darwin') launcherFolders.push('/Users/Shared/Epic Games', '/Applications')
  else launcherFolders.push(join(home, 'UnrealEngine'), '/opt')
  for (const folder of launcherFolders) {
    const children = await directories(folder, name => /^UE_\d/i.test(name))
    for (const name of children) roots.push({ root: join(folder, name), source: 'standard', association: name.slice(3) })
    if (basename(folder) === 'UnrealEngine') roots.push({ root: folder, source: 'standard' })
  }
  const verified = await verifyCandidates(roots, ({ root, source, association }) => installation(root, source, association))
  return verified.sort((a, b) => (b.version ?? '').localeCompare(a.version ?? '', 'en', { numeric: true }))
}

export async function unrealProjectAssociation(project) {
  const path = absolutePath(project)
  if (!path || !/\.uproject$/i.test(path)) return null
  const association = (await smallJson(path))?.EngineAssociation
  return typeof association === 'string' && associationPattern.test(association) ? association : null
}

export function selectUnreal(editors, requested) {
  if (!requested) return { status: 'unspecified', requested: null, candidate: null }
  if (!associationPattern.test(requested)) return { status: 'unknown-association', requested, candidate: null }
  const match = editors.find(editor => editor.associations.some(association => association.toLowerCase() === requested.toLowerCase()))
  return { status: match ? 'association-match' : 'unavailable', requested, candidate: match ?? null }
}
