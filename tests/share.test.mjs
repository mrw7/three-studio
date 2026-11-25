/**
 * P3-1 share-link regression matrix. These tests never bind a port: the Host
 * handlers/resources are called directly with injected time and fake streams.
 * Browser behavior (CSP/srcdoc, dialogs, egress) lives in
 * `.preview-tmp/verify-p31-share.mjs`.
 */
// Run: node --test "tests/**/*.mjs"
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { __shareInternal as host } from '../index.js'

const ROUTE = '/three-workbench/share'
const HOST_HEADER = 'localhost:3099'
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8')
const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const SESSION_A = 'share-session-a'
const SESSION_B = 'share-session-b'
const SESSION_C = 'share-session-c'
const DOC = '<!doctype html><html><head><meta charset="utf-8"></head><body><p>shared</p></body></html>'
const DELETE_KEY = 'D'.repeat(22)

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: current => ({ current }),
  useCallback: fn => fn,
  Fragment: 'fragment',
}
let definition
globalThis.window = { __ModuleLoader__: { load: value => { definition = value } } }
globalThis.document = {
  createElement: () => ({ textContent: '', remove () {} }),
  head: { append () {} },
}
await import(`${pathToFileURL(new URL('../client.js', import.meta.url).pathname).href}?share=${String(Date.now())}`)
const client = definition.factory(name => {
  if (name === 'react') return reactStub
  if (name === '@deepseek-ai/dsh-client-store') {
    return { createSnapshotStore: initial => ({ getSnapshot: () => initial, subscribe: () => () => {}, set: () => {}, update: () => {} }) }
  }
  throw new Error(`unexpected require: ${name}`)
})

function editorState(extra = {}) {
  return {
    v: 2,
    objects: {},
    tracks: { v: 1, items: [] },
    params: { v: 1, values: {} },
    camera: null,
    ...extra,
  }
}

function payload(overrides = {}) {
  return {
    revision: 0,
    editorState: editorState(),
    stepFps: 30,
    document: DOC,
    ...overrides,
  }
}

function presentationField() {
  return {
    v: 1,
    manual: {
      v: 1,
      title: 'Lamp walkthrough',
      product: 'Task lamp',
      version: '1.0',
      language: 'en',
      steps: [
        {
          id: 'step-1',
          title: 'Overview',
          body: 'Start with the whole lamp.',
          camera: { position: [2, 3, 6], target: [0, 1, 0], fov: 40 },
          time: 1.5,
          hidden: ['s:shade'],
          highlight: 's:base',
          parts: [{ name: 'Base', number: 'A-01' }],
          duration: 4,
        },
        {
          id: 'step-2',
          title: 'Exploded view',
          body: 'The shade lifts away from the base.',
          camera: { position: [0, 4, 7], target: [0, 1.2, 0], fov: 35 },
          time: 0,
          hidden: ['s:base'],
          highlight: 's:shade',
          parts: [{ name: 'Shade', number: 'B-02' }],
          duration: 3,
        },
      ],
    },
    film: null,
  }
}

function seed(sessionId, overrides = {}) {
  host.seedSession(sessionId, {
    revision: 0,
    title: 'Shared scene',
    code: 'const x = 1',
    ...overrides,
  })
}

function createHeaders(sessionId = SESSION_A, extra = {}) {
  return {
    host: HOST_HEADER,
    'content-type': 'application/json',
    'x-workbench-session': sessionId,
    ...extra,
  }
}

function handlerOptions(now, extra = {}) {
  const out = { ...extra }
  if (now !== undefined) out.now = typeof now === 'function' ? now : () => now
  return out
}

function fakeResponse(resolve) {
  return {
    status: 0,
    headers: {},
    body: '',
    destroyed: false,
    writableEnded: false,
    writeHead(code, values = {}) {
      this.status = code
      this.headers = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]))
    },
    end(text) {
      this.writableEnded = true
      this.body = Buffer.isBuffer(text) ? text.toString('utf8') : (text ?? '')
      resolve(this)
    },
  }
}

function invokeHandler(handler, options = {}) {
  const {
    method = 'POST',
    headers = {},
    body = null,
    handlerOptions: extra = {},
  } = options
  return new Promise(resolve => {
    const buffer = body === null
      ? null
      : Buffer.isBuffer(body) ? body : Buffer.from(String(body))
    const req = Readable.from(buffer === null ? [] : [buffer])
    req.method = method
    req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
    const res = fakeResponse(resolve)
    handler(req, res, extra)
  })
}

function invokeRawHandler(handler, req, extra = {}) {
  return new Promise(resolve => {
    const res = fakeResponse(resolve)
    handler(req, res, extra)
  })
}

async function createShare(sessionId = SESSION_A, options = {}) {
  const body = options.body === undefined
    ? JSON.stringify(options.payload === undefined ? payload() : options.payload)
    : options.body
  const response = await invokeHandler(host.createHandler, {
    method: options.method ?? 'POST',
    headers: options.headers === undefined ? createHeaders(sessionId) : options.headers,
    body,
    handlerOptions: handlerOptions(options.now, options.handlerOptions),
  })
  let json = null
  try { json = JSON.parse(response.body) } catch (error) { void error }
  return { response, json }
}

async function deleteShare(id, deleteKey, options = {}) {
  const body = options.body === undefined
    ? JSON.stringify({ id, deleteKey })
    : options.body
  const response = await invokeHandler(host.deleteHandler, {
    method: options.method ?? 'POST',
    headers: options.headers === undefined
      ? { host: HOST_HEADER, 'content-type': 'application/json' }
      : options.headers,
    body,
    handlerOptions: handlerOptions(options.now),
  })
  let json = null
  try { json = JSON.parse(response.body) } catch (error) { void error }
  return { response, json }
}

function viewerRequest(pathOrId, options = {}) {
  const path = pathOrId.startsWith('/') ? pathOrId : `${ROUTE}/${pathOrId}`
  const headers = options.host === null ? {} : { host: options.host ?? HOST_HEADER }
  return new Request(`http://placeholder${path}`, {
    method: options.method ?? 'GET',
    headers,
  })
}

function viewer(pathOrId, options = {}) {
  return host.viewerResponse(viewerRequest(pathOrId, options), handlerOptions(options.now))
}

function seedRecord(options = {}) {
  const id = options.id ?? host.newId()
  host.store.put({
    id,
    v: 1,
    ownerSessionHash: host.ownerHash(options.owner ?? SESSION_A),
    revision: 0,
    title: 'seeded',
    code: '',
    editorState: {},
    stepFps: 30,
    documentBuffer: Buffer.from(''),
    metadataJson: '{}',
    bytes: options.bytes ?? 0,
    createdAt: options.createdAt ?? 0,
    expiresAt: options.expiresAt ?? 1000000000000,
    deleteKeyHash: host.deleteKeyHash(options.deleteKey ?? DELETE_KEY),
  })
  return id
}

function registryEntry(overrides = {}) {
  const id = overrides.id ?? 'R'.repeat(22)
  return {
    id,
    path: `${ROUTE}/${id}`,
    deleteKey: 'K'.repeat(22),
    createdAt: 1000,
    expiresAt: 5000,
    title: 'stored',
    revision: 0,
    ...overrides,
  }
}

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => { data.set(key, String(value)) },
    removeItem: key => { data.delete(key) },
    dump: () => Object.fromEntries(data),
  }
}

beforeEach(() => {
  host.reset()
  host.resetScenes()
  seed(SESSION_A)
  seed(SESSION_B)
  seed(SESSION_C)
})

// ---------------------------------------------------------------------------
// IDs, records, title truncation
// ---------------------------------------------------------------------------
test('share ids are 1000 unique 22-char base64url capabilities', () => {
  const ids = new Set()
  for (let index = 0; index < 1000; index += 1) {
    const id = host.newId()
    assert.match(id, host.idPattern)
    assert.equal(id.length, 22)
    assert.ok(!id.includes(SESSION_A))
    ids.add(id)
  }
  assert.equal(ids.size, 1000)
})

test('id collisions retry with a fresh id and exhaust to 500', async () => {
  const firstId = 'A'.repeat(22)
  const secondId = 'B'.repeat(22)
  const first = await createShare(SESSION_A, {
    now: Date.now(),
    handlerOptions: { makeId: () => firstId, makeDeleteKey: () => DELETE_KEY },
  })
  assert.equal(first.response.status, 200)
  assert.equal(first.json.id, firstId)
  let candidate = 0
  const second = await createShare(SESSION_A, {
    now: Date.now(),
    handlerOptions: {
      makeId: () => (candidate++ === 0 ? firstId : secondId),
      makeDeleteKey: () => DELETE_KEY,
    },
  })
  assert.equal(second.response.status, 200)
  assert.equal(second.json.id, secondId)
  assert.equal(host.stats().shares, 2)

  const exhausted = await createShare(SESSION_A, {
    now: Date.now(),
    handlerOptions: { makeId: () => firstId, makeDeleteKey: () => DELETE_KEY },
  })
  assert.equal(exhausted.response.status, 500)
  assert.equal(exhausted.json.code, 'internal')
  assert.equal(host.stats().shares, 2)
})

