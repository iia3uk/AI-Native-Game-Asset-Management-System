const element = id => document.getElementById('index-quality-' + id)
const path = '/api/index/quality-profiles'
const numbers = new Intl.NumberFormat('ru', { maximumSignificantDigits: 8 })
const labels = {
  maxVertices: 'Максимум вершин',
  maxTriangles: 'Максимум треугольников',
  maxMeshes: 'Максимум мешей',
  maxMaterials: 'Максимум материалов',
  maxTextureEdge: 'Максимальная сторона текстуры, px',
  minExtent: 'Минимум для наибольшего габарита',
  maxExtent: 'Максимум для наибольшего габарита',
  requireUV: 'Требовать UV',
  requireVerifiedDependencies: 'Проверять доступность зависимостей',
  requireValidStructure: 'Проверять разобранную структуру',
}
const summary = {
  pass: 'Пройдены все применимые проверки профиля.',
  fail: 'Есть превышения бюджета или ошибки.',
  unknown: 'Для части проверок не хватает данных.',
  'not-applicable': 'У профиля нет применимых проверок для этого файла.',
}
const checkStatus = { pass: 'Пройдено', fail: 'Не пройдено', unknown: 'Неизвестно', 'not-applicable': 'Не применимо' }
const explanations = {
  'metric-unknown': 'Значение не определено.',
  'texture-size-unknown': 'Размер части текстур неизвестен.',
  'asset-kind': 'Проверка не применяется к этому типу файла.',
  'source-missing': 'Исходный файл отсутствует.',
  'no-textures': 'Связанные текстуры не указаны.',
  'missing-dependencies': 'Недоступных зависимостей: ',
  'dependencies-unverified': 'Часть зависимостей требует подтверждения.',
  'dependencies-verified': 'Доступных и встроенных зависимостей: ',
  'structure-issues': 'Структурных ошибок в отчёте: ',
  'structure-unverified': 'Данных для проверки структуры недостаточно.',
  'structure-checked': 'В разобранной структуре ошибок не найдено.',
  'uv-found': 'В отчёте есть UV.',
  'uv-missing': 'UV не обнаружены.',
}

function explain(check) {
  const value = Number.isFinite(check.actual) ? numbers.format(check.actual) : ''
  if (check.reason === 'within-budget' || check.reason === 'outside-budget') {
    const limit = check.key === 'minExtent' ? 'Минимум' : 'Максимум'
    const unit = check.key === 'maxTextureEdge' ? ' px' : ''
    return 'Измерено ' + value + unit + '. ' + limit + ' ' + numbers.format(check.limit) + unit + '.'
  }
  if (check.reason === 'texture-size-unknown' && value) {
    return explanations[check.reason] + ' Наибольшая измеренная сторона: ' + value + ' px.'
  }
  const explanation = explanations[check.reason] ?? ''
  return explanation.endsWith(': ') ? explanation + value + '.' : explanation
}

export function mountQualityProfile({ json, post, run, currentAsset }) {
  const panel = document.getElementById('index-quality')
  const select = element('profile')
  const editor = element('editor')
  const edit = element('edit')
  const reset = element('reset')
  const status = element('status')
  const report = element('report')
  let fields
  let draft

  function show(validation) {
    report.replaceChildren()
    status.textContent = validation ? summary[validation.status] : 'Выберите профиль.'
    if (!validation) return
    for (const check of validation.checks) {
      const item = document.createElement('li')
      const label = document.createElement('span')
      const state = document.createElement('strong')
      const reason = document.createElement('small')
      label.textContent = labels[check.key]
      state.textContent = checkStatus[check.status]
      state.dataset.result = check.status
      const evidence = check.evidence ? ' ' + check.evidence : ''
      reason.textContent = explain(check) + evidence
      item.append(label, state, reason)
      report.append(item)
    }
  }

  async function load() {
    if (fields) return
    const data = await json(path)
    fields = data.fields
    const controls = []
    for (const [name, field] of Object.entries(fields)) {
      const label = document.createElement('label')
      const input = document.createElement('input')
      if (field.type === 'boolean') {
        input.type = 'checkbox'
        label.className = 'index-quality-flag'
        label.append(input, labels[name])
      } else {
        input.type = 'number'
        input.min = field.min
        input.max = field.max
        input.step = field.type === 'integer' ? '1' : 'any'
        label.append(labels[name], input)
      }
      input.name = name
      controls.push(label)
    }
    element('fields').replaceChildren(...controls)
    select.replaceChildren(new Option('Выберите профиль', ''), ...data.profiles.map(profile =>
      new Option(profile.name, profile.id)))
  }

  function assetUrl(id) {
    return '/api/index/assets/' + id + (select.value ? '?' + new URLSearchParams({ profile: select.value }) : '')
  }

  async function evaluate() {
    const id = currentAsset()
    if (id && select.value) {
      const { validation } = await json(assetUrl(id))
      show(validation)
    } else show()
  }

  function closeEditor() {
    editor.hidden = true
    draft = undefined
    edit.setAttribute('aria-expanded', 'false')
  }

  async function save(change) {
    await json(path + '/' + draft.id, post({ revision: draft.revision, ...change }))
    closeEditor()
    await evaluate()
  }

  select.addEventListener('change', () => void run(async () => {
    closeEditor()
    show()
    await evaluate()
  }))
  edit.addEventListener('click', () => void run(async () => {
    if (!editor.hidden) return closeEditor()
    const { profiles: current } = await json(path)
    draft = current.find(profile => profile.id === select.value)
    if (!draft) return
    for (const [name, field] of Object.entries(fields)) {
      const input = editor.elements[name]
      if (field.type === 'boolean') input.checked = Boolean(draft.limits[name])
      else input.value = draft.limits[name] ?? ''
    }
    editor.hidden = false
    edit.setAttribute('aria-expanded', 'true')
    editor.elements.maxVertices.focus()
  }))
  editor.addEventListener('submit', event => {
    event.preventDefault()
    void run(() => {
      const limits = {}
      for (const [name, field] of Object.entries(fields)) {
        const input = editor.elements[name]
        if (field.type === 'boolean') {
          if (input.checked) limits[name] = true
        } else if (input.value !== '') limits[name] = input.valueAsNumber
      }
      return save({ limits })
    })
  })
  reset.addEventListener('click', () => void run(() => save({ reset: true })))
  element('cancel').addEventListener('click', closeEditor)

  return {
    assetUrl, load, show,
    visible(visible) {
      panel.hidden = !visible
      if (!visible) closeEditor()
    },
    busy(busy) {
      select.disabled = busy || !fields
      edit.disabled = busy || !select.value
      element('save').disabled = busy || !draft
      reset.disabled = busy || !draft?.customized
      element('cancel').disabled = busy
    },
  }
}
