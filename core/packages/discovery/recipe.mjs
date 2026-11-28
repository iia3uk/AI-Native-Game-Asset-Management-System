import { packageOptions } from '../dispatch.mjs'
import { isUnrealLoose } from '../unreal/loose/source.mjs'
import { isUnrealArchive } from '../unreal/containers.mjs'

export function folderPackageOptions(format, { mode, unityVersion, unrealVersion, formats }) {
  if (isUnrealArchive(format)) return packageOptions(format, { formats })
  if (['unityfs', 'unity-serialized', 'unreal-asset'].includes(format)) return packageOptions(format, { formats })
  return packageOptions(format, { mode, formats, editorVersion: mode === 'engineless' ? '' :
    isUnrealLoose(format) ? unrealVersion : unityVersion })
}
