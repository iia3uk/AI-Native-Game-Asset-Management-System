export function mountImportOptions($) {
  const mode = $('engine-mode')
  const editor = $('editor-version')
  const unreal = $('unreal-version')
  function sync() {
    $('editor-version-control').hidden = $('unreal-version-control').hidden = mode.value === 'engineless'
  }
  mode.addEventListener('change', sync)
  sync()
  return format => ({
    mode: mode.value,
    formats: ['fbx', 'glb'].filter(format => $('export-' + format).checked),
    ...(mode.value !== 'engineless' && { editorVersion: (format.startsWith('unreal-') ? unreal : editor).value.trim() }),
  })
}
