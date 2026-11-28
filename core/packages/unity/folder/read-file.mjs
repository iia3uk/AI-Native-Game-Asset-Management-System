import { readVerifiedFile } from '../../../files/read-verified.mjs'
import { invalid } from '../policy.mjs'

export const folderChanged = () => invalid('содержимое папки изменилось. Проанализируйте её снова.')

export async function readFolderFile(root, file, { temporary, metadata, signal }) {
  const { prefix, ...result } = await readVerifiedFile(root, file, {
    temporary, capture: metadata ? 16 * 1024 : 0, signal, changed: folderChanged,
  })
  if (prefix) result.guid = /^guid:[ \t]*([0-9a-f]{32})[ \t]*\r?$/im.exec(prefix.toString('utf8'))?.[1].toLowerCase()
  return result
}
