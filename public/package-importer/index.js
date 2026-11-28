import { mountEngineStatus } from './engine-status.js'
import { mountPackageFolder } from './folder.js'
import { formatLabel, isUnityBinary, isUnityFolder, isUnrealArchive, isUnrealLoose } from './formats.js'
import { appendManifest, assetLabel, cookedMeshSummary, describeIssue } from './report.js'
import { mountImportOptions } from './import-options.js'
import { mountPackageExport } from './export.js'
import { requestPackageCleanup } from './cleanup.js'
import { mountFolderProcessing } from './folder-processing.js'

const $ = name => document.getElementById('package-' + name)
const jobsRoute = '/api/index/jobs'
const packagesRoute = '/api/index/packages'
const batchSize = 16
const selectionKey = ({ root, path }) => JSON.stringify([root, path])
const selectionLabel = ({ root, path }) => root ? path : path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1)
const active = job => ['pending', 'running'].includes(job.status)
const assetStatus = {
  ready: 'Готово', extracted: 'Прямое извлечение', unsupported: 'Не поддерживается',
  available: 'Доступно для декодирования', 'requires-engine': 'Требуется обработчик Unity', failed: 'Ошибка обработки',
  'missing-dependencies': 'Отсутствуют зависимости', converted: 'Сконвертировано', skipped: 'Пропущено',
}
const jobStatus = {
  pending: 'В очереди', running: 'Обработка', paused: 'На паузе', completed: 'Обработан',
  cancelled: 'Отменён', interrupted: 'Прерван', failed: 'Ошибка',
}

function element(tag, text) {
  const node = document.createElement(tag)
  if (text) node.textContent = text
  return node
}

function button(text, action) {
  const node = element('button', text)
  node.type = 'button'
  node.className = 'control'
  node.addEventListener('click', action)
  return node
}

