import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const exporterVersion = '5.1.5'
const dependencies = {
  'com.unity.formats.fbx': exporterVersion,
  'com.autodesk.fbx': '5.1.3',
  'com.unity.timeline': '1.8.10',
}
export const unityBridgeVersion = 1
export const bridgeScripts = ['Protocol.cs', 'EntryPoint.cs', 'FbxAssets.cs', 'AssetObjects.cs']
const scriptRoot = fileURLToPath(new URL('./editor/', import.meta.url))

export async function createBridgeProject(project, editorVersion, targets, signal) {
  const packages = join(project, 'Packages')
  const settings = join(project, 'ProjectSettings')
  const scripts = join(project, 'Assets', 'Editor')
  await Promise.all([packages, settings, scripts].map(path => mkdir(path, { recursive: true })))
  const options = { signal, flag: 'wx' }
  await Promise.all([
    writeFile(join(packages, 'manifest.json'), JSON.stringify({ dependencies }), options),
    writeFile(join(settings, 'ProjectVersion.txt'), 'm_EditorVersion: ' + editorVersion + '\n', options),
    writeFile(join(project, 'bridge-request.json'), JSON.stringify({ targets }), options),
    ...bridgeScripts.map(async file => writeFile(join(scripts, file), await readFile(join(scriptRoot, file), { signal }), options)),
  ])
}
