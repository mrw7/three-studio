/**
 * Standalone Three Studio server.
 *
 * Runs the workbench's scene engine without the DeepSeek Harness: a tiny
 * Cordis-compatible context captures the existing tools, prompt sections and
 * web routes from ../index.js, and this process serves them together with the
 * Studio client shell and its session/model APIs.
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply as applyWorkbench } from '../index.js'
import { createModelSettings } from './settings.mjs'
import { runAgent, runSubagent } from './agent.mjs'
import { createPluginRuntime } from './plugins/runtime.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(HERE, 'public')
const CLIENT = join(HERE, '..', 'client.js')
const HOME = process.env.THREE_STUDIO_HOME || join(homedir(), '.three-studio')
const SCENES = process.env.THREE_WORKBENCH_DATA_DIR || join(HOME, 'scenes')
const SESSIONS_FILE = join(HOME, 'sessions.json')
const PORT = Number(process.env.THREE_STUDIO_PORT || 3090)

process.env.THREE_WORKBENCH_DATA_DIR = SCENES
await mkdir(HOME, { recursive: true })
await mkdir(SCENES, { recursive: true })
const modelSettings = await createModelSettings(HOME)

/** Minimal Cordis context surface used by index.js. */
const routes = []
const tools = new Map()
const promptSections = []
const disposers = []
const effect = fn => {
  const dispose = fn()
  if (typeof dispose === 'function') disposers.push(dispose)
  return dispose
}
const webServer = {
  register(definition) {
    routes.push(definition)
    return () => {
      const index = routes.indexOf(definition)
      if (index >= 0) routes.splice(index, 1)
    }
  },
}
const fakeCtx = {
  effect,
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  systemPrompt: {
    section(definition) {
      promptSections.push(definition)
      return () => {}
    },
  },
  inject(names, callback) {
    if (!Array.isArray(names) || !names.includes('webServer')) return
    callback({
      on() { return () => {} },
      effect,
      webServer,
    })
  },
  get(name) {
    return name === 'webServer' ? webServer : undefined
  },
}
applyWorkbench(fakeCtx)

/** Session catalog. Phase one is deliberately agent-free. */
const sessions = new Map()
try {
  const raw = await readFile(SESSIONS_FILE, 'utf8')
  const parsed = JSON.parse(raw)
  if (Array.isArray(parsed)) {
    for (const row of parsed) {
      if (row !== null && typeof row === 'object' && typeof row.id === 'string') {
        sessions.set(row.id, {
          id: row.id,
          title: typeof row.title === 'string' ? row.title : 'Untitled',
          createdAt: Number.isFinite(row.createdAt) ? row.createdAt : Date.now(),
          updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : Date.now(),
          events: Array.isArray(row.events) ? row.events : [],
          history: Array.isArray(row.history) ? row.history : [],
          selection: row.selection !== null && typeof row.selection === 'object' ? row.selection : null,
          running: false,
          seq: Number.isSafeInteger(row.seq) ? row.seq : 0,
          lastAgentError: typeof row.lastAgentError === 'string' ? row.lastAgentError : '',
        })
      }
    }
  }
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
if (sessions.size === 0) {
  const id = `studio-${randomUUID()}`
  sessions.set(id, {
    id, title: 'New scene', createdAt: Date.now(), updatedAt: Date.now(),
    events: [], history: [], selection: null, running: false, seq: 0, lastAgentError: '',
  })
}

const saveSessions = async () => {
  await writeFile(SESSIONS_FILE, JSON.stringify([...sessions.values()], null, 2), { mode: 0o600 })
}
// Persist the initial catalog before serving, so a restart before the first
// prompt keeps the same Session id and scene binding.
await saveSessions()
const sessionRows = () => [...sessions.values()]
  .sort((left, right) => right.updatedAt - left.updatedAt)
  .map((row, index) => ({
    id: row.id,
    displayTitle: row.title,
    updatedAt: row.updatedAt,
    running: row.running === true,
    blank: !Array.isArray(row.history) || row.history.length === 0,
    parentId: undefined,
    origin: undefined,
    retainedBy: { mainView: index === 0 ? 1 : 0 },
  }))

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})

