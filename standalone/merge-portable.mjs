#!/usr/bin/env node
/**
 * Merge one portable snapshot store into another.
 *
 * Source and target are data roots (the directory that contains `portable/`).
 * The target store is loaded normally, source rows are validated and merged in
 * memory, then the target manifest and blobs are rewritten atomically. Conflicts
 * are skipped by default; pass --on-conflict replace to overwrite same-id
 * scenes/assets/shares/thumbnails. Assets with the same session/name are always
 * skipped rather than renamed.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { apply, __diskInternal } from '../index.js'

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null
}

if (args.includes('--help') || args.includes('-h') || option('from') === null) {
  console.log(`Usage: node standalone/merge-portable.mjs --from DIR [--to DIR] [--on-conflict skip|replace]

  --from          source data root (contains portable/portable-store.json)
  --to            target data root (default: $THREE_WORKBENCH_DATA_DIR or
                  $THREE_STUDIO_HOME/scenes, then ~/.three-studio/scenes)
  --on-conflict   skip (default) or replace same-id records
`)
  process.exit(option('from') === null && !args.includes('--help') && !args.includes('-h') ? 1 : 0)
}

const normalizeRoot = value => {
  const absolute = resolve(value)
  if (basename(absolute) === 'portable' && existsSync(join(absolute, 'portable-store.json'))) {
    return dirname(absolute)
  }
  return absolute
}

const conflictOption = option('on-conflict') || 'skip'
if (conflictOption !== 'skip' && conflictOption !== 'replace') {
  console.error('--on-conflict must be "skip" or "replace"')
  process.exit(1)
}

const source = normalizeRoot(option('from'))
const studioHome = process.env.THREE_STUDIO_HOME || join(homedir(), '.three-studio')
const target = normalizeRoot(option('to') || process.env.THREE_WORKBENCH_DATA_DIR || join(studioHome, 'scenes'))
if (source === target) {
  console.error('Source and target are the same data root.')
  process.exit(1)
}

// Load the target as a portable store, then merge the source into it.
process.env.THREE_WORKBENCH_DATA_DIR = target
process.env.THREE_STUDIO_PORTABLE_STORE = '1'

const ctx = {
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  tools: { register() { return () => {} } },
  systemPrompt: { section() { return () => {} } },
  inject(names, callback) {
    if (!Array.isArray(names) || !names.includes('webServer')) return
    callback({
      on() { return () => {} },
      effect: ctx.effect,
      webServer: { register() { return () => {} } },
    })
  },
  get(name) {
    return name === 'webServer' ? { register() { return () => {} } } : undefined
  },
}

try {
  apply(ctx)
  const ready = await __diskInternal.waitReadyForTests()
  if (ready.mode !== 'portable') {
    throw new Error(`target is not a portable store (mode "${ready.mode}", status "${ready.status ?? ''}")`)
  }
  const result = await __diskInternal.portable.importFrom(source, { conflict: conflictOption })
  console.log(JSON.stringify(result, null, 2))
  if (result.saved !== true) process.exitCode = 1
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
