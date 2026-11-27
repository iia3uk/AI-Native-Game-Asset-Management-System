import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { stageUnrealContent } from './inputs.mjs'
import { createUnrealProject } from './project.mjs'
import { readUnrealResults } from './protocol.mjs'

export function unrealEditorCommand({ executable, project, script, log, platform = process.platform }) {
  const windows = platform === 'win32'
  const quoted = path => windows ? '"' + path + '"' : path
  return {
    options: { windowsVerbatimArguments: windows, argv0: quoted(executable) },
    args: [quoted(project), '-run=pythonscript', '-script=' + quoted(script),
      '-unattended', '-nop4', '-nosplash', '-nosound', '-nullrhi', '-ddc=NoShared', '-abslog=' + quoted(log)],
  }
}

export async function runUnrealCommandlet(editor, workspace, files, signal) {
  signal?.throwIfAborted()
  const command = unrealEditorCommand({ ...files, executable: editor.executable, log: join(workspace, 'editor.log') })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^python/i.test(key)))
  const child = spawn(editor.executable, command.args, {
    ...command.options, cwd: workspace, env, signal, windowsHide: true,
    timeout: 240_000, killSignal: 'SIGKILL', stdio: 'ignore',
  })
  // Abort and launch failures can emit an error before the process closes.
  child.on('error', () => {})
  const { code, killedBy } = await new Promise(resolve => child.once('close', (code, killedBy) => resolve({ code, killedBy })))
  signal?.throwIfAborted()
  if (code === 0) return null
  return child.killed && killedBy === 'SIGKILL' ? 'unreal-editor-timeout' : 'unreal-editor-failed'
}

export async function prepareUnrealExports({ workspace, source, selection, signal }) {
  if (!selection.editor) return { summary: selection, targets: [], issues: [], results: new Map() }
  const stage = await stageUnrealContent(source, workspace, signal)
  if (!stage.targets.length) return { ...stage, results: new Map(), summary: { status: 'no-compatible-inputs' } }
  const editor = selection.editor
  const files = await createUnrealProject(workspace, stage.targets, signal)
  const failure = await runUnrealCommandlet(editor, workspace, files, signal)
  const report = !failure && await readUnrealResults(workspace, stage.targets, editor)
  if (!report) return { ...stage, results: new Map(), summary: { status: 'failed',
    issue: failure ?? 'unreal-invalid-bridge-report', editorVersion: editor.version } }
  return {
    ...stage, results: report.results, outputRoot: join(workspace, 'BridgeOutput'),
    summary: { status: 'completed', editorVersion: editor.version, engineVersion: report.engineVersion,
      match: selection.match },
  }
}