const subscribers = new Map()
const controllers = new Map()
let saveTimer = null
const scheduleSave = () => {
  if (saveTimer !== null) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = null; void saveSessions() }, 250)
}
const sessionSnapshot = session => ({
  running: session.running === true,
  pendingSubmissions: [],
  promptError: null,
  lastAgentError: session.lastAgentError === undefined ? '' : session.lastAgentError,
  loadingOlder: false,
})
const broadcast = (sessionId, payload) => {
  const listeners = subscribers.get(sessionId)
  if (listeners === undefined) return
  const data = `data: ${JSON.stringify(payload)}\n\n`
  for (const response of [...listeners]) {
    try { response.write(data) } catch (error) { listeners.delete(response) }
  }
}
const emitEvent = (session, event) => {
  const row = Object.assign({ seq: ++session.seq }, event)
  session.events.push(row)
  session.updatedAt = Date.now()
  broadcast(session.id, { kind: 'event', event: row })
  scheduleSave()
  return row
}
const emitChunk = (session, attemptId, text) => {
  broadcast(session.id, { kind: 'chunk', attemptId, text })
}
const modelGroups = () => modelSettings.publicProviders()
  .filter(provider => provider.models.length > 0)
  .map(provider => ({ id: provider.id, name: provider.name, models: provider.models }))
const defaultSelection = () => {
  const providers = modelSettings.publicProviders()
  const configured = providers.find(provider => provider.keyConfigured && provider.models.length > 0)
  const provider = configured ?? providers.find(item => item.models.length > 0)
  return provider === undefined ? null : { provider: provider.id, model: provider.models[0].id }
}
const selectionOf = session => {
  const current = session.selection
  if (current !== null && typeof current === 'object'
    && typeof current.provider === 'string' && typeof current.model === 'string') {
    return current
  }
  return defaultSelection()
}
const textFromParts = parts => (Array.isArray(parts) ? parts : [])
  .filter(part => part !== null && typeof part === 'object' && part.type === 'text'
    && typeof part.text === 'string')
  .map(part => part.text).join('\n')
const providerForSelection = selection => {
  if (selection === null || typeof selection !== 'object') return undefined
  return modelSettings.providerOf(selection.provider)
}

const pluginRuntime = await createPluginRuntime({
  dataDir: HOME,
  tools,
  promptSections,
  modelSettings,
  runSubagent,
  selectionOf: sessionId => {
    const session = sessions.get(sessionId)
    return session === undefined ? defaultSelection() : selectionOf(session)
  },
})

const readBody = async request => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

const toWebRequest = async request => {
  const host = request.headers.host || `127.0.0.1:${String(PORT)}`
  const url = `http://${host}${request.url || '/'}`
  const method = request.method || 'GET'
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(request)
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  return new Request(url, { method, headers, ...(body === undefined || body.length === 0 ? {} : { body }) })
}

