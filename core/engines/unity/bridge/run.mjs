import { execFile } from 'node:child_process'
import { lstat, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { readBoundedText } from '../../../files/asset-files.mjs'
import { discoverUnity, selectUnity } from '../discovery.mjs'
import { createBridgeProject, exporterVersion, unityBridgeVersion } from './project.mjs'
import { isUnityExportTarget, stageUnityInputs } from './safe-inputs.mjs'

const execute = promisify(execFile)
const supportsBridge = editor => /^6000\.\d+\.\d+[fp]/.test(editor?.version ?? '')
const formats = new Map([['prefab', 'fbx'], ['component', 'fbx'], ['mesh', 'fbx'], ['animation', 'fbx'],
  ['texture', 'png'], ['material', 'json']])

export async function locateUnityBridge(requested) {
  const editors = await discoverUnity(process.env, homedir())
  const matched = requested && selectUnity(editors, requested)
  const editor = requested ? matched.candidate :
    editors.find(item => item.source === 'configured' && supportsBridge(item)) ?? editors.find(supportsBridge)
  if (!supportsBridge(editor)) return { issue: requested ? 'unity-version-unavailable' : 'unity-editor-unavailable' }
  const file = await lstat(editor.executable).catch(() => null)
  if (!file?.isFile()) return { issue: 'unity-editor-unavailable' }
  return { editor, match: matched?.status ?? 'detected', identity: [unityBridgeVersion, exporterVersion,
    editor.executable, editor.version, file.size, file.mtimeMs] }
}

async function runEditor(editor, project, signal) {
  signal?.throwIfAborted()
  const child = execute(editor, ['-batchmode', '-nographics', '-quit', '-projectPath', project,
    '-executeMethod', 'AssetViewerBridge.EntryPoint.Export', '-logFile', join(project, 'editor.log')],
  { cwd: project, signal, timeout: 180_000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 2 * 1024 ** 2 })
  const closed = new Promise(resolve => child.child.once('close', resolve))
  try {
    await child
    return null
  } catch (error) {
    signal?.throwIfAborted()
    return error.killed ? 'unity-editor-timeout' : 'unity-editor-failed'
  } finally {
    await closed
  }
}

export async function prepareUnityExports({ project, output, entries, selection, signal }) {
  const candidates = entries.filter(isUnityExportTarget)
  if (!candidates.length) return { results: new Map(), summary: { status: 'not-needed' } }
  if (!selection.editor) return {
    results: new Map(candidates.map(({ id }) => [id, { issue: selection.issue }])),
    summary: { status: 'unavailable', issue: selection.issue },
  }
  const { targets, rejected } = await stageUnityInputs(output, project, entries, signal)
  const results = new Map([...rejected].map(([id, issue]) => [id, { issue }]))
  if (!targets.length) return { results, summary: { status: 'no-compatible-inputs' } }
  const { editor } = selection
  await createBridgeProject(project, editor.version, targets, signal)
  const failure = await runEditor(editor.executable, project, signal)
  const response = !failure && await readBoundedText(project, 'bridge-result.json', 16 * 1024 ** 2)
  const outputRoot = join(project, 'BridgeOutput')
  let payload
  try { payload = response && JSON.parse(response) } catch { /* The Editor did not publish a valid response. */ }
  if (payload?.editorVersion !== editor.version || payload?.exporterVersion !== exporterVersion || !Array.isArray(payload.results)) {
    const issue = failure ?? 'unity-invalid-bridge-report'
    for (const { id } of targets) results.set(id, { issue })
    return { results, summary: { status: 'failed', issue, editorVersion: editor.version } }
  }
  const validIDs = new Set(targets.map(target => target.id))
  for (const row of payload.results) {
    if (!validIDs.has(row?.id) || results.has(row.id) || !Array.isArray(row.products)) continue
    const products = row.products.slice(0, 101).filter(product => product && formats.get(product.role) === product.format &&
      Number.isSafeInteger(product.number) && product.number >= 0 && product.number <= 100)
    results.set(row.id, { issue: row.issue || null, products })
  }
  for (const { id } of targets) {
    if (!results.has(id)) results.set(id, { issue: 'unity-missing-asset-report' })
  }
  return { outputRoot, results, summary: { status: 'completed', editorVersion: editor.version,
    exporterVersion, match: selection.match } }
}

export async function removeUnityProject(project) {
  await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
