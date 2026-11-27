#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { AssetIndex, IndexInputError } from '../core/index/asset-index.mjs'
import { discoverAssets, folderPath } from '../core/files/asset-files.mjs'
import { dataPaths } from '../core/config/data-paths.mjs'
import { ProcessingWorker } from '../core/processing/processing-worker.mjs'
import { ThumbnailCache } from '../core/thumbnails/thumbnail-cache.mjs'
import { assetThumbnail } from '../core/thumbnails/thumbnail-service.mjs'
import { inspectPackage, packageOptions } from '../core/packages/dispatch.mjs'
import { packageSource } from '../core/packages/unity/paths.mjs'
import { importUnityBundle } from '../core/packages/unity/bundle/import.mjs'
import { engineInventory } from '../core/engines/inventory.mjs'
import { inspectUnreal } from '../core/packages/unreal/inspect.mjs'
import { exportUnrealWithEditor } from '../core/packages/unreal/export.mjs'
import { extractUnrealPak } from '../core/packages/unreal/extract.mjs'

const string = { type: 'string' }
const flag = { type: 'boolean' }
const paging = { limit: string, offset: string }
const commands = {
  libraries: { args: [], options: {} },
  connect: { args: ['absolute-path'], options: { 'dry-run': flag } },
  scan: { args: ['library-id'], options: { 'dry-run': flag } },
  watch: { args: ['library-id', 'on|off'], options: {} },
  'watch-packages': { args: ['library-id', 'on|off'], options: {} },
  search: { args: ['query?'], options: { ...paging, library: string, kind: string, hash: string } },
  inspect: { args: ['asset-id'], options: { profile: string } },
  preview: { args: ['asset-id'], options: { 'dry-run': flag, queue: flag, status: flag } },
  jobs: { args: ['job-id?'], options: { ...paging, library: string, type: string, cancel: flag, retry: flag } },
  'package-inspect': { args: ['absolute-path'], options: {} },
  'package-import': { args: ['absolute-path'], options: { 'dry-run': flag, queue: flag, export: string,
    mode: string, 'unity-version': string } },
  'unity-bundle': { args: ['absolute-path'], options: { inspect: flag, fbx: flag } },
  'unreal-inspect': { args: ['absolute-path'], options: {} },
  'unreal-export': { args: ['absolute-path'], options: { 'unreal-version': string } },
  'unreal-extract': { args: ['absolute-path'], options: { inspect: flag } },
  engines: { args: [], options: { 'unity-project': string, 'unreal-project': string } },
  'thumbnail-cache': { args: [], options: { clear: flag, 'dry-run': flag } },
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

async function preview(index, cache, id, values) {
  const enqueue = !values['dry-run'] && !values.status
  let result = await assetThumbnail(index, cache, id, { enqueue })
  if (!result) throw new IndexInputError('Asset unavailable.')
  if (values['dry-run']) return { dryRun: true, ...result }
  if (values.status || values.queue || !result.job) return result
  const finished = await waitForJob(index, result.job.id, { type: 'thumbnail', cache })
  result = await assetThumbnail(index, cache, id)
  return { ...result, job: finished }
}

async function waitForJob(index, id, options) {
  const worker = new ProcessingWorker(index, { ...options, targetId: id })
  const stop = new AbortController()
  const abort = () => stop.abort()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, abort)
  try {
    return await worker.wait(id, stop.signal)
  } finally {
    await worker.stop()
    for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, abort)
  }
}

async function runPackageOperation(paths, label, operation) {
  const stop = new AbortController()
  const abort = () => stop.abort()
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, abort)
  try {
    const report = await operation({ directory: paths.imports, signal: stop.signal })
    if (!report.output || report.status === 'no-compatible-inputs') {
      if (report.status !== 'completed') process.exitCode = 1
      return report
    }
    const index = await AssetIndex.open(paths.database)
    try {
      const library = index.registerLibrary(report.output, label + ' · ' + report.sourceName)
      return { ...report, library, scan: await index.scan(library.id, { signal: stop.signal }) }
    } finally {
      await index.close()
    }
  } finally {
    for (const event of ['SIGINT', 'SIGTERM']) process.off(event, abort)
  }
}

