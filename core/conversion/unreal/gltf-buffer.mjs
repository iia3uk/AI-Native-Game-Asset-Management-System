const elementTypes = new Map([[1, 'SCALAR'], [2, 'VEC2'], [3, 'VEC3'], [4, 'VEC4'], [16, 'MAT4']])

export function meshBuffer() {
  const parts = []
  const bufferViews = []
  const accessors = []
  let size = 0
  function appendView(values, target) {
    const bytes = Buffer.from(values.buffer, values.byteOffset, values.byteLength)
    const index = bufferViews.length
    bufferViews.push({ buffer: 0, byteOffset: size, byteLength: bytes.length, ...(target && { target }) })
    parts.push(bytes)
    size += bytes.length
    const padding = (4 - size % 4) % 4
    if (padding) parts.push(Buffer.alloc(padding))
    size += padding
    return index
  }
  function append(values, components, componentType, target, extras) {
    const bufferView = appendView(values, target)
    return accessors.push({ bufferView, componentType, count: values.length / components,
      type: elementTypes.get(components), ...extras }) - 1
  }
  function finish(uri) {
    // A dedicated backing buffer can be transferred by the conversion worker.
    const buffer = Buffer.allocUnsafeSlow(size)
    let offset = 0
    for (const part of parts) offset += part.copy(buffer, offset)
    return { buffer, layout: { accessors, bufferViews, buffers: [{ uri, byteLength: size }] } }
  }
  return { append, appendView, finish }
}