test('create stores host title/code and only hashed owner/delete material', async () => {
  const { response, json } = await createShare(SESSION_A, {
    now: 1000,
    handlerOptions: { makeDeleteKey: () => DELETE_KEY },
  })
  assert.equal(response.status, 200)
  assert.equal(json.ok, true)
  assert.match(json.id, host.idPattern)
  assert.equal(json.path, `${ROUTE}/${json.id}`)
  assert.equal(json.deleteKey, DELETE_KEY)
  const record = host.rawShare(json.id)
  assert.deepEqual(Object.keys(record).sort(), [
    'bytes', 'code', 'createdAt', 'deleteKeyHash', 'documentBuffer', 'editorState',
    'expiresAt', 'id', 'metadataJson', 'ownerSessionHash', 'revision', 'stepFps', 'title', 'v',
  ])
  assert.equal(record.v, 1)
  assert.equal(record.title, 'Shared scene')
  assert.equal(record.code, 'const x = 1')
  assert.equal(record.ownerSessionHash, host.ownerHash(SESSION_A))
  assert.equal(record.deleteKeyHash, host.deleteKeyHash(DELETE_KEY))
  assert.match(record.ownerSessionHash, /^[a-f0-9]{64}$/)
  assert.match(record.deleteKeyHash, /^[a-f0-9]{64}$/)
  const serialized = JSON.stringify(record)
  assert.ok(!serialized.includes(SESSION_A))
  assert.ok(!serialized.includes(DELETE_KEY))
  assert.equal(record.createdAt, 1000)
  assert.equal(record.expiresAt, 1000 + 604800000)
})

test('a host title over 200 code points is truncated in metadata and bytes, not in the leak scan', async () => {
  const longTitle = '😀'.repeat(250)
  seed(SESSION_A, { title: longTitle })
  const { response, json } = await createShare(SESSION_A, { now: 50 })
  assert.equal(response.status, 200)
  const record = host.rawShare(json.id)
  assert.equal(Array.from(record.title).length, 200)
  const metadata = JSON.parse(record.metadataJson)
  assert.equal(metadata.title, record.title)
  assert.ok(Buffer.byteLength(record.metadataJson) <= host.limits.metadataMaxBytes)
  assert.equal(record.bytes, record.documentBuffer.length
    + Buffer.byteLength(record.metadataJson) + Buffer.byteLength(record.code)
    + Buffer.byteLength(JSON.stringify(record.editorState)) + Buffer.byteLength(record.title))
})

test('a session id split by the 200-code-point title cut is still rejected', async () => {
  seed(SESSION_A, { title: '😀'.repeat(200) + SESSION_A })
  const { response, json } = await createShare(SESSION_A)
  assert.equal(response.status, 400)
  assert.equal(json.code, 'session-leak')
})

// ---------------------------------------------------------------------------
// Create validation order and limits
// ---------------------------------------------------------------------------
test('invalid Host is rejected before method, body, or lookup', async () => {
  const { response, json } = await createShare(SESSION_A, {
    method: 'GET',
    headers: createHeaders(SESSION_A, { host: 'evil.example.;x' }),
  })
  assert.equal(response.status, 400)
  assert.equal(json.code, 'bad-host')
  const viewerResponse = await viewer('A'.repeat(22), { host: 'evil.example.;x' })
  assert.equal(viewerResponse.status, 400)
  assert.equal(await viewerResponse.text(), 'Bad request.\n')
})

test('method, content type, encoding, and oversized Content-Length reject before the body', async () => {
  let result = await createShare(SESSION_A, { method: 'GET' })
  assert.equal(result.response.status, 405)
  assert.equal(result.response.headers.allow, 'POST')
  assert.equal(result.json.code, 'method')

  result = await createShare(SESSION_A, {
    headers: createHeaders(SESSION_A, { 'content-type': 'text/plain' }),
  })
  assert.equal(result.response.status, 415)
  assert.equal(result.json.code, 'content-type')

  result = await createShare(SESSION_A, {
    headers: createHeaders(SESSION_A, { 'content-encoding': 'gzip' }),
  })
  assert.equal(result.response.status, 415)
  assert.equal(result.json.code, 'encoding')

  result = await createShare(SESSION_A, {
    headers: createHeaders(SESSION_A, { 'content-length': String(host.limits.maxBodyBytes + 1) }),
  })
  assert.equal(result.response.status, 413)
  assert.equal(result.json.code, 'too-large')

  result = await createShare(SESSION_A, {
    headers: createHeaders(SESSION_A, { 'content-length': '9' }),
  })
  assert.equal(result.response.status, 400)
  assert.equal(result.json.code, 'fields')
})

test('both-scheme Origin, Sec-Fetch-Site and session checks follow the design order', async () => {
  let result = await createShare(SESSION_A, {
    headers: createHeaders(SESSION_A, { origin: 'https://evil.example' }),
  })
  assert.equal(result.response.status, 403)
  assert.equal(result.json.code, 'origin')

  result = await createShare(SESSION_A, {
    headers: createHeaders(SESSION_A, { 'sec-fetch-site': 'cross-site' }),
  })
  assert.equal(result.response.status, 403)

  result = await createShare(SESSION_A, {
    headers: createHeaders(SESSION_A, { origin: `http://${HOST_HEADER}`, 'sec-fetch-site': 'same-origin' }),
  })
  assert.equal(result.response.status, 200)

  result = await createShare(SESSION_A, {
    headers: createHeaders(SESSION_A, { origin: `https://${HOST_HEADER}` }),
  })
  assert.equal(result.response.status, 200)

  result = await createShare(SESSION_A, {
    headers: createHeaders(SESSION_A, { 'x-workbench-session': 'missing-session' }),
  })
  assert.equal(result.response.status, 404)
  assert.equal(result.json.code, 'session')

  result = await createShare(SESSION_A, {
    headers: createHeaders(SESSION_A, { 'x-workbench-session': '' }),
  })
  assert.equal(result.response.status, 404)
  assert.equal(result.json.code, 'session')

  result = await createShare(SESSION_A, { payload: payload({ revision: 99 }) })
  assert.equal(result.response.status, 404)
  assert.equal(result.json.code, 'revision')
})

test('raw JSON depth and field validation run before editor-state checks', async () => {
  let result = await createShare(SESSION_A, {
    body: '['.repeat(host.limits.maxJsonDepth + 1) + ']'.repeat(host.limits.maxJsonDepth + 1),
  })
  assert.equal(result.response.status, 400)
  assert.equal(result.json.code, 'fields')

  result = await createShare(SESSION_A, { payload: payload({ extra: true }) })
  assert.equal(result.response.status, 400)
  assert.equal(result.json.code, 'fields')

  result = await createShare(SESSION_A, {
    payload: payload({ editorState: { v: 1, objects: {}, tracks: {}, params: {} } }),
  })
  assert.equal(result.response.status, 400)
  assert.equal(result.json.code, 'editor-state')

  for (const key of ['objects', 'tracks', 'params']) {
    const state = editorState()
    state[key] = null
    result = await createShare(SESSION_A, { payload: payload({ editorState: state }) })
    assert.equal(result.response.status, 400)
    assert.equal(result.json.code, 'editor-state')
  }

  result = await createShare(SESSION_A, { payload: payload({ document: '<html></html>' }) })
  assert.equal(result.response.status, 400)
  assert.equal(result.json.code, 'document')

  result = await createShare(SESSION_A, { payload: payload({ stepFps: 0 }) })
  assert.equal(result.response.status, 400)
  assert.equal(result.json.code, 'fields')

  result = await createShare(SESSION_A, { payload: payload({ ttlSeconds: 1.5 }) })
  assert.equal(result.response.status, 400)
  assert.equal(result.json.code, 'fields')
})

test('iterative state depth/node caps reject without a raw-body overrun', () => {
  let value = {}
  let cursor = value
  for (let depth = 0; depth < host.limits.maxJsonDepth; depth += 1) {
    cursor.next = {}
    cursor = cursor.next
  }
  assert.equal(host.stateDepthAndNodes(value).ok, false)
  const many = { nodes: new Array(host.limits.maxStateNodes) }
  assert.equal(host.stateDepthAndNodes(many).ok, false)
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(host.stateDepthAndNodes(cyclic).ok, false)
  assert.equal(host.stateDepthAndNodes({ a: [1, 2, 3] }).ok, true)
})

