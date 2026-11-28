import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ids, unityFixtureEntries } from './unitypackage.mjs'

export const upmName = 'com.test.asset-viewer'
export const localUpmName = 'com.test.local-upm'

export async function writeUnityFolderFixture(root) {
  const project = join(root, 'Unity Folder Fixture')
  const upm = join(project, 'Packages', upmName)
  const local = join(project, 'Assets', 'Local UPM')
  const outside = join(root, 'outside-upm')
  const save = async (path, data) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data)
  }
  await save(join(project, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.3.10f1\n')
  await save(join(project, 'Packages/manifest.json'), JSON.stringify({ dependencies: {
    [upmName]: '1.0.0',
    [localUpmName]: 'file:../Assets/Local UPM',
    'com.test.outside': 'file:../../outside-upm',
    'com.test.cached': 'file:../Library/PackageCache/com.test.cached',
  } }))
  await save(join(project, 'Library/PackageCache/com.test.cached/package.json'),
    JSON.stringify({ name: 'com.test.cached', version: '1.0.0' }))
  await save(join(project, 'Library/PackageCache/com.test.cached/private.txt'), 'cached dependency')
  await save(join(project, 'Packages', upmName, 'package.json'),
    JSON.stringify({ name: upmName, version: '1.0.0', unity: '2022.3' }))
  await save(join(local, 'package.json'), JSON.stringify({ name: localUpmName, version: '2.0.0' }))
  await save(join(local, 'README.md'), 'local package')
  await save(join(outside, 'package.json'), JSON.stringify({ name: 'com.test.outside', version: '1.0.0' }))
  await save(join(outside, 'private.txt'), 'outside project')
  const entries = new Map(unityFixtureEntries().map(entry => [entry.name, entry.payload]))
  for (const id of Object.values(ids)) {
    let folder = project
    let name = entries.get(id + '/pathname').trim()
    if (id === ids.texture) {
      folder = upm
      name = 'Runtime/albedo.png'
    }
    const path = join(folder, name)
    const bytes = entries.get(id + '/asset')
    if (bytes !== undefined) await save(path, bytes)
    await save(path + '.meta', entries.get(id + '/asset.meta'))
  }
  await save(join(project, 'Assets/Imported/Invalid.md'), 'text')
  await save(join(project, 'Assets/Imported/Invalid.md.meta'), 'not a Unity GUID\n')
  return { project, upm, local, outside }
}
