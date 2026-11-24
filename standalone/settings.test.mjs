import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModelSettings } from './settings.mjs'

const LEGACY_ANTHROPIC = {
  id: 'anthropic',
  name: 'Anthropic',
  api: 'anthropic-messages',
  baseURL: 'https://api.anthropic.com/v1',
  models: [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  ],
}

test('providers can be added, edited, keyed and deleted', async () => {
  const home = await mkdtemp(join(tmpdir(), 'three-studio-settings-'))
  try {
    const settings = await createModelSettings(home)
    assert.deepEqual(settings.providers().map(provider => provider.id), ['deepseek'])
    assert.equal((await settings.addProvider({
      id: 'acme', name: 'Acme', baseURL: 'https://api.acme.test/v1',
      api: 'openai-completions', models: ['a', 'b'], apiKey: 'secret',
    })).ok, true)
    assert.equal(settings.keyOf('acme'), 'secret')
    assert.equal((await settings.updateProvider('acme', {
      name: 'Acme Gateway', baseURL: 'https://gateway.acme.test/v1',
      api: 'anthropic-messages', models: ['b'],
    })).ok, true)
    const updated = settings.providerOf('acme')
    assert.equal(updated.name, 'Acme Gateway')
    assert.equal(updated.baseURL, 'https://gateway.acme.test/v1')
    assert.equal(updated.api, 'anthropic-messages')
    assert.deepEqual(updated.models.map(model => model.id), ['b'])
    assert.equal(settings.keyOf('acme'), 'secret', 'editing preserves the credential')
    assert.equal((await settings.deleteProvider('acme')).ok, true)
    assert.equal(settings.providerOf('acme'), undefined)
    assert.equal(settings.keyOf('acme'), undefined)

    const reloaded = await createModelSettings(home)
    assert.equal(reloaded.providerOf('acme'), undefined)
    assert.deepEqual(reloaded.providers().map(provider => provider.id), ['deepseek'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the untouched legacy Anthropic seed is removed, customized providers are kept', async () => {
  const home = await mkdtemp(join(tmpdir(), 'three-studio-settings-'))
  try {
    await writeFile(join(home, 'models.json'), JSON.stringify({
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          api: 'openai-completions',
          baseURL: 'https://api.deepseek.com/v1',
          models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
        },
        LEGACY_ANTHROPIC,
      ],
    }), 'utf8')
    const settings = await createModelSettings(home)
    assert.deepEqual(settings.providers().map(provider => provider.id), ['deepseek'])
    const stored = JSON.parse(await readFile(join(home, 'models.json'), 'utf8'))
    assert.deepEqual(stored.providers.map(provider => provider.id), ['deepseek'])

    await writeFile(join(home, 'models.json'), JSON.stringify({
      providers: [{ ...LEGACY_ANTHROPIC, name: 'My Anthropic' }],
    }), 'utf8')
    const customized = await createModelSettings(home)
    assert.deepEqual(customized.providers().map(provider => provider.id), ['anthropic'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('invalid provider edits are refused', async () => {
  const home = await mkdtemp(join(tmpdir(), 'three-studio-settings-'))
  try {
    const settings = await createModelSettings(home)
    assert.equal((await settings.updateProvider('missing', {
      baseURL: 'https://missing.test/v1', models: ['x'],
    })).ok, false)
    assert.equal((await settings.updateProvider('deepseek', {
      baseURL: 'ftp://nope', models: ['x'],
    })).ok, false)
    assert.equal((await settings.updateProvider('deepseek', {
      baseURL: 'https://api.deepseek.com/v1', models: [],
    })).ok, false)
    assert.equal((await settings.deleteProvider('missing')).ok, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
