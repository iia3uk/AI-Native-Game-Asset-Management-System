import { IndexInputError } from '../../index/index-errors.mjs'

const modes = ['engineless', 'auto', 'engine-assisted']
export const unityVersionPattern = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})([abfp])(\d{1,4})(?:c\d{1,4})?$/

export function unityImportOptions(mode = 'engineless', editorVersion = '') {
  if (!modes.includes(mode)) throw new IndexInputError('Неизвестный режим импорта пакета.')
  if (typeof editorVersion !== 'string' || (editorVersion && (!unityVersionPattern.test(editorVersion) || mode === 'engineless'))) {
    throw new IndexInputError('Укажите версию редактора Unity для режима с редактором.')
  }
  return { mode, editorVersion }
}
