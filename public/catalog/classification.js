import { normalize } from './format.js'
import { fileReviewKey, storageNamespace, storedValue } from './viewer-storage.js'

const categories = {
  Animals: 'Животные', Animations: 'Анимации', Architecture: 'Архитектура', Bushes: 'Кустарники', Characters: 'Персонажи',
  Crafting: 'Ремесло', Dungeons: 'Подземелья', Fishing: 'Рыбалка', Magic: 'Магия', Mixed_Packs: 'Смешанные наборы',
  Mounts: 'Ездовые животные', Nature: 'Природа', Resources: 'Ресурсы', Rocks: 'Камни', Terrain: 'Рельеф', Textures: 'Текстуры',
  Trees: 'Деревья', Vegetation: 'Растительность', VFX: 'Эффекты', Villages: 'Поселения',
  Local: 'Папка',
}
const classificationStorage = storageNamespace + '.classification.v1'
export const newCategory = '__new_category__'
const noCategory = '__no_category__'

export function createClassification(storage) {
  function loadClassification() {
    try {
      const data = JSON.parse(storedValue(storage, classificationStorage) ?? '{}')
      return { names: data.names ?? {}, roots: data.roots ?? {}, models: data.models ?? {} }
    } catch { return { names: {}, roots: {}, models: {} } }
  }

  const classification = loadClassification()
  let revision = 0

  const folderCategory = pack => pack.folderKey ? classification.roots[pack.folderKey] ?? noCategory : pack.category ?? noCategory
  const modelCategory = (pack, file) => classification.models[fileReviewKey(pack, file.id)] ?? folderCategory(pack)
  function modelsInCategory(pack, selected) {
    if (!selected) return pack.models
    if (pack.modelIds) {
      return pack.modelIds.reduce((sum, id) => sum + Number((classification.models[fileReviewKey(pack, id)] ?? folderCategory(pack)) === selected), 0)
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
    storage.setItem(classificationStorage, JSON.stringify(classification))
    revision++
  }

  const categoryLabel = key => key === noCategory ? 'Без категории' : classification.names[key] ?? categories[key] ?? key

  return {
    get revision() { return revision },
    folderCategory, modelCategory, categoryLabel, modelsInCategory, fillCategories, categoryValue, persistCategories,
    modelOverride: key => classification.models[key],
    setFolderCategory: (key, value) => { classification.roots[key] = value },
    setModelCategory: (key, value) => {
      if (value) classification.models[key] = value
      else delete classification.models[key]
    },
  }
}
