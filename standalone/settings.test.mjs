import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModelSettings } from './settings.mjs'

test('providers can be added, edited, keyed and deleted', async () => {
  const home = await mkdtemp(join(tmpdir(), 'three-studio-settings-'))
  try {
    const settings = await createModelSettings(home)
    assert.deepEqual(settings.providers().map(provider => provider.id), ['deepseek', 'anthropic'])
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
    assert.deepEqual(reloaded.providers().map(provider => provider.id), ['deepseek', 'anthropic'])
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
