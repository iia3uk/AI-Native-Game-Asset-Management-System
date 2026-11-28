import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { executable } from '../../discovery-files.mjs'

const execute = promisify(execFile)
export const unrealViewerRevision = 5
const toolOptions = { windowsHide: true, killSignal: 'SIGKILL' }
const exportsByType = {
  meshes: ['-gltf', '-lods', '-noanim', '-png'],
  animations: ['-psk', '-nomesh', '-nostat', '-notex'],
}

export async function locateUnrealViewer() {
  const path = await executable(process.env.ASSET_VIEWER_UE_VIEWER)
  if (!path) return null
  try {
    const { size, mtimeMs } = await stat(path)
    const { stdout } = await execute(path, ['-version'], { ...toolOptions, timeout: 3000, maxBuffer: 32 * 1024 })
    const version = /UE Viewer \(UModel\)[\s\S]*?\(build (\d{1,8})\)/i.exec(stdout)?.[1]
    return version && Number(version) >= 1590 ? { path, version, identity: [path, version, size, mtimeMs] } : null
  } catch {
    return null
  }
}

export async function runUnrealViewer(viewer, { input, output, workspace, version, signal, type = 'meshes' }) {
  signal?.throwIfAborted()
  const flags = ['-export', ...exportsByType[type], '-nomt', '-path=' + input, '-out=' + output]
  if (/^4\.(?:[0-9]|1[0-9]|2[0-7])$/.test(version ?? '')) flags.push('-game=ue' + version)
  const running = execute(viewer.path, [...flags, '*.uasset'], { ...toolOptions, cwd: workspace, signal,
    timeout: 120_000, maxBuffer: 16 * 1024 ** 2 })
  const closed = new Promise(resolve => running.child.once('close', resolve))
  try {
    await running
    return null
  } catch (error) {
    signal?.throwIfAborted()
    return error.killed ? 'unreal-viewer-timeout' : 'unreal-viewer-failed'
  } finally {
    await closed
  }
}