test('session-leak scan covers document, state, code, title and metadata', async () => {
  let result = await createShare(SESSION_A, {
    payload: payload({ document: `<!doctype html><p>${SESSION_A}</p>` }),
  })
  assert.equal(result.response.status, 400)
  assert.equal(result.json.code, 'session-leak')

  result = await createShare(SESSION_A, {
    payload: payload({ editorState: editorState({ params: { v: 1, values: { leak: SESSION_A } } }) }),
  })
  assert.equal(result.response.status, 400)
  assert.equal(result.json.code, 'session-leak')

  seed(SESSION_B, { code: `const leak = "${SESSION_B}"` })
  result = await createShare(SESSION_B)
  assert.equal(result.response.status, 400)
  assert.equal(result.json.code, 'session-leak')

  seed(SESSION_C, { title: `Title ${SESSION_C}` })
  result = await createShare(SESSION_C)
  assert.equal(result.response.status, 400)
  assert.equal(result.json.code, 'session-leak')
})

test('revision is rechecked after the body has been read', async () => {
  const req = new Readable({ read () {} })
  req.method = 'POST'
  req.headers = createHeaders(SESSION_A)
  const promise = invokeRawHandler(host.createHandler, req, handlerOptions(1000))
  host.clearScene(SESSION_A)
  req.push(Buffer.from(JSON.stringify(payload())))
  req.push(null)
  const response = await promise
  assert.equal(response.status, 404)
  assert.equal(JSON.parse(response.body).code, 'revision')
})

test('document and editor-state size caps map to 413', async () => {
  const bigDocument = '<!doctype html>' + 'x'.repeat(host.limits.maxDocumentBytes)
  let result = await createShare(SESSION_A, { payload: payload({ document: bigDocument }) })
  assert.equal(result.response.status, 413)
  assert.equal(result.json.code, 'document')

  const bigState = editorState({ params: { v: 1, values: { blob: 'x'.repeat(host.limits.maxStateBytes) } } })
  result = await createShare(SESSION_A, { payload: payload({ editorState: bigState }) })
  assert.equal(result.response.status, 413)
  assert.equal(result.json.code, 'editor-state')
})

test('an idle request body times out with 408 and releases its slot', async () => {
  const req = new Readable({ read () {} })
  req.method = 'POST'
  req.headers = createHeaders(SESSION_A)
  const response = await invokeRawHandler(host.createHandler, req, handlerOptions(1000, {
    bodyIdleTimeoutMs: 10,
    bodyTotalTimeoutMs: 50,
  }))
  assert.equal(response.status, 408)
  assert.equal(JSON.parse(response.body).code, 'timeout')
  const next = await createShare(SESSION_A, { now: 1001 })
  assert.equal(next.response.status, 200)
})

test('a destroyed/closed body is rejected and releases concurrency', async () => {
  const req = new Readable({ read () {} })
  req.method = 'POST'
  req.headers = createHeaders(SESSION_A)
  const promise = invokeRawHandler(host.createHandler, req, handlerOptions(1000, {
    bodyIdleTimeoutMs: 500,
    bodyTotalTimeoutMs: 1000,
  }))
  req.destroy()
  const response = await promise
  assert.equal(response.status, 400)
  assert.equal(JSON.parse(response.body).code, 'fields')
})

test('create rate windows return 429 with retry-after and prune after 60 s', async () => {
  const headers = createHeaders(SESSION_A)
  const base = Date.now()
  for (let index = 0; index < 10; index += 1) {
    const result = await createShare(SESSION_A, {
      now: base,
      headers,
      payload: payload({ revision: 99 }),
    })
    assert.equal(result.response.status, 404)
  }
  const limited = await createShare(SESSION_A, { now: base, headers, payload: payload({ revision: 99 }) })
  assert.equal(limited.response.status, 429)
  assert.equal(limited.json.code, 'rate')
  assert.ok(Number(limited.response.headers['retry-after']) >= 1)
  const recovered = await createShare(SESSION_A, { now: base + 61000, headers })
  assert.equal(recovered.response.status, 200)
})

// ---------------------------------------------------------------------------
// TTL, delete, expiry and orphan accounting
// ---------------------------------------------------------------------------
test('TTL defaults to seven days, clamps to one hour and thirty days, and expires at now === expiresAt', async () => {
  const base = 1700000000000
  let created = await createShare(SESSION_A, { now: base })
  assert.equal(created.json.expiresAt, base + 604800000)
  const id = created.json.id

  let response = await viewer(id, { now: base + 604800000 - 1 })
  assert.equal(response.status, 200)
  response = await viewer(id, { now: base + 604800000 })
  assert.equal(response.status, 404)
  assert.equal(host.rawShare(id), undefined)

  host.reset()
  seed(SESSION_A)
  created = await createShare(SESSION_A, { now: base, payload: payload({ ttlSeconds: 1 }) })
  assert.equal(created.json.expiresAt, base + 3600000)

  host.reset()
  seed(SESSION_A)
  created = await createShare(SESSION_A, { now: base, payload: payload({ ttlSeconds: 999999999 }) })
  assert.equal(created.json.expiresAt, base + 2592000000)
})

test('correct delete key deletes once; wrong, missing, and second deletes are identical 404s', async () => {
  const created = await createShare(SESSION_A, {
    now: 1000,
    handlerOptions: { makeDeleteKey: () => DELETE_KEY },
  })
  const id = created.json.id
  let result = await deleteShare(id, 'W'.repeat(22), { now: 1000 })
  assert.equal(result.response.status, 404)
  const wrongBody = result.response.body
  result = await deleteShare(id, undefined, { body: JSON.stringify({ id }), now: 1000 })
  assert.equal(result.response.status, 404)
  assert.equal(result.response.body, wrongBody)
  result = await deleteShare('Z'.repeat(22), DELETE_KEY, { now: 1000 })
  assert.equal(result.response.status, 404)
  assert.equal(result.response.body, wrongBody)

  result = await deleteShare(id, DELETE_KEY, { now: 1000 })
  assert.equal(result.response.status, 200)
  assert.deepEqual(result.json, { ok: true })
  const second = await deleteShare(id, DELETE_KEY, { now: 1000 })
  assert.equal(second.response.status, 404)
  assert.equal(second.response.body, wrongBody)
  assert.equal(host.rawShare(id), undefined)
})

test('delete ignores a valid owner Session header and uses only the deleteKey', async () => {
  const created = await createShare(SESSION_A, {
    now: 1000,
    handlerOptions: { makeDeleteKey: () => DELETE_KEY },
  })
  const id = created.json.id
  const headers = { host: HOST_HEADER, 'content-type': 'application/json', 'x-workbench-session': SESSION_A }
  const result = await deleteShare(id, 'Q'.repeat(22), { headers, now: 1000 })
  assert.equal(result.response.status, 404)
  assert.notEqual(host.rawShare(id), undefined)
  const success = await deleteShare(id, DELETE_KEY, { headers, now: 1000 })
  assert.equal(success.response.status, 200)
})

test('delete has its own 60/min global window', async () => {
  for (let index = 0; index < 60; index += 1) {
    const result = await deleteShare('Z'.repeat(22), DELETE_KEY, { now: 1000 })
    assert.equal(result.response.status, 404)
  }
  const limited = await deleteShare('Z'.repeat(22), DELETE_KEY, { now: 1000 })
  assert.equal(limited.response.status, 429)
  assert.equal(limited.json.code, 'rate')
})

test('a lost create response leaves an orphan that expires and is reclaimed by a later create', async () => {
  const base = 2000
  const lost = await createShare(SESSION_A, { now: base, handlerOptions: { makeDeleteKey: () => DELETE_KEY } })
  assert.equal(lost.response.status, 200)
  assert.equal(host.usage(SESSION_A).count, 1)
  assert.equal(host.globalUsage().count, 1)
  const orphanId = lost.json.id
  const replacement = await createShare(SESSION_A, { now: base + 604800000 })
  assert.equal(replacement.response.status, 200)
  assert.equal(host.rawShare(orphanId), undefined)
  assert.equal(host.rawShare(replacement.json.id).id, replacement.json.id)
  assert.deepEqual(host.usage(SESSION_A), { count: 1, bytes: host.rawShare(replacement.json.id).bytes })
  assert.equal(host.globalUsage().count, 1)
  assert.equal(host.stats().shares, 1)
})

test('shares survive Host scene eviction and keep the exact document bytes', async () => {
  const created = await createShare(SESSION_A, { now: 1000 })
  const id = created.json.id
  const before = Buffer.from(host.rawShare(id).documentBuffer)
  host.clearScene(SESSION_A)
  const shell = await viewer(id, { now: 1000 })
  assert.equal(shell.status, 200)
  const metadata = await viewer(`${id}/metadata`, { now: 1000 })
  assert.equal(metadata.status, 200)
  const documentResponse = await viewer(`${id}/document`, { now: 1000 })
  assert.equal(documentResponse.status, 200)
  assert.deepEqual(Buffer.from(await documentResponse.arrayBuffer()), before)
})

