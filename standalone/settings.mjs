/**
 * Standalone model providers and credentials.
 *
 * Settings are non-secret JSON; API keys live in a separate 0600 file. Both
 * stay under the selected Three Studio home.
 */
import { readFile, writeFile, rename } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

const SEED_PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    api: 'openai-completions',
    baseURL: 'https://api.deepseek.com/v1',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    api: 'anthropic-messages',
    baseURL: 'https://api.anthropic.com/v1',
    models: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
    ],
  },
]

const keyRef = providerId => `${String(providerId).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
const providerFromRef = ref => {
  const match = /^(.+)_API_KEY$/.exec(String(ref))
  return match === null ? null : match[1].toLowerCase().replace(/_/g, '-')
}
const validId = value => /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)
const validURL = value => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch (error) {
    return false
  }
}
const atomicWrite = async (path, text) => {
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temp, text, { mode: 0o600 })
  await rename(temp, path)
}

export async function createModelSettings(home) {
  const settingsPath = join(home, 'models.json')
  const credentialsPath = join(home, 'credentials.json')
  let document = { providers: SEED_PROVIDERS.map(provider => structuredClone(provider)) }
  let credentials = {}
  try {
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.providers)) {
      document = { providers: parsed.providers }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await atomicWrite(settingsPath, JSON.stringify(document, null, 2))
  }
  try {
    const parsed = JSON.parse(await readFile(credentialsPath, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) credentials = parsed
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const saveSettings = () => atomicWrite(settingsPath, JSON.stringify(document, null, 2))
  const saveCredentials = () => atomicWrite(credentialsPath, JSON.stringify(credentials, null, 2))

  const providers = () => Array.isArray(document.providers) ? document.providers : []
  const providerOf = id => providers().find(provider => provider.id === id)
  const keyOf = id => {
    const value = credentials[id]
    return typeof value === 'string' && value !== '' ? value : undefined
  }

  const publicProviders = () => providers().map(provider => ({
    id: provider.id,
    name: provider.name,
    api: provider.api,
    baseURL: provider.baseURL,
    models: (Array.isArray(provider.models) ? provider.models : []).map(model => ({
      id: model.id,
      name: model.name,
      ...(Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0
        ? { reasoning: {
            efforts: model.reasoningEfforts.map(effort => ({ id: effort.id, name: effort.name })),
            defaultEffort: model.reasoningEfforts.find(effort => effort.default === true)?.id
              ?? model.reasoningEfforts[0]?.id,
          } }
        : {}),
    })),
    keyRef: keyRef(provider.id),
    keyConfigured: keyOf(provider.id) !== undefined,
  }))

  return {
    providers,
    providerOf,
    keyOf,
    publicProviders,
    keyRef,
    providerFromRef,
    credentialsConfigured: id => keyOf(id) !== undefined,
    async setKey(id, value) {
      if (providerOf(id) === undefined) return { ok: false, message: 'Unknown provider.' }
      if (typeof value !== 'string' || value.trim() === '') return { ok: false, message: 'API key is empty.' }
      credentials[id] = value.trim()
      await saveCredentials()
      return { ok: true }
    },
    async clearKey(idOrRef) {
      const id = providerOf(idOrRef) !== undefined ? idOrRef : providerFromRef(idOrRef)
      if (id === null || id === undefined) return { ok: false, message: 'Unknown credential reference.' }
      delete credentials[id]
      await saveCredentials()
      return { ok: true }
    },
    async addProvider(draft) {
      const id = typeof draft.id === 'string' ? draft.id.trim() : ''
      const baseURL = typeof draft.baseURL === 'string' ? draft.baseURL.trim() : ''
      const api = draft.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions'
      const models = Array.isArray(draft.models)
        ? draft.models.filter(model => typeof model === 'string' && model.trim() !== '').map(model => ({
            id: model.trim(),
            name: model.trim(),
          }))
        : []
      if (!validId(id)) return { ok: false, message: 'Provider id is invalid.' }
      if (!validURL(baseURL)) return { ok: false, message: 'Base URL must be an http(s) URL.' }
      if (models.length === 0) return { ok: false, message: 'At least one model id is required.' }
      if (providerOf(id) !== undefined) return { ok: false, message: 'provider-exists' }
      document.providers = providers().concat([{
        id,
        name: typeof draft.name === 'string' && draft.name.trim() !== '' ? draft.name.trim() : id,
        api,
        baseURL,
        models,
      }])
      await saveSettings()
      if (typeof draft.apiKey === 'string' && draft.apiKey.trim() !== '') {
        credentials[id] = draft.apiKey.trim()
        await saveCredentials()
      }
      return { ok: true, provider: publicProviders().find(provider => provider.id === id) }
    },
  }
}
