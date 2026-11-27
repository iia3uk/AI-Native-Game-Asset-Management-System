import { TGALoader } from 'three/addons/loaders/TGALoader.js'
import { TIFFLoader } from 'three/addons/loaders/TIFFLoader.js'
import { textureUrls, fbxTextureRequests } from '../materials/texture-references.js'

function withFbxWrapping(Loader) {
  return class extends Loader {
    load(url, ...callbacks) {
      const texture = super.load(url, ...callbacks)
      textureUrls.set(texture, this.manager.resolveURL((this.path ?? '') + url))
      fbxTextureRequests.set(texture, url.replaceAll('\\', '/').split('/').at(-1))
      return texture
    }

    _applyTexData(texture, data) {
      // FBXLoader sets the authored wrapping on the texture before its pixels arrive.
      super._applyTexData(texture, { ...data, wrapS: texture.wrapS, wrapT: texture.wrapT })
    }
  }
}

export const FbxTgaLoader = withFbxWrapping(TGALoader)
export class ViewerTiffLoader extends TIFFLoader {
  parse(buffer) {
    return { ...super.parse(buffer), generateMipmaps: true }
  }
}
export const FbxTiffLoader = withFbxWrapping(ViewerTiffLoader)
