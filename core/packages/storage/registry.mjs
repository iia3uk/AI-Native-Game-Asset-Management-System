import { randomUUID } from 'node:crypto'
import { pathKey } from '../../files/asset-files.mjs'

function storage(row) {
  if (!row) return null
  const { id, root: path, dev, ino, destination, destination_dev, destination_ino } = row
  return { id, path, dev, ino, destination: { path: destination, dev: destination_dev, ino: destination_ino } }
}

export class PackageStorage {
  #db

  constructor(db) { this.#db = db }

  get(id) {
    return storage(this.#db.prepare('SELECT * FROM package_output_roots WHERE id = ?').get(id))
  }

  at({ path, dev, ino }) {
    return storage(this.#db.prepare(`SELECT * FROM package_output_roots
      WHERE destination_key = ? AND destination_dev = ? AND destination_ino = ?`).get(pathKey(path), dev, ino))
  }

  register(root, destination) {
    this.#db.prepare(`INSERT INTO package_output_roots
      (id, destination, destination_key, destination_dev, destination_ino, root, dev, ino) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (destination_key, destination_dev, destination_ino) DO NOTHING`)
      .run(randomUUID(), destination.path, pathKey(destination.path), destination.dev, destination.ino,
        root.path, root.dev, root.ino)
    return this.at(destination)
  }

  paths() {
    return this.#db.prepare('SELECT root FROM package_output_roots').all().map(row => row.root)
  }
}
