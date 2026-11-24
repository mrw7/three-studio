#!/usr/bin/env node
/**
 * Merge sessions.json and models.json between two Three Studio homes.
 *
 * Scene/asset data lives in the scene store and is handled by
 * migrate-portable.mjs / merge-portable.mjs. This tool handles the rest of the
 * profile: conversation sessions and non-secret provider settings. It never
 * reads or writes credentials.json; API keys must be entered again per machine.
 *
 * Run it while both Studio servers are stopped: a running server may rewrite
 * sessions.json from its in-memory copy.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { SESSION_LIMITS, compactSessions } from './sessions.mjs'
import { SEED_PROVIDERS } from './settings.mjs'

const PROVIDER_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const MAX_PROVIDERS = 64
const MAX_MODELS = 64
const MAX_REASONING_EFFORTS = 16
const MAX_TITLE_CHARS = 200
const MAX_ERROR_CHARS = 2000

const isSafeSessionId = value => typeof value === 'string'
  && Array.from(value).length >= 1 && Array.from(value).length <= 256
  && !/[\u0000-\u001F\u007F-\u009F]/u.test(value)

const finiteTime = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback

function normalizeSession(row, now = Date.now()) {
  if (row === null || typeof row !== 'object' || !isSafeSessionId(row.id)) return null
  const events = Array.isArray(row.events)
    ? row.events.filter(event => event !== null && typeof event === 'object')
      .slice(-SESSION_LIMITS.events)
    : []
  const history = Array.isArray(row.history)
    ? row.history.filter(event => event !== null && typeof event === 'object')
      .slice(-SESSION_LIMITS.history)
    : []
  const selection = row.selection !== null && typeof row.selection === 'object'
    && !Array.isArray(row.selection) ? { ...row.selection } : null
  return {
    id: row.id,
    title: typeof row.title === 'string' ? row.title.slice(0, MAX_TITLE_CHARS) : 'Untitled',
    createdAt: finiteTime(row.createdAt, now),
    updatedAt: finiteTime(row.updatedAt, now),
    events,
    history,
    selection,
    running: false,
    seq: Number.isSafeInteger(row.seq) && row.seq >= 0 ? row.seq : 0,
    lastAgentError: typeof row.lastAgentError === 'string'
      ? row.lastAgentError.slice(0, MAX_ERROR_CHARS) : '',
    archived: row.archived === true,
    historyTrimmed: row.historyTrimmed === true,
  }
}

function normalizeReasoningEfforts(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter(effort => effort !== null && typeof effort === 'object'
      && typeof effort.id === 'string' && effort.id.trim() !== '')
    .slice(0, MAX_REASONING_EFFORTS)
    .map(effort => ({
      id: effort.id.trim().slice(0, 120),
      name: typeof effort.name === 'string' && effort.name.trim() !== ''
        ? effort.name.trim().slice(0, 120) : effort.id.trim().slice(0, 120),
      ...(effort.default === true ? { default: true } : {}),
    }))
}

function normalizeProvider(row) {
  if (row === null || typeof row !== 'object') return null
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (!PROVIDER_ID_RE.test(id)) return null
  const baseURL = typeof row.baseURL === 'string' ? row.baseURL.trim() : ''
  let url
  try {
    url = new URL(baseURL)
  } catch (error) {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const models = Array.isArray(row.models)
    ? row.models
      .map(model => {
        if (typeof model === 'string') {
          const modelId = model.trim()
          return modelId === '' ? null : { id: modelId.slice(0, 200), name: modelId.slice(0, 200) }
        }
        if (model === null || typeof model !== 'object' || typeof model.id !== 'string'
          || model.id.trim() === '') return null
        const modelId = model.id.trim().slice(0, 200)
        const reasoningEfforts = normalizeReasoningEfforts(model.reasoningEfforts)
        return {
          id: modelId,
          name: typeof model.name === 'string' && model.name.trim() !== ''
            ? model.name.trim().slice(0, 200) : modelId,
          ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
        }
      })
      .filter(model => model !== null)
      .slice(0, MAX_MODELS)
    : []
  if (models.length === 0) return null
  return {
    id,
    name: typeof row.name === 'string' && row.name.trim() !== ''
      ? row.name.trim().slice(0, 200) : id,
    api: row.api === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
    baseURL,
    models,
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function readSessions(path) {
  const parsed = await readJson(path, [])
  if (!Array.isArray(parsed)) throw new Error(`${path}: expected a JSON array`)
  return parsed
}

async function readModels(path, fallbackProviders) {
  const parsed = await readJson(path, null)
  if (parsed === null) return structuredClone(fallbackProviders)
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.providers)) {
    throw new Error(`${path}: expected { "providers": [...] }`)
  }
  return parsed.providers
}

async function writeJsonWithBackup(path, value, dryRun) {
  if (dryRun) return
  await mkdir(dirname(path), { recursive: true })
  try {
    const existing = await readFile(path)
    await writeFile(`${path}.bak-${String(Date.now())}`, existing, { mode: 0o600 })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const text = JSON.stringify(value, null, 2)
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, text, { mode: 0o600 })
  try {
    await rename(temp, path)
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'EPERM') {
      await rm(path, { force: true })
      await rename(temp, path)
    } else {
      await rm(temp, { force: true })
      throw error
    }
  }
}

export async function mergeProfiles(options = {}) {
  const from = resolve(String(options.from ?? ''))
  const to = resolve(String(options.to ?? ''))
  if (!options.from || !options.to) throw new Error('both source and target homes are required')
  if (!existsSync(from)) throw new Error(`source home not found: ${from}`)
  if (from === to) throw new Error('source and target homes are the same')
  const conflict = options.conflict === 'replace' ? 'replace' : 'skip'
  const dryRun = options.dryRun === true
  const now = Date.now()

  const rawSourceSessions = await readSessions(join(from, 'sessions.json'))
  const sourceSessions = rawSourceSessions
    .map(row => normalizeSession(row, now))
    .filter(row => row !== null)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  const targetSessions = (await readSessions(join(to, 'sessions.json')))
    .map(row => normalizeSession(row, now))
    .filter(row => row !== null)
  const sessionMap = new Map(targetSessions.map(row => [row.id, row]))
  const sessionResult = { imported: 0, replaced: 0, skipped: 0, invalid: 0, trimmed: 0, total: 0 }
  sessionResult.invalid = rawSourceSessions.length - sourceSessions.length
  for (const row of sourceSessions) {
    if (sessionMap.has(row.id)) {
      if (conflict === 'skip') {
        sessionResult.skipped += 1
        continue
      }
      sessionMap.set(row.id, row)
      sessionResult.replaced += 1
      continue
    }
    if (sessionMap.size >= SESSION_LIMITS.sessions) {
      sessionResult.skipped += 1
      continue
    }
    sessionMap.set(row.id, row)
    sessionResult.imported += 1
  }
  sessionResult.total = sessionMap.size
  sessionResult.trimmed = compactSessions(sessionMap).trimmed

  const rawSourceProviders = await readModels(join(from, 'models.json'), [])
  const sourceProviders = rawSourceProviders
    .map(provider => normalizeProvider(provider))
    .filter(provider => provider !== null)
  const targetProviders = (await readModels(join(to, 'models.json'), SEED_PROVIDERS))
    .map(provider => normalizeProvider(provider))
    .filter(provider => provider !== null)
  const providerMap = new Map(targetProviders.map(provider => [provider.id, provider]))
  const modelResult = { imported: 0, replaced: 0, skipped: 0, invalid: 0, total: 0 }
  modelResult.invalid = rawSourceProviders.length - sourceProviders.length
  for (const provider of sourceProviders) {
    if (providerMap.has(provider.id)) {
      if (conflict === 'skip') {
        modelResult.skipped += 1
        continue
      }
      providerMap.set(provider.id, provider)
      modelResult.replaced += 1
      continue
    }
    if (providerMap.size >= MAX_PROVIDERS) {
      modelResult.skipped += 1
      continue
    }
    providerMap.set(provider.id, provider)
    modelResult.imported += 1
  }
  modelResult.total = providerMap.size

  if (!dryRun) {
    await writeJsonWithBackup(join(to, 'sessions.json'), [...sessionMap.values()], false)
    await writeJsonWithBackup(join(to, 'models.json'), { providers: [...providerMap.values()] }, false)
  }
  return {
    from,
    to,
    conflict,
    dryRun,
    sessions: sessionResult,
    models: modelResult,
    credentials: 'not copied; enter API keys on the target machine',
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const args = process.argv.slice(2)
  const option = name => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 && index + 1 < args.length ? args[index + 1] : null
  }
  if (args.includes('--help') || args.includes('-h') || option('from') === null) {
    console.log(`Usage: node standalone/profile-merge.mjs --from DIR [--to DIR] [--on-conflict skip|replace] [--dry-run]

  --from          source Three Studio home (contains sessions.json/models.json)
  --to            target Three Studio home (default: $THREE_STUDIO_HOME or ~/.three-studio)
  --on-conflict   skip (default) or replace same-id sessions/providers
  --dry-run       validate and merge in memory without writing

credentials.json is never read or written. Stop both Studio servers first.`)
    process.exit(option('from') === null && !args.includes('--help') && !args.includes('-h') ? 1 : 0)
  }
  const conflict = option('on-conflict') || 'skip'
  if (conflict !== 'skip' && conflict !== 'replace') {
    console.error('--on-conflict must be "skip" or "replace"')
    process.exit(1)
  }
  try {
    const result = await mergeProfiles({
      from: option('from'),
      to: option('to') || process.env.THREE_STUDIO_HOME || join(homedir(), '.three-studio'),
      conflict,
      dryRun: args.includes('--dry-run'),
    })
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
