#!/usr/bin/env node
/**
 * Pre-release gate for the desktop build and Pro license setup.
 * This does not sign or upload anything; it refuses obvious incomplete states.
 */
import { createPublicKey } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { validateManifest } from './template-pack.mjs'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const warnings = []
const checks = []

const exists = async path => {
  try { await access(path); return true } catch { return false }
}
const check = async (path, label) => {
  const present = await exists(join(desktopRoot, path))
  checks.push({ label, path, present })
  if (!present) errors.push(`missing ${path}`)
}

const pkg = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'))

for (const file of [
  'main.mjs', 'preload.cjs', 'build/icon.svg', 'build/icon.png', 'build/icon.ico',
  'license/core.mjs', 'license/public-key.pem', 'templates/manifest.json',
  'scripts/prepare-node.mjs', 'scripts/license.mjs', 'scripts/template-pack.mjs',
  'scripts/assemble-templates.mjs',
]) await check(file, file)

try {
  createPublicKey(await readFile(join(desktopRoot, 'license/public-key.pem'), 'utf8'))
} catch (error) {
  errors.push('license/public-key.pem is not a valid public key')
}

const readManifest = async path => {
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  const manifestErrors = validateManifest(manifest)
  return { manifest, manifestErrors }
}

try {
  const { manifest, manifestErrors } = await readManifest(join(desktopRoot, 'templates/manifest.json'))
  if (manifestErrors.length > 0) {
    errors.push(`templates/manifest.json: ${manifestErrors.join('; ')}`)
  } else {
    checks.push({ label: 'free template pack', path: 'templates/manifest.json', templates: manifest.templates.length })
  }
} catch (error) {
  errors.push(`templates/manifest.json: ${error.message}`)
}

const proManifestPath = join(desktopRoot, 'templates/pro/manifest.json')
if (await exists(proManifestPath)) {
  try {
    const { manifest, manifestErrors } = await readManifest(proManifestPath)
    if (manifestErrors.length > 0) {
      errors.push(`templates/pro/manifest.json: ${manifestErrors.join('; ')}`)
    } else {
      checks.push({ label: 'private Pro template pack', path: 'templates/pro/manifest.json', templates: manifest.templates.length })
    }
  } catch (error) {
    errors.push(`templates/pro/manifest.json: ${error.message}`)
  }
} else if (process.env.THREE_STUDIO_REQUIRE_PRO_TEMPLATES === '1') {
  errors.push('templates/pro/manifest.json is missing: run scripts/assemble-templates.mjs')
} else {
  warnings.push('private Pro template pack not assembled (open-source build); templates/pro/ is absent')
}

const versions = pkg.version
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(versions)) errors.push('package version is not semver')

if (!process.env.CSC_LINK) warnings.push('CSC_LINK is not set: Windows/macOS signing will be skipped')
if (!process.env.CSC_KEY_PASSWORD) warnings.push('CSC_KEY_PASSWORD is not set')
if (process.platform === 'darwin' || process.argv.includes('--mac')) {
  for (const name of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (!process.env[name]) warnings.push(`${name} is not set: macOS notarization will be skipped`)
  }
}
const privateKey = process.env.THREE_STUDIO_LICENSE_PRIVATE_KEY
  || join(homedir(), '.three-studio-release', 'private-key.pem')
if (!(await exists(privateKey))) warnings.push(`license private key not found at ${privateKey}`)

const result = {
  ok: errors.length === 0,
  product: pkg.build?.productName ?? pkg.name,
  version: versions,
  platform: process.platform,
  arch: process.arch,
  checks,
  warnings,
  errors,
}
console.log(JSON.stringify(result, null, 2))
if (errors.length > 0) process.exitCode = 1
