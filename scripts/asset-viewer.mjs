#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { AssetIndex, IndexInputError } from '../core/asset-index.mjs'
import { discoverAssets, folderPath } from '../core/asset-files.mjs'
import { dataPaths } from '../core/data-paths.mjs'

const string = { type: 'string' }
const flag = { type: 'boolean' }
const paging = { limit: string, offset: string }
const commands = {
  libraries: { args: [], options: {} },
  connect: { args: ['absolute-path'], options: { 'dry-run': flag } },
  scan: { args: ['library-id'], options: { 'dry-run': flag } },
  watch: { args: ['library-id', 'on|off'], options: {} },
  search: { args: ['query?'], options: { ...paging, library: string, kind: string, hash: string } },
  inspect: { args: ['asset-id'], options: { profile: string } },
  profiles: { args: [], options: {} },
  profile: { args: ['profile-id'], options: { 'set-json': string, reset: flag } },
  duplicates: { args: [], options: paging },
  export: { args: [], options: { library: string } },
  doctor: { args: [], options: {} },
  backup: { args: [], options: { 'dry-run': flag } },
  mcp: { args: [], options: {} },
}

function help() {
  console.log('Asset Viewer CLI\n\nUsage: asset-viewer <command> [arguments] [--json]\n\nCommands')
  for (const [name, { args, options }] of Object.entries(commands)) {
    const flags = Object.entries(options).map(([key, value]) => '[--' + key + (value.type === 'string' ? ' value]' : ']'))
    const syntax = args.map(arg => arg.endsWith('?') ? '[' + arg.slice(0, -1) + ']' : '<' + arg + '>')
    console.log('  ' + [name, ...syntax, ...flags].join(' '))
  }
}

function page(values) {
  const integer = (value, fallback) => {
    if (value === undefined) return fallback
    if (!/^\d+$/.test(value)) throw new IndexInputError('Expected an integer for limit or offset.')
    return Number(value)
  }
  return { limit: integer(values.limit, 50), offset: integer(values.offset, 0) }
}

function print(data, json) {
  if (json) console.log(JSON.stringify(data))
  else if (Array.isArray(data)) console.table(data)
  else console.dir(data, { depth: 4, colors: Boolean(process.stdout.isTTY) })
}

async function execute(index, paths, command, [input, setting], values) {
  switch (command) {
    case 'libraries': return index.libraries()
    case 'connect': return index.connect(input)
    case 'watch': return index.setWatching(input, setting === 'on')
    case 'scan': {
      if (!values['dry-run']) return index.scan(input)
      const library = index.libraries().find(library => library.id === input)
      if (!library) throw new IndexInputError('Unknown connected library ID.')
      let files = 0
      let bytes = 0
      for await (const file of discoverAssets(library.root, { strict: true })) {
        files++
        bytes += file.info.size
      }
      return { dryRun: true, files, bytes }
    }
    case 'search': return index.search({ q: input, kind: values.kind, libraryId: values.library, hash: values.hash, ...page(values) })
    case 'profiles': return index.qualityProfiles.list()
    case 'profile': {
      const profile = index.qualityProfiles.get(input)
      if (values.reset) return index.qualityProfiles.update(input, { revision: profile.revision, reset: true })
      if (values['set-json'] === undefined) return profile
      let limits
      try { limits = JSON.parse(values['set-json']) } catch { throw new IndexInputError('Profile limits must be valid JSON.') }
      return index.qualityProfiles.update(input, { revision: profile.revision, limits })
    }
    case 'inspect': {
      const details = index.inspect(input, { profileId: values.profile })
      if (!details) throw new Error('Asset unavailable.')
      return details
    }
    case 'duplicates': {
      const { limit, offset } = page(values)
      return index.duplicates(limit, offset)
    }
    case 'export': return index.exportMetadata(values.library)
    case 'doctor': return { node: process.version, platform: process.platform, database: paths.database, ...index.integrity() }
    case 'backup': return { path: await index.backup(paths.backups) }
  }
}

async function main([command, ...args]) {
  if (!command || command === 'help' || command === '--help') return help()
  const spec = Object.hasOwn(commands, command) && commands[command]
  if (!spec) throw new IndexInputError('Unknown command. Run asset-viewer --help.')
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { ...spec.options, json: flag, help: flag } })
  } catch (error) {
    throw new IndexInputError(error.message)
  }
  const { positionals, values } = parsed
  if (values.help) return help()
  const required = spec.args.filter(arg => !arg.endsWith('?')).length
  if (positionals.length < required || positionals.length > spec.args.length) {
    throw new IndexInputError('Incorrect arguments for ' + command + '. Run asset-viewer --help.')
  }
  const [input, setting] = positionals
  if (command === 'watch' && !['on', 'off'].includes(setting)) {
    throw new IndexInputError('Use on or off to set library watching.')
  }
  const modifiesProfile = command === 'profile' && (values.reset || values['set-json'] !== undefined)
  if (command === 'profile' && values.reset && values['set-json'] !== undefined) {
    throw new IndexInputError('Use either --set-json or --reset.')
  }
  const paths = dataPaths()
  if (command === 'connect' && values['dry-run']) {
    return print({ dryRun: true, root: await folderPath(input) }, values.json)
  }
  if (command === 'backup' && values['dry-run']) {
    return print({ dryRun: true, database: paths.database, backups: paths.backups }, values.json)
  }
  if (command === 'doctor' && !existsSync(paths.database)) {
    return print({ node: process.version, platform: process.platform, database: paths.database, initialized: false }, values.json)
  }
  if (command === 'mcp') {
    const { startMcp } = await import('./asset-mcp.mjs')
    await startMcp(paths.database)
    return
  }
  const readOnly = (!['connect', 'scan', 'watch'].includes(command) && !modifiesProfile) || Boolean(values['dry-run'])
  const index = readOnly ? new AssetIndex(paths.database, { readOnly }) : await AssetIndex.open(paths.database)
  try {
    const result = await execute(index, paths, command, positionals, values)
    if (command === 'doctor' && !result.ok) process.exitCode = 1
    print(result, values.json || command === 'export')
  } finally {
    await index.close()
  }
}

try {
  await main(process.argv.slice(2))
} catch (error) {
  console.error(error.message)
  process.exitCode = error instanceof IndexInputError ? 2 : 1
}
