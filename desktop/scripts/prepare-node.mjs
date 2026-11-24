#!/usr/bin/env node
/**
 * Copy a Node 24 binary into desktop/vendor/node/<platform>-<arch>/ so the
 * packaged desktop app can spawn the standalone server without relying on the
 * user's PATH.
 *
 * Usage:
 *   node scripts/prepare-node.mjs                 # current Node if it is 24.x
 *   node scripts/prepare-node.mjs --node /path/to/node24
 *   node scripts/prepare-node.mjs --node ./node --platform darwin --arch arm64
 *
 * Cross-platform builds must be prepared with a matching target Node binary;
 * this script does not download binaries (the build machine should already
 * have the target Node 24 artifact or network access to fetch it).
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(here, '..')
const args = process.argv.slice(2)

const option = name => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null
}

const platform = option('platform') || process.platform
const arch = option('arch') || process.arch
const requested = option('node')
const source = resolve(requested || process.execPath)
const executable = platform === 'win32' ? 'node.exe' : 'node'
const targetDir = join(desktopRoot, 'vendor', 'node', `${platform}-${arch}`)
const target = join(targetDir, executable)

if (existsSync(target) && !args.includes('--force')) {
  console.log(`Bundled Node already present: ${target} (use --force to replace)`)
  process.exit(0)
}

if (!existsSync(source)) {
  console.error(`Node binary not found: ${source}`)
  process.exit(1)
}

if (platform === process.platform && arch === process.arch) {
  const version = execFileSync(source, ['--version'], { encoding: 'utf8' }).trim()
  if (!/^v24\./u.test(version)) {
    console.error(`Desktop packaging requires Node 24; ${source} reports ${version}.`)
    console.error('Pass --node /path/to/node24 or install Node 24 first.')
    process.exit(1)
  }
}

mkdirSync(targetDir, { recursive: true })
copyFileSync(source, target)
if (platform !== 'win32') chmodSync(target, 0o755)
console.log(`Bundled Node for ${platform}-${arch}: ${target}`)
