import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeProfiles } from '../standalone/profile-merge.mjs'

const session = (id, title, code = 'code') => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 1,
  events: [{ seq: 1, type: 'user/message' }],
  history: [{ role: 'user', text: code }],
  selection: null,
  running: false,
  seq: 1,
  lastAgentError: '',
  archived: false,
  historyTrimmed: false,
})

const provider = (id, name, model = 'model-a') => ({
  id,
  name,
  api: 'openai-completions',
  baseURL: `https://${id}.example.com/v1`,
  models: [{ id: model, name: model }],
})

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), 'three-studio-profile-'))
  const from = join(root, 'source')
  const to = join(root, 'target')
  await mkdir(from, { recursive: true })
  await mkdir(to, { recursive: true })
  await writeFile(join(from, 'sessions.json'), JSON.stringify([
    session('s1', 'source s1', 'source-one'),
    session('s2', 'source s2', 'source-two'),
  ]), 'utf8')
  await writeFile(join(to, 'sessions.json'), JSON.stringify([
    session('s1', 'target s1', 'target-one'),
  ]), 'utf8')
  await writeFile(join(from, 'models.json'), JSON.stringify({
    providers: [provider('custom', 'Custom')],
  }), 'utf8')
  await writeFile(join(to, 'models.json'), JSON.stringify({
    providers: [provider('target', 'Target')],
  }), 'utf8')
  await writeFile(join(to, 'credentials.json'), JSON.stringify({ custom: 'do-not-copy' }), 'utf8')
  return { root, from, to }
}

test('profile merge imports sessions and models without copying credentials', async () => {
  const { root, from, to } = await setup()
  try {
    const result = await mergeProfiles({ from, to, conflict: 'skip' })
    assert.equal(result.sessions.imported, 1)
    assert.equal(result.sessions.skipped, 1)
    assert.equal(result.sessions.total, 2)
    assert.equal(result.models.imported, 1)
    assert.equal(result.models.total, 2)
    assert.match(result.credentials, /not copied/)

    const sessions = JSON.parse(await readFile(join(to, 'sessions.json'), 'utf8'))
    const byId = new Map(sessions.map(row => [row.id, row]))
    assert.equal(byId.get('s1').title, 'target s1')
    assert.equal(byId.get('s2').title, 'source s2')
    assert.equal(byId.get('s2').running, false)

    const models = JSON.parse(await readFile(join(to, 'models.json'), 'utf8'))
    assert.equal(models.providers.some(row => row.id === 'custom'), true)
    assert.equal(models.providers.some(row => row.id === 'target'), true)
    assert.equal(await readFile(join(to, 'credentials.json'), 'utf8'), JSON.stringify({ custom: 'do-not-copy' }))

    const files = await readdir(to)
    assert.equal(files.some(name => name.startsWith('sessions.json.bak-')), true)
    assert.equal(files.some(name => name.startsWith('models.json.bak-')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('profile merge replace updates conflicts and dry-run writes nothing', async () => {
  const { root, from, to } = await setup()
  try {
    const dry = await mergeProfiles({ from, to, conflict: 'replace', dryRun: true })
    assert.equal(dry.sessions.replaced, 1)
    assert.equal(dry.models.replaced, 0)
    const untouched = JSON.parse(await readFile(join(to, 'sessions.json'), 'utf8'))
    assert.equal(untouched.find(row => row.id === 's1').title, 'target s1')

    const result = await mergeProfiles({ from, to, conflict: 'replace' })
    assert.equal(result.sessions.replaced, 1)
    const sessions = JSON.parse(await readFile(join(to, 'sessions.json'), 'utf8'))
    assert.equal(sessions.find(row => row.id === 's1').history[0].text, 'source-one')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('profile merge drops invalid session rows and reports them', async () => {
  const { root, from, to } = await setup()
  try {
    await writeFile(join(from, 'sessions.json'), JSON.stringify([
      session('valid', 'valid'),
      { id: '', title: 'invalid' },
      { id: 'bad\u0000id', title: 'invalid' },
    ]), 'utf8')
    const result = await mergeProfiles({ from, to, conflict: 'skip' })
    assert.equal(result.sessions.imported, 1)
    assert.equal(result.sessions.invalid, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
