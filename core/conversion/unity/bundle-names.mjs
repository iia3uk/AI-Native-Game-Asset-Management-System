import { createHash } from 'node:crypto'

export function bundleIdentity({ member, pathId, name }) {
  const id = createHash('sha256').update(member + ':' + pathId).digest('hex').slice(0, 32)
  const label = Array.from(name.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f]/g, '_'))
    .slice(0, 60).join('').replace(/^[. ]+|[. ]+$/g, '')
  return { id, label }
}
