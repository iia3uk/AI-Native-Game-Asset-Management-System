import { packageOptions } from '../dispatch.mjs'
import { isUnrealLoose } from '../unreal/loose/source.mjs'

export function folderPackageOptions(format, { mode, unityVersion, unrealVersion, formats }) {
  if (format === 'unreal-pak') return packageOptions(format, {})
  if (['unityfs', 'unity-serialized', 'unreal-asset'].includes(format)) return packageOptions(format, { formats })
  return packageOptions(format, { mode, formats, editorVersion: mode === 'engineless' ? '' :
    isUnrealLoose(format) ? unrealVersion : unityVersion })
}
