import { ModelStage, convertedImages, decodedImageUrl } from './stage.js'
import { ModelThumbnails } from './thumbnails.js'

const $ = id => document.getElementById(id)
const ui = Object.fromEntries([
  'all-packs', 'candidate-packs', 'candidate-count', 'library-stats', 'search', 'category', 'result-count', 'pack-list',
  'pack-category', 'pack-title', 'pack-author', 'stage-canvas', 'stage-image', 'stage-empty', 'stage-label',
  'fit', 'zoom-in', 'zoom-out', 'rotate', 'wireframe', 'texture-tools', 'texture-variant', 'animation-tools', 'animation', 'play', 'model-stats',
  'view-options', 'lighting', 'part-tools', 'preview-part', 'color-source',
  'selected-name', 'decision', 'note', 'save-note', 'notice', 'file-tabs', 'file-search', 'file-list',
  'license', 'fab-link', 'source-link',
  'fab-mode', 'open-folder', 'folder-tools', 'folder-root', 'rescan-folder', 'folder-dialog', 'folder-form',
  'folder-path', 'folder-pick', 'folder-status', 'folder-cancel', 'folder-submit', 'library-title', 'category-wrap',
  'folder-browser', 'add-folder', 'remove-folder',
  'manual-texture', 'manual-material', 'manual-search', 'manual-image', 'manual-apply', 'manual-status',
  'folder-category', 'new-folder-category', 'model-category-tools', 'model-category', 'new-model-category',
  'save-model-category', 'model-category-status',
].map(id => [id, $(id)]))
const formatter = new Intl.NumberFormat('ru-RU')
const counts = number => formatter.format(number)
const plurals = new Intl.PluralRules('ru-RU')
const counted = (number, one, few, many) => counts(number) + ' ' + ({ one, few, many }[plurals.select(number)] ?? many)
const categories = {
  Animals: 'Животные', Animations: 'Анимации', Architecture: 'Архитектура', Bushes: 'Кустарники', Characters: 'Персонажи',
  Crafting: 'Ремесло', Dungeons: 'Подземелья', Fishing: 'Рыбалка', Magic: 'Магия', Mixed_Packs: 'Смешанные наборы',
  Mounts: 'Ездовые животные', Nature: 'Природа', Resources: 'Ресурсы', Rocks: 'Камни', Terrain: 'Рельеф', Textures: 'Текстуры',
  Trees: 'Деревья', Vegetation: 'Растительность', VFX: 'Эффекты', Villages: 'Поселения',
  Local: 'Папка',
}
const filePageSize = 65
const state = { packs: [], marks: {}, active: null, file: null, candidates: false, kind: 'model',
  limit: filePageSize, load: 0, packLoad: 0, folder: null }
const fab = { packs: [], marks: {}, selection: null }
const localFolders = new Map()
const foldersStorage = 'eldermere.folders.v1'
const classificationStorage = 'eldermere.classification.v1'
const newCategory = '__new_category__'
const noCategory = '__no_category__'
let localSelection
let categoryRevision = 0
let stage
let pendingSave = false
let imageZoom = 1
let imageObjectUrl
let openingFolder = false
const localTextures = file => file.kind === 'image' && (file.preview || convertedImages.has(file.ext))
const storageKey = (folder, kind) => `eldermere.${kind}.${folder.key}`
const post = value => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })

function readLocal(folder, kind) {
  try { return JSON.parse(localStorage.getItem(storageKey(folder, kind)) ?? '{}') ?? {} }
  catch { return {} }
}

function savedFolders() {
  try {
    const saved = JSON.parse(localStorage.getItem(foldersStorage) ?? '[]')
    return Array.isArray(saved) ? saved.filter(item => typeof item?.root === 'string' && typeof item.id === 'string') : []
  } catch { return [] }
}

function saveFolders() {
  localStorage.setItem(foldersStorage, JSON.stringify([...localFolders.values()].map(({ id, root }) => ({ id, root }))))
}

function registerFolder(info) {
  const name = info.root.split(/[\\/]/).filter(Boolean).at(-1) ?? info.root
  const previous = localFolders.get(info.key)
  if (previous && previous.id !== info.id) {
    for (const url of packRequests.keys()) if (url.startsWith(`/api/folder/${previous.id}/`)) packRequests.delete(url)
  }
  const resources = info.resources.map(file => ({ ...file, selectionId: info.key + '.' + file.id }))
  const folder = { ...info, name, images: resources.filter(localTextures), resources,
    marks: readLocal(info, 'review'), maps: readLocal(info, 'textures'),
  }
  localFolders.set(folder.key, folder)
  return folder
}

async function restoreFolders() {
  const entries = savedFolders()
  const results = await Promise.allSettled(entries.map(entry => json('/api/folder/' + encodeURIComponent(entry.id))
    .catch(() => json('/api/folder', post({ path: entry.root })))))
  for (const result of results) if (result.status === 'fulfilled') registerFolder(result.value)
}

