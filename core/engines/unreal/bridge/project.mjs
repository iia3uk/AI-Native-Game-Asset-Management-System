import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const unrealBridgeVersion = 1
export const unrealBridgeScripts = ['entry.py', 'registry.py', 'exporters.py', 'materials.py']
const scripts = fileURLToPath(new URL('./editor/', import.meta.url))

export async function createUnrealProject(root, targets, signal) {
  const project = join(root, 'AssetViewerBridge.uproject')
  const code = join(root, 'Bridge')
  const config = join(root, 'Config')
  await Promise.all([code, config, join(root, 'Content'), join(root, 'BridgeOutput')].map(path => mkdir(path, { recursive: true })))
  const options = { signal, flag: 'wx' }
  await Promise.all([
    writeFile(project, JSON.stringify({ FileVersion: 3, DisableEnginePluginsByDefault: true,
      Plugins: [{ Name: 'PythonScriptPlugin', Enabled: true }] }), options),
    writeFile(join(config, 'DefaultEngine.ini'), '[/Script/PythonScriptPlugin.PythonScriptPluginSettings]\nbIsolateInterpreterEnvironment=True\n', options),
    writeFile(join(root, 'bridge-request.json'), JSON.stringify({ version: unrealBridgeVersion, targets }), options),
    ...unrealBridgeScripts.map(async file => writeFile(join(code, file), await readFile(join(scripts, file), { signal }), options)),
  ])
  return { project, script: join(code, 'entry.py') }
}
