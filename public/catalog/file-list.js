import { isCollisionFile } from '../shared/model-names.js'
import { canPreviewAudio } from '../preview/loaders/audio-preview.js'
import { counts, label, normalize } from './format.js'
import { markKey } from './viewer-storage.js'

export function renderFileList({ ui, state, eligibleFile, classification, pageSize }, revealSelection) {
  const { categoryLabel, modelCategory } = classification
  const query = normalize(ui['file-search'].value)
  const pack = state.active
  const hideColliders = state.kind === 'model' && !state.candidates &&
    pack?.files.some(file => file.kind === 'model' && !isCollisionFile(file) && eligibleFile(pack, file))
  const matchesKind = file => state.kind === 'all' || state.kind === file.kind ||
    (state.kind === 'audio' && canPreviewAudio(file))
  const files = !pack ? [] : pack.files.filter(file => matchesKind(file) &&
    eligibleFile(pack, file) && (!hideColliders || !isCollisionFile(file)) &&
    (!query || normalize(file.displayPath).includes(query)))
  if (revealSelection && state.file) {
    const index = files.findIndex(file => file.id === state.file.id)
    if (index >= state.limit) state.limit = Math.ceil((index + 1) / pageSize) * pageSize
  }
  const list = ui['file-list']
  const scroll = list.scrollTop
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.file : null
  const fragment = document.createDocumentFragment()
  let nextFocus
  let selected
  for (const file of files.slice(0, state.limit)) {
    const button = label('button', 'file')
    button.title = file.displayPath + (file.kind === 'model' ? ' · ' + categoryLabel(modelCategory(pack, file)) : '')
    button.dataset.file = file.id
    if (file.id === focused) nextFocus = button
    button.setAttribute('aria-current', String(state.file?.id === file.id))
    if (state.file?.id === file.id) selected = button
    button.append(label('span', 'file-name', file.name),
      label('span', 'file-type', isCollisionFile(file) ? 'Коллизия' : file.ext.toUpperCase()))
    const status = state.marks[markKey(pack.id, file.id)]?.status
    if (status) button.append(label('span', 'file-mark', { candidate: '✓', later: '◷', excluded: '×' }[status]))
    fragment.append(button)
  }
  if (!files.length && pack) fragment.append(label('p', 'list-empty', 'В этой подборке файлов нет.'))
  if (files.length > state.limit) {
    const more = label('button', 'more-files', 'Показать ещё · ' + counts(files.length - state.limit))
    more.dataset.more = 'true'
    fragment.append(more)
  }
  list.replaceChildren(fragment)
  list.scrollTop = scroll
  nextFocus?.focus({ preventScroll: true })
  if (revealSelection && selected) {
    const viewport = list.getBoundingClientRect()
    const item = selected.getBoundingClientRect()
    if (item.top < viewport.top) list.scrollTop += item.top - viewport.top
    else if (item.bottom > viewport.bottom) list.scrollTop += item.bottom - viewport.bottom
  }
}