// ---------------------------------------------------------------------------
// Quotas and concurrency
// ---------------------------------------------------------------------------
test('session and global count quotas reject on full and reclaim on expiry', async () => {
  for (let index = 0; index < 8; index += 1) {
    const result = await createShare(SESSION_A, { now: 1000 + index })
    assert.equal(result.response.status, 200)
  }
  let result = await createShare(SESSION_A, { now: 2000 })
  assert.equal(result.response.status, 507)
  assert.equal(result.json.code, 'quota')

  for (const [batch, session] of [SESSION_B, SESSION_C, 'share-session-d'].entries()) {
    host.seedSession(session, { revision: 0, title: 'seed', code: '' })
    for (let index = 0; index < 8; index += 1) {
      const created = await createShare(session, { now: 70000 + batch * 61000 + index })
      assert.equal(created.response.status, 200)
    }
  }
  assert.equal(host.globalUsage().count, 32)
  host.seedSession('share-session-e', { revision: 0, title: 'seed', code: '' })
  result = await createShare('share-session-e', { now: 70000 + 3 * 61000 + 20 })
  assert.equal(result.response.status, 507)
})

test('create sweeps expired records before the coarse quota check', async () => {
  for (let index = 0; index < 8; index += 1) {
    seedRecord({ owner: SESSION_A, bytes: 1024, expiresAt: 5000 })
  }
  assert.deepEqual(host.stats(), { shares: 8, bytes: 8192, owners: 1 })
  const created = await createShare(SESSION_A, { now: 10000 })
  assert.equal(created.response.status, 200)
  assert.equal(host.rawShare(created.json.id).id, created.json.id)
  assert.deepEqual(host.usage(SESSION_A), { count: 1, bytes: host.rawShare(created.json.id).bytes })
  assert.equal(host.globalUsage().count, 1)
  assert.equal(host.stats().shares, 1)

  host.reset()
  seed(SESSION_A)
  for (let index = 0; index < 3; index += 1) {
    seedRecord({ owner: SESSION_A, bytes: 22 * 1024 * 1024, expiresAt: 5000 })
  }
  const byteRecovered = await createShare(SESSION_A, { now: 10000 })
  assert.equal(byteRecovered.response.status, 200)
  assert.deepEqual(host.usage(SESSION_A), { count: 1, bytes: host.rawShare(byteRecovered.json.id).bytes })

  host.reset()
  for (let ownerIndex = 0; ownerIndex < 4; ownerIndex += 1) {
    const owner = `share-session-${String(ownerIndex)}`
    for (let index = 0; index < 8; index += 1) {
      seedRecord({ owner, bytes: 1024, expiresAt: 5000 })
    }
  }
  assert.equal(host.stats().shares, 32)
  seed('share-session-global')
  const globalRecovered = await createShare('share-session-global', { now: 10000 })
  assert.equal(globalRecovered.response.status, 200)
  assert.equal(host.globalUsage().count, 1)
  assert.equal(host.stats().shares, 1)
})

test('delete sweeps unrelated expired records before lookup', async () => {
  const live = await createShare(SESSION_A, {
    now: 1000,
    handlerOptions: { makeDeleteKey: () => DELETE_KEY },
  })
  seedRecord({ owner: SESSION_B, bytes: 2048, expiresAt: 5000 })
  seedRecord({ owner: SESSION_C, bytes: 2048, expiresAt: 5000 })
  assert.equal(host.stats().shares, 3)
  const deleted = await deleteShare(live.json.id, DELETE_KEY, { now: 10000 })
  assert.equal(deleted.response.status, 200)
  assert.deepEqual(deleted.json, { ok: true })
  assert.equal(host.stats().shares, 0)
  assert.deepEqual(host.usage(SESSION_A), { count: 0, bytes: 0 })
  assert.equal(host.globalUsage().count, 0)

  seedRecord({ owner: SESSION_A, bytes: 1024, expiresAt: 5000 })
  seedRecord({ owner: SESSION_A, bytes: 1024, expiresAt: 5000 })
  const unknown = await deleteShare('Z'.repeat(22), DELETE_KEY, { now: 10000 })
  assert.equal(unknown.response.status, 404)
  assert.equal(host.stats().shares, 0)
  assert.deepEqual(host.usage(SESSION_A), { count: 0, bytes: 0 })
})

test('coarse and final byte quotas reject before and after body processing', async () => {
  seedRecord({ owner: SESSION_A, bytes: 22 * 1024 * 1024, expiresAt: 1000000000000 })
  seedRecord({ owner: SESSION_A, bytes: 22 * 1024 * 1024, expiresAt: 1000000000000 })
  seedRecord({ owner: SESSION_A, bytes: 22 * 1024 * 1024, expiresAt: 1000000000000 })
  let result = await createShare(SESSION_A, { now: 1000 })
  assert.equal(result.response.status, 507)
  assert.equal(result.json.code, 'quota')

  host.reset()
  seed(SESSION_A)
  seedRecord({ owner: SESSION_A, bytes: 64 * 1024 * 1024 - 1, expiresAt: 1000000000000 })
  result = await createShare(SESSION_A, { now: 1000 })
  assert.equal(result.response.status, 507)
  assert.equal(result.json.code, 'quota')
})

test('a record whose accounted bytes exceed 30 MiB is rejected with 507', async () => {
  const prefix = '<!doctype html><html><head></head><body>'
  const document = prefix + 'x'.repeat(host.limits.maxDocumentBytes - prefix.length)
  seed(SESSION_A, { code: 'y'.repeat(5 * 1024 * 1024) })
  const result = await createShare(SESSION_A, {
    now: Date.now(),
    payload: payload({ document }),
  })
  assert.equal(result.response.status, 507)
  assert.equal(result.json.code, 'quota')
})

test('global byte quota rejects on full', async () => {
  for (const [index, owner] of [SESSION_A, SESSION_B, SESSION_C, 'share-session-d'].entries()) {
    host.seedSession(owner, { revision: 0, title: 'seed', code: '' })
    for (let count = 0; count < 2; count += 1) {
      seedRecord({ owner, bytes: 16 * 1024 * 1024, expiresAt: 1000000000000 })
    }
    assert.ok(index >= 0)
  }
  const result = await createShare(SESSION_A, { now: 1000 })
  assert.equal(result.response.status, 507)
  assert.equal(result.json.code, 'quota')
})

test('concurrent creates are bounded per session and globally, and slots release on timeout', async () => {
  const hanging = () => {
    const req = new Readable({ read () {} })
    req.method = 'POST'
    req.headers = createHeaders()
    return invokeRawHandler(host.createHandler, req, handlerOptions(1000, {
      bodyIdleTimeoutMs: 25,
      bodyTotalTimeoutMs: 80,
    }))
  }
  const first = hanging()
  const second = await createShare(SESSION_A, { now: 1001 })
  assert.equal(second.response.status, 429)
  const firstResponse = await first
  assert.equal(firstResponse.status, 408)

  const third = hanging()
  const globalHang = invokeRawHandler(host.createHandler, (() => {
    const req = new Readable({ read () {} })
    req.method = 'POST'
    req.headers = createHeaders(SESSION_B)
    return req
  })(), handlerOptions(1002, { bodyIdleTimeoutMs: 25, bodyTotalTimeoutMs: 80 }))
  await new Promise(resolve => setTimeout(resolve, 5))
  const fourth = await createShare(SESSION_C, { now: 1003 })
  assert.equal(fourth.response.status, 429)
  await Promise.all([third, globalHang])
  const recovered = await createShare(SESSION_C, { now: 10000 })
  assert.equal(recovered.response.status, 200)
})

// ---------------------------------------------------------------------------
// Viewer routes, headers and identity
// ---------------------------------------------------------------------------
test('viewer and document concurrency slots hold until the body closes or is cancelled', async () => {
  const base = 100000
  const created = await createShare(SESSION_A, { now: base })
  const id = created.json.id

  const shellOne = await viewer(id, { now: base })
  const shellTwo = await viewer(id, { now: base })
  assert.equal(shellOne.status, 200)
  assert.equal(shellTwo.status, 200)
  const shellLimited = await viewer(id, { now: base })
  assert.equal(shellLimited.status, 429)
  await shellOne.body.cancel()
  await shellTwo.body.cancel()
  await shellLimited.text()
  const shellRecovered = await viewer(id, { now: base })
  assert.equal(shellRecovered.status, 200)
  await shellRecovered.text()

  const documentOne = await viewer(`${id}/document`, { now: base })
  assert.equal(documentOne.status, 200)
  const documentLimited = await viewer(`${id}/document`, { now: base })
  assert.equal(documentLimited.status, 429)
  await documentOne.body.cancel()
  await documentLimited.text()
  const documentRecovered = await viewer(`${id}/document`, { now: base })
  assert.equal(documentRecovered.status, 200)
  await documentRecovered.text()
})

