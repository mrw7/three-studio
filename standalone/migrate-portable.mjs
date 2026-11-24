#!/usr/bin/env node
/**
 * Migrate a Linux fd-anchored scene store into the portable snapshot backend.
 *
 * The migration loads the disk store through the normal scene-engine startup,
 * stops it, and writes a portable manifest plus content-addressed blobs. The
 * original disk data is never deleted. Run this on Linux (the disk store's
 * platform); copy the resulting `portable/` directory to macOS/Windows or point
 * THREE_WORKBENCH_DATA_DIR at the target directory.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { apply, __diskInternal } from '../index.js'

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node standalone/migrate-portable.mjs [--from DIR] [--to DIR] [--force]

  --from   Linux disk store root (default: $THREE_WORKBENCH_DATA_DIR or
           $THREE_STUDIO_HOME/scenes, then ~/.three-studio/scenes)
  --to     target root that receives portable/ (default: same as --from)
  --force  overwrite an existing target portable/portable-store.json

The source disk store is left untouched.`)
  process.exit(0)
}

const studioHome = process.env.THREE_STUDIO_HOME || join(homedir(), '.three-studio')
const from = resolve(option('from') || process.env.THREE_WORKBENCH_DATA_DIR || join(studioHome, 'scenes'))
const to = resolve(option('to') || from)
const force = args.includes('--force')
const targetManifest = join(to, 'portable', 'portable-store.json')

if (existsSync(targetManifest) && !force) {
  console.error(`Refusing to overwrite an existing portable store: ${targetManifest}`)
  console.error('Re-run with --force if that is intentional.')
  process.exit(1)
}

process.env.THREE_WORKBENCH_DATA_DIR = from
// The migration needs the Linux fd store, not the portable backend.
process.env.THREE_STUDIO_PORTABLE_STORE = '0'

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
  if (ready.mode !== 'disk') {
    throw new Error(`expected the Linux disk store at ${from}, got mode "${ready.mode}" (${ready.status ?? 'no status'})`)
  }
  const result = await __diskInternal.portable.migrateToPortable(to)
  console.log(JSON.stringify({ from, ...result }, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
