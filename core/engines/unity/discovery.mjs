import { basename, dirname, join, parse } from 'node:path'
import { absolutePath, configuredPaths, directories, executable, smallJson, smallText, verifyCandidates } from '../discovery-files.mjs'

const versionPattern = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})([abfp])(\d{1,4})(?:c\d{1,4})?$/
const version = value => typeof value === 'string' && versionPattern.test(value) ? value : null

function releaseOrder(left, right) {
  if (!left || !right) return Number(Boolean(right)) - Number(Boolean(left))
  const parts = value => {
    const [, major, minor, patch, channel, build] = versionPattern.exec(value)
    return [Number(major), Number(minor), Number(patch), 'abfp'.indexOf(channel), Number(build)]
  }
  const a = parts(left)
  const b = parts(right)
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i]
  return right.localeCompare(left)
}

function fromLocation(path) {
  for (let directory = dirname(path), steps = 0; steps < 7; steps++) {
    const name = basename(directory)
    if (version(name)) return name
    const parent = dirname(directory)
    if (directory === parent) break
    directory = parent
  }
  return null
}

function unityPaths(root) {
  if (process.platform === 'win32') return [join(root, 'Editor/Unity.exe'), join(root, 'Unity.exe')]
  if (process.platform === 'darwin') {
    return [join(root, 'Unity.app/Contents/MacOS/Unity'), join(root, 'Contents/MacOS/Unity')]
  }
  return [join(root, 'Editor/Unity'), join(root, 'Unity')]
}

export async function unityProjectVersion(project) {
  const path = absolutePath(project)
  if (!path) return null
  const text = await smallText(join(path, 'ProjectSettings/ProjectVersion.txt'), 8 * 1024)
  return version(text?.match(/^m_EditorVersion:\s*(\S+)/m)?.[1])
}

export async function discoverUnity(env, home) {
  const candidates = []
  const override = absolutePath(env.ASSET_VIEWER_UNITY)
  if (override) candidates.push({ path: override, source: 'configured' })
  const hubData = process.platform === 'win32' ? absolutePath(env.APPDATA) :
    process.platform === 'darwin' ? join(home, 'Library/Application Support') : absolutePath(env.XDG_CONFIG_HOME) ?? join(home, '.config')
  const hubRoot = hubData && await smallJson(join(hubData, 'UnityHub/secondaryInstallPath.json'))
  const roots = configuredPaths(env.ASSET_VIEWER_UNITY_ROOTS).map(root => ({ root, source: 'configured-root' }))
  if (absolutePath(hubRoot)) roots.push({ root: hubRoot, source: 'unity-hub' })
  if (process.platform === 'win32') {
    for (const install of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(absolutePath)) {
      roots.push({ root: join(install, 'Unity/Hub/Editor'), source: 'unity-hub' },
        { root: join(install, 'Unity'), source: 'standard' })
    }
  } else if (process.platform === 'darwin') {
    roots.push({ root: '/Applications/Unity/Hub/Editor', source: 'unity-hub' },
      { root: '/Applications/Unity', source: 'standard' })
  } else {
    roots.push({ root: join(home, 'Unity/Hub/Editor'), source: 'unity-hub' },
      { root: '/opt/unity', source: 'standard' })
  }
  for (const { root, source } of roots) {
    const children = await directories(root, name => Boolean(version(name)))
    for (const install of [root, ...children.map(child => join(root, child))]) {
      for (const path of unityPaths(install)) candidates.push({ path, source })
    }
  }
  const verified = await verifyCandidates(candidates, async ({ path, source }) => {
    const found = await executable(path)
    if (!found || !/^Unity(?:\.exe)?$/i.test(parse(found).base)) return null
    return { executable: found, source, version: fromLocation(path) ?? fromLocation(found) }
  })
  return verified.sort((a, b) => releaseOrder(a.version, b.version))
}

export function selectUnity(editors, requested) {
  if (!requested) return { status: 'unspecified', requested: null, candidate: null }
  if (!version(requested)) return { status: 'unknown-version', requested, candidate: null }
  const exact = editors.find(editor => editor.version === requested)
  if (exact) return { status: 'exact', requested, candidate: exact }
  const [, major, minor, , channel] = versionPattern.exec(requested)
  const sameSeries = editors.find(editor => {
    if (!editor.version) return false
    const match = versionPattern.exec(editor.version)
    return match[1] === major && match[2] === minor && (channel === 'a' || channel === 'b' ? match[4] === channel : /[fp]/.test(match[4]))
  })
  return { status: sameSeries ? 'same-series' : 'unavailable', requested, candidate: sameSeries ?? null }
}