test('global viewer and document concurrency slots are bounded across ids', async () => {
  const base = 200000
  const ids = []
  for (let index = 0; index < 9; index += 1) {
    ids.push(seedRecord({ owner: index % 2 === 0 ? SESSION_A : SESSION_B, expiresAt: 1000000000000 }))
  }
  const shells = []
  for (let index = 0; index < 8; index += 1) {
    const response = await viewer(ids[index], { now: base })
    assert.equal(response.status, 200)
    shells.push(response)
  }
  const shellLimited = await viewer(ids[8], { now: base })
  assert.equal(shellLimited.status, 429)
  for (const response of shells) await response.body.cancel()
  await shellLimited.text()

  const documents = []
  for (let index = 0; index < 2; index += 1) {
    const response = await viewer(`${ids[index]}/document`, { now: base })
    assert.equal(response.status, 200)
    documents.push(response)
  }
  const documentLimited = await viewer(`${ids[2]}/document`, { now: base })
  assert.equal(documentLimited.status, 429)
  for (const response of documents) await response.body.cancel()
  await documentLimited.text()
})

test('shell, metadata and document return the designed types, headers and bytes', async () => {
  const created = await createShare(SESSION_A, { now: 1000, payload: payload({ editorState: editorState(), stepFps: 24 }) })
  const id = created.json.id
  const shell = await viewer(id, { now: 1000 })
  assert.equal(shell.status, 200)
  assert.equal(shell.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(shell.headers.get('cache-control'), 'no-store')
  assert.equal(shell.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(shell.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(shell.headers.get('x-frame-options'), 'DENY')
  assert.equal(shell.headers.get('cross-origin-opener-policy'), 'same-origin')
  assert.equal(shell.headers.get('cross-origin-resource-policy'), 'same-origin')
  assert.equal(shell.headers.get('content-security-policy'), host.shellCsp)
  assert.equal(shell.headers.get('access-control-allow-origin'), null)
  const shellText = await shell.text()
  assert.equal(Number(shell.headers.get('content-length')), Buffer.byteLength(shellText))
  assert.equal((shellText.match(/<iframe/g) ?? []).length, 1)
  assert.ok(shellText.includes('sandbox="allow-scripts allow-pointer-lock allow-downloads"'))
  assert.ok(!shellText.includes(id))
  assert.ok(!shellText.includes(SESSION_A))
  assert.ok(!shellText.includes(DOC))

  const headShell = await viewer(id, { now: 1000, method: 'HEAD' })
  assert.equal(headShell.status, 200)
  assert.equal(headShell.body, null)
  assert.equal(headShell.headers.get('content-length'), shell.headers.get('content-length'))

  const metadata = await viewer(`${id}/metadata`, { now: 1000 })
  assert.equal(metadata.status, 200)
  assert.equal(metadata.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(metadata.headers.get('content-disposition'), 'attachment; filename="share.json"')
  assert.equal(metadata.headers.get('content-security-policy'), "default-src 'none'; sandbox")
  assert.equal(metadata.headers.get('access-control-allow-origin'), null)
  const metadataText = await metadata.text()
  const parsed = JSON.parse(metadataText)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.title, 'Shared scene')
  assert.equal(parsed.revision, 0)
  assert.equal(parsed.stepFps, 24)
  assert.equal(parsed.createdAt, 1000)
  assert.equal(parsed.expiresAt, 1000 + 604800000)
  for (const forbidden of ['document', 'code', 'editorState', 'ownerSessionHash', 'deleteKey', SESSION_A]) {
    assert.ok(!metadataText.includes(forbidden))
  }

  const documentResponse = await viewer(`${id}/document`, { now: 1000 })
  assert.equal(documentResponse.status, 200)
  assert.equal(documentResponse.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(documentResponse.headers.get('content-disposition'), 'attachment; filename="share.txt"')
  assert.equal(documentResponse.headers.get('access-control-allow-origin'), null)
  assert.equal(await documentResponse.text(), DOC)
  const headDocument = await viewer(`${id}/document`, { now: 1000, method: 'HEAD' })
  assert.equal(headDocument.body, null)
  assert.equal(headDocument.headers.get('content-length'), String(Buffer.byteLength(DOC)))
})

test('presentation suffix returns only the additive field with constant headers', async () => {
  const presentation = presentationField()
  const created = await createShare(SESSION_A, {
    now: 1000,
    payload: payload({ editorState: editorState({ presentation }) }),
  })
  assert.equal(created.response.status, 200)
  const id = created.json.id
  const response = await viewer(`${id}/presentation`, { now: 1000 })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="presentation.json"')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin')
  assert.equal(response.headers.get('content-security-policy'), host.documentCsp)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  const text = await response.text()
  assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(text))
  assert.deepEqual(JSON.parse(text), { ok: true, presentation })
  // The suffix is a projection, never a record dump.
  for (const forbidden of ['editorState', 'ownerSessionHash', 'deleteKey', 'documentBuffer', 'metadataJson', SESSION_A]) {
    assert.ok(!text.includes(forbidden), forbidden)
  }
  const head = await viewer(`${id}/presentation`, { now: 1000, method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.body, null)
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(text)))
  assert.equal(head.headers.get('content-security-policy'), host.documentCsp)

  const empty = await createShare(SESSION_B, { now: 1000 })
  const emptyResponse = await viewer(`${empty.json.id}/presentation`, { now: 1000 })
  assert.equal(emptyResponse.status, 200)
  assert.deepEqual(JSON.parse(await emptyResponse.text()), { ok: true, presentation: null })
})

test('presentation data still rides the existing editor-state caps', async () => {
  const oversized = {
    v: 1,
    manual: {
      v: 1,
      title: 'Manual',
      product: '',
      version: '',
      language: 'en',
      steps: [{
        id: 'step-1',
        title: 'Huge',
        body: 'x'.repeat(2 * 1024 * 1024),
        camera: { position: [0, 0, 0], target: [0, 0, 0], fov: 50 },
        time: 0,
        hidden: [],
        highlight: null,
        parts: [],
        duration: 0,
      }],
    },
    film: null,
  }
  const result = await createShare(SESSION_A, {
    payload: payload({ editorState: editorState({ presentation: oversized }) }),
  })
  assert.equal(result.response.status, 413)
  assert.equal(result.json.code, 'editor-state')
  assert.equal(host.stats().shares, 0)
})

test('presentation 404s are indistinguishable from every other missing share', async () => {
  const created = await createShare(SESSION_A, {
    now: 1000,
    handlerOptions: { makeDeleteKey: () => DELETE_KEY },
  })
  const id = created.json.id
  const unknown = await viewer(`${'Z'.repeat(22)}/presentation`, { now: 1000 })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.headers.get('content-security-policy'), host.documentCsp)
  assert.equal(unknown.headers.get('access-control-allow-origin'), null)
  const unknownBody = await unknown.text()
  assert.equal(unknownBody, host.unavailableText)
  assert.equal(await (await viewer('short/presentation', { now: 1000 })).text(), unknownBody)
  await deleteShare(id, DELETE_KEY)
  assert.equal(await (await viewer(`${id}/presentation`, { now: 1000 })).text(), unknownBody)
  const expiredId = (await createShare(SESSION_A, { now: 5000, payload: payload({ ttlSeconds: 3600 }) })).json.id
  assert.equal(await (await viewer(`${expiredId}/presentation`, { now: 5000 + 3600000 })).text(), unknownBody)
  assert.equal((await viewer(`${'A'.repeat(22)}/presentations`, { now: 1000 })).status, 404)
  assert.equal((await viewer(`${'A'.repeat(22)}/presentation/extra`, { now: 1000 })).status, 404)
  assert.equal((await viewer(`${'A'.repeat(22)}/presentation`, { now: 1000, method: 'POST' })).status, 405)
})