async function execute(index, paths, command, [input, setting], values) {
  switch (command) {
    case 'libraries': return index.libraries()
    case 'connect': return index.connect(input)
    case 'watch': return index.setWatching(input, setting === 'on')
    case 'watch-packages': return index.setPackageWatching(input, setting === 'on', [paths.cache, paths.backups, paths.imports])
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
    case 'preview': {
      const result = await preview(index, new ThumbnailCache(paths.thumbnails), input, values)
      if (!values['dry-run'] && !values.status && !['available', 'pending', 'running'].includes(result.status)) process.exitCode = 1
      return result
    }
    case 'jobs': {
      if (input) {
        const job = values.cancel ? index.jobs.cancel(input) : values.retry ? index.jobs.retry(input) : index.jobs.get(input)
        if (!job) throw new IndexInputError('Job unavailable.')
        return job
      }
      const { limit, offset } = page(values)
      if (limit < 1 || limit > 200 || !Number.isSafeInteger(offset) ||
          (values.type !== undefined && !['scan', 'thumbnail', 'package-import'].includes(values.type))) {
        throw new IndexInputError('Invalid jobs page or type.')
      }
      return index.jobs.list({ type: values.type, libraryId: values.library, limit, offset })
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
  if (['watch', 'watch-packages'].includes(command) && !['on', 'off'].includes(setting)) {
    throw new IndexInputError('Use on or off to set library watching.')
  }
  const modifiesProfile = command === 'profile' && (values.reset || values['set-json'] !== undefined)
  if (command === 'profile' && values.reset && values['set-json'] !== undefined) {
    throw new IndexInputError('Use either --set-json or --reset.')
  }
  const paths = dataPaths()
  if (command === 'engines') return print(await engineInventory({
    unityProject: values['unity-project'], unrealProject: values['unreal-project'],
  }), values.json)
  if (command === 'unreal-inspect') {
    return print(await inspectUnreal(input, { signal: AbortSignal.timeout(120_000) }), values.json)
  }
  if (command === 'unity-bundle') return print(await runPackageOperation(paths, 'Unity Bundle', options =>
    importUnityBundle(input, { ...options, inspectOnly: values.inspect, withFbx: values.fbx })), values.json)
  if (command === 'unreal-export') return print(await runPackageOperation(paths, 'Unreal', options =>
    exportUnrealWithEditor(input, { ...options, unrealVersion: values['unreal-version'] })), values.json)
  if (command === 'unreal-extract') return print(await runPackageOperation(paths, 'Unreal', options =>
    extractUnrealPak(input, { ...options, inspectOnly: values.inspect })), values.json)
  if (command === 'package-inspect' || command === 'package-import') {
    if (values.queue && values['dry-run']) throw new IndexInputError('Use only one of --queue or --dry-run.')
    const source = await packageSource(input)
    const report = await inspectPackage(source, { signal: AbortSignal.timeout(120_000) })
    if (command === 'package-inspect') return print(report, values.json)
    const { formats: exportFormats, ...options } = packageOptions(report.format, {
      mode: values.mode, editorVersion: values['unity-version'], formats: values.export?.split(','),
    })
    if (values['dry-run']) return print({ dryRun: true, ...report, ...options,
      ...(exportFormats && { exportFormats: exportFormats.split(',') }) }, values.json)
    const index = await AssetIndex.open(paths.database)
    try {
      const queued = index.jobs.enqueueImport(source.path, report.hash, exportFormats, options)
      if (values.queue) return print({ job: queued }, values.json)
      const job = await waitForJob(index, queued.id, { type: 'package-import', importDirectory: paths.imports })
      const scan = job.result?.scanJobId ? await waitForJob(index, job.result.scanJobId, { type: 'scan' }) : null
      if (job.status !== 'completed' || (scan && scan.status !== 'completed')) process.exitCode = 1
      return print({ job, scan }, values.json)
    } finally {
      await index.close()
    }
  }
  if (command === 'connect' && values['dry-run']) {
    return print({ dryRun: true, root: await folderPath(input) }, values.json)
  }
  if (command === 'backup' && values['dry-run']) {
    return print({ dryRun: true, database: paths.database, backups: paths.backups }, values.json)
  }
  if (command === 'doctor' && !existsSync(paths.database)) {
    return print({ node: process.version, platform: process.platform, database: paths.database, initialized: false }, values.json)
  }
  if (command === 'preview' && [values.queue, values.status, values['dry-run']].filter(Boolean).length > 1) {
    throw new IndexInputError('Use only one of --queue, --status or --dry-run.')
  }
  if (command === 'thumbnail-cache') {
    const cache = new ThumbnailCache(paths.thumbnails)
    const result = values.clear && !values['dry-run'] ? await cache.clear() : await cache.usage()
    return print(values['dry-run'] ? { dryRun: true, ...result } : result, values.json)
  }
  if (command === 'mcp') {
    const { startMcp } = await import('./asset-mcp.mjs')
    await startMcp(paths.database)
    return
  }
  const queuesPreview = command === 'preview' && !values.status
  const changesJob = command === 'jobs' && (values.cancel || values.retry)
  if (changesJob && (!input || (values.cancel && values.retry))) throw new IndexInputError('Specify a job ID and one action.')
  const readOnly = (!['connect', 'scan', 'watch', 'watch-packages'].includes(command) && !modifiesProfile && !queuesPreview && !changesJob) ||
    Boolean(values['dry-run'])
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
