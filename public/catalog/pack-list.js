import { counts, label, normalize } from './format.js'

export function renderPackList({ ui, state, localFolders, classification, categoryMatches, thumbnails, thumbnailInput }) {
  const { categoryLabel, folderCategory } = classification
  thumbnails.clearObserved()
  const query = normalize(ui.search.value)
  const selectedCategory = ui.category.value
  const modelsInCategory = pack => classification.modelsInCategory(pack, selectedCategory)
  const scroll = ui['pack-list'].scrollTop
  const focused = ui['pack-list'].contains(document.activeElement) ? document.activeElement.dataset.pack : null
  const roots = [...localFolders.values()].map(folder => folder.id).join(',')
  const packsById = new Map(state.packs.map(pack => [pack.id, pack]))
  const moved = new Map()
  for (const pack of state.packs) for (const id of pack.originalFiles ?? []) moved.set(pack.originalGroup + ':' + id, pack)
  const candidateFiles = new Map()
  for (const [key, candidate] of Object.entries(state.marks)) {
    if (candidate.status !== 'candidate') continue
    const id = candidate.packId ?? candidate.fabId
    const pack = moved.get(key) ?? packsById.get(id)
    if (!pack) continue
    const fileId = key.slice(id.length + 1)
    const file = state.active?.id === pack.id && state.active.files.find(file => file.id === fileId)
    if (selectedCategory && (file ? !categoryMatches(pack, file) :
      (pack.modelIds && !pack.modelIds.includes(fileId)) ||
      (classification.modelOverride(key) ?? folderCategory(pack)) !== selectedCategory)) continue
    if (!candidateFiles.has(pack.id)) candidateFiles.set(pack.id, [])
    candidateFiles.get(pack.id).push(fileId)
  }
  const visible = state.packs.filter(pack => (!state.candidates || candidateFiles.has(pack.id)) &&
    (!selectedCategory || modelsInCategory(pack) > 0) &&
    (!query || normalize([pack.title, pack.author, categoryLabel(pack.category), ...pack.formats].join(' ')).includes(query)))
  const fragment = document.createDocumentFragment()
  let nextFocus
  for (const pack of visible) {
    const button = label('button', 'pack')
    button.dataset.pack = pack.id
    if (pack.id === focused) nextFocus = button
    if (pack.folderKey) button.title = localFolders.get(pack.folderKey)?.root + ' / ' + pack.localPath
    button.setAttribute('aria-current', String(pack.id === state.active?.id))
    const icon = label('span', 'pack-icon')
    icon.textContent = pack.models ? '3D' : 'IMG'
    if (pack.models) {
      const candidateIds = state.candidates ? candidateFiles.get(pack.id) : null
      const key = [pack.id, selectedCategory, pack.folderKey ? roots : '', selectedCategory ? classification.revision : 0,
        candidateIds ? [...candidateIds].sort().join(',') : ''].join(':')
      const fallback = selectedCategory || state.candidates ? null : pack.previewImage
      thumbnails.observe(icon, key, () => thumbnailInput(pack, selectedCategory, candidateIds), fallback)
    } else if (pack.previewImage) thumbnails.paint(icon, pack.previewImage)
    const text = label('span', 'pack-text')
    text.append(label('span', 'pack-title', pack.title), label('span', 'pack-meta', state.folder
      ? localFolders.get(pack.folderKey)?.name + ' · ' + counts(modelsInCategory(pack)) + ' 3D'
      : categoryLabel(selectedCategory || pack.category) + ' · ' + counts(modelsInCategory(pack)) + ' 3D'))
    button.append(icon, text)
    if (candidateFiles.has(pack.id)) button.append(label('span', 'pack-count', counts(candidateFiles.get(pack.id).length)))
    fragment.append(button)
  }
  if (!visible.length) fragment.append(label('p', 'list-empty', state.candidates ? 'Подходящих отметок пока нет.' :
    state.folder ? 'Подходящие файлы не найдены.' : 'Наборы не найдены.'))
  ui['pack-list'].replaceChildren(fragment)
  ui['pack-list'].scrollTop = scroll
  nextFocus?.focus({ preventScroll: true })
  ui['result-count'].textContent = counts(visible.length) + ' из ' + counts(state.packs.length)
  return visible
}