test('presentation rate, concurrency and HEAD release are bounded', async () => {
  const base = 3000000
  const created = await createShare(SESSION_A, { now: base })
  const id = created.json.id
  const first = await viewer(`${id}/presentation`, { now: base })
  const second = await viewer(`${id}/presentation`, { now: base })
  assert.equal(first.status, 200)
  assert.equal(second.status, 429)
  assert.ok(Number(second.headers.get('retry-after')) >= 1)
  await first.body.cancel()
  await second.text()
  const recovered = await viewer(`${id}/presentation`, { now: base })
  assert.equal(recovered.status, 200)
  await recovered.text()

  const rateId = (await createShare(SESSION_B, { now: base })).json.id
  for (let index = 0; index < host.limits.presentationRatePerIdPerMinute; index += 1) {
    const response = await viewer(`${rateId}/presentation`, { now: base })
    assert.equal(response.status, 200)
    await response.text()
  }
  const limited = await viewer(`${rateId}/presentation`, { now: base })
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) >= 1)
  // The presentation bucket is separate from the document bucket.
  const documentResponse = await viewer(`${rateId}/document`, { now: base })
  assert.equal(documentResponse.status, 200)
  await documentResponse.text()
  const headRecovered = await viewer(`${rateId}/presentation`, { now: base + 61000, method: 'HEAD' })
  assert.equal(headRecovered.status, 200)
  assert.equal(headRecovered.body, null)

  const firstGlobalId = (await createShare(SESSION_C, { now: base + 61000 })).json.id
  host.seedSession('share-session-d', { revision: 0, title: 'seed', code: '' })
  const secondGlobalId = (await createShare('share-session-d', { now: base + 61000 })).json.id
  const globalOne = await viewer(`${firstGlobalId}/presentation`, { now: base + 61000 })
  const globalTwo = await viewer(`${secondGlobalId}/presentation`, { now: base + 61000 })
  assert.equal(globalOne.status, 200)
  assert.equal(globalTwo.status, 200)
  const globalLimited = await viewer(`${rateId}/presentation`, { now: base + 61000 })
  assert.equal(globalLimited.status, 429)
  await globalOne.body.cancel()
  await globalTwo.body.cancel()
  await globalLimited.text()
  const globalRecovered = await viewer(`${rateId}/presentation`, { now: base + 61000 })
  assert.equal(globalRecovered.status, 200)
  await globalRecovered.text()
})

test('the shell is constant across two valid ids and contains no share data', async () => {
  const first = await createShare(SESSION_A, { now: 1000 })
  const second = await createShare(SESSION_B, { now: 1000 })
  const shellA = await (await viewer(first.json.id, { now: 1000 })).text()
  const shellB = await (await viewer(second.json.id, { now: 1000 })).text()
  assert.equal(shellA, shellB)
  assert.equal(shellA, host.shellHtml)
  assert.ok(shellA.includes('Shared scene'))
  assert.ok(shellA.includes('Loading shared scene…'))
  assert.ok(shellA.includes('正在加载分享场景…'))
  assert.ok(shellA.includes('This share link is unavailable or has expired.'))
  assert.ok(shellA.includes('分享链接不可用或已过期。'))
  assert.ok(shellA.includes("credentials: 'omit'"))
  assert.equal((shellA.match(/credentials: 'omit'/g) ?? []).length, 3)
  assert.ok(shellA.includes("cache: 'no-store'"))
  assert.ok(shellA.includes("referrerPolicy: 'no-referrer'"))
  // The shell only posts runtime commands to the sandboxed frame. It never
  // listens for messages and never accepts or echoes share data into markup.
  assert.equal((shellA.match(/postMessage\(/g) ?? []).length, 1)
  assert.ok(shellA.includes("frame.contentWindow.postMessage(Object.assign({ type: 'three-workbench:command' }, message), '*')"))
  assert.ok(!shellA.includes('addEventListener(\'message\''))
  assert.ok(!shellA.includes('allow-same-origin'))
  assert.ok(!shellA.includes('innerHTML'))
  assert.ok(!shellA.includes('eval('))
  assert.ok(!shellA.includes('new Function'))
  assert.equal((shellA.match(/sandbox="allow-scripts allow-pointer-lock allow-downloads"/g) ?? []).length, 1)
  // Manual presentation wiring: fetch the additive suffix and render every
  // user-authored field through textContent.
  assert.ok(shellA.includes("location.pathname + '/presentation'"))
  assert.ok(shellA.includes("command: 'camera'"))
  assert.ok(shellA.includes("command: 'select'"))
  assert.ok(shellA.includes("command: 'mutate'"))
  assert.ok(shellA.includes("command: 'timeline'"))
  assert.ok(shellA.includes('visible: true'))
  assert.ok(shellA.includes('visible: false'))
  assert.ok(shellA.includes('transient: true'))
  assert.ok(shellA.includes("action: 'seek'"))
  assert.ok(shellA.includes('manualTitleEl.textContent'))
  assert.ok(shellA.includes('stepTitleEl.textContent'))
  assert.ok(shellA.includes('stepBodyEl.textContent'))
  assert.ok(shellA.includes('partsListEl.textContent'))
  assert.ok(shellA.includes('ArrowLeft') && shellA.includes('ArrowRight'))
  assert.ok(!shellA.includes(`${ROUTE}/create`))
  assert.ok(!shellA.includes(`${ROUTE}/delete`))
  assert.ok(shellA.includes("const LOADING = 'Loading shared scene"))
  assert.ok(shellA.includes("const UNAVAILABLE = 'This share link is unavailable"))
  assert.ok(shellA.includes('setTimeout(() => {'))
  assert.ok(shellA.includes('}, 10000)'))
  assert.ok(shellA.includes('frame.removeAttribute(\'srcdoc\')'))
  assert.ok(shellA.includes('frame.addEventListener(\'load\''))
})

test('viewer method, trailing slash, malformed id and no-listing paths are 404/405', async () => {
  const post = await viewer('A'.repeat(22), { method: 'POST' })
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET, HEAD')
  for (const path of [`${ROUTE}/`, `${ROUTE}`, `${ROUTE}/${'A'.repeat(22)}/`, `${ROUTE}/${'A'.repeat(22)}//`, `${ROUTE}/short`, `${ROUTE}/${'A'.repeat(22)}/other`]) {
    const response = await viewer(path)
    assert.equal(response.status, 404, path)
    assert.equal(await response.text(), host.unavailableText)
  }
})

test('malformed, unknown, deleted and expired ids are indistinguishable per route', async () => {
  const created = await createShare(SESSION_A, {
    now: 1000,
    handlerOptions: { makeDeleteKey: () => DELETE_KEY },
  })
  const id = created.json.id
  const unknownBody = await (await viewer('Z'.repeat(22), { now: 1000 })).text()
  const malformedBody = await (await viewer('short', { now: 1000 })).text()
  await deleteShare(id, DELETE_KEY)
  const deletedBody = await (await viewer(id, { now: 1000 })).text()
  const expiredId = (await createShare(SESSION_A, { now: 5000, payload: payload({ ttlSeconds: 3600 }) })).json.id
  const expiredBody = await (await viewer(expiredId, { now: 5000 + 3600000 })).text()
  assert.equal(unknownBody, malformedBody)
  assert.equal(unknownBody, deletedBody)
  assert.equal(unknownBody, expiredBody)
  assert.equal(unknownBody, host.unavailableText)
  assert.equal(await (await viewer('Z'.repeat(22), { now: 1000, method: 'HEAD' })).text(), '')
})

test('viewer shell and document rates are bounded per id and globally', async () => {
  const base = Date.now()
  const created = await createShare(SESSION_A, { now: base })
  const id = created.json.id
  for (let index = 0; index < host.limits.viewerRatePerIdPerMinute; index += 1) {
    const response = await viewer(id, { now: base })
    assert.equal(response.status, 200)
    await response.text()
  }
  let limited = await viewer(id, { now: base })
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('retry-after')) >= 1)
  assert.equal((await viewer(id, { now: base + 61000 })).status, 200)

  const documentId = (await createShare(SESSION_A, { now: base })).json.id
  for (let index = 0; index < host.limits.documentRatePerIdPerMinute; index += 1) {
    const response = await viewer(`${documentId}/document`, { now: base })
    assert.equal(response.status, 200)
    await response.text()
  }
  limited = await viewer(`${documentId}/document`, { now: base })
  assert.equal(limited.status, 429)
})

// ---------------------------------------------------------------------------
// Host allowlist, Origin normalization and CSP
// ---------------------------------------------------------------------------
test('strict Host allowlist accepts DNS, IPv4, bracketed IPv6 and valid ports', () => {
  for (const valid of ['localhost', 'localhost:3099', 'example.com:443', 'a-b.c.example', '127.0.0.1', '127.0.0.1:80', '[::1]', '[::1]:3099', '[2001:db8::1]:65535']) {
    assert.notEqual(host.validateHost(valid), null, valid)
  }
  assert.equal(host.validateHost('EXAMPLE.com'), null)
  assert.equal(host.validateHost('example.com.'), null)
  assert.equal(host.validateHost('01.2.3.4'), null)
  assert.equal(host.validateHost('256.0.0.1'), null)
  assert.equal(host.validateHost('1.2.3'), null)
  // Decimal ports are parsed and re-emitted without leading zeros.
  assert.equal(host.validateHost('example.com:01'), 'example.com:1')
  assert.equal(host.validateHost('[::1]:0443'), '[::1]:443')
  for (const invalid of [
    'evil.example.;x', 'evil.example.;connect-src', '*', '%3B', 'a,b', 'a"b', 'user@example.com',
    'example.com/path', 'example.com?x', 'example.com#x', 'exa mple.com', 'a..b', '-a.example',
    'a-.example', 'example.com:0', 'example.com:65536', 'example.com:',
    '[::1%25eth0]', '[::1', '::1', '[zzzz::1]', '',
  ]) {
    assert.equal(host.validateHost(invalid), null, invalid)
  }
})

