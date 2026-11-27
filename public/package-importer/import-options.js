export function mountImportOptions($) {
  const mode = $('engine-mode')
  const editor = $('editor-version')
  const sync = () => { $('editor-version-control').hidden = mode.value === 'engineless' }
  mode.addEventListener('change', sync)
  sync()
  return () => ({
    mode: mode.value,
    formats: ['fbx', 'glb'].filter(format => $('export-' + format).checked),
    ...(mode.value !== 'engineless' && editor.value.trim() && { editorVersion: editor.value.trim() }),
  })
}
