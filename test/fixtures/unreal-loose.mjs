import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function packagePrefix(layout, ue4, ue5, flags) {
  // A bounded classifier prefix without real Unreal objects.
  const bytes = Buffer.alloc(256)
  const offset = layout <= -8 ? 24 : 20
  const hashed = ue5 >= 1016
  bytes.writeUInt32LE(0x9e2a83c1)
  bytes.writeInt32LE(layout, 4)
  bytes.writeInt32LE(ue4, 12)
  if (layout <= -8) bytes.writeInt32LE(ue5, 16)
  bytes.writeInt32LE(128, hashed ? offset + 20 : offset + 4)
  const summary = offset + (hashed ? 28 : 8)
  bytes.writeUInt32LE(flags, summary + 4)
  bytes.writeInt32LE(1, summary + 8)
  bytes.writeInt32LE(120, summary + 12)
  return bytes
}

export const primary = 'Props/Fixture.uasset'
export const companion = 'Props/Fixture.UEXP'
export const association = '5.997.998'

export async function writeUnrealLooseFixture(root) {
  const project = join(root, 'Unreal Loose Fixture')
  const descriptor = join(project, 'Fixture.uproject')
  const content = join(project, 'Content')
  await mkdir(join(content, 'Props'), { recursive: true })
  await Promise.all([
    writeFile(descriptor, JSON.stringify({ FileVersion: 3, EngineAssociation: association, Modules: [{ Name: 'NeverLoad' }] })),
    writeFile(join(content, primary), packagePrefix(-8, 522, 1008, 0)),
    writeFile(join(content, companion), 'sidecar-v1'),
    writeFile(join(content, 'Props/Cooked.umap'), packagePrefix(-8, 522, 1008, 0x200)),
    writeFile(join(content, 'Props/Malformed.uasset'), 'invalid Unreal asset'),
    writeFile(join(content, 'Props/Orphan.ubulk'), 'orphan payload'),
    writeFile(join(content, 'Props/startup.py'), 'raise RuntimeError()'),
    writeFile(join(content, 'AssetRegistry.bin'), 'opaque fixture registry'),
  ])
  return { project, descriptor, content }
}