const localMarks = () => Object.assign({}, ...[...localFolders.values()].map(folder => folder.marks))
const combinedImages = () => [...localFolders.values()].flatMap(folder => folder.images)
const localGroupId = (folder, group) => folder.key + '.' + group
const imageLabel = file => `${localFolders.get(file.selectionId.split('.')[0])?.name ?? ''} / ${file.path}`

function loadClassification() {
  try {
    const data = JSON.parse(localStorage.getItem(classificationStorage) ?? '{}')
    return { names: data.names ?? {}, roots: data.roots ?? {}, models: data.models ?? {} }
  } catch { return { names: {}, roots: {}, models: {} } }
}

const classification = loadClassification()
const thumbnails = new ModelThumbnails(ui['pack-list'])
const packRequests = new Map()
const folderCategory = pack => pack.folderKey ? classification.roots[pack.folderKey] ?? noCategory : pack.category ?? noCategory
const modelCategory = (pack, file) => classification.models[markKey(pack.id, file.id)] ?? folderCategory(pack)
const categoryMatches = (pack, file) => !ui.category.value || (file.kind === 'model' && modelCategory(pack, file) === ui.category.value)
const eligibleFile = (pack, file) => categoryMatches(pack, file) &&
  (!state.candidates || state.marks[markKey(pack.id, file.id)]?.status === 'candidate')

function modelsInCategory(pack) {
  const selected = ui.category.value
  if (!selected) return pack.models
  if (pack.modelIds) {
    return pack.modelIds.reduce((sum, id) => sum + Number((classification.models[markKey(pack.id, id)] ?? folderCategory(pack)) === selected), 0)
  }
  let count = folderCategory(pack) === selected ? pack.models : 0
  for (const [key, category] of Object.entries(classification.models)) if (key.startsWith(pack.id + ':')) {
    count += Number(category === selected) - Number(folderCategory(pack) === selected)
  }
  return count
}

function knownCategories() {
  return Object.entries({ ...categories, ...classification.names }).filter(([id]) => id !== 'Local')
    .sort((a, b) => a[1].localeCompare(b[1], 'ru'))
}

function fillCategories(select, empty, editable) {
  const value = select.value
  select.replaceChildren(new Option(empty, ''), ...knownCategories().map(([id, title]) => new Option(title, id)),
    new Option('Без категории', noCategory))
  if (editable) select.append(new Option('Новая категория…', newCategory))
  if (Array.from(select.options).some(item => item.value === value)) select.value = value
}

function categoryValue(select, input) {
  if (select.value !== newCategory) return select.value
  const title = input.value.trim().replace(/\s+/g, ' ')
  if (!title) throw new Error('Введите название категории.')
  const existing = knownCategories().find(([, name]) => normalize(name) === normalize(title))
  if (existing) return existing[0]
  const id = 'custom-' + crypto.randomUUID()
  classification.names[id] = title
  return id
}

function persistCategories() {
  localStorage.setItem(classificationStorage, JSON.stringify(classification))
  categoryRevision++
  fillCategories(ui.category, 'Все категории', false)
}

function modelCategoryControls() {
  const show = state.active && state.file?.kind === 'model'
  ui['model-category-tools'].hidden = !show
  ui['new-model-category'].hidden = true
  ui['new-model-category'].value = ''
  ui['model-category-status'].textContent = ''
  if (!show) return
  fillCategories(ui['model-category'], 'По умолчанию · ' + categoryLabel(folderCategory(state.active)), true)
  ui['model-category'].value = classification.models[markKey(state.active.id, state.file.id)] ?? ''
}

function label(tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}
const normalize = text => text.toLocaleLowerCase().trim()
const markKey = (pack, file) => pack + ':' + file
const currentMark = () => state.active && state.file ? state.marks[markKey(state.active.id, state.file.id)] : null
const categoryLabel = key => key === noCategory ? 'Без категории' : classification.names[key] ?? categories[key] ?? key
const chosen = () => Object.values(state.marks).filter(mark => mark.status === 'candidate')
const sizeLabel = size => {
  if (size >= 1024 ** 3) return (size / 1024 ** 3).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ГиБ'
  if (size >= 1024 ** 2) return (size / 1024 ** 2).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' МиБ'
  return counts(Math.ceil(size / 1024)) + ' КиБ'
}

async function json(url, options) {
  const response = await fetch(url, options)
  const body = await response.json().catch(() => null)
  if (!response.ok || !body) throw new Error(body?.error || 'Локальный сервер вернул HTTP ' + response.status)
  return body
}

async function fetchPack(pack) {
  const folder = pack.folderKey && localFolders.get(pack.folderKey)
  const url = folder ? `/api/folder/${folder.id}/group/${pack.groupId}` : '/api/packs/' + pack.id
  if (!packRequests.has(url)) {
    const request = json(url).catch(error => { packRequests.delete(url); throw error })
    packRequests.set(url, request)
  }
  return packRequests.get(url)
}

async function ensurePreview(file, folder) {
  if (!file.convertible || file.preview || !folder) return file
  const { preview } = await json(`/api/folder/${folder.id}/blend/${file.id}`, post({}))
  return { ...file, preview, previewFormat: 'glb' }
}

