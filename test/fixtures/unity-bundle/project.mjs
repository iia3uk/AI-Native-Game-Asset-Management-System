import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

export async function buildAssetBundleFixture(root, editor) {
  const project = join(root, 'BundleProject')
  for (const directory of ['Assets/Editor', 'Packages', 'ProjectSettings']) {
    await mkdir(join(project, directory), { recursive: true })
  }
  const log = join(root, 'bundle-fixture-editor.log')
  await Promise.all([
    copyFile(new URL('./BuildFixture.cs', import.meta.url), join(project, 'Assets', 'Editor', 'BuildFixture.cs')),
    writeFile(join(project, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: {} })),
    writeFile(join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: ' + editor.version + '\n'),
  ])
  try {
    await promisify(execFile)(editor.executable, ['-batchmode', '-nographics', '-quit', '-projectPath', project,
      '-executeMethod', 'AssetViewerBundleFixture.Build', '-logFile', log], {
      timeout: 120_000, killSignal: 'SIGKILL', windowsHide: true,
    })
  } catch (error) {
    throw new Error((await readFile(log, 'utf8').catch(() => error.message)).slice(-6000), { cause: error })
  }
  return join(root, 'Bundles', 'fixture.bundle')
}
