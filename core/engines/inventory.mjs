import { homedir } from 'node:os'
import { discoverBlender } from './blender/discovery.mjs'
import { discoverUnity, selectUnity, unityProjectVersion } from './unity/discovery.mjs'
import { discoverUnreal, selectUnreal, unrealProjectAssociation } from './unreal/discovery.mjs'

export async function engineInventory({ env = process.env, home = homedir(), unityProject, unrealProject } = {}) {
  const [unity, unreal, blender, editorVersion, engineAssociation] = await Promise.all([
    discoverUnity(env, home), discoverUnreal(env, home), discoverBlender(env, home),
    unityProjectVersion(unityProject), unrealProjectAssociation(unrealProject),
  ])
  return {
    unity, unreal, blender,
    match: {
      unity: unityProject && !editorVersion ? { status: 'project-version-unreadable', candidate: null } : selectUnity(unity, editorVersion),
      unreal: unrealProject && !engineAssociation ? { status: 'project-association-unreadable', candidate: null } : selectUnreal(unreal, engineAssociation),
    },
  }
}
