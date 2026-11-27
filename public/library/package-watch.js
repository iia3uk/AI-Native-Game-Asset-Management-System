export function mountPackageWatch(panel, onToggle) {
  const summary = panel.querySelector('summary')
  const buttons = panel.querySelectorAll('button[data-format]')
  for (const button of buttons) {
    button.addEventListener('click', () => onToggle(button.dataset.format, button.textContent.trim()))
  }

  return {
    update(library, busy) {
      const formats = library?.packageWatchFormats ?? []
      summary.textContent = formats.length ? 'Автоимпорт пакетов · ' + formats.length : 'Автоимпорт пакетов'
      for (const button of buttons) {
        button.disabled = busy || !library
        button.setAttribute('aria-pressed', String(formats.includes(button.dataset.format)))
      }
    },
  }
}
