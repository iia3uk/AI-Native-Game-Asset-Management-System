import { lstat, opendir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { unityVersionPattern } from '../../../engines/unity/options.mjs'
import { checkedPath, inside, pathKey, readBoundedText } from '../../../files/asset-files.mjs'
import { validPackageSegment } from '../../source.mjs'
import { invalid, packageLimits } from '../policy.mjs'

const packageName = /^(?=.{1,180}$)[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/
const packageVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const manifestLimit = 256 * 1024
const projectStorage = new Set(['library', 'temp', 'obj', 'logs', 'usersettings', 'projectsettings'])
const byName = (key, a, b) => a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0

async function safeDirectory(root, path) {
  const checked = await checkedPath(root, path)
  return checked && (await lstat(checked).catch(() => null))?.isDirectory() ? checked : null
}

async function packageManifest(root, path) {
  const text = await readBoundedText(root, join(path, 'package.json'), manifestLimit)
  if (text === null) return null
  try {
    const { name, version, unity } = JSON.parse(text.replace(/^\uFEFF/, ''))
    if (typeof name !== 'string' || !packageName.test(name) || !validPackageSegment(name) ||
        typeof version !== 'string' || version.length > 128 || !packageVersion.test(version)) return null
    return { name, version, unity: typeof unity === 'string' && /^\d{4}\.\d{1,4}$/.test(unity) ? unity : null, text }
  } catch {
    return null
  }
}

export async function unityFolderFormat(root) {
  const project = await projectHeader(root)
  if (project) return 'unity-project'
  if (await packageManifest(root, root)) return 'unity-upm'
  throw invalid('выберите корень проекта с Assets и ProjectSettings/ProjectVersion.txt или папку UPM с package.json.')
}

async function projectHeader(root) {
  const assets = await safeDirectory(root, 'Assets')
  const version = assets && await readBoundedText(root, 'ProjectSettings/ProjectVersion.txt', 16 * 1024)
  const editor = version && /^m_EditorVersion:[ \t]*(\S+)/m.exec(version)?.[1]
  return unityVersionPattern.test(editor ?? '') ? { assets, version, editor } : null
}

export async function unityFolderLayout(root, signal) {
  const project = await projectHeader(root)
  const format = project ? 'unity-project' : 'unity-upm'
  const mounts = []
  const packages = []
  const fingerprint = []
  let engineVersion = null
  if (project) {
    engineVersion = project.editor
    mounts.push({ path: project.assets, logical: 'Assets' })
    fingerprint.push(['project-version', project.version])
    const embedded = await safeDirectory(root, 'Packages')
    if (embedded) {
      let visited = 0
      for await (const child of await opendir(embedded)) {
        signal?.throwIfAborted()
        if (++visited > packageLimits.entries) throw invalid('в папке Packages слишком много записей.')
        if (!child.isDirectory() || child.name.startsWith('.') || !validPackageSegment(child.name)) continue
        const candidate = await safeDirectory(root, join(embedded, child.name))
        const manifest = candidate && await packageManifest(root, candidate)
        if (manifest) addPackage(candidate, manifest)
      }
      const manifest = await readBoundedText(root, join(embedded, 'manifest.json'), manifestLimit)
      fingerprint.push(['project-manifest', manifest])
      fingerprint.push(['package-lock', await readBoundedText(root, join(embedded, 'packages-lock.json'), manifestLimit)])
      const embeddedNames = new Set(packages.map(pack => pack.name))
      for (const [name, path] of localPackages(root, embedded, manifest)) {
        signal?.throwIfAborted()
        if (embeddedNames.has(name)) continue
        const candidate = await safeDirectory(root, path)
        const local = candidate && await packageManifest(root, candidate)
        if (local?.name === name) addPackage(candidate, local)
      }
    }
  } else {
    const manifest = await packageManifest(root, root)
    if (!manifest) throw invalid('package.json недоступен или содержит неверные имя и версию.')
    addPackage(root, manifest)
  }
  mounts.sort(byName.bind(null, 'logical'))
  packages.sort(byName.bind(null, 'name'))
  fingerprint.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return { format, engineVersion, packages, mounts, fingerprint }

  function addPackage(path, { name, version, unity, text }) {
    if (packages.length >= 256) throw invalid('превышен лимит количества пакетов UPM.')
    if (mounts.some(mount => pathKey(mount.path) === pathKey(path))) throw invalid('папка пакета UPM подключена дважды.')
    mounts.push({ path, logical: 'Packages/' + name })
    packages.push({ name, version, unity })
    fingerprint.push(['upm:' + name, text])
  }
}

function* localPackages(root, packages, text) {
  let dependencies
  try { dependencies = JSON.parse(text?.replace(/^\uFEFF/, '') ?? '{}')?.dependencies } catch { return }
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return
  for (const [name, value] of Object.entries(dependencies)) {
    if (!packageName.test(name) || typeof value !== 'string' || !value.startsWith('file:') || value.length > 4096) continue
    const reference = value.slice(5)
    if (!reference || /^[\\/]{2}/.test(reference)) continue
    const path = resolve(packages, reference)
    if (!inside(root, path) || pathKey(root) === pathKey(path)) continue
    const parts = relative(root, path).split(sep)
    if (projectStorage.has(parts[0].toLowerCase()) ||
        parts.some(segment => segment.startsWith('.') || !validPackageSegment(segment))) continue
    yield [name, path]
  }
}
