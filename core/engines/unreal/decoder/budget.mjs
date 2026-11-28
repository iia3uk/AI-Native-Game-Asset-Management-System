const maxFile = 64 * 1024 ** 2
const maxBatch = 1024 ** 3

export function boundedCookedBatch(inputs, maximum) {
  let size = 0
  let limited = false
  const selected = []
  const files = []
  for (const input of inputs) {
    const members = [...input.files.values()]
    const bytes = members.reduce((sum, file) => sum + file.info.size, 0)
    if (selected.length >= maximum || size + bytes > maxBatch || members.some(file => file.info.size > maxFile)) {
      limited = true
      continue
    }
    const prefix = String(selected.length).padStart(5, '0') + '.'
    for (const [type, file] of input.files) files.push({ stageName: prefix + type, file })
    selected.push(input)
    size += bytes
  }
  return { selected, files, size, limited }
}
