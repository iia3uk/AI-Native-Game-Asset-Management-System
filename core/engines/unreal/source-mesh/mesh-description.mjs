import { parseMeshDescriptionUe4 } from '@threenative/raw-unreal'
import { meshLodLayout, meshLodPayload } from './layout.mjs'
import { staticMeshHeader } from './package.mjs'

export function sourceMeshLods(bytes, mesh, header = staticMeshHeader(bytes, mesh)) {
  const models = header.properties.get('SourceModels')
  const count = models?.size >= 4 ? bytes.readInt32LE(models.start) : 0
  const { payloads, missing, materials } = meshLodLayout(bytes, mesh, header, count)
  return {
    materials,
    missing,
    *lods() {
      for (const { lod, header } of payloads) {
        yield { lod, data: parseMeshDescriptionUe4(meshLodPayload(bytes, header)) }
      }
    },
  }
}
