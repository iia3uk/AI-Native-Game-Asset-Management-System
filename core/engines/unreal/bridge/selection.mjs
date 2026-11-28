import { homedir } from 'node:os'
import { discoverUnreal, selectUnreal } from '../discovery.mjs'
import { IndexInputError } from '../../../index/index-errors.mjs'

const compatible = editor => /^5\.[1-9]\d*\.\d+$/.test(editor?.version ?? '')

export function validateUnrealVersion(requested) {
  if (requested !== undefined && (typeof requested !== 'string' ||
      !/^(?:\{[0-9a-f-]{36}\}|5\.\d{1,3}(?:\.\d{1,3})?)$/i.test(requested))) {
    throw new IndexInputError('Укажите версию Unreal 5 или ID зарегистрированной сборки.')
  }
}

export async function locateUnrealBridge(source, requested) {
  validateUnrealVersion(requested)
  const association = requested ?? source.association
  const editors = await discoverUnreal(process.env, homedir())
  const match = selectUnreal(editors, association)
  const editor = association ? match.candidate : editors.find(compatible)
  if (!editor) return { status: 'unavailable', issue: association ? 'unreal-version-unavailable' : 'unreal-editor-unavailable',
    ...(association && { association }) }
  if (!compatible(editor)) return { status: 'unavailable', issue: 'unreal-editor-version-unsupported' }
  return { editor, match: association ? match.status : 'detected' }
}
