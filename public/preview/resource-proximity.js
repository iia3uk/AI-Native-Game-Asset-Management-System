export function closest(candidates, source) {
  if (candidates.length < 2) return candidates[0]
  const root = source.url.startsWith('/local-files/') && source.url.split('/', 3)[2]
  if (root) {
    const ownFolder = candidates.filter(file => file.url?.startsWith('/local-files/' + root + '/'))
    if (ownFolder.length < 2) return ownFolder[0]
    candidates = ownFolder
  }
  const directory = file => file.path.toLowerCase().split('/').slice(0, -1)
  const parent = directory(source)
  const ranked = candidates.map(file => {
    const parts = directory(file)
    let shared = 0
    while (shared < parent.length && parts[shared] === parent[shared]) shared++
    return { file, shared, distance: parent.length + parts.length - 2 * shared }
  }).sort((a, b) => b.shared - a.shared || a.distance - b.distance)
  const [best, next] = ranked
  if (best.shared > next.shared || best.distance < next.distance) return best.file
}
