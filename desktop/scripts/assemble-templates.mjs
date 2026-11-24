#!/usr/bin/env node
/**
 * Assemble the private Pro template pack into the desktop build.
 *
 * The public repository ships only the pack contract
 * (`desktop/templates/manifest.json`). Paid scenes live outside this repo and
 * are copied into the gitignored `desktop/templates/pro/` directory before
 * packaging, so they never enter the public tree or its history.
 *
 * Usage:
 *   node scripts/assemble-templates.mjs [--source DIR] [--out DIR] [--require]
 *
 * Source resolution order:
 *   1. --source DIR
 *   2. THREE_STUDIO_PRO_TEMPLATES
 *   3. ../three-studio-private/pro-templates (private sibling repo)
 *   4. ../three-studio-pro-templates (legacy sibling directory)
 *
 * A missing pack is a skip with exit 0 for open-source builds. Pass --require
 * or set THREE_STUDIO_REQUIRE_PRO_TEMPLATES=1 to fail instead. Any stale
 * assembled pack is removed when the source is missing or invalid.
 */
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { existsSync } from 'node:fs'
import { validateManifest } from './template-pack.mjs'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultSources = [
  resolve(desktopRoot, '..', '..', 'three-studio-private', 'pro-templates'),
  resolve(desktopRoot, '..', '..', 'three-studio-pro-templates'),
]
const defaultSource = defaultSources.find(path => existsSync(join(path, 'manifest.json')))
  ?? defaultSources[0]
const defaultOut = join(desktopRoot, 'templates', 'pro')

const option = name => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/**
 * Validate a pack and atomically replace `out` with its files.
 * @param {{ source: string, out: string }} options
 */
export async function assembleTemplates({ source, out }) {
  if (resolve(source) === resolve(out)) {
    throw new Error('source and output directories must differ')
  }
  const manifestPath = join(source, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read ${manifestPath}: ${error.message}`)
  }
  const errors = validateManifest(manifest)
  if (errors.length > 0) {
    throw new Error(`invalid template manifest:\n- ${errors.join('\n- ')}`)
  }

  for (const template of manifest.templates) {
    const filePath = join(source, template.file)
    let stat
    try {
      stat = await lstat(filePath)
    } catch {
      throw new Error(`missing template file: ${template.file}`)
    }
    if (!stat.isFile()) throw new Error(`not a regular file: ${template.file}`)
  }

  const staging = `${out}.tmp-${process.pid}-${Date.now()}`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    for (const template of manifest.templates) {
      await copyFile(join(source, template.file), join(staging, template.file))
    }
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    await rm(out, { recursive: true, force: true })
    await mkdir(dirname(out), { recursive: true })
    await rename(staging, out)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }

  return {
    ok: true,
    pack: manifest.pack,
    templates: manifest.templates.map(template => template.id),
    source,
    out,
  }
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const source = resolve(option('--source')
    || process.env.THREE_STUDIO_PRO_TEMPLATES
    || defaultSource)
  const out = resolve(option('--out') || defaultOut)
  const required = process.argv.includes('--require')
    || process.env.THREE_STUDIO_REQUIRE_PRO_TEMPLATES === '1'

  if (!existsSync(join(source, 'manifest.json'))) {
    await rm(out, { recursive: true, force: true })
    const result = {
      ok: !required,
      skipped: true,
      reason: 'private Pro template pack not found',
      source,
      out,
      hint: 'Set THREE_STUDIO_PRO_TEMPLATES or keep the pack at ../three-studio-private/pro-templates.',
    }
    console.log(JSON.stringify(result, null, 2))
    if (required) process.exitCode = 1
  } else {
    try {
      console.log(JSON.stringify(await assembleTemplates({ source, out }), null, 2))
    } catch (error) {
      await rm(out, { recursive: true, force: true })
      console.error(JSON.stringify({ ok: false, source, out, error: error.message }, null, 2))
      process.exitCode = 1
    }
  }
}