function modelResources(folder, files) {
  if (!folder) return files
  const otherImages = [...localFolders.values()].filter(other => other.key !== folder.key).flatMap(other => other.images)
  return otherImages.length ? folder.resources.concat(otherImages) : folder.resources
}

async function thumbnailInput(pack, category, candidateIds) {
  const data = await fetchPack(pack)
  const folder = localFolders.get(pack.folderKey)
  const models = data.files.filter(file => file.kind === 'model' &&
    (!category || modelCategory(pack, file) === category) && (!candidateIds || candidateIds.includes(file.id)))
  const eligible = models.filter(file => file.preview)
  const byId = new Map(eligible.map(file => [file.id, file]))
  const candidates = (pack.previewFiles ?? []).map(id => byId.get(id)).filter(Boolean)
  const sorted = eligible.filter(file => !candidates.includes(file)).sort((a, b) => a.size - b.size)
  candidates.push(...sorted.slice(0, 4 - candidates.length))
  if (folder) candidates.push(...models.filter(file => file.convertible && !file.preview)
    .sort((a, b) => a.size - b.size).slice(0, 4))
  return { files: candidates, resources: modelResources(folder, data.files),
    unityMaterials: data.unityMaterials, prepare: file => ensurePreview(file, folder) }
}

function updateTabs() {
  pressed(ui['fab-mode'], !state.folder)
  pressed(ui['open-folder'], Boolean(state.folder))
  ui['all-packs'].setAttribute('aria-pressed', String(!state.candidates))
  ui['candidate-packs'].setAttribute('aria-pressed', String(state.candidates))
  ui['candidate-count'].textContent = counts(chosen().length)
  for (const button of ui['file-tabs'].querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.kind === state.kind))
    button.disabled = Boolean(ui.category.value) && button.dataset.kind !== 'model'
  }
}

