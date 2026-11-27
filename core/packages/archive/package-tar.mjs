import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { checkedPath, sameFile } from '../../files/asset-files.mjs'
import { IndexInputError } from '../../index/index-errors.mjs'

const block = 512
const utf8 = new TextDecoder('utf-8', { fatal: true })
const empty = bytes => bytes.every(byte => byte === 0)
const string = bytes => utf8.decode(bytes.subarray(0, bytes.indexOf(0) === -1 ? bytes.length : bytes.indexOf(0)))
const invalid = detail => new IndexInputError('Архив Unity: ' + detail)

function octal(bytes) {
  const value = string(bytes).trim()
  if (!/^[0-7]+$/.test(value)) throw invalid('ошибка в числовом поле TAR.')
  const number = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(number)) throw invalid('числовое поле TAR слишком велико.')
  return number
}

function header(bytes) {
  const expected = octal(bytes.subarray(148, 156))
  let sum = 0
  for (let offset = 0; offset < block; offset++) sum += offset >= 148 && offset < 156 ? 32 : bytes[offset]
  if (sum !== expected) throw invalid('неверная контрольная сумма заголовка TAR.')
  const name = string(bytes.subarray(0, 100))
  const prefix = bytes.subarray(257, 263).equals(Buffer.from('ustar\0'))
    ? string(bytes.subarray(345, 500)) : ''
  const type = bytes[156] ? String.fromCharCode(bytes[156]) : '0'
  return { name: prefix ? prefix + '/' + name : name, size: octal(bytes.subarray(124, 136)), type }
}

function paxAttributes(bytes) {
  let path
  let offset = 0
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset)
    const lengthText = bytes.toString('ascii', offset, space)
    if (space < offset || !/^[1-9][0-9]{0,4}$/.test(lengthText)) throw invalid('повреждён заголовок PAX.')
    const end = offset + Number(lengthText)
    const equals = bytes.indexOf(61, space + 1)
    if (end > bytes.length || equals <= space + 1 || equals >= end - 1 || bytes[end - 1] !== 10) {
      throw invalid('повреждён заголовок PAX.')
    }
    const key = utf8.decode(bytes.subarray(space + 1, equals))
    if (key === 'path') {
      if (path !== undefined) throw invalid('поле path повторяется в PAX.')
      path = utf8.decode(bytes.subarray(equals + 1, end - 1))
    } else if (!['mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'comment', 'charset', 'hdrcharset'].includes(key)) {
      throw invalid('неподдерживаемое поле PAX.')
    }
    offset = end
  }
  return path
}

async function readTar(stream, limits, entry, signal) {
  const iterator = stream[Symbol.asyncIterator]()
  let chunk = Buffer.alloc(0)
  let unpacked = 0
  async function next() {
    signal?.throwIfAborted()
    const value = await iterator.next()
    if (value.done) return false
    chunk = value.value
    unpacked += chunk.length
    if (unpacked > limits.unpacked) throw invalid('превышен предел распакованного объёма.')
    return true
  }
  async function consume(length, write) {
    while (length) {
      signal?.throwIfAborted()
      if (!chunk.length && !await next()) throw invalid('TAR оборван.')
      const count = Math.min(length, chunk.length)
      if (write) await write(chunk.subarray(0, count))
      chunk = chunk.subarray(count)
      length -= count
    }
  }
  async function read(length) {
    const bytes = Buffer.alloc(length)
    let offset = 0
    await consume(length, data => { offset += data.copy(bytes, offset) })
    return bytes
  }

  let overwrite
  let extended = false
  for (let count = 0; ; count++) {
    const raw = await read(block)
    if (empty(raw)) {
      if (extended || !empty(await read(block))) throw invalid('неверный конец TAR.')
      do {
        if (!empty(chunk)) throw invalid('в TAR обнаружены данные после завершающих блоков.')
      } while (await next())
      return unpacked
    }
    if (count >= limits.entries) throw invalid('превышен предел числа записей TAR.')
    const item = header(raw)
    if (item.size > limits.entry) throw invalid('файл в архиве превышает допустимый размер.')
    if (item.type === 'x' || item.type === 'L') {
      if (extended || item.size > 4096) throw invalid('недопустимое расширение заголовка TAR.')
      const bytes = await read(item.size)
      overwrite = item.type === 'x' ? paxAttributes(bytes) : string(bytes)
      extended = true
    } else {
      if (!['0', '5'].includes(item.type) || (item.type === '5' && item.size)) {
        throw invalid('ссылки и специальные записи TAR не поддерживаются.')
      }
      const name = overwrite ?? item.name
      overwrite = undefined
      extended = false
      let readBody = false
      await entry({ ...item, name }, async write => {
        if (readBody) throw new Error('TAR entry already consumed.')
        readBody = true
        await consume(item.size, write)
      })
      if (!readBody) await consume(item.size)
    }
    await consume((block - item.size % block) % block)
  }
}

export async function unityTar(file, root, limits, entry, { signal, progress } = {}) {
  const handle = await open(file, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !await checkedPath(root, file)) throw invalid('файл недоступен.')
    if (opened.size > limits.compressed) throw invalid('пакет превышает допустимый размер.')
    const magic = Buffer.alloc(3)
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0)
    if (bytesRead !== 3 || !magic.equals(Buffer.from([0x1f, 0x8b, 0x08]))) {
      throw invalid('формат не распознан. Ожидается пакет Unity в TAR.GZ.')
    }
    let size = 0
    const hash = createHash('sha256')
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length
        if (size > limits.compressed) return callback(invalid('пакет превышает допустимый размер.'))
        hash.update(chunk)
        try {
          progress?.(Math.min(70, Math.floor(size * 70 / opened.size)))
        } catch (error) {
          return callback(error)
        }
        callback(null, chunk)
      },
    })
    const unpacked = await pipeline(handle.createReadStream({ start: 0, autoClose: false }), meter, createGunzip(),
      stream => readTar(stream, limits, entry, signal), { signal })
    if (size !== opened.size || !sameFile(opened, await handle.stat()) || !await checkedPath(root, file)) {
      throw invalid('файл изменился во время чтения.')
    }
    return { hash: hash.digest('hex'), size, unpacked }
  } catch (error) {
    if (error.code?.startsWith('Z_') || error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') {
      throw invalid('повреждены сжатые данные или текстовые поля.')
    }
    throw error
  } finally {
    await handle.close()
  }
}
