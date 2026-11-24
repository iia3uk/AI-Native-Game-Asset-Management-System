export const storageNamespace = 'asset-viewer'

export function storedValue(storage, key) {
  const value = storage.getItem(key)
  if (value !== null) return value
  // Import settings from a single prior namespace on this origin.
  const suffix = key.slice(storageNamespace.length)
  const previous = Object.keys(storage).filter(candidate => candidate.endsWith(suffix) &&
    /^[a-z][a-z\d_-]*$/i.test(candidate.slice(0, -suffix.length)))
  if (previous.length !== 1) return null
  const inherited = storage.getItem(previous[0])
  if (inherited !== null) {
    try { storage.setItem(key, inherited) } catch { /* read it even when storage is full */ }
  }
  return inherited
}
