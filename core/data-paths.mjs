import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

function absoluteSetting(value, name) {
  if (!isAbsolute(value)) throw new Error(name + ' must be an absolute path.')
  return value
}

export function dataPaths(env = process.env, platform = process.platform, home = homedir()) {
  const override = env.ASSET_VIEWER_DATA_DIR
  let data, cache, config
  if (override) {
    const root = absoluteSetting(override, 'ASSET_VIEWER_DATA_DIR')
    data = config = root
    cache = join(root, 'cache')
  } else if (platform === 'win32') {
    data = config = join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'AssetViewer')
    cache = join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'AssetViewer')
  } else if (platform === 'darwin') {
    data = config = join(home, 'Library', 'Application Support', 'AssetViewer')
    cache = join(home, 'Library', 'Caches', 'AssetViewer')
  } else {
    const xdg = (value, fallback) => value && isAbsolute(value) ? value : join(home, fallback)
    data = join(xdg(env.XDG_DATA_HOME, '.local/share'), 'asset-viewer')
    cache = join(xdg(env.XDG_CACHE_HOME, '.cache'), 'asset-viewer')
    config = join(xdg(env.XDG_CONFIG_HOME, '.config'), 'asset-viewer')
  }
  return { data, cache, config, database: join(data, 'index.sqlite'), backups: join(data, 'backups'),
    demo: join(cache, 'demo-v1'), logs: join(cache, 'logs'), temporary: join(cache, 'tmp') }
}
