import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

const workerName = 'AssetViewer.UnrealDecode'
const noticeFiles = [
  'CUE4Parse-LICENSE.txt', 'CUE4Parse-NOTICE.txt', 'Dependencies.txt',
  'FixedMathSharp-LICENSE.txt', 'FixedMathSharp-NOTICE.txt', 'FixedMathSharp-COPYRIGHT.txt',
  'BouncyCastle-LICENSE.md', 'CommunityToolkit-LICENSE.md', 'CommunityToolkit-NOTICE.txt',
  'DotNetPackages-NOTICE.txt', 'Newtonsoft.Json-LICENSE.md', 'LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT',
]

export async function verifyUnrealWorker(directory) {
  const dependencies = JSON.parse(await readFile(join(directory, workerName + '.deps.json'), 'utf8'))
  const target = dependencies.runtimeTarget.name
  if (!target.endsWith('/win-x64')) throw new Error('Expected a win-x64 Unreal Pak worker, received ' + target)
  const runtime = JSON.parse(await readFile(join(directory, workerName + '.runtimeconfig.json'), 'utf8'))
  if (!runtime.runtimeOptions.includedFrameworks?.some(framework => framework.name === 'Microsoft.NETCore.App')) {
    throw new Error('The Unreal Pak worker must include its .NET runtime.')
  }

  const packages = Object.entries(dependencies.libraries).filter(([, library]) => library.type === 'package')
  const inventory = await readFile(join(directory, 'Notices', 'Dependencies.txt'), 'utf8')
  const recorded = inventory.split(/\r?\n/).map(line => line.split(' | ')[0])
    .filter(value => /^[a-z][a-z0-9.-]*\/\d/i.test(value))
  const published = packages.map(([id]) => id)
  const difference = published.filter(id => !recorded.includes(id)).concat(recorded.filter(id => !published.includes(id)))
  if (difference.length) throw new Error('Update the Unreal worker dependency notices for: ' + difference.join(', '))

  const libraries = packages.flatMap(([id]) => {
    const assets = dependencies.targets[target][id]
    return Object.keys({ ...assets?.runtime, ...assets?.native }).map(path => basename(path))
  })
  for (const path of [
    workerName + '.exe', workerName + '.dll',
    'coreclr.dll', 'hostfxr.dll', 'hostpolicy.dll', ...libraries,
    ...noticeFiles.map(name => join('Notices', name)),
  ]) {
    const info = await stat(join(directory, path))
    if (!info.isFile() || !info.size) throw new Error('Missing Unreal Pak worker resource: ' + path)
  }
}