test('default-port Origin normalization accepts both schemes and rejects mismatched non-default ports', async () => {
  let result = await createShare(SESSION_A, {
    headers: createHeaders(SESSION_A, { host: 'example.com:443', origin: 'https://example.com' }),
  })
  assert.equal(result.response.status, 200)

  result = await createShare(SESSION_A, {
    headers: createHeaders(SESSION_A, { host: 'example.com:80', origin: 'http://example.com' }),
  })
  assert.equal(result.response.status, 200)

  result = await createShare(SESSION_A, {
    headers: createHeaders(SESSION_A, { host: 'example.com:8443', origin: 'https://example.com' }),
  })
  assert.equal(result.response.status, 403)

  result = await createShare(SESSION_A, {
    headers: createHeaders(SESSION_A, { host: 'example.com:8443', origin: 'http://example.com:8443' }),
  })
  assert.equal(result.response.status, 200)

  result = await createShare(SESSION_A, {
    headers: createHeaders(SESSION_A, { host: '[::1]:3099', origin: 'http://[::1]:3099' }),
  })
  assert.equal(result.response.status, 200)

  const allowed = host.allowedOrigins('example.com:443')
  assert.deepEqual([...allowed].sort(), ['http://example.com:443', 'https://example.com'])
})

test('crafted Hosts cannot split or inject the constant CSP', async () => {
  for (const crafted of ['evil.example.;x', 'evil.example.;connect-src', '*', '%3B', 'a,b', 'a"b', 'user@example.com', 'example.com/path', 'exa mple.com']) {
    const response = await viewer('A'.repeat(22), { host: crafted })
    assert.equal(response.status, 400, crafted)
    assert.equal(await response.text(), 'Bad request.\n')
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox")
  }
  const shellCsp = host.shellCsp
  const expected = [
    "default-src 'none'", 'frame-src about:', "script-src 'unsafe-inline' 'unsafe-eval' 'self'",
    "style-src 'unsafe-inline' 'self'", "img-src 'self' data: blob:", "media-src 'self' data: blob:",
    "connect-src 'self' data: blob:", "font-src 'self' data:", "worker-src 'none'", "object-src 'none'",
    "base-uri 'none'", "form-action 'none'", "manifest-src 'none'", "prefetch-src 'none'", "navigate-to 'none'",
  ]
  assert.deepEqual(shellCsp.split('; '), expected)
  assert.ok(!shellCsp.includes('evil'))
  assert.ok(!shellCsp.includes('localhost'))
  assert.ok(host.documentMeta.includes("frame-src 'none'"))
  assert.ok(host.documentMeta.includes('connect-src data: blob:'))
  assert.ok(!host.documentMeta.includes('script-src'))
  assert.ok(!host.documentMeta.includes('default-src'))
})

test('route registration is exact-first and no share write uses the ACAO text helper', () => {
  const createAt = indexSource.indexOf("path: `${SHARE_PATH}/create`")
  const deleteAt = indexSource.indexOf("path: `${SHARE_PATH}/delete`")
  const viewerAt = indexSource.indexOf('path: SHARE_PATH')
  assert.ok(createAt > 0 && deleteAt > createAt && viewerAt > deleteAt)
  const createBlock = indexSource.slice(indexSource.indexOf('async function shareCreateHandler'), indexSource.indexOf('async function shareDeleteHandler'))
  const finalAt = createBlock.lastIndexOf('shareFinalQuotaFailure')
  const insertAt = createBlock.indexOf('insertShare(record)', finalAt)
  assert.ok(finalAt >= 0 && insertAt > finalAt)
  const between = createBlock.slice(finalAt, insertAt)
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
  assert.ok(!/\bawait\b/.test(between))
  assert.ok(indexSource.includes('timingSafeEqual'))
})

// ---------------------------------------------------------------------------
// Client pure helpers
// ---------------------------------------------------------------------------
test('asset remap rewrites every reference to fresh ids without mutating inputs', () => {
  const A = 'A'.repeat(22)
  const B = 'B'.repeat(22)
  const C = 'C'.repeat(22)
  const state = editorState({
    environment: { assetId: A },
    objects: {
      u1: { overrides: { material: { mat: { textures: { map: A, normalMap: B } } } } },
      u2: { overrides: { material: { mat: { textures: { alphaMap: A } } } } },
    },
  })
  const before = JSON.stringify(state)
  const assets = [
    { id: A, name: 'a', kind: 'image', mime: 'image/png', bytes: 10, url: 'data:image/png;base64,AA', data: new Uint8Array([1]), extension: 'png' },
    { id: B, name: 'b', kind: 'image', mime: 'image/png', bytes: 20, url: 'data:image/png;base64,BB', data: new Uint8Array([2]), extension: 'png' },
    { id: C, name: 'unreferenced', kind: 'model', mime: 'model/gltf-binary', bytes: 30, url: 'data:model/gltf-binary;base64,CC', data: new Uint8Array([3]), extension: 'glb' },
  ]
  const assetsBefore = JSON.stringify(assets)
  let counter = 0
  const remapped = client.__remapShareAssets(state, assets, () => 'N' + String(counter++).padStart(21, '0'))
  assert.equal(JSON.stringify(state), before)
  assert.equal(JSON.stringify(assets), assetsBefore)
  assert.equal(remapped.assets.length, 3)
  assert.equal(new Set(remapped.assets.map(asset => asset.id)).size, 3)
  assert.ok(remapped.assets.every(asset => !asset.data && !asset.extension))
  const manifestIds = new Set(remapped.assets.map(asset => asset.id))
  assert.ok(manifestIds.has(remapped.state.environment.assetId))
  assert.ok(manifestIds.has(remapped.state.objects.u1.overrides.material.mat.textures.map))
  assert.ok(manifestIds.has(remapped.state.objects.u1.overrides.material.mat.textures.normalMap))
  assert.ok(manifestIds.has(remapped.state.objects.u2.overrides.material.mat.textures.alphaMap))
  const stateText = JSON.stringify(remapped.state)
  const manifestText = JSON.stringify(remapped.assets)
  for (const original of [A, B, C]) {
    assert.ok(!stateText.includes(original))
    assert.ok(!manifestText.includes(original))
  }
  assert.ok(manifestText.includes('data:image/png;base64,AA'))
})

test('asset remap skips original ids, enforces uniqueness, and rejects missing references', () => {
  const A = 'A'.repeat(22)
  const assets = [{ id: A, name: 'a', kind: 'image', mime: 'image/png', bytes: 1, url: 'data:image/png;base64,AA' }]
  let counter = 0
  const remapped = client.__remapShareAssets(editorState({ environment: { assetId: A } }), assets,
    () => counter++ === 0 ? A : 'N'.repeat(22))
  assert.notEqual(remapped.state.environment.assetId, A)
  assert.throws(() => client.__remapShareAssets(editorState({ environment: { assetId: A } }), assets, () => A),
    error => error.code === 'asset-id')
  const state = editorState({ environment: { assetId: 'M'.repeat(22) } })
  assert.throws(() => client.__remapShareAssets(state, assets, () => 'N'.repeat(22)),
    error => error.code === 'asset-missing')
})

test('share document adds the constant metas after head and leaves ordinary previewDocument unchanged', () => {
  const record = { title: 'Doc', revision: 3, code: 'const value = 1' }
  const frozen = { camera: { position: [0, 1, 2], target: [0, 0, 0] } }
  const state = editorState()
  const assets = [{ id: 'N'.repeat(22), name: 'n', kind: 'image', mime: 'image/png', bytes: 1, url: 'data:image/png;base64,AA' }]
  const shareHtml = client.__shareDocument(record, frozen, state, assets)
  const ordinary = client.__previewDocument(record, frozen.camera, state, { revision: 1, assets })
  assert.ok(shareHtml.startsWith('<!doctype html>'))
  assert.ok(shareHtml.includes(client.__SHARE_DOCUMENT_META))
  assert.ok(shareHtml.includes(client.__SHARE_REFERRER_META))
  const headMatch = /<head[^>]*>/i.exec(shareHtml)
  assert.ok(headMatch !== null)
  assert.equal(shareHtml.indexOf(client.__SHARE_DOCUMENT_META), headMatch.index + headMatch[0].length)
  assert.ok(shareHtml.indexOf(client.__SHARE_DOCUMENT_META) < shareHtml.indexOf('<meta charset'))
  assert.ok(ordinary.indexOf(client.__SHARE_DOCUMENT_META) < 0)
  assert.ok(shareHtml.includes('/three-workbench/runtime/three.module.js'))
  assert.ok(shareHtml.includes('const value = 1'))
  assert.ok(shareHtml.includes('data:image/png;base64,AA'))
  assert.ok(!shareHtml.includes('?token='))
  assert.ok(!shareHtml.includes('token%3D'))
  assert.ok(!shareHtml.includes(SESSION_A))
})

