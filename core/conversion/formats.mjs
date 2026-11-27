import { IndexInputError } from '../index/index-errors.mjs'

export const packageExportVersion = 1
const supported = ['fbx', 'glb']

export function packageExportFormats(input) {
  if (input === undefined) return ''
  if (!Array.isArray(input) || input.length > supported.length ||
      input.some(format => !supported.includes(format))) {
    throw new IndexInputError('Выберите форматы экспорта FBX и GLB.')
  }
  return supported.filter(format => input.includes(format)).join(',')
}