export function mountPackageImporter({ dialog, json, post, openIndex, openLibrary, hasWatchedLibraries }) {
  mountEngineStatus({ json })
  const importOptions = mountImportOptions($)
  const section = $('importer')
  const plans = $('plans')
  const jobs = $('jobs')
  const status = $('status')
  const cleanupStatus = $('cleanup-status')
  const pathInput = $('path')
  const fileInput = $('files')
  const startAll = $('start-all')
  const queuedPlans = new Map()
  const bridge = window.assetViewerDesktop
  let timer
  let refreshVersion = 0
  let jobRows = new Map()
  let busy = false

  const visible = () => dialog.open && section.open
  function showError(error) {
    status.textContent = error.message
  }

  async function refresh() {
    clearTimeout(timer)
    const version = ++refreshVersion
    if (!visible()) return
    try {
      const { jobs: records } = await json(jobsRoute + '?type=package-import&limit=16')
      const rows = await Promise.all(records.map(async record => {
        const scan = record.result?.scanJobId
          ? (await json(jobsRoute + '/' + record.result.scanJobId)).job : null
        return { record, scan }
      }))
      if (!visible() || version !== refreshVersion) return
      const previous = jobRows
      jobRows = new Map(rows.map(row => {
        const { id } = row.record
        const key = JSON.stringify(row)
        const cached = previous.get(id)
        return [id, cached?.key === key ? cached : { key, node: jobRow(row) }]
      }))
      const nodes = [...jobRows.values()].map(row => row.node)
      if (nodes.length !== jobs.children.length || nodes.some((node, index) => jobs.children[index] !== node)) jobs.replaceChildren(...nodes)
      if (rows.some(({ record, scan }) => active(record) || (scan && active(scan)))) {
        timer = setTimeout(() => void refresh(), 1000)
      } else if (rows.some(({ record }) => record.status === 'paused') || hasWatchedLibraries()) {
        timer = setTimeout(() => void refresh(), 3000)
      }
    } catch (error) {
      if (!visible() || version !== refreshVersion) return
      showError(error)
      timer = setTimeout(() => void refresh(), 3000)
    }
  }

  function jobRow({ record, scan }) {
    const row = element('li')
    row.className = 'index-analysis'
    let label = jobStatus[record.status]
    if (active(record) && record.cancelRequested) label = 'Отмена запрошена'
    else if (record.status === 'running' && record.pauseRequested) label = 'Приостановка'
    else if (record.status === 'running') label += ' · ' + record.progress + '%'
    else if (record.result?.report?.status === 'no-compatible-inputs') label = 'Нет совместимых файлов'
    if (scan) label += ' · ' + (active(scan) ? 'Индексация' : scan.status === 'completed' ? 'В индексе' : 'Индексация прервана')
    row.append(element('p', record.packageName + (record.trigger === 'watch' ? ' · Автоимпорт' : '') + ' · ' + label))
    if (record.error || scan?.error) row.append(element('p', record.error ?? scan.error))
    const controls = element('div')
    controls.className = 'index-toolbar'
    if (active(record) && !record.cancelRequested && !record.pauseRequested) {
      controls.append(jobButton('Приостановить', record, 'pause'))
    }
    if (record.status === 'paused') controls.append(jobButton('Продолжить', record, 'resume'))
    if ((active(record) || record.status === 'paused') && !record.cancelRequested) {
      controls.append(jobButton('Отменить', record, 'cancel'))
    }
    if (['failed', 'interrupted', 'cancelled'].includes(record.status) && record.attempts < 3) {
      controls.append(jobButton('Повторить', record, 'retry'))
    }
    if (scan && !active(scan)) {
      controls.append(button('Показать в индексе', () => void openLibrary(record.libraryId).catch(showError)))
    }
    if (record.result) {
      const details = element('details')
      details.append(element('summary', 'Отчёт об импорте'),
        element('p', Object.entries(record.result.report.counts).map(([key, value]) =>
          (assetStatus[key] ?? key) + ' · ' + value).join(' / ')),
        element('p', record.result.directory))
      const materials = record.result.report.materials
      if (materials?.written) details.append(element('p', 'Описаний материалов · ' + materials.written))
      if (isUnityBinary(record.result.report.packageFormat)) {
        const { packageFormat, format, unityVersion, converted, total } = record.result.report
        details.append(element('p', formatLabel(packageFormat) + ' ' + format + ' · Unity ' + unityVersion +
          ' · Декодировано ' + converted + ' из ' + total))
      }
      if (isUnityFolder(record.result.report.packageFormat)) {
        const { packageFormat, engineVersion } = record.result.report
        details.append(element('p', [formatLabel(packageFormat), engineVersion].filter(Boolean).join(' · ')))
      }
      if (isUnrealLoose(record.result.report.packageFormat)) {
        const { packageFormat, engineVersion, unreal, media, soundCues, unrealViewer, unrealSourceMeshes,
          unrealSourceMaterials, unrealCooked } = record.result.report
        const gltf = (unrealViewer?.gltf ?? 0) + (unrealSourceMeshes?.gltf ?? 0)
        const textured = (unrealViewer?.materials?.texturedGltf ?? 0) + (unrealSourceMeshes?.texturedGltf ?? 0)
        const materials = (unrealViewer?.materials?.materialJson ?? 0) + (unrealSourceMaterials?.materialJson ?? 0)
        const packed = (unrealViewer?.materials?.packedMaterials ?? 0) + (unrealSourceMaterials?.packedMaterials ?? 0)
        const normals = unrealSourceMaterials?.normalMaterials
        const masks = unrealSourceMaterials?.opacityMaterials
        const collision = unrealSourceMeshes?.collision
        const fbx = (unrealViewer?.derivatives?.fbx ?? 0) + (unrealSourceMeshes?.derivatives?.fbx ?? 0)
        const glb = (unrealViewer?.derivatives?.glb ?? 0) + (unrealSourceMeshes?.derivatives?.glb ?? 0)
        details.append(element('p', [formatLabel(packageFormat), engineVersion || unreal?.editorVersion,
          media?.png && media.png + ' PNG', media?.wav && media.wav + ' WAV',
          soundCues?.graphs && 'Графов SoundCue · ' + soundCues.graphs,
          soundCues?.incomplete && 'Неполных SoundCue · ' + soundCues.incomplete,
          unrealSourceMeshes?.meshes && 'Статических моделей UE4 · ' + unrealSourceMeshes.meshes,
          collision?.shapes && 'Форм коллизии · ' + collision.shapes,
          collision?.incomplete && 'Пакетов с неполными коллизиями · ' + collision.incomplete,
          gltf && gltf + ' glTF', unrealViewer?.psa && unrealViewer.psa + ' PSA',
          materials && 'Описаний материалов · ' + materials,
          packed && 'С картой AO/roughness/metallic · ' + packed,
          normals && 'С картой нормалей · ' + normals,
          masks && 'С маской прозрачности · ' + masks,
          textured && textured + ' glTF с текстурами',
          fbx && fbx + ' FBX', glb && glb + ' GLB',
          unrealSourceMeshes?.issue && describeIssue(unrealSourceMeshes.issue),
          unrealSourceMaterials?.issue && describeIssue(unrealSourceMaterials.issue),
          soundCues?.issue && describeIssue(soundCues.issue),
          unrealViewer?.issue && describeIssue(unrealViewer.issue),
          unreal?.issue && describeIssue(unreal.issue)].filter(Boolean).join(' · ')))
        if (unrealCooked) {
          const { textures, materials, meshes } = unrealCooked
          details.append(element('p', ['Cooked UE4.27',
            textures.converted && 'Текстуры · ' + textures.converted + ' PNG',
            materials.converted && 'Описания материалов · ' + materials.converted,
            (textures.skipped + materials.skipped) || (textures.failed + materials.failed) ?
              'Пропущено ' + (textures.skipped + materials.skipped) + ', ошибок ' + (textures.failed + materials.failed) : '',
            textures.issue && describeIssue(textures.issue),
            materials.issue && describeIssue(materials.issue)].filter(Boolean).join(' · ')))
          if (meshes) details.append(element('p', cookedMeshSummary(meshes)))
        }
      }
      if (record.result.report.packageFormat === 'unreal-pak') {
        const { containerVersion, extracted, textures, materials, meshes, total } = record.result.report
        details.append(element('p', 'Unreal Pak ' + containerVersion + ' · Извлечено ' + extracted + ' из ' + total))
        if (textures?.converted) details.append(element('p', 'Текстур из cooked-ресурсов · ' + textures.converted + ' PNG'))
        if (materials) {
          details.append(element('p', ['Материалы из cooked-ресурсов', materials.converted && 'Готово ' + materials.converted,
            materials.skipped && 'Пропущено ' + materials.skipped, materials.failed && 'Ошибок ' + materials.failed,
            materials.issue && describeIssue(materials.issue)].filter(Boolean).join(' · ')))
        }
        if (meshes) details.append(element('p', cookedMeshSummary(meshes)))
      }
      if (record.result.report.packageFormat === 'unreal-iostore') {
        const { containerVersion, extracted, extractedTypes, textures, audio, total } = record.result.report
        details.append(element('p', 'Unreal IoStore ' + containerVersion + ' · Извлечено ' + extracted + ' из ' + total))
        if (extractedTypes) details.append(element('p', [
          'Готовых файлов · ' + extractedTypes.file,
          'Блоков в формате IoStore · ' + (extractedTypes.package + extractedTypes.bulk + extractedTypes.registry),
        ].join(' · ')))
        if (textures?.converted) details.append(element('p', 'Текстур из Zen-пакетов · ' + textures.converted + ' PNG'))
        if (audio?.converted || audio?.skipped || audio?.failed) {
          details.append(element('p', ['Аудио из Zen-пакетов', audio.converted && 'Готово ' + audio.converted,
            audio.skipped && 'Пропущено ' + audio.skipped, audio.failed && 'Ошибок ' + audio.failed].filter(Boolean).join(' · ')))
        }
      }
      if (record.result.report.export) {
        details.append(element('p', 'Моделей сконвертировано · ' + record.result.report.converted))
      }
      const unity = record.result.report.export?.unity
      if (unity?.status === 'completed') details.append(element('p', 'Unity Editor ' + unity.editorVersion))
      else if (unity?.issue) details.append(element('p', 'Unity Editor · ' + describeIssue(unity.issue)))
      const exporter = (!scan || !active(scan)) && mountPackageExport({ record, json, post,
        chooseFolder: bridge?.chooseFolder, element, button })
      if (exporter) details.append(exporter.panel)
      if (bridge?.cleanupSource && scan?.status === 'completed' && record.result.report.packageFormat !== 'unreal-iostore') {
        const cleanup = button('Исходники в корзину…', async () => {
          if (busy) return
          busy = cleanup.disabled = true
          try { await requestPackageCleanup(bridge, record.id, cleanupStatus) }
          finally { busy = cleanup.disabled = false }
        })
        details.append(cleanup)
      }
      appendManifest({ details, record, json, element, button, assetStatus, selectAsset: exporter?.selectAsset })
      row.append(details)
    }
    row.append(controls)
    return row
  }

  function jobButton(title, record, action) {
    return button(title, event => {
      event.currentTarget.disabled = true
      void json(jobsRoute + '/' + record.id + '/' + action, post({})).then(refresh, error => {
        showError(error)
        void refresh()
      })
    })
  }

  async function queuePlan(target, plan, options = importOptions(plan.format)) {
    if (isUnityBinary(plan.format)) options = { mode: 'engineless', formats: options.formats }
    if (isUnrealArchive(plan.format)) {
      options = { mode: 'engineless', ...(plan.format === 'unreal-pak' && { formats: options.formats }) }
    }
    if (plan.format === 'unreal-asset' || (isUnrealLoose(plan.format) && options.mode === 'engineless')) {
      options = { mode: 'engineless', formats: options.formats }
    }
    const queued = await json(packagesRoute + '/import', post({ ...target, hash: plan.hash, ...options }))
    const key = selectionKey(target)
    queuedPlans.get(key)?.row.remove()
    queuedPlans.delete(key)
    startAll.hidden = queuedPlans.size < 2
    return queued
  }

  startAll.addEventListener('click', async () => {
    if (busy) return
    busy = startAll.disabled = true
    try {
      const batch = [...queuedPlans.values()].map(item => ({ ...item, options: importOptions(item.plan.format) }))
      for (const { target, plan, start, options } of batch) {
        start.disabled = true
        try { await queuePlan(target, plan, options) }
        catch (error) { showError(error); start.disabled = false }
      }
      await refresh()
    } finally {
      busy = startAll.disabled = false
    }
  })

  function planRow(target, plan) {
    const row = element('li')
    row.className = 'index-analysis'
    const details = element('details')
    const preview = element('ul')
    const shown = plan.assets.slice(0, 50)
    for (const asset of shown) {
      const status = isUnrealArchive(plan.format) && asset.status === 'available' ? 'Доступно для извлечения' :
        isUnrealLoose(plan.format) && asset.status === 'extracted' ? 'Готово к копированию' :
        assetStatus[asset.status] ?? asset.status
      preview.append(element('li', [assetLabel(asset), status, asset.issue && describeIssue(asset.issue)].filter(Boolean).join(' · ')))
    }
    details.append(element('summary', selectionLabel(target) + ' · ' + plan.total + ' записей'), preview)
    if (isUnityBinary(plan.format)) {
      details.insertBefore(element('p', formatLabel(plan.format) + ' ' + plan.containerVersion +
        ' · Unity ' + plan.unityVersion + ' · Без Unity Editor'), preview)
      if (plan.resources?.length) {
        details.insertBefore(element('p', 'Файлы данных · ' + plan.resources.map(resource => resource.name).join(', ')), preview)
      }
    }
    if (plan.format === 'unreal-pak') {
      details.insertBefore(element('p', 'Unreal Pak ' + plan.containerVersion + ' · Извлечение и конвертация'), preview)
    }
    if (plan.format === 'unreal-iostore') {
      details.insertBefore(element('p', 'Unreal IoStore ' + plan.containerVersion + ' · Всего блоков · ' + plan.chunks), preview)
      details.insertBefore(element('p', plan.files.map(file => file.name).join(', ')), preview)
    }
    if (isUnityFolder(plan.format)) {
      const packages = plan.packages.slice(0, 8).map(pack => pack.name + ' ' + pack.version)
      if (plan.packages.length > packages.length) packages.push('ещё ' + (plan.packages.length - packages.length))
      details.insertBefore(element('p', [formatLabel(plan.format), plan.engineVersion,
        ...packages].filter(Boolean).join(' · ')), preview)
    }
    if (isUnrealLoose(plan.format)) {
      details.insertBefore(element('p', [formatLabel(plan.format), plan.engineVersion].filter(Boolean).join(' · ')), preview)
    }
    if (plan.total > shown.length) details.append(element('p', 'Показано ' + shown.length + ' из ' + plan.total + ' записей.'))
    const start = button('Обработать и добавить в индекс', async () => {
      if (busy) return
      busy = true
      start.disabled = true
      try {
        await queuePlan(target, plan)
        await refresh()
      } catch (error) {
        showError(error)
        start.disabled = false
      } finally {
        busy = false
      }
    })
    row.append(details, start)
    queuedPlans.set(selectionKey(target), { target, plan, row, start })
    return row
  }

  async function inspect(targets) {
    if (busy) return
    busy = true
    plans.replaceChildren()
    queuedPlans.clear()
    startAll.hidden = true
    const unique = [...new Map(targets.filter(target => target.path).map(target => [selectionKey(target), target])).values()]
    const batch = unique.slice(0, batchSize)
    try {
      for (const [index, target] of batch.entries()) {
        status.textContent = `Анализ пакета ${index + 1} из ${batch.length}…`
        try {
          const { package: plan } = await json(packagesRoute + '/inspect', post(target))
          plans.append(planRow(target, plan))
        } catch (error) {
          plans.append(element('li', selectionLabel(target) + ' · ' + error.message))
        }
      }
      status.textContent = unique.length > batchSize ? 'За один раз можно проанализировать до ' + batchSize + ' пакетов.' : ''
      startAll.hidden = queuedPlans.size < 2
    } finally {
      busy = false
    }
  }

  $('form').addEventListener('submit', event => {
    event.preventDefault()
    if (pathInput.value.trim()) void inspect([{ path: pathInput.value.trim() }])
  })
  if (bridge?.chooseFolder) {
    const pickProject = $('pick-project')
    pickProject.hidden = false
    pickProject.addEventListener('click', async () => {
      if (busy) return
      try {
        const path = await bridge.chooseFolder()
        if (path) {
          pathInput.value = path
          await inspect([{ path }])
        }
      } catch (error) { showError(error) }
    })
  }
  mountFolderProcessing({ get: $, bridge, json, post, importOptions, refresh, openIndex,
    async runLocked(action) {
      if (busy) return
      busy = true
      try { await action() }
      finally { busy = false }
    } })
  section.addEventListener('toggle', () => void refresh())
  dialog.addEventListener('close', () => {
    if (!dialog.open) void refresh()
  })
  if (bridge?.selectedFilePath) {
    const select = files => void inspect(Array.from(files, file => ({ path: bridge.selectedFilePath(file) })))
    $('drop').hidden = $('pick').hidden = false
    $('pick').addEventListener('click', () => fileInput.click())
    fileInput.addEventListener('change', () => { select(fileInput.files); fileInput.value = '' })
    section.addEventListener('dragover', event => {
      if (event.dataTransfer.types.includes('Files')) event.preventDefault()
    })
    section.addEventListener('drop', event => {
      if (!event.dataTransfer.files.length) return
      event.preventDefault()
      select(event.dataTransfer.files)
    })
  }
  mountPackageFolder({ $, scan: path => json(packagesRoute + '/folder', post({ path, structured: true })), inspect,
    chooseFolder: bridge?.chooseFolder, batchSize })
  return { refresh }
}