test('share preflight enforces state, document and JSON body caps', () => {
  const state = editorState()
  const ok = client.__sharePreflight({
    revision: 0, editorState: state, stepFps: 30, ttlSeconds: 604800, document: DOC,
  })
  assert.equal(ok.ok, true)
  assert.equal(JSON.parse(ok.body).revision, 0)
  assert.equal(JSON.parse(ok.body).stepFps, 30)

  const bigState = editorState({ params: { v: 1, values: { blob: 'x'.repeat(2 * 1024 * 1024) } } })
  const stateFail = client.__sharePreflight({
    revision: 0, editorState: bigState, stepFps: 30, ttlSeconds: 604800, document: DOC,
  })
  assert.equal(stateFail.ok, false)
  assert.equal(stateFail.reason, 'state')

  const bigDocument = '<!doctype html>' + 'x'.repeat(26 * 1024 * 1024)
  const documentFail = client.__sharePreflight({
    revision: 0, editorState: state, stepFps: 30, ttlSeconds: 604800, document: bigDocument,
  })
  assert.equal(documentFail.ok, false)
  assert.equal(documentFail.reason, 'document')

  // 21 MiB of quotes stays under the document cap but doubles in JSON.
  const escapeHeavy = '"'.repeat(21 * 1024 * 1024)
  const bodyFail = client.__sharePreflight({
    revision: 0, editorState: state, stepFps: 30, ttlSeconds: 604800, document: escapeHeavy,
  })
  assert.equal(bodyFail.ok, false)
  assert.equal(bodyFail.reason, 'body')
})

test('snapshot and revalidation guards block only an active draft and reject demo/stale state', () => {
  const record = { sceneId: SESSION_A, revision: 4, code: '', title: 'T' }
  const base = {
    busy: false,
    viewingHistory: false,
    editorLoaded: true,
    assetListReady: true,
    record,
    session: SESSION_A,
    drafts: {},
  }
  assert.equal(client.__shareSnapshotIssue(base), null)
  assert.equal(client.__shareDraftActive({ 4: { active: false } }, 4), false)
  assert.equal(client.__shareDraftActive({ 4: { active: true } }, 4), true)
  assert.equal(client.__shareDraftActive({}, 4), false)
  assert.equal(client.__shareSnapshotIssue({ ...base, drafts: { 4: { active: false } } }), null)
  assert.equal(client.__shareSnapshotIssue({ ...base, drafts: { 4: { active: true } } }), 'draft')
  assert.equal(client.__shareSnapshotIssue({ ...base, viewingHistory: true }), 'history')
  assert.equal(client.__shareSnapshotIssue({ ...base, editorLoaded: false }), 'not-ready')
  assert.equal(client.__shareSnapshotIssue({ ...base, assetListReady: false }), 'not-ready')
  assert.equal(client.__shareSnapshotIssue({ ...base, record: { ...record, sceneId: 'demo' } }), 'not-ready')
  assert.equal(client.__shareSnapshotIssue({ ...base, session: SESSION_B }), 'not-ready')
  assert.equal(client.__shareSnapshotIssue({ ...base, busy: true }), 'busy')

  const validation = {
    op: 7,
    activeOp: 7,
    record,
    currentRecord: record,
    session: SESSION_A,
    currentSession: SESSION_A,
    revision: 4,
    viewingHistory: false,
    drafts: {},
  }
  assert.equal(client.__shareRevalidationIssue(validation), null)
  assert.equal(client.__shareRevalidationIssue({ ...validation, activeOp: 8 }), 'stale')
  assert.equal(client.__shareRevalidationIssue({ ...validation, currentRecord: { ...record } }), 'stale')
  assert.equal(client.__shareRevalidationIssue({ ...validation, currentSession: SESSION_B }), 'not-ready')
  assert.equal(client.__shareRevalidationIssue({ ...validation, revision: 3 }), 'stale')
  assert.equal(client.__shareRevalidationIssue({ ...validation, viewingHistory: true }), 'stale')
  assert.equal(client.__shareRevalidationIssue({ ...validation, drafts: { 4: { active: true } } }), 'draft')
  assert.equal(client.__shareRevalidationIssue({ ...validation, drafts: { 4: { active: false } } }), null)
  const demoRecord = { ...record, sceneId: 'demo' }
  assert.equal(client.__shareRevalidationIssue({ ...validation, record: demoRecord, currentRecord: demoRecord }), 'not-ready')
})

test('share registry is bounded, pruned, deduplicated and storage-failure tolerant', () => {
  const now = 10000
  assert.equal(client.__SHARE_REGISTRY_KEY, 'three-workbench:shares:v1')
  assert.equal(client.__SHARE_REGISTRY_MAX, 20)
  const entries = []
  for (let index = 0; index < 20; index += 1) {
    const entry = registryEntry({
      id: index.toString(36).padStart(22, '0'),
      createdAt: 1000 + index,
      expiresAt: now + 1000,
    })
    entries.push(entry)
  }
  assert.equal(client.__pruneShareRegistry(entries, now).length, 20)
  assert.equal(client.__addShareRegistryEntry(entries, registryEntry({
    id: 'R'.repeat(22), createdAt: 2000, expiresAt: now + 1000,
  }), now), null)
  const expired = [...entries, registryEntry({ id: 'E'.repeat(22), createdAt: 3000, expiresAt: now })]
  assert.equal(client.__pruneShareRegistry(expired, now).some(entry => entry.id === 'E'.repeat(22)), false)
  assert.equal(client.__pruneShareRegistry([...entries, { nope: true }], now).length, 20)

  const storage = memoryStorage()
  assert.equal(client.__writeShareRegistry(storage, entries), true)
  const read = client.__readShareRegistry(storage, now)
  assert.equal(read.failed, false)
  assert.equal(read.entries.length, 20)
  assert.equal(client.__removeShareRegistryEntry(read.entries, read.entries[0].id).length, 19)

  const throwing = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
  }
  assert.equal(client.__readShareRegistry(throwing).failed, true)
  assert.equal(client.__writeShareRegistry(throwing, entries), false)
  assert.equal(client.__readShareRegistry(null).failed, true)
  storage.setItem(client.__SHARE_REGISTRY_KEY, 'not json')
  assert.equal(client.__readShareRegistry(storage).failed, true)
})

test('client source keeps the pinned guards and the ref-backed share contract', () => {
  assert.equal((clientSource.match(/sandbox: 'allow-scripts allow-pointer-lock allow-downloads'/g) ?? []).length, 1)
  assert.equal((clientSource.match(/allow-same-origin/g) ?? []).length, 0)
  assert.equal((clientSource.match(/eval\(/g) ?? []).length, 0)
  assert.equal((clientSource.match(/new Function/g) ?? []).length, 1)
  assert.equal((clientSource.match(/\?token=/g) ?? []).length, 0)
  assert.equal((clientSource.match(/token%3D/g) ?? []).length, 0)
  for (const needle of [
    'recordRef.current', 'recordMatchesSession(session, record)', 'editorLoaded', 'assetListReady',
    'draftsRef.current', "record.sceneId === 'demo'", 'activeShareOpRef.current', 'shareBusyRef.current',
    'shareOpSeqRef.current', 'JSON.parse(JSON.stringify(state))', 'shareDispatchRef.current = true',
    'shareLockedRef.current', 'draft.active === true', '__remapShareAssets', '__shareDocument',
  ]) {
    assert.ok(clientSource.includes(needle), needle)
  }
  assert.ok(clientSource.includes('previewDocument(record, camera, remappedState'))
  assert.ok(clientSource.includes('revision: 1'))
  const createFetchAt = clientSource.indexOf('fetch(`${ROUTE}/share/create`')
  const dispatchAt = clientSource.lastIndexOf('shareDispatchRef.current = true', createFetchAt)
  assert.ok(createFetchAt > 0 && dispatchAt > 0 && dispatchAt < createFetchAt)
})

test('share shell renders manual BOM/hotspots, print-to-PDF and a local QR', () => {
  const shell = host.shellHtml
  assert.match(shell, /id="step-hotspots"/)
  assert.match(shell, /id="bom-list"/)
  assert.match(shell, /id="manual-print"/)
  assert.match(shell, /id="print"/)
  assert.match(shell, /qrcode-generator\.js/)
  assert.match(shell, /renderHotspots/)
  assert.match(shell, /renderBom/)
  assert.match(shell, /renderPrint/)
  assert.match(shell, /window\.print\(\)/)
  assert.match(shell, /sandbox="allow-scripts allow-pointer-lock allow-downloads"/)
  assert.ok(!shell.includes('allow-same-origin'))
})
