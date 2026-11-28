import { cookedMaterial } from './unreal-cooked-material.mjs'
import { cookedStaticMesh } from './unreal-cooked-static-mesh.mjs'
import { cookedTexture } from './unreal-cooked-texture.mjs'

export function pakStaticMesh(name) {
  const texture = '/Game/Example/T_Panel'
  return [
    ...cookedStaticMesh({ name, external: true }),
    ...cookedMaterial({ name: 'M_Panel', split: false }),
    ...cookedMaterial({ name: 'MI_Panel', parent: ['/Game/Example/M_Panel'],
      textures: [{ parameter: 'BaseColor', value: texture }], streaming: [{ path: texture }] }),
    ...cookedTexture({ name: 'T_Panel', format: 'PF_G8', width: 2, height: 1, pixels: Buffer.from([48, 128]), external: true }),
  ].map(file => ({ ...file, path: 'Example/' + file.path }))
}
