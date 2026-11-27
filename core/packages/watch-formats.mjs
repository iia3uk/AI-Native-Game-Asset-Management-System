const recipes = {
  unitypackage: { extensions: ['unitypackage'], formats: 'fbx,glb' },
  unityfs: { extensions: ['bundle', 'unity3d'], formats: 'fbx,glb' },
  'unity-serialized': { extensions: ['asset', 'assets', 'sharedassets'], formats: 'fbx,glb' },
  'unreal-pak': { extensions: ['pak'], formats: '' },
}

export const watchedPackageFormats = Object.keys(recipes)
export const watchedPackageRecipe = format => Object.hasOwn(recipes, format) ? recipes[format] : undefined
export const watchedFormatByExtension = new Map(Object.entries(recipes)
  .flatMap(([format, recipe]) => recipe.extensions.map(extension => [extension, format])))
