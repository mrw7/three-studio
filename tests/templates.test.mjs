import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateManifest } from '../desktop/scripts/template-pack.mjs'
import { assembleTemplates } from '../desktop/scripts/assemble-templates.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))

const validManifest = (overrides = {}) => ({
  v: 1,
  pack: 'test-pack',
  templates: [
    {
      id: 'demo-scene',
      title: 'Demo scene',
      file: 'demo-scene.js',
      tags: ['environment', 'demo'],
    },
  ],
  ...overrides,
})

test('template manifest validation accepts the documented shape', () => {
  assert.deepEqual(validateManifest(validManifest()), [])
  assert.deepEqual(validateManifest({ v: 1, pack: 'empty', templates: [] }), [])
})

test('template manifest validation rejects traversal, duplicates and bad schemas', () => {
  const errors = value => validateManifest(value).join('\n')

  assert.match(errors(validManifest({ v: 2 })), /v must be 1/)
  assert.match(errors(validManifest({ templates: {} })), /templates must be an array/)
  assert.match(errors(validManifest({
    templates: [{ id: 'ok', title: 'x', file: '../escape.js' }],
  })), /flat \.js filename/)
  assert.match(errors(validManifest({
    templates: [{ id: 'ok', title: 'x', file: 'nested/demo.js' }],
  })), /flat \.js filename/)
  assert.match(errors(validManifest({
    templates: [{ id: 'ok', title: 'x', file: '..js' }],
  })), /flat \.js filename/)
  assert.match(errors(validManifest({
    templates: [
      { id: 'same', title: 'a', file: 'a.js' },
      { id: 'same', title: 'b', file: 'b.js' },
    ],
  })), /duplicates "same"/)
  assert.match(errors(validManifest({
    templates: [
      { id: 'a', title: 'a', file: 'same.js' },
      { id: 'b', title: 'b', file: 'same.js' },
    ],
  })), /duplicates "same\.js"/)
  assert.match(errors(validManifest({
    templates: [{ id: 'ok', title: 'x', file: 'x.js', tags: ['Not Valid'] }],
  })), /tags must be an array/)
})

test('the public repository ships an empty free pack and no Pro scenes', async () => {
  const manifest = JSON.parse(await readFile(join(repo, 'desktop/templates/manifest.json'), 'utf8'))
  assert.deepEqual(validateManifest(manifest), [])
  assert.deepEqual(manifest.templates, [])

  for (const file of ['chrono-watch.js', 'city-skyline.js']) {
    await assert.rejects(access(join(repo, 'desktop/templates', file)), `${file} must stay private`)
  }
  const ignore = await readFile(join(repo, 'desktop/.gitignore'), 'utf8')
  assert.match(ignore, /^templates\/pro\/$/m)
})

test('the assembler replaces the output with a validated private pack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'three-studio-templates-'))
  const source = join(root, 'source')
  const out = join(root, 'templates', 'pro')
  try {
    await mkdir(source, { recursive: true })
    await mkdir(out, { recursive: true })
    await writeFile(join(out, 'stale.js'), 'stale\n')
    await writeFile(join(source, 'demo-scene.js'), 'setBackground(0x000000);\n')
    await writeFile(join(source, 'manifest.json'), JSON.stringify(validManifest()))

    const result = await assembleTemplates({ source, out })
    assert.deepEqual(result.templates, ['demo-scene'])
    assert.equal(await readFile(join(out, 'demo-scene.js'), 'utf8'), 'setBackground(0x000000);\n')
    await assert.rejects(access(join(out, 'stale.js')))
    const written = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'))
    assert.equal(written.pack, 'test-pack')

    await writeFile(join(source, 'manifest.json'), JSON.stringify(validManifest({
      templates: [{ id: 'missing', title: 'Missing', file: 'missing.js' }],
    })))
    await assert.rejects(assembleTemplates({ source, out }), /missing template file/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the assembler rejects symlinked template files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'three-studio-templates-'))
  const source = join(root, 'source')
  const out = join(root, 'out')
  try {
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'real.js'), 'scene\n')
    await symlink('real.js', join(source, 'linked.js'))
    await writeFile(join(source, 'manifest.json'), JSON.stringify(validManifest({
      templates: [{ id: 'linked', title: 'Linked', file: 'linked.js' }],
    })))
    await assert.rejects(assembleTemplates({ source, out }), /not a regular file/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
