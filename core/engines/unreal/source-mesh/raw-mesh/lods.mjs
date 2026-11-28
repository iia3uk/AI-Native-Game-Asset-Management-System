import { structArray, taggedProperties } from '../../editor-package/properties.mjs'
import { requireLayout } from '../../editor-package/tables.mjs'
import { meshLodLayout, meshLodPayload } from '../layout.mjs'
import { parseRawMesh } from './geometry.mjs'

function meshBuildSettings(bytes, field, nameAt) {
  if (!field) return {}
  requireLayout(field.type === 'StructProperty' && field.inner === 'MeshBuildSettings')
  const { properties, end } = taggedProperties(bytes, field.start, field.end, nameAt)
  requireLayout(end === field.end)
  const settings = {}
  const scale = properties.get('BuildScale3D')
  if (scale) {
    requireLayout(scale.type === 'StructProperty' && scale.inner === 'Vector' && scale.size === 12)
    settings.scale = [0, 4, 8].map(offset => bytes.readFloatLE(scale.start + offset))
    requireLayout(settings.scale.every(value => Number.isFinite(value) && value !== 0))
  }
  for (const name of ['bRecomputeNormals', 'bRecomputeTangents', 'bRemoveDegenerates', 'bGenerateLightmapUVs']) {
    const property = properties.get(name)
    if (!property) continue
    requireLayout(property.type === 'BoolProperty' && property.size === 0 && property.value <= 1)
    settings[name] = property.value === 1
  }
  return settings
}

export function rawMeshLods(bytes, mesh, header) {
  const models = structArray(bytes, header.properties.get('SourceModels'), mesh.nameAt, 'StaticMeshSourceModel', 16)
  const { payloads, missing, materials } = meshLodLayout(bytes, mesh, header, models.length, true)
  return {
    materials,
    missing,
    *lods() {
      for (const { lod, header } of payloads) {
        const settings = meshBuildSettings(bytes, models[lod].get('BuildSettings'), mesh.nameAt)
        yield { lod, data: parseRawMesh(meshLodPayload(bytes, header), settings) }
      }
    },
  }
}