function renderPacks() {
  thumbnails.clearObserved()
  const query = normalize(ui.search.value)
  const selectedCategory = ui.category.value
  const scroll = ui['pack-list'].scrollTop
  const focused = ui['pack-list'].contains(document.activeElement) ? document.activeElement.dataset.pack : null
  const roots = [...localFolders.values()].map(folder => folder.id).join(',')
  const packsById = new Map(state.packs.map(pack => [pack.id, pack]))
  const candidateFiles = new Map()
  for (const [key, candidate] of Object.entries(state.marks)) {
    if (candidate.status !== 'candidate') continue
    const id = candidate.packId ?? candidate.fabId
    const pack = packsById.get(id)
    if (!pack) continue
    const fileId = key.slice(id.length + 1)
    const file = state.active?.id === id && state.active.files.find(file => file.id === fileId)
    if (selectedCategory && (file ? !categoryMatches(pack, file) :
      (pack.modelIds && !pack.modelIds.includes(fileId)) ||
      (classification.models[key] ?? folderCategory(pack)) !== selectedCategory)) continue
    if (!candidateFiles.has(id)) candidateFiles.set(id, [])
    candidateFiles.get(id).push(fileId)
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
      const key = [pack.id, selectedCategory, pack.folderKey ? roots : '', selectedCategory ? categoryRevision : 0,
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
  updateTabs()
  return visible
}

function renderFiles(revealSelection = false) {
  const query = normalize(ui['file-search'].value)
  const pack = state.active
  const files = !pack ? [] : pack.files.filter(file => (state.kind === 'all' || state.kind === file.kind) &&
    eligibleFile(pack, file) &&
    (!query || normalize(file.displayPath).includes(query)))
  if (revealSelection && state.file) {
    const index = files.findIndex(file => file.id === state.file.id)
    if (index >= state.limit) state.limit = Math.ceil((index + 1) / filePageSize) * filePageSize
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
    button.append(label('span', 'file-name', file.name), label('span', 'file-type', file.ext.toUpperCase()))
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
  updateTabs()
}

function status(text) {
  ui['stage-empty'].hidden = !text
  ui['stage-empty'].firstElementChild.textContent = text
}

function pressed(button, value) {
  button.setAttribute('aria-pressed', String(value))
}

function enableZoom(enabled) {
  ui.fit.disabled = ui['zoom-in'].disabled = ui['zoom-out'].disabled = !enabled
}

function setImageZoom(scale) {
  imageZoom = Math.max(.4, Math.min(8, scale))
  ui['stage-image'].style.transform = `scale(${imageZoom})`
}

function zoom(inward) {
  if (ui['stage-image'].hidden) stage?.zoom(inward)
  else setImageZoom(imageZoom * (inward ? 1.25 : .8))
}

function renderDecision() {
  const mark = currentMark()
  for (const button of ui.decision.querySelectorAll('button')) {
    button.disabled = !state.file || pendingSave
    pressed(button, mark?.status === button.dataset.status)
  }
  ui.note.disabled = !state.file || pendingSave
  ui['save-note'].disabled = !state.file || pendingSave
}

function showLicense(pack) {
  if (state.folder) {
    ui.license.textContent = 'Локальные файлы'
    ui.license.title = ''
    ui['fab-link'].hidden = true
    return
  }
  const values = [pack.license || 'Лицензия требует проверки']
  if (pack.noAI === true) values.push('NoAI')
  if (pack.noAI === null) values.push('NoAI не указан в каталоге')
  ui.license.textContent = values.join(' · ')
  ui.license.title = pack.restrictions?.join('\n') || ''
  ui['fab-link'].hidden = !/^https:\/\/(?:www\.)?fab\.com\//i.test(pack.url)
  if (!ui['fab-link'].hidden) ui['fab-link'].href = pack.url
}

function rememberLocation() {
  const query = new URLSearchParams()
  if (state.folder) query.set('folder', state.folder.id)
  if (state.active) query.set('pack', state.active.groupId ?? state.active.id)
  if (state.file) query.set('file', state.file.id)
  history.replaceState(null, '', query.size ? '?' + query : location.pathname)
  if (!state.folder && state.active) fab.selection = { pack: state.active.id, file: state.file?.id }
  if (state.folder && state.active) localSelection = { pack: state.active.id, file: state.file?.id }
}

function renderManualImages() {
  if (!state.folder || !stage) return
  const current = stage.manualTexture(Number(ui['manual-material'].value))
  const filter = normalize(ui['manual-search'].value)
  const allImages = combinedImages().sort((a, b) => imageLabel(a).localeCompare(imageLabel(b), 'ru', { numeric: true }))
  const images = allImages.filter(file => normalize(imageLabel(file)).includes(filter))
  const items = images.slice(0, 120)
  if (current && !items.some(file => file.selectionId === current)) {
    const selected = allImages.find(file => file.selectionId === current)
    if (selected) items.unshift(selected)
  }
  ui['manual-image'].replaceChildren(new Option('Автоматическая привязка', ''),
    ...items.map(file => new Option(imageLabel(file), file.selectionId)))
  ui['manual-image'].value = current
  ui['manual-status'].textContent = images.length > 120 ? 'Уточните имя или путь, чтобы увидеть остальные карты.' : ''
}

async function restoreManualTextures(file) {
  const images = state.folder && combinedImages()
  if (!images?.length || !stage.manualMaterials.length) return false
  const { maps } = state.folder
  const lookup = new Map(images.map(image => [image.selectionId, image]))
  await Promise.all(stage.manualMaterials.map(async (_, index) => {
    const remembered = maps[markKey(file.id, index)]
    const image = lookup.get(remembered) ?? lookup.get(state.folder.key + '.' + remembered)
    if (image && localTextures(image)) await stage.setManualTexture(index, image).catch(() => {})
  }))
  return true
}

function renderColorSource() {
  const colors = stage?.parts?.colorSummary()
  if (!colors) return
  const sources = [
    colors.maps && `с текстурой ${counts(colors.maps)}`,
    colors.vertices && `цвет вершин ${counts(colors.vertices)}`,
    colors.flat && `без цветовой карты ${counts(colors.flat)}`,
  ].filter(Boolean)
  ui['color-source'].hidden = !sources.length
  ui['color-source'].textContent = 'Материалы · ' + sources.join(' · ')
}

function renderTextureVariants() {
  const variant = stage?.variant
  ui['texture-tools'].hidden = !variant
  if (!variant) return
  ui['texture-variant'].replaceChildren(...variant.files.map((file, index) => new Option(file.name, String(index))))
  ui['texture-variant'].value = String(variant.index)
}

async function selectFile(file) {
  state.packLoad++
  const load = ++state.load
  state.file = file
  state.previewFailed = false
  rememberLocation()
  stage?.clear()
  ui['stage-image'].hidden = true
  ui['stage-image'].onload = ui['stage-image'].onerror = null
  ui['stage-image'].removeAttribute('src')
  if (imageObjectUrl) URL.revokeObjectURL(imageObjectUrl)
  imageObjectUrl = null
  setImageZoom(1)
  ui['stage-canvas'].hidden = true
  ui['view-options'].hidden = ui['part-tools'].hidden = ui['color-source'].hidden = true
  ui['texture-tools'].hidden = true
  ui['manual-texture'].hidden = true
  ui['manual-texture'].open = false
  ui['animation-tools'].hidden = true
  ui['model-stats'].textContent = ''
  ui.notice.textContent = ''
  ui['selected-name'].textContent = file?.name ?? 'Выберите файл'
  ui['selected-name'].title = file?.displayPath ?? ''
  modelCategoryControls()
  ui.note.value = currentMark()?.note ?? ''
  ui['stage-label'].hidden = !file
  ui['stage-label'].textContent = file ? file.ext.toUpperCase() + ' · ' + sizeLabel(file.size) : ''
  ui['source-link'].hidden = !file
  if (file) {
    ui['source-link'].href = file.url
    ui['source-link'].download = file.name
  }
  enableZoom(false)
  ui.rotate.disabled = ui.wireframe.disabled = true
  for (const button of [ui.rotate, ui.wireframe, ui.play]) pressed(button, false)
  ui.play.textContent = 'Пуск'
  renderFiles(true)
  renderDecision()
  if (!file) return status(state.folder ? 'В папке нет подходящих файлов.' : 'В этом наборе нет выбранного файла.')
  if (localTextures(file)) {
    let preview = file.preview
    if (!preview) {
      status('Загружаю текстуру…')
      try {
        const url = await decodedImageUrl(file)
        if (load !== state.load) { URL.revokeObjectURL(url); return }
        preview = imageObjectUrl = url
      } catch {
        if (load === state.load) {
          state.previewFailed = true
          status('Не удалось открыть изображение. Исходник доступен справа.')
        }
        return
      }
    }
    status('')
    const image = ui['stage-image']
    image.alt = file.name
    image.hidden = false
    image.onload = () => { if (load === state.load) enableZoom(true) }
    image.onerror = () => {
      if (load !== state.load) return
      state.previewFailed = true
      status('Изображение не открылось. Исходник доступен справа.')
    }
    image.src = preview
    return
  }
  if (file.kind !== 'model' || (!file.preview && !file.convertible)) {
    return status(file.previewIssue ? 'Не удалось создать GLB-превью. Исходник доступен справа.' :
      'Для этого файла нет браузерного предпросмотра. Исходник доступен справа.')
  }
  try {
    let preview = file
    if (file.convertible && !file.preview) {
      status('Blender готовит предпросмотр…')
      try { preview = await ensurePreview(file, state.folder) }
      catch (error) {
        if (load === state.load) {
          state.previewFailed = true
          status(error.message)
        }
        return
      }
      if (load !== state.load) return
    }
    ui['stage-canvas'].hidden = false
    stage ??= new ModelStage(ui['stage-canvas'])
    stage.resize()
    status('Загружаю модель…')
    const result = await stage.load(preview, modelResources(state.folder, state.active.files), state.active.unityMaterials)
    if (load !== state.load || !result) return
    if (result.empty) return status('В файле нет видимой геометрии. Исходник доступен справа.')
    const manual = await restoreManualTextures(file)
    if (load !== state.load) return
    status('')
    enableZoom(true)
    ui.rotate.disabled = false
    ui.wireframe.disabled = result.skeletonOnly
    ui['view-options'].hidden = result.skeletonOnly
    if (result.parts.length > 1) {
      ui['preview-part'].replaceChildren(new Option('Вся модель', ''),
        ...result.parts.map((name, index) => new Option(name, String(index))))
      ui['part-tools'].hidden = false
    }
    renderColorSource()
    const stats = result.skeletonOnly ? ['Скелет', counted(result.boneCount, 'кость', 'кости', 'костей')] : []
    if (result.meshes) stats.push(counted(result.meshes, 'меш', 'меша', 'мешей'),
      counted(result.triangles, 'треугольник', 'треугольника', 'треугольников'))
    if (result.points) stats.push(counted(result.points, 'точка', 'точки', 'точек'))
    if (result.lines) stats.push(counted(result.lines, 'объект с линиями', 'объекта с линиями', 'объектов с линиями'))
    if (result.clips.length) stats.push(counted(result.clips.length, 'анимация', 'анимации', 'анимаций'))
    ui['model-stats'].textContent = stats.join(' · ')
    renderTextureVariants()
    if (manual) {
      ui['manual-material'].replaceChildren(...stage.manualMaterials.map((material, index) =>
        new Option((index + 1) + '. ' + (material.name || 'Материал'), String(index))))
      ui['manual-search'].value = ''
      renderManualImages()
      ui['manual-texture'].hidden = false
    }
    if (result.clips.length) {
      ui.animation.replaceChildren(...result.clips.map((clip, index) => {
        const item = label('option', '', clip.name || 'Анимация ' + (index + 1))
        item.value = String(index)
        return item
      }))
      ui['animation-tools'].hidden = false
    }
  } catch (error) {
    if (load !== state.load) return
    state.previewFailed = true
    console.error(error)
    status('3D-предпросмотр недоступен. Исходник можно открыть из локальной папки.')
  }
}

async function selectPack(id, fileId) {
  const request = ++state.packLoad
  if (state.active?.id === id && !fileId && state.file && eligibleFile(state.active, state.file)) return
  try {
    const summary = state.packs.find(pack => pack.id === id)
    const folder = summary?.folderKey && localFolders.get(summary.folderKey)
    if (!summary) return
    const raw = await fetchPack(summary)
    if (request !== state.packLoad) return
    const pack = { ...raw, ...summary, files: raw.files }
    if (folder) {
      state.folder = folder
      ui['folder-root'].textContent = folder.root
      ui['folder-root'].title = folder.root
    }
    state.active = pack
    state.limit = filePageSize
    ui['file-list'].scrollTop = 0
    ui['file-search'].value = ''
    ui['pack-category'].textContent = categoryLabel(pack.category)
    ui['pack-title'].textContent = pack.title
    ui['pack-author'].textContent = [pack.author, pack.models ? '3D-файлы: ' + counts(pack.models) : null].filter(Boolean).join(' · ')
    showLicense(pack)
    renderPacks()
    const eligible = pack.files.filter(item => eligibleFile(pack, item))
    const file = eligible.find(item => item.id === fileId) ?? eligible.find(item => item.id === pack.defaultFile) ?? eligible[0]
    state.kind = ui.category.value ? 'model' :
      !state.candidates && file && ['model', 'image'].includes(file.kind) ? file.kind : 'all'
    await selectFile(file ?? null)
  } catch (error) {
    if (request === state.packLoad) {
      if (state.file) ui.notice.textContent = error.message
      else status(error.message)
    }
  }
}

async function saveReview(statusValue) {
  if (!state.file || !state.active || pendingSave) return
  const key = markKey(state.active.id, state.file.id)
  const folder = state.folder
  const pack = state.active
  const file = state.file
  pendingSave = true
  renderDecision()
  try {
    if (folder) {
      const entries = { ...folder.marks }
      const note = ui.note.value.trim()
      if (note || statusValue) entries[key] = { packId: pack.id, file: file.path, status: statusValue, note }
      else delete entries[key]
      localStorage.setItem(storageKey(folder, 'review'), JSON.stringify(entries))
      folder.marks = entries
      state.marks = localMarks()
    } else {
      const result = await json('/api/review', post({ pack: pack.id, file: file.id, status: statusValue, note: ui.note.value }))
      fab.marks = result.entries
      if (state.folder) return
      state.marks = fab.marks
    }
    if (state.file && key === markKey(state.active.id, state.file.id)) ui.notice.textContent = 'Сохранено локально'
    if (state.candidates) refreshCategoryResults()
    else {
      renderPacks()
      renderFiles()
    }
  } catch (error) {
    ui.notice.textContent = error.message
  } finally {
    pendingSave = false
    renderDecision()
  }
}

async function activateCatalog(folder, selection = {}) {
  state.folder = folder
  state.packs = folder ? [...localFolders.values()].flatMap(root => root.packs.map(pack => ({
    ...pack, id: localGroupId(root, pack.id), groupId: pack.id, folderKey: root.key,
  }))) : fab.packs
  state.marks = folder ? localMarks() : fab.marks
  state.candidates = false
  state.active = null
  void selectFile(null)
  ui.search.value = ''
  ui.search.placeholder = folder ? 'Название папки или формат' : 'Название или автор'
  ui['library-title'].textContent = folder ? 'Папки' : 'Наборы'
  ui['folder-tools'].hidden = !folder
  ui['folder-root'].textContent = folder?.root ?? ''
  ui['folder-root'].title = folder?.root ?? ''
  ui['category-wrap'].hidden = false
  fillCategories(ui.category, 'Все категории', false)
  ui.category.value = ''
  const total = state.packs.reduce((sum, pack) => sum + pack.models, 0)
  ui['library-stats'].textContent = folder
    ? counted(total, 'модель', 'модели', 'моделей') + ' · ' + counted(localFolders.size, 'ветка', 'ветки', 'веток')
    : counts(state.packs.length) + ' наборов · ' + counts(total) + ' 3D-файлов'
  renderPacks()
  const first = state.packs.find(pack => pack.id === selection.pack) ??
    (folder ? state.packs.find(pack => pack.folderKey === folder.key) : undefined) ??
    (folder ? undefined : state.packs.find(pack => pack.id === '43468395-d701-48e3-a3f3-53c3e2282938')) ?? state.packs[0]
  if (first?.id) await selectPack(first.id, selection.file)
  else {
    ui['pack-category'].textContent = folder ? 'Локальная папка' : 'Обзор'
    ui['pack-title'].textContent = folder ? 'Папка ассетов' : 'Библиотека ассетов'
    ui['pack-author'].textContent = ''
    ui.license.textContent = ''
    ui['fab-link'].hidden = true
    status(folder ? 'В папке нет подходящих файлов. Можно выбрать другую папку.' : 'Откройте локальную папку с ассетами.')
  }
}

function busyFolder(busy) {
  openingFolder = busy
  for (const name of ['folder-cancel', 'folder-submit', 'folder-path', 'folder-pick', 'rescan-folder']) ui[name].disabled = busy
}

async function openPath(path, rescan = false) {
  if (openingFolder) return
  busyFolder(true)
  const previousFolder = state.folder?.id
  const selected = rescan ? { pack: state.active?.id, file: state.file?.id } : {}
  const message = rescan ? ui.notice : ui['folder-status']
  message.textContent = 'Сканирую папку…'
  try {
    const category = rescan ? '' : categoryValue(ui['folder-category'], ui['new-folder-category'])
    const info = await json('/api/folder', post({ path }))
    if (rescan && state.folder?.id !== previousFolder) return
    const folder = registerFolder(info)
    if (category) classification.roots[folder.key] = category
    persistCategories()
    saveFolders()
    if (ui['folder-dialog'].open) ui['folder-dialog'].close()
    await activateCatalog(folder, selected)
  } catch (error) {
    message.textContent = error.message
  } finally {
    busyFolder(false)
  }
}

ui['fab-mode'].addEventListener('click', () => {
  if (state.folder) void activateCatalog(null, fab.selection ?? {})
})
function showFolderDialog() {
  ui['folder-path'].value = state.folder?.root ?? ''
  ui['folder-browser'].hidden = true
  fillCategories(ui['folder-category'], 'Выбрать позже', true)
  ui['folder-category'].value = ''
  ui['new-folder-category'].value = ''
  ui['new-folder-category'].hidden = true
  ui['folder-status'].textContent = ''
  ui['folder-dialog'].showModal()
}
ui['open-folder'].addEventListener('click', async () => {
  if (!state.folder && !localFolders.size && savedFolders().length) await restoreFolders()
  if (!state.folder && localFolders.size) return activateCatalog(localFolders.values().next().value, localSelection)
  showFolderDialog()
})
ui['add-folder'].addEventListener('click', showFolderDialog)
ui['remove-folder'].addEventListener('click', () => {
  if (!state.folder) return
  localFolders.delete(state.folder.key)
  saveFolders()
  const next = localFolders.values().next().value
  void activateCatalog(next ?? null, next ? {} : fab.selection ?? {})
})
ui['folder-form'].addEventListener('submit', event => {
  event.preventDefault()
  void openPath(ui['folder-path'].value)
})
ui['folder-cancel'].addEventListener('click', () => ui['folder-dialog'].close())
ui['folder-dialog'].addEventListener('cancel', event => { if (openingFolder) event.preventDefault() })
async function browsePath(path) {
  if (openingFolder) return
  busyFolder(true)
  ui['folder-status'].textContent = 'Открываю список папок…'
  try {
    const folder = await json('/api/folder/browse', post({ path }))
    ui['folder-path'].value = folder.path
    const items = folder.parent ? [{ name: '↑ На уровень выше', path: folder.parent }, ...folder.directories] : folder.directories
    const buttons = document.createDocumentFragment()
    for (const item of items) {
      const button = label('button', 'control', item.name)
      button.type = 'button'
      button.dataset.path = item.path
      buttons.append(button)
    }
    if (!items.length) buttons.append(label('p', 'notice', 'Вложенных папок нет.'))
    ui['folder-browser'].replaceChildren(buttons)
    ui['folder-browser'].hidden = false
    ui['folder-status'].textContent = ''
  } catch (error) {
    ui['folder-status'].textContent = error.message
  } finally {
    busyFolder(false)
  }
  if (!ui['folder-browser'].hidden) ui['folder-browser'].querySelector('button')?.focus()
}
ui['folder-pick'].addEventListener('click', () => void browsePath(ui['folder-path'].value))
ui['folder-path'].addEventListener('input', () => { ui['folder-browser'].hidden = true })
ui['folder-browser'].addEventListener('click', event => {
  const button = event.target.closest('[data-path]')
  if (button) void browsePath(button.dataset.path)
})
ui['rescan-folder'].addEventListener('click', () => { if (state.folder) void openPath(state.folder.root, true) })
for (const [select, input] of [[ui['folder-category'], ui['new-folder-category']], [ui['model-category'], ui['new-model-category']]]) {
  select.addEventListener('change', () => {
    input.hidden = select.value !== newCategory
    if (!input.hidden) input.focus()
  })
}
ui['save-model-category'].addEventListener('click', () => {
  const pack = state.active
  const file = state.file
  if (!pack || file?.kind !== 'model') return
  try {
    const selected = categoryValue(ui['model-category'], ui['new-model-category'])
    const key = markKey(pack.id, file.id)
    if (selected) classification.models[key] = selected
    else delete classification.models[key]
    persistCategories()
    modelCategoryControls()
    ui['model-category-status'].textContent = 'Категория сохранена.'
    refreshCategoryResults()
  } catch (error) {
    ui['model-category-status'].textContent = error.message
  }
})
ui['manual-search'].addEventListener('input', renderManualImages)
ui['manual-material'].addEventListener('change', renderManualImages)
ui['manual-apply'].addEventListener('click', async () => {
  if (!state.folder || !state.file || !stage) return
  const load = state.load
  const folder = state.folder
  const index = Number(ui['manual-material'].value)
  const key = markKey(state.file.id, index)
  const file = combinedImages().find(image => image.selectionId === ui['manual-image'].value)
  ui['manual-apply'].disabled = true
  try {
    await stage.setManualTexture(index, file)
    if (load !== state.load) return
    if (file) folder.maps[key] = file.selectionId
    else delete folder.maps[key]
    localStorage.setItem(storageKey(folder, 'textures'), JSON.stringify(folder.maps))
    renderManualImages()
    renderTextureVariants()
    renderColorSource()
    ui['manual-status'].textContent = file ? 'Текстура применена.' : 'Восстановлена автоматическая привязка.'
  } catch (error) {
    if (load === state.load) ui['manual-status'].textContent = error.message
  } finally {
    ui['manual-apply'].disabled = false
  }
})

ui.search.addEventListener('input', renderPacks)
function refreshCategoryResults() {
  state.packLoad++
  if (ui.category.value) state.kind = 'model'
  const packs = renderPacks()
  renderFiles()
  if (state.active && packs.some(pack => pack.id === state.active.id)) {
    if (state.file && eligibleFile(state.active, state.file)) return
    const file = state.active.files.find(file => eligibleFile(state.active, file))
    if (file) { void selectFile(file); return }
  }
  if (packs.length && packs[0].id !== state.active?.id) void selectPack(packs[0].id)
  else {
    state.active = null
    void selectFile(null)
    ui['pack-category'].textContent = ''
    ui['pack-title'].textContent = state.candidates ? 'Кандидаты' : 'Библиотека ассетов'
    ui['pack-author'].textContent = ''
    ui.license.textContent = ''
    ui.license.title = ''
    ui['fab-link'].hidden = true
    status(state.candidates ? 'В этой подборке пока нет кандидатов.' : 'В этой категории пока нет моделей.')
  }
}
ui.category.addEventListener('change', refreshCategoryResults)
ui['pack-list'].addEventListener('click', event => {
  const id = event.target.closest('[data-pack]')?.dataset.pack
  if (id) void selectPack(id)
})
ui['all-packs'].addEventListener('click', () => {
  state.candidates = false
  refreshCategoryResults()
})
ui['candidate-packs'].addEventListener('click', () => {
  state.candidates = true
  state.kind = ui.category.value ? 'model' : 'all'
  refreshCategoryResults()
})
ui['file-tabs'].addEventListener('click', event => {
  const kind = event.target.closest('[data-kind]')?.dataset.kind
  if (!kind) return
  state.kind = kind
  state.limit = filePageSize
  renderFiles()
})
ui['file-search'].addEventListener('input', () => { state.limit = filePageSize; renderFiles() })
ui['file-list'].addEventListener('click', event => {
  if (event.target.closest('[data-more]')) {
    state.limit += filePageSize
    renderFiles()
    return
  }
  const id = event.target.closest('[data-file]')?.dataset.file
  const file = state.active?.files.find(item => item.id === id)
  if (file && (file.id !== state.file?.id || state.previewFailed)) void selectFile(file)
})
ui.decision.addEventListener('click', event => {
  const status = event.target.closest('[data-status]')?.dataset.status
  if (status) void saveReview(currentMark()?.status === status ? '' : status)
})
ui['save-note'].addEventListener('click', () => void saveReview(currentMark()?.status ?? ''))
ui.fit.addEventListener('click', () => {
  if (ui['stage-image'].hidden) stage?.fit()
  else setImageZoom(1)
})
ui['zoom-in'].addEventListener('click', () => zoom(true))
ui['zoom-out'].addEventListener('click', () => zoom(false))
ui.lighting.addEventListener('change', () => stage?.setLighting(ui.lighting.value))
ui['preview-part'].addEventListener('change', () => {
  stage?.showPart(ui['preview-part'].value === '' ? -1 : Number(ui['preview-part'].value))
  renderTextureVariants()
  renderColorSource()
})
ui['texture-variant'].addEventListener('change', async () => {
  const load = state.load
  try {
    await stage?.setTextureVariant(Number(ui['texture-variant'].value))
    if (load === state.load) renderColorSource()
  } catch {
    if (load === state.load) {
      renderTextureVariants()
      ui.notice.textContent = 'Текстура не открылась'
    }
  }
})
ui.rotate.addEventListener('click', () => {
  if (!stage) return
  stage.controls.autoRotate = !stage.controls.autoRotate
  pressed(ui.rotate, stage.controls.autoRotate)
})
ui.wireframe.addEventListener('click', () => {
  const active = ui.wireframe.getAttribute('aria-pressed') !== 'true'
  stage?.wireframe(active)
  pressed(ui.wireframe, active)
})
ui.play.addEventListener('click', () => {
  if (ui.play.getAttribute('aria-pressed') === 'true') {
    stage?.pause()
    pressed(ui.play, false)
    ui.play.textContent = 'Пуск'
  } else if (stage?.play(Number(ui.animation.value))) {
    pressed(ui.play, true)
    ui.play.textContent = 'Пауза'
  }
})
ui.animation.addEventListener('change', () => {
  if (ui.play.getAttribute('aria-pressed') === 'true') stage?.play(Number(ui.animation.value))
})

try {
  const query = new URLSearchParams(location.search)
  const [index, review, config] = await Promise.all([json('/api/library').catch(() => ({ packs: [] })),
    json('/api/review').catch(() => ({ entries: {} })), json('/api/folder')])
  fab.packs = index.packs
  fab.marks = review.entries
  const selection = { pack: query.get('pack'), file: query.get('file') || undefined }
  const folderId = query.get('folder') ?? (query.get('pack') ? null : config.startup)
  let folder = null
  if (folderId) {
    const saved = savedFolders().find(entry => entry.id === folderId)
    await restoreFolders()
    folder = [...localFolders.values()].find(entry => entry.id === folderId || entry.root === saved?.root) ?? null
    if (!folder) {
      const info = await json('/api/folder/' + encodeURIComponent(folderId)).catch(() => null)
      if (info) folder = registerFolder(info)
    }
    if (folder) {
      if (selection.pack) selection.pack = localGroupId(folder, selection.pack)
      saveFolders()
    }
  }
  await activateCatalog(folder, selection)
  if (folderId && !folder) {
    ui['folder-status'].textContent = 'Папка закрыта. Выберите её снова.'
    if (!ui['folder-dialog'].open) ui['folder-dialog'].showModal()
  }
} catch (error) {
  ui['library-stats'].textContent = 'Каталог недоступен'
  status(error.message)
}
