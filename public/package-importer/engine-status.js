export function mountEngineStatus({ json }) {
  const discover = document.getElementById('package-engines')
  const list = document.getElementById('package-engine-list')
  const status = document.getElementById('package-engine-status')
  const labels = { unity: 'Unity Editor', unreal: 'Unreal Editor', blender: 'Blender' }
  discover.addEventListener('click', async () => {
    discover.disabled = true
    status.textContent = 'Поиск инструментов…'
    try {
      const inventory = await json('/api/index/engines')
      list.replaceChildren()
      for (const [engine, label] of Object.entries(labels)) {
        const candidates = inventory[engine]
        if (!candidates.length) {
          const row = document.createElement('li')
          row.textContent = label + ' · Установка не обнаружена'
          list.append(row)
        }
        for (const { version, executable } of candidates) {
          const row = document.createElement('li')
          row.textContent = label + ' · ' + (version ?? 'Версия неизвестна')
          const path = document.createElement('small')
          path.textContent = executable
          row.append(path)
          list.append(row)
        }
      }
      status.textContent = ''
    } catch (error) {
      status.textContent = error.message
    } finally {
      discover.disabled = false
    }
  })
}