const writeWebResponse = async (response, responseNode, head) => {
  responseNode.statusCode = response.status
  for (const [name, value] of response.headers) responseNode.setHeader(name, value)
  if (head) {
    responseNode.end()
    return
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  responseNode.end(bytes)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

const safePublicPath = pathname => {
  const clean = normalize(pathname).replace(/^([/\\])+/, '')
  if (clean === '' || clean.startsWith('..') || clean.includes(`..${sep}`)) return null
  return join(PUBLIC, clean)
}

const serveFile = async (responseNode, path, head) => {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    const bytes = await readFile(path)
    responseNode.statusCode = 200
    responseNode.setHeader('content-type', MIME[extname(path)] || 'application/octet-stream')
    responseNode.setHeader('cache-control', 'no-store')
    responseNode.end(head ? undefined : bytes)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

const dispatchWorkbench = async request => {
  const pathname = new URL(request.url).pathname
  const exact = routes.find(row => row.kind === 'exact' && row.path === pathname)
  if (exact !== undefined) {
    if (typeof exact.handler === 'function') return exact.handler(request)
    if (typeof exact.resource === 'function') return exact.resource(request)
  }
  const prefixes = routes
    .filter(row => row.kind === 'prefix' && pathname.startsWith(row.path))
    .sort((left, right) => right.path.length - left.path.length)
  const prefix = prefixes[0]
  if (prefix !== undefined) {
    if (typeof prefix.resource === 'function') return prefix.resource(request)
    if (typeof prefix.handler === 'function') return prefix.handler(request)
  }
  return new Response('not found', { status: 404 })
}

const createSession = async () => {
  const id = `studio-${randomUUID()}`
  const now = Date.now()
  sessions.set(id, {
    id, title: 'New scene', createdAt: now, updatedAt: now,
    events: [], history: [], selection: null, running: false, seq: 0, lastAgentError: '',
  })
  await saveSessions()
  return id
}

const handleApi = async (request, pathname) => {
  if (request.method === 'GET' && pathname === '/api/sessions') {
    return json({ sessions: sessionRows() })
  }
  if (request.method === 'POST' && pathname === '/api/sessions') {
    const id = await createSession()
    return json({ id, session: sessionRows().find(row => row.id === id) }, 201)
  }
  if (request.method === 'GET' && pathname === '/api/workspaces') {
    return json({
      items: [{
        workspaceId: 'studio',
        path: HOME,
        title: 'Three Studio',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        sessionIds: sessionRows().map(row => row.id),
      }],
    })
  }
  if (request.method === 'GET' && pathname === '/api/models') {
    return json({
      providers: modelSettings.publicProviders(),
      groups: modelGroups(),
      default: defaultSelection(),
    })
  }
  if (request.method === 'POST' && pathname === '/api/providers') {
    const body = await request.json().catch(() => null)
    if (body === null || typeof body !== 'object') return json({ ok: false, message: 'Invalid provider body.' }, 400)
    const result = await modelSettings.addProvider({
      id: body.id,
      name: body.name,
      baseURL: body.baseURL,
      api: body.api,
      models: body.models,
      apiKey: body.apiKey,
    })
    return json(result, result.ok ? 201 : 400)
  }
  if (request.method === 'GET' && pathname === '/api/plugins') {
    return json({ catalog: pluginRuntime.catalog(), installed: pluginRuntime.installed() })
  }
  const pluginMatch = /^\/api\/plugins\/([^/]+)\/(install|uninstall)$/.exec(pathname)
  if (pluginMatch !== null) {
    const pluginId = decodeURIComponent(pluginMatch[1])
    const action = pluginMatch[2]
    if (request.method === 'POST' && action === 'install') {
      const result = await pluginRuntime.install(pluginId)
      return json(result, result.ok ? 200 : 400)
    }
    if (request.method === 'DELETE' && action === 'uninstall') {
      const result = await pluginRuntime.uninstall(pluginId)
      return json(result, result.ok ? 200 : 400)
    }
  }
  const providerMatch = /^\/api\/providers\/([^/]+)$/.exec(pathname)
  if (providerMatch !== null) {
    const providerId = decodeURIComponent(providerMatch[1])
    if (request.method === 'PUT') {
      const body = await request.json().catch(() => null)
      if (body === null || typeof body !== 'object') return json({ ok: false, message: 'Invalid provider body.' }, 400)
      const result = await modelSettings.updateProvider(providerId, {
        name: body.name,
        baseURL: body.baseURL,
        api: body.api,
        models: body.models,
        apiKey: body.apiKey,
      })
      if (result.ok) {
        const provider = result.provider
        const known = new Set((provider.models || []).map(model => model.id))
        for (const session of sessions.values()) {
          if (session.selection !== null && session.selection !== undefined
            && session.selection.provider === providerId && !known.has(session.selection.model)) {
            session.selection = null
            broadcast(session.id, { kind: 'selection', selection: null })
          }
        }
        void saveSessions()
      }
      return json(result, result.ok ? 200 : 400)
    }
    if (request.method === 'DELETE') {
      const result = await modelSettings.deleteProvider(providerId)
      if (result.ok) {
        for (const session of sessions.values()) {
          if (session.selection !== null && session.selection !== undefined
            && session.selection.provider === providerId) {
            session.selection = null
            broadcast(session.id, { kind: 'selection', selection: null })
          }
        }
        void saveSessions()
      }
      return json(result, result.ok ? 200 : 400)
    }
  }
  const keyMatch = /^\/api\/providers\/([^/]+)\/key$/.exec(pathname)
  if (keyMatch !== null) {
    const providerId = decodeURIComponent(keyMatch[1])
    if (request.method === 'POST') {
      const body = await request.json().catch(() => null)
      const result = await modelSettings.setKey(providerId, body?.key)
      return json(result, result.ok ? 200 : 400)
    }
    if (request.method === 'DELETE') {
      const result = await modelSettings.clearKey(providerId)
      return json(result, result.ok ? 200 : 400)
    }
  }
  const sessionMatch = /^\/api\/sessions\/([^/]+)\/(state|prompt|cancel|selection)$/.exec(pathname)
  if (sessionMatch !== null) {
    const sessionId = decodeURIComponent(sessionMatch[1])
    const action = sessionMatch[2]
    const session = sessions.get(sessionId)
    if (session === undefined) return json({ error: 'session-not-found' }, 404)
    if (request.method === 'GET' && action === 'state') {
      return json({
        state: sessionSnapshot(session),
        events: session.events,
        selection: selectionOf(session),
        groups: modelGroups(),
        providers: modelSettings.publicProviders(),
      })
    }
    if (request.method === 'POST' && action === 'prompt') {
      if (session.running === true) return json({ ok: false, error: { message: 'Session is already running.' } }, 409)
      const body = await request.json().catch(() => null)
      const text = textFromParts(body?.parts)
      if (text.trim() === '') return json({ ok: false, error: { message: 'Prompt is empty.' } }, 400)
      const controller = new AbortController()
      controllers.set(sessionId, controller)
      emitEvent(session, {
        type: 'user/message',
        data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
      })
      session.history.push({ role: 'user', text })
      const firstUser = !session.history.some(message => message.role === 'assistant')
      if (firstUser && (session.title === 'New scene' || session.title === '')) {
        session.title = text.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New scene'
      }
      session.running = true
      session.lastAgentError = ''
      session.updatedAt = Date.now()
      broadcast(sessionId, { kind: 'state', state: sessionSnapshot(session) })
      const attemptId = `attempt-${randomUUID()}`
      void runAgent({
        session,
        settings: modelSettings,
        tools,
        promptSections,
        signal: controller.signal,
        emit: event => emitEvent(session, event),
        emitChunk: textDelta => emitChunk(session, attemptId, textDelta),
      }).catch(error => {
        if (controller.signal.aborted) return
        session.lastAgentError = error instanceof Error ? error.message : String(error)
      }).finally(() => {
        session.running = false
        controllers.delete(sessionId)
        session.updatedAt = Date.now()
        void saveSessions()
        broadcast(sessionId, { kind: 'state', state: sessionSnapshot(session) })
      })
      return json({ ok: true, value: { accepted: true } }, 202)
    }
    if (request.method === 'POST' && action === 'cancel') {
      const controller = controllers.get(sessionId)
      if (controller !== undefined) controller.abort()
      session.running = false
      broadcast(sessionId, { kind: 'state', state: sessionSnapshot(session) })
      return json({ ok: true })
    }
    if (request.method === 'POST' && action === 'selection') {
      const body = await request.json().catch(() => null)
      const provider = providerForSelection(body)
      if (provider === undefined) return json({ ok: false, message: 'Unknown provider.' }, 400)
      const model = (Array.isArray(provider.models) ? provider.models : [])
        .find(entry => entry.id === body?.model)
      if (model === undefined) return json({ ok: false, message: 'Unknown model.' }, 400)
      session.selection = {
        provider: provider.id,
        model: model.id,
        ...(typeof body?.reasoningEffort === 'string' && body.reasoningEffort !== ''
          ? { reasoningEffort: body.reasoningEffort } : {}),
      }
      session.updatedAt = Date.now()
      await saveSessions()
      return json({ ok: true, selection: session.selection })
    }
  }
  return json({ error: 'not-found' }, 404)
}

const server = http.createServer(async (request, responseNode) => {
  try {
    const pathname = new URL(request.url || '/', `http://127.0.0.1:${String(PORT)}`).pathname
    const head = request.method === 'HEAD'
    if (pathname.startsWith('/three-workbench/')) {
      const exactHandler = routes.find(row => row.kind === 'exact' && row.path === pathname
        && typeof row.handler === 'function')
      if (exactHandler !== undefined) {
        await exactHandler.handler(request, responseNode)
        return
      }
      const requestWeb = await toWebRequest(request)
      await writeWebResponse(await dispatchWorkbench(requestWeb), responseNode, head)
      return
    }
    const streamMatch = /^\/api\/sessions\/([^/]+)\/stream$/.exec(pathname)
    if (request.method === 'GET' && streamMatch !== null) {
      const sessionId = decodeURIComponent(streamMatch[1])
      const session = sessions.get(sessionId)
      if (session === undefined) {
        responseNode.statusCode = 404
        responseNode.end('session not found')
        return
      }
      responseNode.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      responseNode.write(': connected\n\n')
      responseNode.write(`data: ${JSON.stringify({
        kind: 'snapshot',
        state: sessionSnapshot(session),
        events: session.events,
        selection: selectionOf(session),
        groups: modelGroups(),
        providers: modelSettings.publicProviders(),
      })}\n\n`)
      let listeners = subscribers.get(sessionId)
      if (listeners === undefined) {
        listeners = new Set()
        subscribers.set(sessionId, listeners)
      }
      listeners.add(responseNode)
      const heartbeat = setInterval(() => {
        try { responseNode.write(': ping\n\n') } catch (error) { void error }
      }, 15000)
      const cleanup = () => {
        clearInterval(heartbeat)
        const current = subscribers.get(sessionId)
        if (current !== undefined) current.delete(responseNode)
      }
      request.on('close', cleanup)
      responseNode.on('close', cleanup)
      return
    }
    if (pathname.startsWith('/api/')) {
      await writeWebResponse(await handleApi(await toWebRequest(request), pathname), responseNode, head)
      return
    }
    if (pathname === '/client.js') {
      responseNode.statusCode = 200
      responseNode.setHeader('content-type', 'text/javascript; charset=utf-8')
      responseNode.setHeader('cache-control', 'no-store')
      responseNode.end(head ? undefined : await readFile(CLIENT))
      return
    }
    const target = pathname === '/' || pathname === '/index.html'
      ? join(PUBLIC, 'index.html')
      : safePublicPath(pathname)
    if (target !== null && await serveFile(responseNode, target, head)) return
    responseNode.statusCode = 404
    responseNode.setHeader('content-type', 'text/plain; charset=utf-8')
    responseNode.end('not found')
  } catch (error) {
    responseNode.statusCode = 500
    responseNode.setHeader('content-type', 'text/plain; charset=utf-8')
    responseNode.end(error instanceof Error ? error.stack || error.message : String(error))
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Three Studio standalone: http://127.0.0.1:${String(PORT)}/`)
  console.log(`data: ${HOME}`)
})

const shutdown = () => {
  for (const dispose of disposers.splice(0)) {
    try { dispose() } catch (error) { void error }
  }
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
