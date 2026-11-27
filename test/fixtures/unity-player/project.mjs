import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

export async function buildUnityPlayerFixture(root, editor) {
  const project = join(root, 'PlayerProject')
  const scripts = join(project, 'Assets', 'Editor')
  for (const directory of [scripts, join(project, 'Packages'), join(project, 'ProjectSettings')]) {
    await mkdir(directory, { recursive: true })
  }
  const log = join(root, 'player-fixture-editor.log')
  await Promise.all([
    copyFile(new URL('./BuildPlayerFixture.cs', import.meta.url), join(scripts, 'BuildPlayerFixture.cs')),
    ...['BuildTextures.cs', 'BuildAudio.cs'].map(name =>
      copyFile(new URL('../unity-bundle/' + name, import.meta.url), join(scripts, name))),
    writeFile(join(project, 'Packages', 'manifest.json'), JSON.stringify({
      dependencies: { 'com.unity.modules.audio': '1.0.0' },
    })),
    writeFile(join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: ' + editor.version + '\n'),
  ])
  try {
    await promisify(execFile)(editor.executable, ['-batchmode', '-nographics', '-quit', '-projectPath', project,
      '-executeMethod', 'AssetViewerPlayerFixture.Build', '-logFile', log], {
      timeout: 210_000, killSignal: 'SIGKILL', windowsHide: true,
    })
  } catch (error) {
    throw new Error((await readFile(log, 'utf8').catch(() => error.message)).slice(-8000), { cause: error })
  }
  return join(root, 'Player', 'Fixture_Data')
}
