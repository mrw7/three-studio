/**
 * P3-2 history restore/diff matrix. No ports: Host handlers and resources are
 * called directly with fake streams and an injected clock. Browser behavior
 * (dialogs, focus, real fetch/DOM) lives in
 * `.preview-tmp/verify-p32-history-diff.mjs`.
 */
// Run: node --test "tests/**/*.mjs"
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { Readable, PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import {
  apply as applyHost,
  __historyInternal as host,
  __shareInternal as shareHost,
  __assetInternal as assetHost,
} from '../index.js'

const ROUTE = '/three-workbench'
const RESTORE_PATH = `${ROUTE}/scene/restore`
const HOST_HEADER = 'localhost:3099'
const ORIGIN = 'http://localhost:3099'
const SESSION_A = 'history-fixture-a'
const SESSION_B = 'history-fixture-b'
const SESSION_C = 'history-fixture-c'
const REQUEST_A = 'A'.repeat(22)
const REQUEST_B = 'B'.repeat(22)
const REQUEST_C = 'C'.repeat(22)
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8')
const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

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
await import(`${pathToFileURL(new URL('../client.js', import.meta.url).pathname).href}?history=${String(Date.now())}`)
const client = definition.factory(name => {
  if (name === 'react') return reactStub
  if (name === '@deepseek-ai/dsh-client-store') {
    return {
      createSnapshotStore: initial => ({
        getSnapshot: () => initial,
        subscribe: () => () => {},
        set: () => {},
        update: () => {},
      }),
    }
  }
  throw new Error(`unexpected require: ${name}`)
})
const history = client.__historyInternal

function fixtureRecord(sessionId, revision, updatedAt, options = {}) {
  const code = options.code === undefined ? `const revision = ${String(revision)}\n` : options.code
  const title = options.title === undefined ? `Fixture title ${String(revision)}` : options.title
  return {
    sceneId: options.sceneId === undefined ? sessionId : options.sceneId,
    revision,
    title,
    code,
    bytes: options.bytes === undefined ? Buffer.byteLength(code, 'utf8') : options.bytes,
    updatedAt,
  }
}

function linearHistory(sessionId, count, options = {}) {
  const baseUpdatedAt = options.baseUpdatedAt ?? 1000
  const records = []
  for (let index = 1; index <= count; index += 1) {
    records.push(fixtureRecord(sessionId, index, baseUpdatedAt + index, {
      code: options.codeFor === undefined ? undefined : options.codeFor(index),
      title: options.titleFor === undefined ? undefined : options.titleFor(index),
      sceneId: options.sceneId,
      bytes: options.bytesFor === undefined ? undefined : options.bytesFor(index),
    }))
  }
  return records
}

function seed(sessionId, countOrHistory, options = {}) {
  const records = Array.isArray(countOrHistory)
    ? countOrHistory
    : linearHistory(sessionId, countOrHistory, options)
  host.seedSession(sessionId, records)
  return records
}

function fieldsFor(records, overrides = {}) {
  const source = records[0]
  const head = records[records.length - 1]
  return {
    sourceRevision: source.revision,
    sourceUpdatedAt: source.updatedAt,
    expectedRevision: head.revision,
    expectedUpdatedAt: head.updatedAt,
    requestId: REQUEST_A,
    ...overrides,
  }
}

function bodyOf(fields) {
  return JSON.stringify(fields)
}

function baseHeaders(sessionId = SESSION_A, extra = {}) {
  return {
    host: HOST_HEADER,
    'content-type': 'application/json',
    'x-workbench-session': sessionId,
    ...extra,
  }
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

function invokeRaw(handler, req, options = {}) {
  return new Promise(resolve => {
    const res = fakeResponse(resolve)
    handler(req, res, options)
  })
}

function invoke(handler, options = {}) {
  const body = options.body ?? null
  const buffer = body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body))
  const req = Readable.from(buffer === null ? [] : [buffer])
  req.method = options.method ?? 'POST'
  req.url = options.url ?? RESTORE_PATH
  req.headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
  return invokeRaw(handler, req, options.handlerOptions ?? {})
}

async function restoreCall(options = {}) {
  const response = await invoke(host.restoreHandler, {
    method: options.method,
    url: options.url,
    headers: options.headers === undefined ? baseHeaders(options.sessionId ?? SESSION_A) : options.headers,
    body: options.body,
    handlerOptions: options.handlerOptions,
  })
  let json = null
  try { json = JSON.parse(response.body) } catch (error) { void error }
  return { response, json }
}

function successCall(sessionId, records, options = {}) {
  return restoreCall({
    sessionId,
    body: bodyOf(fieldsFor(records, options.fields)),
    handlerOptions: options.handlerOptions,
    headers: options.headers,
  })
}

function assertErrorShape(result, status, code) {
  assert.equal(result.response.status, status)
  assert.deepEqual(result.json, { ok: false, code })
  assert.deepEqual(Object.keys(result.json).sort(), ['code', 'ok'])
  assert.equal(result.response.headers['access-control-allow-origin'], undefined)
  assert.equal(result.response.headers['set-cookie'], undefined)
  assert.equal(result.response.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(result.response.headers['cache-control'], 'no-store')
  assert.equal(result.response.headers['x-content-type-options'], 'nosniff')
  assert.equal(result.response.headers['content-length'], String(Buffer.byteLength(result.response.body)))
}

function currentHistory(sessionId = SESSION_A) {
  return host.history(sessionId).history
}

function sessionRecord(sessionId = SESSION_A) {
  return fixtureRecord(sessionId, 1, 1001)
}

function recordingContext() {
  const records = { routes: [] }
  const ctx = {
    effect(fn) { fn(); return () => {} },
    inject(names, callback) {
      assert.deepEqual(names, ['webServer'])
      callback(ctx)
    },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    webServer: { register(route) { records.routes.push(route); return () => {} } },
  }
  applyHost(ctx)
  return records
}

function idFor(index) {
  return `${String(index).padStart(2, '0')}${'x'.repeat(20)}`
}

beforeEach(() => {
  host.reset()
  assetHost.reset()
})

// ---------------------------------------------------------------------------
// H1 route/source contract
// ---------------------------------------------------------------------------

test('H1 restore route is exact, registered once, and uses the shared handler', () => {
  const records = recordingContext()
  const routes = records.routes.filter(route => route.path === RESTORE_PATH)
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].handler, host.restoreHandler)
  assert.equal(host.path, RESTORE_PATH)
  assert.ok(!RESTORE_PATH.endsWith('/'))
  assert.ok(records.routes.some(route => route.kind === 'prefix' && route.path === ROUTE))
})

test('H1 restore limits are exact and unchanged scene caps coexist', () => {
  assert.deepEqual(host.limits, {
    maxBodyBytes: 4096,
    bodyIdleTimeoutMs: 2000,
    bodyTotalTimeoutMs: 5000,
    requestsPerSessionPerMinute: 6,
    requestsGlobalPerMinute: 30,
    concurrentPerSession: 1,
    concurrentGlobal: 2,
    idempotencyEntriesPerSession: 8,
    idempotencyTtlMs: 600000,
    requestIdLength: 22,
    clientTimeoutMs: 20000,
  })
  assert.match(indexSource, /const MAX_CODE_BYTES = 256 \* 1024/)
  assert.match(indexSource, /const MAX_SCENES = 16/)
  assert.match(indexSource, /const MAX_REVISIONS = 12/)
  assert.match(indexSource, /const MAX_THUMBNAILS_PER_SESSION = 12/)
  assert.match(indexSource, /const ASSET_LIMITS = \{/)
})

test('H1 HTTP method and query are rejected before Host/session work', async () => {
  const method = await restoreCall({
    method: 'GET',
    headers: { host: 'BAD HOST', 'content-type': 'text/plain' },
    url: `${RESTORE_PATH}?x=1`,
  })
  assertErrorShape(method, 405, 'method')
  assert.equal(method.response.headers.allow, 'POST')
  const query = await restoreCall({ url: `${RESTORE_PATH}?x=1`, headers: {} })
  assertErrorShape(query, 400, 'fields')
})

test('H1 restore section has no disk, token, CORS or generic text responder', () => {
  const start = indexSource.indexOf('function reserveRestoreSlot')
  const end = indexSource.indexOf(' * POST /three-workbench/share/create.')
  assert.ok(start > 0 && end > start)
  const section = indexSource.slice(start, end)
  assert.ok(!section.includes('writeFile'))
  assert.ok(!section.includes('appendFile'))
  assert.ok(!section.includes('createWriteStream'))
  assert.ok(!section.includes('node:fs'))
  assert.ok(!section.includes('readFile'))
  assert.ok(!section.includes('textResponse'))
  assert.ok(!section.includes('access-control-allow-origin'))
  assert.ok(!section.includes('?token='))
  assert.ok(!section.includes('token%3D'))
  assert.ok(!section.includes('console.log'))
  assert.ok(section.includes('sendRestoreJson'))
})

test('H1 success body source contains only four fields and no request echo', () => {
  const start = indexSource.indexOf('function reserveRestoreSlot')
  const end = indexSource.indexOf(' * POST /three-workbench/share/create.')
  const section = indexSource.slice(start, end)
  assert.match(section, /const success = \{\n\s+ok: true,\n\s+revision: record\.revision,\n\s+sourceRevision: source\.revision,\n\s+updatedAt: record\.updatedAt,\n\s+\}/)
  assert.ok(!section.includes('sessionId: sessionId'))
})

test('H1 tool and restore share one append/trim/LRU helper that clears restore state', () => {
  assert.equal((indexSource.match(/function commitSceneRevision/g) ?? []).length, 1)
  assert.match(indexSource, /const scene = commitSceneRevision\(sceneId, \{/)
  assert.match(indexSource, /const record = commitSceneRevision\(sessionId, \{/)
  const helperStart = indexSource.indexOf('function commitSceneRevision')
  const helperEnd = indexSource.indexOf('function storeThumbnail')
  const helper = indexSource.slice(helperStart, helperEnd)
  assert.ok(helper.includes('while (nextHistory.length > MAX_REVISIONS) nextHistory.shift()'))
  assert.ok(helper.includes('deleteAssetSession(oldest)'))
  assert.ok(helper.includes('clearRestoreSessionState(oldest)'))
  assert.ok(helper.includes('scenes.delete(sessionId)'))
  assert.ok(helper.includes('scenes.set(sessionId, { history: nextHistory })'))
})

test('H1 client sandbox triple is exactly once and never allow-same-origin', () => {
  assert.equal((clientSource.match(/allow-scripts allow-pointer-lock allow-downloads/g) ?? []).length, 1)
  assert.equal((clientSource.match(/allow-same-origin/g) ?? []).length, 0)
  assert.equal((clientSource.match(/innerHTML/g) ?? []).length, 0)
  assert.equal((clientSource.match(/dangerouslySetInnerHTML/g) ?? []).length, 0)
  assert.equal((clientSource.match(/eval\(/g) ?? []).length, 0)
  assert.equal((clientSource.match(/new Function/g) ?? []).length, 1)
  assert.equal((clientSource.match(/\?token=/g) ?? []).length, 0)
  assert.equal((clientSource.match(/token%3D/g) ?? []).length, 0)
  assert.ok(!clientSource.includes('allow-same-origin'))
})

test('H1 constant share CSP and runtime CORS remain untouched', () => {
  assert.ok(indexSource.includes('const SHARE_DOCUMENT_CSP = "default-src \'none\'; sandbox"'))
  assert.equal((indexSource.match(/access-control-allow-origin': '\*'/g) ?? []).length, 3)
  assert.equal((indexSource.match(/access-control-allow-origin/g) ?? []).length, 3)
})

test('H1 restore and diff code add no iframe, message bridge or navigation', () => {
  const start = clientSource.indexOf('P3-2 restore/diff state.')
  const end = clientSource.indexOf('const statusRef = React.useRef(status)')
  const section = clientSource.slice(start, end)
  assert.ok(start > 0 && end > start)
  assert.ok(!section.includes('postMessage'))
  assert.ok(!section.includes("addEventListener('message'"))
  assert.ok(!section.includes('iframe'))
  assert.ok(!section.includes('window.location'))
  assert.ok(!section.includes('window.open'))
  assert.ok(!section.includes('innerHTML'))
  assert.ok(!section.includes('eval('))
})

// ---------------------------------------------------------------------------
// H2 validation matrix
// ---------------------------------------------------------------------------

test('H2 bad hosts are 400 bad-host with no store mutation', async () => {
  seed(SESSION_A, 2)
  for (const hostValue of [undefined, '', 'LOCALHOST:3099', 'local_host:3099', 'localhost:0',
    'localhost:65536', '256.1.1.1', '01.2.3.4', 'localhost:3099:123']) {
    const headers = baseHeaders()
    if (hostValue === undefined) delete headers.host
    else headers.host = hostValue
    const result = await restoreCall({ headers, body: bodyOf(fieldsFor(linearHistory(SESSION_A, 2))) })
    assertErrorShape(result, 400, 'bad-host')
    assert.equal(currentHistory().length, 2)
    assert.equal(host.stats().idempotencyEntries, 0)
  }
})

test('H2 host allowlist accepts localhost, strict IPv4, DNS and bracketed IPv6', () => {
  for (const value of ['localhost', 'localhost:3099', '127.0.0.1:3099', 'preview.example:8080',
    '[::1]', '[::1]:3099']) {
    assert.equal(host.validateHost(value), value.toLowerCase())
  }
})

test('H2 matching http/https origins and absent origins are accepted', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  for (const headers of [
    baseHeaders(SESSION_A, { origin: 'http://localhost:3099' }),
    baseHeaders(SESSION_A, { origin: 'https://localhost:3099' }),
    baseHeaders(SESSION_A, { 'sec-fetch-site': 'same-origin' }),
    baseHeaders(SESSION_A, { origin: 'http://localhost:3099', 'sec-fetch-site': 'same-origin' }),
  ]) {
    host.clearScene(SESSION_A)
    seed(SESSION_A, records)
    const result = await restoreCall({ headers, body: bodyOf(fieldsFor(records)) })
    assert.equal(result.response.status, 200, JSON.stringify(headers.origin ?? null))
    host.clearScene(SESSION_A)
  }
})

test('H2 cross/malformed origins and cross-site fetch metadata are 403 origin', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  const bodies = [
    { origin: 'http://evil.example' },
    { origin: 'http://localhost:3099/' },
    { origin: 'http://localhost:3099?x=1' },
    { origin: 'null' },
    { origin: 'not a url' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { origin: 'http://localhost:3099', 'sec-fetch-site': 'cross-site' },
  ]
  for (const extra of bodies) {
    const result = await restoreCall({ headers: baseHeaders(SESSION_A, extra), body: bodyOf(fieldsFor(records)) })
    assertErrorShape(result, 403, 'origin')
    assert.equal(currentHistory().length, 2)
  }
})

test('H2 content-type grammar accepts only JSON with optional UTF-8 charset', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  for (const value of ['application/json', 'Application/JSON', 'application/json;charset=utf-8',
    'application/json ; charset = "UTF-8"']) {
    host.clearScene(SESSION_A)
    seed(SESSION_A, records)
    const result = await restoreCall({
      headers: baseHeaders(SESSION_A, { 'content-type': value }),
      body: bodyOf(fieldsFor(records)),
    })
    assert.equal(result.response.status, 200)
  }
  for (const value of [undefined, '', 'text/plain', 'application/json; charset=iso-8859-1',
    'application/json; boundary=x', 'application/jsonx']) {
    const headers = baseHeaders()
    if (value === undefined) delete headers['content-type']
    else headers['content-type'] = value
    const result = await restoreCall({ headers, body: bodyOf(fieldsFor(records)) })
    assertErrorShape(result, 415, 'content-type')
  }
})

test('H2 any content-encoding including identity is 415 encoding', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  for (const value of ['identity', 'gzip', 'br', '']) {
    const result = await restoreCall({
      headers: baseHeaders(SESSION_A, { 'content-encoding': value }),
      body: bodyOf(fieldsFor(records)),
    })
    assertErrorShape(result, 415, 'encoding')
  }
})

test('H2 malformed and oversized Content-Length split 400 fields vs 413 too-large', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  for (const value of ['abc', '-1', '1.5', '4096x', '9999999999999999']) {
    const result = await restoreCall({
      headers: baseHeaders(SESSION_A, { 'content-length': value }),
      body: bodyOf(fieldsFor(records)),
    })
    assertErrorShape(result, 400, 'fields')
  }
  const tooLarge = await restoreCall({
    headers: baseHeaders(SESSION_A, { 'content-length': '4097' }),
    body: '',
  })
  assertErrorShape(tooLarge, 413, 'too-large')
  assert.equal(currentHistory().length, 2)
})

test('H2 exactly 4096 bytes is accepted and 4097 is 413 too-large', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  const base = bodyOf(fieldsFor(records))
  const exact = base + ' '.repeat(host.limits.maxBodyBytes - Buffer.byteLength(base))
  assert.equal(Buffer.byteLength(exact), 4096)
  const ok = await restoreCall({
    headers: baseHeaders(SESSION_A, { 'content-length': '4096' }),
    body: exact,
  })
  assert.equal(ok.response.status, 200)
  host.clearScene(SESSION_A)
  seed(SESSION_A, records)
  const over = base + ' '.repeat(host.limits.maxBodyBytes - Buffer.byteLength(base) + 1)
  const tooLarge = await restoreCall({ body: over })
  assertErrorShape(tooLarge, 413, 'too-large')
  assert.equal(currentHistory().length, 2)
  assert.equal(host.stats().idempotencyEntries, 0)
})

test('H2 declared length mismatch is 400 fields and releases its slot', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  const body = bodyOf(fieldsFor(records))
  const result = await restoreCall({
    headers: baseHeaders(SESSION_A, { 'content-length': String(Buffer.byteLength(body) + 1) }),
    body,
  })
  assertErrorShape(result, 400, 'fields')
  const stats = host.stats()
  assert.equal(stats.globalActive, 0)
  assert.equal(stats.globalTimes, 1)
})

test('H2 idle timeout is 408 timeout and releases the reservation', async () => {
  seed(SESSION_A, 2)
  const req = new Readable({ read () {} })
  req.method = 'POST'
  req.url = RESTORE_PATH
  req.headers = baseHeaders(SESSION_A)
  const result = await invokeRaw(host.restoreHandler, req, {
    now: () => 1000,
    bodyIdleTimeoutMs: 10,
    bodyTotalTimeoutMs: 100,
  })
  const parsed = JSON.parse(result.body)
  assert.equal(result.status, 408)
  assert.deepEqual(parsed, { ok: false, code: 'timeout' })
  assert.equal(host.stats().globalActive, 0)
  const records = linearHistory(SESSION_A, 2)
  const next = await successCall(SESSION_A, records)
  assert.equal(next.response.status, 200)
})

test('H2 total timeout is 408 timeout even while the idle timer is larger', async () => {
  seed(SESSION_A, 2)
  const req = new Readable({ read () {} })
  req.method = 'POST'
  req.url = RESTORE_PATH
  req.headers = baseHeaders(SESSION_A)
  const result = await invokeRaw(host.restoreHandler, req, {
    now: () => 1000,
    bodyIdleTimeoutMs: 5000,
    bodyTotalTimeoutMs: 10,
  })
  assert.equal(result.status, 408)
  assert.deepEqual(JSON.parse(result.body), { ok: false, code: 'timeout' })
  assert.equal(host.stats().globalActive, 0)
})

test('H2 invalid JSON, arrays and null are 400 fields', async () => {
  seed(SESSION_A, 2)
  for (const body of ['{', '[]', 'null', '"x"', '42', 'true']) {
    const result = await restoreCall({ body })
    assertErrorShape(result, 400, 'fields')
  }
  assert.equal(currentHistory().length, 2)
})

test('H2 JSON nesting deeper than the shared limit is 400 fields', async () => {
  seed(SESSION_A, 2)
  const deep = '['.repeat(70) + ']'.repeat(70)
  const result = await restoreCall({ body: deep })
  assertErrorShape(result, 400, 'fields')
})

const fieldFailureCases = [
  ['sourceRevision zero', { sourceRevision: 0 }],
  ['sourceRevision negative', { sourceRevision: -1 }],
  ['sourceRevision float', { sourceRevision: 1.5 }],
  ['sourceRevision string', { sourceRevision: '1' }],
  ['sourceRevision null', { sourceRevision: null }],
  ['sourceRevision unsafe', { sourceRevision: Number.MAX_SAFE_INTEGER + 1 }],
  ['sourceUpdatedAt negative', { sourceUpdatedAt: -1 }],
  ['sourceUpdatedAt float', { sourceUpdatedAt: 1.5 }],
  ['sourceUpdatedAt string', { sourceUpdatedAt: '1001' }],
  ['sourceUpdatedAt null', { sourceUpdatedAt: null }],
  ['sourceUpdatedAt unsafe', { sourceUpdatedAt: Number.MAX_SAFE_INTEGER + 1 }],
  ['expectedRevision negative', { expectedRevision: -1 }],
  ['expectedRevision float', { expectedRevision: 1.5 }],
  ['expectedRevision string', { expectedRevision: '2' }],
  ['expectedRevision null', { expectedRevision: null }],
  ['expectedRevision unsafe', { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }],
  ['expectedUpdatedAt negative', { expectedUpdatedAt: -1 }],
  ['expectedUpdatedAt float', { expectedUpdatedAt: 1.5 }],
  ['expectedUpdatedAt string', { expectedUpdatedAt: '1002' }],
  ['expectedUpdatedAt null', { expectedUpdatedAt: null }],
  ['expectedUpdatedAt unsafe', { expectedUpdatedAt: Number.MAX_SAFE_INTEGER + 1 }],
  ['requestId empty', { requestId: '' }],
  ['requestId short', { requestId: 'A'.repeat(21) }],
  ['requestId long', { requestId: 'A'.repeat(23) }],
  ['requestId invalid char', { requestId: `${'A'.repeat(21)}!` }],
  ['requestId number', { requestId: 123 }],
  ['requestId null', { requestId: null }],
]

for (const [label, patch] of fieldFailureCases) {
  test(`H2 invalid field: ${label} -> 400 fields`, async () => {
    seed(SESSION_A, 2)
    const records = linearHistory(SESSION_A, 2)
    const result = await restoreCall({ body: bodyOf(fieldsFor(records, patch)) })
    assertErrorShape(result, 400, 'fields')
    assert.equal(currentHistory().length, 2)
    assert.equal(host.stats().idempotencyEntries, 0)
  })
}

for (const key of ['sourceRevision', 'sourceUpdatedAt', 'expectedRevision', 'expectedUpdatedAt', 'requestId']) {
  test(`H2 missing field: ${key} -> 400 fields`, async () => {
    seed(SESSION_A, 2)
    const records = linearHistory(SESSION_A, 2)
    const fields = fieldsFor(records)
    delete fields[key]
    const result = await restoreCall({ body: bodyOf(fields) })
    assertErrorShape(result, 400, 'fields')
  })
}

for (const key of ['code', 'title', 'sceneId', 'sessionId', 'session', 'extra']) {
  test(`H2 unknown field: ${key} -> 400 fields`, async () => {
    seed(SESSION_A, 2)
    const records = linearHistory(SESSION_A, 2)
    const result = await restoreCall({ body: bodyOf(fieldsFor(records, { [key]: 'x' })) })
    assertErrorShape(result, 400, 'fields')
    assert.equal(currentHistory().length, 2)
  })
}

test('H2 duplicate known field with a valid last value is accepted', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  const fields = fieldsFor(records)
  const raw = `{"sourceRevision":99,"sourceRevision":${String(fields.sourceRevision)},`
    + `"sourceUpdatedAt":${String(fields.sourceUpdatedAt)},"expectedRevision":${String(fields.expectedRevision)},`
    + `"expectedUpdatedAt":${String(fields.expectedUpdatedAt)},"requestId":"${fields.requestId}"}`
  const result = await restoreCall({ body: raw })
  assert.equal(result.response.status, 200)
  assert.equal(currentHistory().length, 3)
})

test('H2 duplicate known field with an invalid last value is 400 fields', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  const fields = fieldsFor(records)
  const raw = `{"sourceRevision":1,"sourceRevision":0,`
    + `"sourceUpdatedAt":${String(fields.sourceUpdatedAt)},"expectedRevision":${String(fields.expectedRevision)},`
    + `"expectedUpdatedAt":${String(fields.expectedUpdatedAt)},"requestId":"${fields.requestId}"}`
  const result = await restoreCall({ body: raw })
  assertErrorShape(result, 400, 'fields')
})

test('H2 duplicate unknown field still results in six keys and 400 fields', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  const fields = fieldsFor(records)
  const raw = `{"sourceRevision":${String(fields.sourceRevision)},"sourceUpdatedAt":${String(fields.sourceUpdatedAt)},`
    + `"expectedRevision":${String(fields.expectedRevision)},"expectedUpdatedAt":${String(fields.expectedUpdatedAt)},`
    + `"requestId":"${fields.requestId}","code":"x","code":"y"}`
  const result = await restoreCall({ body: raw })
  assertErrorShape(result, 400, 'fields')
})

test('H2 unknown Session is 404 session before body validation', async () => {
  seed(SESSION_B, 2)
  const result = await restoreCall({
    sessionId: SESSION_A,
    body: '{',
  })
  assertErrorShape(result, 404, 'session')
  assert.deepEqual(host.stats(), {
    rateSessions: 0, globalTimes: 0, globalActive: 0, idempotencySessions: 0, idempotencyEntries: 0,
  })
})

test('H2 source missing and source updatedAt mismatch are 404 source-revision', async () => {
  seed(SESSION_A, 3)
  const records = linearHistory(SESSION_A, 3)
  const missing = await restoreCall({ body: bodyOf(fieldsFor(records, { sourceRevision: 99 })) })
  assertErrorShape(missing, 404, 'source-revision')
  const stale = await restoreCall({ body: bodyOf(fieldsFor(records, { sourceUpdatedAt: 999 })) })
  assertErrorShape(stale, 404, 'source-revision')
  assert.equal(currentHistory().length, 3)
})

test('H2 source identity precedes head identity', async () => {
  seed(SESSION_A, 3)
  const records = linearHistory(SESSION_A, 3)
  const result = await restoreCall({
    body: bodyOf(fieldsFor(records, { sourceRevision: 99, expectedRevision: 99, expectedUpdatedAt: 1 })),
  })
  assertErrorShape(result, 404, 'source-revision')
})

test('H2 head revision and updatedAt mismatches are 409 conflict', async () => {
  seed(SESSION_A, 3)
  const records = linearHistory(SESSION_A, 3)
  const revision = await restoreCall({ body: bodyOf(fieldsFor(records, { expectedRevision: 2 })) })
  assertErrorShape(revision, 409, 'conflict')
  const timestamp = await restoreCall({ body: bodyOf(fieldsFor(records, { expectedUpdatedAt: 1 })) })
  assertErrorShape(timestamp, 409, 'conflict')
  assert.equal(currentHistory().length, 3)
})

test('H2 head identity precedes source-latest', async () => {
  seed(SESSION_A, 3)
  const records = linearHistory(SESSION_A, 3)
  const result = await restoreCall({
    body: bodyOf(fieldsFor(records, {
      sourceRevision: 3,
      sourceUpdatedAt: records[2].updatedAt,
      expectedRevision: 2,
    })),
  })
  assertErrorShape(result, 409, 'conflict')
})

test('H2 restoring the current head is 409 source-latest', async () => {
  seed(SESSION_A, 3)
  const records = linearHistory(SESSION_A, 3)
  const result = await restoreCall({
    body: bodyOf(fieldsFor(records, {
      sourceRevision: 3,
      sourceUpdatedAt: records[2].updatedAt,
    })),
  })
  assertErrorShape(result, 409, 'source-latest')
  assert.equal(currentHistory().length, 3)
})

test('H2 source code over 256 KiB is 409 too-large, not 413', async () => {
  const source = fixtureRecord(SESSION_A, 1, 1001, { code: 'a'.repeat(262145) })
  const head = fixtureRecord(SESSION_A, 2, 1002)
  seed(SESSION_A, [source, head])
  const result = await restoreCall({ body: bodyOf(fieldsFor([source, head])) })
  assertErrorShape(result, 409, 'too-large')
  assert.equal(currentHistory().length, 2)
})

test('H2 revision overflow is 500 internal with no append or cache', async () => {
  const source = fixtureRecord(SESSION_A, 1, 1001)
  const head = fixtureRecord(SESSION_A, Number.MAX_SAFE_INTEGER, 1002)
  seed(SESSION_A, [source, head])
  const result = await restoreCall({ body: bodyOf(fieldsFor([source, head])) })
  assertErrorShape(result, 500, 'internal')
  assert.equal(currentHistory().length, 2)
  assert.equal(host.stats().idempotencyEntries, 0)
})

test('H2 timestamp overflow is 500 internal with no append', async () => {
  const source = fixtureRecord(SESSION_A, 1, 1001)
  const head = fixtureRecord(SESSION_A, 2, Number.MAX_SAFE_INTEGER)
  seed(SESSION_A, [source, head])
  const result = await restoreCall({ body: bodyOf(fieldsFor([source, head])) })
  assertErrorShape(result, 500, 'internal')
  assert.equal(currentHistory().length, 2)
})

test('H2 malformed internal history is 500 internal', async () => {
  const source = fixtureRecord(SESSION_A, 1, 1001)
  const middle = fixtureRecord(SESSION_A, 2, 1002)
  const head = fixtureRecord(SESSION_A, 3, 1003)
  const malformedStores = [
    { history: { not: 'array' } },
    { history: [source, null] },
    { history: [source, middle, { ...head, sceneId: SESSION_B }] },
    { history: [source, { ...middle, title: 1 }, head] },
    { history: [source, { ...middle, code: null }, head] },
    { history: [source, { ...middle, revision: '2' }, head] },
    { history: [source, { ...middle, updatedAt: 1.5 }, head] },
  ]
  for (const [index, entry] of malformedStores.entries()) {
    host.seedSession(SESSION_A, entry.history)
    const result = await restoreCall({
      body: bodyOf(fieldsFor([source, head])),
      handlerOptions: { now: () => 1000 + index * 61000 },
    })
    assertErrorShape(result, 500, 'internal')
    assert.equal(host.stats().idempotencyEntries, 0)
  }
})

test('H2 invalid injected clocks are 500 internal before reservation', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  for (const clock of [() => NaN, () => -1, () => 1.5, () => { throw new Error('clock') }]) {
    const result = await restoreCall({
      body: bodyOf(fieldsFor(records)),
      handlerOptions: { now: clock },
    })
    assertErrorShape(result, 500, 'internal')
  }
  assert.deepEqual(host.stats(), {
    rateSessions: 0, globalTimes: 0, globalActive: 0, idempotencySessions: 0, idempotencyEntries: 0,
  })
})

test('H2 success returns exactly four body fields and no CORS/cookies', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  const result = await successCall(SESSION_A, records, { handlerOptions: { now: () => 5000 } })
  assert.equal(result.response.status, 200)
  assert.deepEqual(Object.keys(result.json), ['ok', 'revision', 'sourceRevision', 'updatedAt'])
  assert.deepEqual(result.json, { ok: true, revision: 3, sourceRevision: 1, updatedAt: 5000 })
  assert.equal(result.response.headers['access-control-allow-origin'], undefined)
  assert.equal(result.response.headers['set-cookie'], undefined)
  assert.equal(result.response.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(result.response.headers['content-length'], String(Buffer.byteLength(result.response.body)))
})

// ---------------------------------------------------------------------------
// H3 store semantics
// ---------------------------------------------------------------------------

const observedRoutes = recordingContext()
const prefixResource = observedRoutes.routes.find(route => route.kind === 'prefix' && route.path === ROUTE).resource
const thumbnailHandler = observedRoutes.routes.find(route => route.path === `${ROUTE}/thumbnail`).handler

async function sceneJson(sessionId, revision) {
  const suffix = revision === undefined ? '' : `?rev=${String(revision)}`
  const response = await prefixResource(new Request(
    `http://localhost:3099${ROUTE}/scene/${encodeURIComponent(sessionId)}${suffix}`,
  ))
  return { status: response.status, json: await response.json() }
}

async function stateJson(sessionId) {
  const response = await prefixResource(new Request(
    `http://localhost:3099${ROUTE}/state/${encodeURIComponent(sessionId)}`,
  ))
  return { status: response.status, json: await response.json() }
}

async function uploadThumbnail(sessionId, revision, marker) {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([marker])])
  return invoke(thumbnailHandler, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      revision,
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    }),
  })
}

test('H3 success appends head+1 with copied title/code/bytes and scene identity', async () => {
  const title = '  Untrimmed restore title  '
  const code = 'const a = 1\r\nconst b = 2\n\n'
  const source = fixtureRecord(SESSION_A, 1, 1001, { title, code, bytes: 999 })
  const head = fixtureRecord(SESSION_A, 2, 1002, { code: 'const latest = true\n' })
  seed(SESSION_A, [source, head])
  const result = await successCall(SESSION_A, [source, head], { handlerOptions: { now: () => 1000 } })
  assert.equal(result.response.status, 200)
  const stored = currentHistory()
  assert.equal(stored.length, 3)
  assert.deepEqual(stored[2], {
    sceneId: SESSION_A,
    revision: 3,
    title,
    code,
    bytes: Buffer.byteLength(code, 'utf8'),
    updatedAt: 1003,
  })
  assert.deepEqual(stored[0], source)
  assert.deepEqual(stored[1], head)
})

test('H3 updatedAt is max(now, head+1) for equal, backwards and forward clocks', async () => {
  for (const [now, expected] of [[100, 5001], [5000, 5001], [5001, 5001], [9000, 9000]]) {
    host.clearScene(SESSION_A)
    const source = fixtureRecord(SESSION_A, 1, 1001)
    const head = fixtureRecord(SESSION_A, 2, 5000)
    seed(SESSION_A, [source, head])
    const result = await successCall(SESSION_A, [source, head], { handlerOptions: { now: () => now } })
    assert.equal(result.response.status, 200)
    assert.equal(result.json.updatedAt, expected)
    assert.equal(currentHistory()[2].updatedAt, expected)
  }
})

test('H3 a non-source restore leaves every earlier revision byte-identical', async () => {
  const records = linearHistory(SESSION_A, 11, { codeFor: index => `const v${String(index)} = ${String(index)}\n` })
  seed(SESSION_A, records)
  const result = await successCall(SESSION_A, [records[1], records[10]], {
    handlerOptions: { now: () => 2000 },
  })
  assert.equal(result.response.status, 200)
  const stored = currentHistory()
  assert.equal(stored.length, 12)
  for (let index = 0; index < 11; index += 1) assert.deepEqual(stored[index], records[index])
  assert.equal(stored[11].revision, 12)
  assert.equal(stored[11].code, records[1].code)
  assert.equal(stored[11].title, records[1].title)
  assert.equal(stored[11].updatedAt, 2000)
})

test('H3 a full 12-revision append trims only the oldest and keeps 12', async () => {
  const records = linearHistory(SESSION_A, 12)
  seed(SESSION_A, records)
  const result = await successCall(SESSION_A, [records[0], records[11]], {
    handlerOptions: { now: () => 1000 },
  })
  assert.equal(result.response.status, 200)
  const stored = currentHistory()
  assert.equal(stored.length, 12)
  assert.deepEqual(stored.map(record => record.revision), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  assert.equal(stored[11].code, records[0].code)
})

test('H3 restoring the oldest of 12 succeeds even though its append trims the source', async () => {
  const records = linearHistory(SESSION_A, 12, { codeFor: index => `source-${String(index)}` })
  seed(SESSION_A, records)
  const result = await successCall(SESSION_A, [records[0], records[11]], {
    handlerOptions: { now: () => 3000 },
  })
  assert.equal(result.response.status, 200)
  assert.equal(result.json.revision, 13)
  assert.equal(result.json.sourceRevision, 1)
  const stored = currentHistory()
  assert.equal(stored.some(record => record.revision === 1), false)
  assert.equal(stored[11].code, records[0].code)
  assert.equal(stored[11].title, records[0].title)
})

test('H3 state and scene resources expose the new head without a Source refetch', async () => {
  const source = fixtureRecord(SESSION_A, 1, 1001, { code: 'restored', title: 'Restored source' })
  const head = fixtureRecord(SESSION_A, 2, 1002)
  seed(SESSION_A, [source, head])
  const result = await successCall(SESSION_A, [source, head], { handlerOptions: { now: () => 7000 } })
  assert.equal(result.response.status, 200)
  const scene = await sceneJson(SESSION_A)
  assert.equal(scene.status, 200)
  assert.equal(scene.json.revision, 3)
  assert.equal(scene.json.code, 'restored')
  assert.equal(scene.json.title, 'Restored source')
  assert.equal(scene.json.updatedAt, 7000)
  const state = await stateJson(SESSION_A)
  assert.equal(state.json.revision, 3)
  assert.equal(state.json.revisions.length, 3)
  assert.equal(state.json.revisions[2].revision, 3)
  const old = await sceneJson(SESSION_A, 1)
  assert.equal(old.status, 200)
  assert.equal(old.json.code, 'restored')
})

test('H3 restore does not copy an old revision thumbnail to the new head', async () => {
  seed(SESSION_A, 2)
  const upload = await uploadThumbnail(SESSION_A, 1, 7)
  assert.equal(upload.status, 200)
  const records = currentHistory()
  const result = await successCall(SESSION_A, [records[0], records[1]], { handlerOptions: { now: () => 4000 } })
  assert.equal(result.response.status, 200)
  const oldThumb = await prefixResource(new Request(
    `http://localhost:3099${ROUTE}/thumbnail/${encodeURIComponent(SESSION_A)}/1`,
  ))
  assert.equal(oldThumb.status, 200)
  const newThumb = await prefixResource(new Request(
    `http://localhost:3099${ROUTE}/thumbnail/${encodeURIComponent(SESSION_A)}/3`,
  ))
  assert.equal(newThumb.status, 404)
})

test('H3 the 17th Session evicts the LRU Session, its assets and restore state', async () => {
  const sessions = Array.from({ length: 16 }, (_, index) => `history-lru-${String(index)}`)
  const all = new Map()
  for (const sessionId of sessions) {
    const records = linearHistory(sessionId, 2)
    all.set(sessionId, records)
    seed(sessionId, records)
  }
  const victim = sessions[0]
  assetHost.store.put(victim, {
    name: 'victim.png', nameFold: 'victim.png', kind: 'image', mime: 'image/png',
    ext: 'png', bytes: 1, buffer: Buffer.from([1]),
  })
  const victimResult = await successCall(victim, all.get(victim), {
    fields: { requestId: REQUEST_A }, handlerOptions: { now: () => 1000 },
  })
  assert.equal(victimResult.response.status, 200)
  for (let index = 1; index < 16; index += 1) {
    const sessionId = sessions[index]
    const result = await successCall(sessionId, all.get(sessionId), {
      fields: { requestId: idFor(index) }, handlerOptions: { now: () => 1000 },
    })
    assert.equal(result.response.status, 200)
  }
  const seventeenth = 'history-lru-16'
  seed(seventeenth, 2)
  const current = currentHistory(sessions[1])
  const final = await successCall(sessions[1], [current[0], current[current.length - 1]], {
    fields: { requestId: idFor(99) }, handlerOptions: { now: () => 1001 },
  })
  assert.equal(final.response.status, 200)
  assert.equal(host.history(victim), null)
  assert.equal(host.history(seventeenth) === null, false)
  assert.equal(assetHost.store.stats().assets, 0)
  assert.deepEqual(assetHost.store.usage(victim), { count: 0, bytes: 0 })
  assert.equal(currentHistory(sessions[1]).length, 4)
  const stats = host.stats()
  assert.equal(stats.rateSessions, 15)
  assert.equal(stats.idempotencySessions, 15)
  assert.equal(stats.idempotencyEntries, 16)
  for (const sessionId of sessions.slice(1)) assert.notEqual(host.history(sessionId), null)
  const gone = await restoreCall({
    sessionId: victim,
    body: bodyOf(fieldsFor(all.get(victim))),
  })
  assertErrorShape(gone, 404, 'session')
})

test('H3 tool-style commits share the same 12-revision trim contract', () => {
  const start = indexSource.indexOf('function commitSceneRevision')
  const end = indexSource.indexOf('function storeThumbnail')
  const helper = indexSource.slice(start, end)
  assert.ok(helper.includes('revision: (head?.revision ?? 0) + 1'))
  assert.ok(helper.includes('bytes: input.bytes === undefined ? Buffer.byteLength(input.code, \'utf8\') : input.bytes'))
  assert.ok(!helper.includes('await'))
  assert.ok(!helper.includes('Date.now'))
})

// ---------------------------------------------------------------------------
// H4 idempotency
// ---------------------------------------------------------------------------

test('H4 sequential same-id replay appends once and returns the identical body', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  const first = await successCall(SESSION_A, records, { handlerOptions: { now: () => 1000 } })
  const second = await restoreCall({ body: bodyOf(fieldsFor(records)), handlerOptions: { now: () => 1001 } })
  assert.equal(first.response.status, 200)
  assert.equal(second.response.status, 200)
  assert.deepEqual(second.json, first.json)
  assert.equal(currentHistory().length, 3)
  assert.equal(currentHistory()[2].updatedAt, first.json.updatedAt)
  assert.equal(host.stats().idempotencyEntries, 1)
})

test('H4 replay still works after the source was trimmed and the head advanced', async () => {
  const records = linearHistory(SESSION_A, 12)
  seed(SESSION_A, records)
  const first = await successCall(SESSION_A, [records[0], records[11]], {
    handlerOptions: { now: () => 1000 },
  })
  assert.equal(first.response.status, 200)
  assert.equal(currentHistory().some(record => record.revision === 1), false)
  const replay = await restoreCall({
    body: bodyOf(fieldsFor(records)),
    handlerOptions: { now: () => 2000 },
  })
  assert.equal(replay.response.status, 200)
  assert.deepEqual(replay.json, first.json)
  assert.equal(currentHistory().length, 12)
})

test('H4 same id with a different fingerprint is 409 idempotency-conflict', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  await successCall(SESSION_A, records, { handlerOptions: { now: () => 1000 } })
  const conflict = await restoreCall({
    body: bodyOf(fieldsFor(records, { expectedRevision: 3, expectedUpdatedAt: 1000 })),
    handlerOptions: { now: () => 1001 },
  })
  assertErrorShape(conflict, 409, 'idempotency-conflict')
  assert.equal(currentHistory().length, 3)
})

test('H4 idempotency lookup precedes source/head validation', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  await successCall(SESSION_A, records, { handlerOptions: { now: () => 1000 } })
  const conflict = await restoreCall({
    body: bodyOf(fieldsFor(records, { sourceRevision: 99, sourceUpdatedAt: 1, expectedRevision: 99 })),
    handlerOptions: { now: () => 1001 },
  })
  assertErrorShape(conflict, 409, 'idempotency-conflict')
})

test('H4 failures are not cached and a corrected same-id request is re-evaluated', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  const failed = await restoreCall({
    body: bodyOf(fieldsFor(records, { expectedRevision: 1 })),
    handlerOptions: { now: () => 1000 },
  })
  assertErrorShape(failed, 409, 'conflict')
  assert.equal(host.stats().idempotencyEntries, 0)
  const corrected = await successCall(SESSION_A, records, { handlerOptions: { now: () => 1001 } })
  assert.equal(corrected.response.status, 200)
  assert.equal(corrected.json.revision, 3)
  assert.equal(currentHistory().length, 3)
})

test('H4 TTL is exactly 600000 ms and a replay never extends it', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  const first = await successCall(SESSION_A, records, { handlerOptions: { now: () => 1000 } })
  assert.equal(first.response.status, 200)
  const atBoundary = await restoreCall({
    body: bodyOf(fieldsFor(records)),
    handlerOptions: { now: () => 600999 },
  })
  assert.equal(atBoundary.response.status, 200)
  assert.deepEqual(atBoundary.json, first.json)
  const expired = await restoreCall({
    body: bodyOf(fieldsFor(records)),
    handlerOptions: { now: () => 601000 },
  })
  assertErrorShape(expired, 409, 'conflict')
  assert.equal(currentHistory().length, 3)
  assert.equal(host.stats().idempotencyEntries, 0)
})

test('H4 per-Session cache is an 8-entry LRU and the oldest entry is evicted', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  const originals = []
  for (let index = 0; index < 9; index += 1) {
    const historyRows = currentHistory()
    const head = historyRows[historyRows.length - 1]
    const fields = {
      sourceRevision: 1,
      sourceUpdatedAt: records[0].updatedAt,
      expectedRevision: head.revision,
      expectedUpdatedAt: head.updatedAt,
      requestId: idFor(index),
    }
    originals.push(fields)
    const result = await restoreCall({
      body: bodyOf(fields),
      handlerOptions: { now: () => 1000 + index * 61000 },
    })
    assert.equal(result.response.status, 200)
  }
  assert.equal(host.stats().idempotencyEntries, 8)
  const newest = await restoreCall({
    body: bodyOf(originals[8]),
    handlerOptions: { now: () => 1000 + 10 * 61000 },
  })
  assert.equal(newest.response.status, 200)
  const oldest = await restoreCall({
    body: bodyOf(originals[0]),
    handlerOptions: { now: () => 1000 + 11 * 61000 },
  })
  assertErrorShape(oldest, 409, 'conflict')
  assert.equal(host.stats().idempotencyEntries, 8)
})

test('H4 per-Session idempotency is isolated while the same id may exist in two Sessions', async () => {
  seed(SESSION_A, 2)
  seed(SESSION_B, 2)
  const a = linearHistory(SESSION_A, 2)
  const b = linearHistory(SESSION_B, 2)
  const first = await successCall(SESSION_A, a, { handlerOptions: { now: () => 1000 } })
  const second = await successCall(SESSION_B, b, {
    fields: { requestId: REQUEST_A }, handlerOptions: { now: () => 1000 },
  })
  assert.equal(first.response.status, 200)
  assert.equal(second.response.status, 200)
  assert.equal(first.json.updatedAt, second.json.updatedAt)
  assert.equal(currentHistory(SESSION_A).length, 3)
  assert.equal(currentHistory(SESSION_B).length, 3)
  assert.equal(host.stats().idempotencySessions, 2)
  assert.equal(host.stats().idempotencyEntries, 2)
})

test('H4 replay counts against the rate window and later becomes 429', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  const first = await successCall(SESSION_A, records, { handlerOptions: { now: () => 1000 } })
  assert.equal(first.response.status, 200)
  for (let index = 0; index < 5; index += 1) {
    const replay = await restoreCall({ body: bodyOf(fieldsFor(records)), handlerOptions: { now: () => 1001 } })
    assert.equal(replay.response.status, 200)
  }
  const limited = await restoreCall({ body: bodyOf(fieldsFor(records)), handlerOptions: { now: () => 1001 } })
  assertErrorShape(limited, 429, 'rate')
  assert.ok(Number(limited.response.headers['retry-after']) >= 1)
  const afterWindow = await restoreCall({ body: bodyOf(fieldsFor(records)), handlerOptions: { now: () => 61001 } })
  assert.equal(afterWindow.response.status, 200)
  assert.equal(currentHistory().length, 3)
})

test('H4 response has no request id, Session, title or code', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  const result = await successCall(SESSION_A, records, { handlerOptions: { now: () => 1000 } })
  const text = result.response.body
  assert.equal(text.includes(REQUEST_A), false)
  assert.equal(text.includes(SESSION_A), false)
  assert.equal(text.includes(records[0].title), false)
  assert.equal(text.includes(records[0].code), false)
  assert.deepEqual(Object.keys(result.json).sort(), ['ok', 'revision', 'sourceRevision', 'updatedAt'])
})

test('H4 clearScene removes the idempotency cache and the next identical request re-executes', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  const first = await successCall(SESSION_A, records, { handlerOptions: { now: () => 1000 } })
  assert.equal(first.json.updatedAt, 1003)
  host.clearScene(SESSION_A)
  assert.equal(host.history(SESSION_A), null)
  assert.equal(host.stats().idempotencyEntries, 0)
  host.seedSession(SESSION_A, records)
  const fresh = await successCall(SESSION_A, records, { handlerOptions: { now: () => 2000 } })
  assert.equal(fresh.response.status, 200)
  assert.equal(fresh.json.revision, 3)
  assert.equal(fresh.json.updatedAt, 2000)
  assert.equal(currentHistory().length, 3)
})

test('H4 resetScenes and reset both clear transient restore state', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  await successCall(SESSION_A, records, { handlerOptions: { now: () => 1000 } })
  assert.equal(host.stats().idempotencyEntries, 1)
  host.resetScenes()
  assert.equal(host.history(SESSION_A), null)
  assert.equal(host.stats().idempotencyEntries, 0)
  seed(SESSION_A, 2)
  await successCall(SESSION_A, currentHistory(), { handlerOptions: { now: () => 1000 } })
  host.reset()
  assert.equal(host.history(SESSION_A), null)
  assert.deepEqual(host.stats(), {
    rateSessions: 0, globalTimes: 0, globalActive: 0, idempotencySessions: 0, idempotencyEntries: 0,
  })
})

test('H4 after reset the restore route sees no Session', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  host.reset()
  const result = await restoreCall({ body: bodyOf(fieldsFor(records)) })
  assertErrorShape(result, 404, 'session')
})

// ---------------------------------------------------------------------------
// H5 rates, limits and concurrency
// ---------------------------------------------------------------------------

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function hangingRestore(sessionId, options = {}) {
  const req = new PassThrough()
  req.method = 'POST'
  req.url = RESTORE_PATH
  req.headers = Object.fromEntries(Object.entries(baseHeaders(sessionId)).map(([key, value]) => [key.toLowerCase(), value]))
  const response = new Promise(resolve => {
    const res = fakeResponse(resolve)
    void host.restoreHandler(req, res, {
      now: () => 1000,
      bodyIdleTimeoutMs: 60,
      bodyTotalTimeoutMs: 2000,
      ...options.handlerOptions,
    })
  })
  return { req, response }
}

async function resultOf(response) {
  const raw = await response
  let json = null
  try { json = JSON.parse(raw.body) } catch (error) { void error }
  return { response: raw, json }
}

test('H5 Session rate is exactly 6/min with retry-after and a 60 s prune boundary', async () => {
  seed(SESSION_A, 2)
  for (let index = 0; index < 6; index += 1) {
    const result = await restoreCall({
      body: '{}', handlerOptions: { now: () => 1000 },
    })
    assertErrorShape(result, 400, 'fields')
  }
  const limited = await restoreCall({ body: '{}', handlerOptions: { now: () => 60999 } })
  assertErrorShape(limited, 429, 'rate')
  assert.equal(limited.response.headers['retry-after'], '1')
  const atBoundary = await restoreCall({ body: '{}', handlerOptions: { now: () => 61000 } })
  assertErrorShape(atBoundary, 400, 'fields')
  assert.equal(host.stats().globalActive, 0)
})

test('H5 global rate is exactly 30/min and a blocked new Session key is deleted', async () => {
  const sessions = Array.from({ length: 30 }, (_, index) => `history-global-${String(index)}`)
  for (const sessionId of sessions) seed(sessionId, 2)
  seed(SESSION_C, 2)
  for (const sessionId of sessions) {
    const result = await restoreCall({
      sessionId, body: '{}', handlerOptions: { now: () => 1000 },
    })
    assertErrorShape(result, 400, 'fields')
  }
  assert.equal(host.stats().globalTimes, 30)
  const limited = await restoreCall({
    sessionId: SESSION_C, body: '{}', handlerOptions: { now: () => 1000 },
  })
  assertErrorShape(limited, 429, 'rate')
  assert.equal(limited.response.headers['retry-after'], '60')
  assert.equal(host.stats().rateSessions, 30)
  const after = await restoreCall({
    sessionId: SESSION_C, body: '{}', handlerOptions: { now: () => 61000 },
  })
  assertErrorShape(after, 400, 'fields')
})

test('H5 a hanging body holds one Session slot and the second request is 429 rate', async () => {
  const records = seed(SESSION_A, 2)
  const hanging = hangingRestore(SESSION_A)
  assert.equal(host.stats().globalActive, 1)
  const overlap = await restoreCall({
    body: bodyOf(fieldsFor(records)), handlerOptions: { now: () => 1000 },
  })
  assertErrorShape(overlap, 429, 'rate')
  assert.equal(host.stats().idempotencyEntries, 0)
  const first = await resultOf(hanging.response)
  assertErrorShape(first, 408, 'timeout')
  assert.equal(host.stats().globalActive, 0)
  assert.equal(currentHistory().length, 2)
  const retry = await successCall(SESSION_A, records, { handlerOptions: { now: () => 61000 } })
  assert.equal(retry.response.status, 200)
})

test('H5 two Sessions proceed under global concurrency 2 and a third is 429 rate', async () => {
  const a = seed(SESSION_A, 2)
  seed(SESSION_B, 2)
  const c = seed(SESSION_C, 2)
  const first = hangingRestore(SESSION_A)
  const second = hangingRestore(SESSION_B)
  assert.equal(host.stats().globalActive, 2)
  const third = await restoreCall({
    sessionId: SESSION_C, body: bodyOf(fieldsFor(c)), handlerOptions: { now: () => 1000 },
  })
  assertErrorShape(third, 429, 'rate')
  const firstResult = await resultOf(first.response)
  const secondResult = await resultOf(second.response)
  assertErrorShape(firstResult, 408, 'timeout')
  assertErrorShape(secondResult, 408, 'timeout')
  assert.equal(host.stats().globalActive, 0)
  const retryA = await successCall(SESSION_A, a, { handlerOptions: { now: () => 61000 } })
  const retryB = await restoreCall({
    sessionId: SESSION_B, body: '{}', handlerOptions: { now: () => 61001 },
  })
  assert.equal(retryA.response.status, 200)
  assertErrorShape(retryB, 400, 'fields')
  const retryC = await successCall(SESSION_C, c, { handlerOptions: { now: () => 61002 } })
  assert.equal(retryC.response.status, 200)
})

test('H5 body 413, timeout, 400, 404, 409 and 200 paths all release the slot', async () => {
  const records = seed(SESSION_A, 2)
  const cases = []
  cases.push(await restoreCall({
    body: Buffer.alloc(4097, 0x20), handlerOptions: { now: () => 1000 },
  }))
  const timed = hangingRestore(SESSION_A, { handlerOptions: { now: () => 61000 } })
  cases.push(await resultOf(timed.response))
  cases.push(await restoreCall({ body: '{', handlerOptions: { now: () => 122000 } }))
  cases.push(await restoreCall({
    body: bodyOf(fieldsFor(records, { sourceRevision: 9 })), handlerOptions: { now: () => 183000 },
  }))
  cases.push(await restoreCall({
    body: bodyOf(fieldsFor(records, { expectedRevision: 1 })), handlerOptions: { now: () => 244000 },
  }))
  cases.push(await restoreCall({
    body: bodyOf(fieldsFor(records)), handlerOptions: { now: () => 305000 },
  }))
  assertErrorShape(cases[0], 413, 'too-large')
  assertErrorShape(cases[1], 408, 'timeout')
  assertErrorShape(cases[2], 400, 'fields')
  assertErrorShape(cases[3], 404, 'source-revision')
  assertErrorShape(cases[4], 409, 'conflict')
  assert.equal(cases[5].response.status, 200)
  assert.equal(host.stats().globalActive, 0)
  const after = await restoreCall({ body: '{}', handlerOptions: { now: () => 366000 } })
  assertErrorShape(after, 400, 'fields')
})

test('H5 an exhausted Session does not starve another Session or the global limiter', async () => {
  seed(SESSION_A, 2)
  seed(SESSION_B, 2)
  for (let index = 0; index < 6; index += 1) {
    await restoreCall({ body: '{}', handlerOptions: { now: () => 1000 } })
  }
  const limitedA = await restoreCall({ body: '{}', handlerOptions: { now: () => 1000 } })
  assertErrorShape(limitedA, 429, 'rate')
  const b = await restoreCall({ sessionId: SESSION_B, body: '{}', handlerOptions: { now: () => 1000 } })
  assertErrorShape(b, 400, 'fields')
  assert.equal(host.stats().globalTimes, 7)
})

// ---------------------------------------------------------------------------
// H6 restart, reseed and client confirmation
// ---------------------------------------------------------------------------

test('H6 reseeding after reset never copies the old scene and uses fresh identity', async () => {
  const original = seed(SESSION_A, 2)
  const success = await successCall(SESSION_A, original, { handlerOptions: { now: () => 1000 } })
  assert.equal(success.response.status, 200)
  host.resetScenes()
  seed(SESSION_A, [
    fixtureRecord(SESSION_A, 1, 9001),
    fixtureRecord(SESSION_A, 2, 9002),
  ])
  const staleSource = await restoreCall({
    body: bodyOf(fieldsFor(original)), handlerOptions: { now: () => 2000 },
  })
  assertErrorShape(staleSource, 404, 'source-revision')
  const staleHead = await restoreCall({
    body: bodyOf(fieldsFor(original, {
      sourceUpdatedAt: 9001,
    })), handlerOptions: { now: () => 2001 },
  })
  assertErrorShape(staleHead, 409, 'conflict')
  assert.equal(currentHistory().length, 2)
  assert.equal(host.stats().idempotencyEntries, 0)
  const current = currentHistory()
  const fresh = await successCall(SESSION_A, current, {
    fields: { requestId: REQUEST_B }, handlerOptions: { now: () => 2002 },
  })
  assert.equal(fresh.response.status, 200)
  assert.equal(fresh.json.updatedAt, 9003)
  assert.equal(currentHistory().length, 3)
})

test('H6 reset, resetScenes and clearScene each clear restore counters and cache', async () => {
  seed(SESSION_A, 2)
  const records = linearHistory(SESSION_A, 2)
  await successCall(SESSION_A, records, { handlerOptions: { now: () => 1000 } })
  assert.notEqual(host.stats().idempotencyEntries, 0)
  host.clearScene(SESSION_A)
  const afterClear = host.stats()
  assert.equal(afterClear.rateSessions, 0)
  assert.equal(afterClear.globalActive, 0)
  assert.equal(afterClear.idempotencySessions, 0)
  assert.equal(afterClear.idempotencyEntries, 0)
  seed(SESSION_A, 2)
  await successCall(SESSION_A, currentHistory(), { handlerOptions: { now: () => 2000 } })
  host.resetScenes()
  assert.equal(host.stats().idempotencyEntries, 0)
  seed(SESSION_A, 2)
  await successCall(SESSION_A, currentHistory(), { handlerOptions: { now: () => 3000 } })
  host.reset()
  assert.equal(host.history(SESSION_A), null)
  assert.equal(host.stats().rateSessions, 0)
  assert.equal(host.stats().globalTimes, 0)
  assert.equal(host.stats().idempotencySessions, 0)
})

test('H6 pending confirmation rejects lower/stale/mismatched feeds as awaiting', () => {
  const pending = { revision: 5, returnedUpdatedAt: 900, sourceRevision: 2, token: 1, stalled: false }
  const record = {
    sceneId: SESSION_A, revision: 5, updatedAt: 900, title: 't', code: 'c',
  }
  const revisions = [
    { revision: 4, updatedAt: 800 },
    { revision: 5, updatedAt: 900 },
  ]
  const base = { pending, sessionId: SESSION_A, record, revisions, latestRevision: 5, missing: false }
  assert.equal(history.restorePendingOutcome(base), 'confirmed')
  assert.equal(history.restorePendingOutcome({ ...base, latestRevision: 4 }), 'awaiting')
  assert.equal(history.restorePendingOutcome({
    ...base, revisions: [{ revision: 5, updatedAt: 901 }],
  }), 'awaiting')
  assert.equal(history.restorePendingOutcome({
    ...base, record: { ...record, updatedAt: 901 },
  }), 'awaiting')
  assert.equal(history.restorePendingOutcome({
    ...base, record: { ...record, sceneId: 'demo' },
  }), 'awaiting')
  assert.equal(history.restorePendingOutcome({ ...base, missing: true }), 'missing')
  assert.equal(history.restorePendingOutcome({ ...base, latestRevision: 6 }), 'superseded')
})

test('H6 record-ready requires exact non-demo identity, title and code', () => {
  const pending = { revision: 5, returnedUpdatedAt: 900, sourceRevision: 2, token: 1, stalled: false }
  const record = {
    sceneId: SESSION_A, revision: 5, updatedAt: 900, title: 'title', code: 'code',
  }
  assert.equal(history.restoreRecordReady(SESSION_A, record, pending), true)
  for (const broken of [
    null,
    { ...record, sceneId: 'demo' },
    { ...record, sceneId: SESSION_A.toUpperCase() },
    { ...record, revision: 4 },
    { ...record, updatedAt: 901 },
    { ...record, title: null },
    { ...record, code: undefined },
  ]) {
    assert.equal(history.restoreRecordReady(SESSION_A, broken, pending), false)
  }
  assert.equal(history.restoreRecordReady(undefined, record, pending), false)
  assert.equal(history.restoreRecordReady(SESSION_A, record, null), false)
})

test('H6 stalled is terminal and terminalRestore clears the pin once', () => {
  const start = clientSource.indexOf('const terminalRestore =')
  const end = clientSource.indexOf('const startRestore =')
  const terminal = clientSource.slice(start, end)
  assert.equal((terminal.match(/setViewRevision\(undefined\)/g) ?? []).length, 1)
  assert.ok(terminal.includes("if (outcome !== 'missing' && pending.stalled === true) return"))
  assert.ok(terminal.includes("restoreNoticeRef.current = 'session-gone:'"))
  assert.ok(terminal.includes("restoreNoticeRef.current = 'superseded:'"))
  assert.ok(terminal.includes("restoreNoticeRef.current = 'done:'"))
  const stall = clientSource.slice(
    clientSource.indexOf('const stallRestore ='),
    clientSource.indexOf('const scheduleRestoreConfirmation ='),
  )
  assert.ok(stall.includes('if (pending === null || pending.stalled === true) return'))
  assert.ok(stall.includes('stalled: true'))
  assert.ok(stall.includes('retry.timers = []'))
  assert.equal((stall.match(/setRestorePendingState/g) ?? []).length, 1)
})

test('H6 the confirmation effect ignores a previous Session and stalled state', () => {
  const start = clientSource.indexOf('// Pending confirmation.')
  const end = clientSource.indexOf('// Session switch discards')
  const effect = clientSource.slice(start, end)
  const stalledGuard = effect.indexOf('pending === null || pending.stalled === true')
  const sessionGuard = effect.indexOf('restoreSessionRef.current !== sessionId')
  const evaluate = effect.indexOf('restorePendingOutcome(')
  assert.ok(stalledGuard >= 0 && sessionGuard > stalledGuard && evaluate > sessionGuard)
  assert.ok(effect.includes("if (outcome === 'missing')"))
  assert.ok(effect.includes("if (outcome === 'superseded')"))
  assert.ok(effect.includes("if (outcome === 'confirmed')"))
})

test('H6 the restore section performs no disk or storage write and no source echo', () => {
  const start = indexSource.indexOf('function restoreHandler')
  const end = indexSource.indexOf('async function shareCreateHandler')
  const section = indexSource.slice(start, end)
  for (const forbidden of ['writeFile', 'appendFile', 'createWriteStream', 'localStorage', 'sessionStorage',
    'textResponse', 'res.end(source']) {
    assert.equal(section.includes(forbidden), false, forbidden)
  }
  assert.equal((section.match(/sendRestoreJson\(res, 200/g) ?? []).length, 2)
})

// ---------------------------------------------------------------------------
// H7 diff normalization, display caps and response caps
// ---------------------------------------------------------------------------

const TextEncoderImpl = TextEncoder

function cappedResponse(text, chunkSize = 65536) {
  const bytes = new TextEncoderImpl().encode(text)
  if (chunkSize === null) {
    return { body: null, text: async () => text }
  }
  let offset = 0
  return {
    body: {
      getReader() {
        return {
          async read() {
            if (offset >= bytes.byteLength) return { done: true, value: undefined }
            const end = Math.min(bytes.byteLength, offset + chunkSize)
            const value = bytes.slice(offset, end)
            offset = end
            return { done: false, value }
          },
          async cancel() {},
          releaseLock() {},
        }
      },
    },
    text: async () => text,
  }
}

test('H7 splitDiffLines normalizes empty, final newline, CRLF and lone CR', () => {
  assert.deepEqual(history.splitDiffLines(''), [])
  assert.deepEqual(history.splitDiffLines('\n'), [''])
  assert.deepEqual(history.splitDiffLines('a'), ['a'])
  assert.deepEqual(history.splitDiffLines('a\n'), ['a'])
  assert.deepEqual(history.splitDiffLines('a\n\n'), ['a', ''])
  assert.deepEqual(history.splitDiffLines('a\r\nb'), ['a', 'b'])
  assert.deepEqual(history.splitDiffLines('a\rb\r\nc'), ['a', 'b', 'c'])
  assert.deepEqual(history.splitDiffLines('a\n\n\n'), ['a', '', ''])
  assert.deepEqual(history.splitDiffLines('a\r\n'), ['a'])
  assert.deepEqual(history.splitDiffLines(undefined), [])
  assert.deepEqual(history.splitDiffLines(42), [])
})

test('H7 empty/one-line permutations and identical detection are exact', () => {
  const emptyEmpty = history.buildRevisionDiff('', '')
  assert.equal(emptyEmpty.ok, true)
  assert.equal(emptyEmpty.identical, true)
  assert.deepEqual(emptyEmpty.rows, [])
  assert.deepEqual(emptyEmpty.stats, { added: 0, removed: 0, unchanged: 0, changedRows: 0 })
  const emptyOne = history.buildRevisionDiff('', 'a')
  assert.equal(emptyOne.identical, false)
  assert.deepEqual(emptyOne.rows.map(row => row.kind), ['added'])
  assert.deepEqual(emptyOne.stats, { added: 1, removed: 0, unchanged: 0, changedRows: 0 })
  const oneEmpty = history.buildRevisionDiff('a', '')
  assert.deepEqual(oneEmpty.rows.map(row => row.kind), ['removed'])
  const newlineEmpty = history.buildRevisionDiff('\n', '')
  assert.deepEqual(newlineEmpty.rows.map(row => row.kind), ['removed'])
  assert.equal(history.buildRevisionDiff('a\n', 'a').identical, true)
  assert.equal(history.buildRevisionDiff('a\r\n', 'a').identical, true)
  assert.equal(history.buildRevisionDiff('a\rb', 'a\nb').identical, true)
  const doubleNewline = history.buildRevisionDiff('a\n\n', 'a\n')
  assert.equal(doubleNewline.identical, false)
  assert.deepEqual(doubleNewline.rows.map(row => row.kind), ['equal', 'removed'])
})

test('H7 tabs, case, NFC/NFD, astral and lone surrogates compare exactly', () => {
  assert.equal(history.buildRevisionDiff('\ta', '    a').identical, false)
  assert.equal(history.buildRevisionDiff('A', 'a').identical, false)
  assert.equal(history.buildRevisionDiff('é', 'é').identical, false)
  assert.equal(history.buildRevisionDiff('\u{1f600}', '\u{1f600}').identical, true)
  assert.equal(history.buildRevisionDiff('\u{1f600}', '\u{1f601}').identical, false)
  assert.equal(history.buildRevisionDiff('\ud800', '\ud800').identical, true)
  assert.equal(history.buildRevisionDiff('\ud800', '\ud801').identical, false)
  assert.equal(history.buildRevisionDiff('\ud800', '�').identical, false)
})

test('H7 4001 lines and 262145 UTF-8 bytes are too large while exact caps pass', () => {
  assert.deepEqual(history.buildRevisionDiff('x\n'.repeat(4001), 'x'), { ok: false, reason: 'too-large' })
  assert.deepEqual(history.buildRevisionDiff('x', 'x\n'.repeat(4001)), { ok: false, reason: 'too-large' })
  const justOverBytes = `${'a'.repeat(262143)}é`
  assert.equal(new TextEncoderImpl().encode(justOverBytes).byteLength, 262145)
  assert.deepEqual(history.buildRevisionDiff(justOverBytes, ''), { ok: false, reason: 'too-large' })
  assert.deepEqual(history.buildRevisionDiff('', justOverBytes), { ok: false, reason: 'too-large' })
  const exactBytes = 'a'.repeat(262144)
  assert.equal(history.buildRevisionDiff(exactBytes, '').ok, true)
  const fourThousandLines = Array.from({ length: 4000 }, (_, index) => `line-${String(index)}`).join('\n')
  assert.equal(history.buildRevisionDiff(fourThousandLines, 'one').ok, true)
})

test('H7 the 4000-line, 16,008,001-cell exact maximum is accepted', () => {
  const source = Array.from({ length: 4000 }, (_, index) => `old-${String(index)}`).join('\n')
  const latest = Array.from({ length: 4000 }, (_, index) => `new-${String(index)}`).join('\n')
  const start = Date.now()
  const result = history.buildRevisionDiff(source, latest)
  const elapsed = Date.now() - start
  assert.equal(result.ok, true)
  assert.equal(result.sourceLines, 4000)
  assert.equal(result.latestLines, 4000)
  assert.equal(result.stats.changedRows, 4000)
  assert.equal(result.rows.length, 4000)
  assert.ok(elapsed < 30000, `exact cap took ${String(elapsed)} ms`)
})

test('H7 buildRevisionDiff never mutates the caller strings', () => {
  const source = 'a\r\nb\n'
  const latest = 'a\nc\n'
  const before = [source, latest]
  history.buildRevisionDiff(source, latest)
  assert.deepEqual([source, latest], before)
  assert.equal(source, 'a\r\nb\n')
  assert.equal(latest, 'a\nc\n')
})

test('H7 displayTitle caps at 200 code points without splitting astral pairs', () => {
  assert.equal(history.displayTitle(''), '')
  assert.equal(history.displayTitle(undefined), '')
  assert.equal(history.displayTitle('a'.repeat(200)), 'a'.repeat(200))
  const capped = history.displayTitle('a'.repeat(201))
  assert.equal(Array.from(capped).length, 201)
  assert.equal(capped, `${'a'.repeat(200)}…`)
  const astral = history.displayTitle('\u{1f600}'.repeat(201))
  assert.equal(Array.from(astral).length, 201)
  assert.equal(astral.endsWith('…'), true)
  assert.equal(astral.startsWith('\u{1f600}'.repeat(200)), true)
  assert.equal(astral.isWellFormed?.() ?? true, true)
  const stored = `${'x'.repeat(250)}\u{1f600}`
  assert.equal(history.displayTitle(stored).endsWith('…'), true)
  assert.equal(stored.length, 252)
})

test('H7 diff header renders both title identities through displayTitle as text', () => {
  const overlayStart = clientSource.indexOf('const diffOverlay = diffDialog === null')
  const overlayEnd = clientSource.indexOf('const codeBar =', overlayStart)
  assert.ok(overlayStart >= 0 && overlayEnd > overlayStart)
  const overlay = clientSource.slice(overlayStart, overlayEnd)
  assert.ok(overlay.includes("'data-wb-diff-title': 'source'"))
  assert.ok(overlay.includes("'data-wb-diff-title': 'latest'"))
  assert.ok(overlay.includes('displayTitle(dialog.sourceTitle)'))
  assert.ok(overlay.includes('displayTitle(dialog.latestTitle)'))
  assert.ok(overlay.includes("t('editor.diffSubtitle'"))
  assert.equal(overlay.includes('innerHTML'), false)
  assert.equal(overlay.includes('dangerouslySetInnerHTML'), false)
  assert.equal(overlay.includes('http://'), false)
  assert.equal(overlay.includes('https://'), false)
})

test('H7 readCappedResponseText accepts exactly 2 MiB and rejects 2 MiB+1', async () => {
  const exact = 'a'.repeat(2 * 1024 * 1024)
  assert.equal((await history.readCappedResponseText(cappedResponse(exact), 2 * 1024 * 1024, null)).length, exact.length)
  await assert.rejects(
    history.readCappedResponseText(cappedResponse(`${exact}a`), 2 * 1024 * 1024, null),
    error => error.code === 'cap',
  )
  assert.equal((await history.readCappedResponseText(
    cappedResponse(exact, null), 2 * 1024 * 1024, null,
  )).length, exact.length)
  await assert.rejects(
    history.readCappedResponseText(cappedResponse(`${exact}a`, null), 2 * 1024 * 1024, null),
    error => error.code === 'cap',
  )
  await assert.rejects(
    history.readCappedResponseText(null, 10, null),
    error => error.code === 'unreadable',
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    history.readCappedResponseText(cappedResponse('x'), 10, controller.signal),
    error => error.code === 'aborted',
  )
})

test('H7 capped response failure maps to diffResponseTooLarge, not diffLoadFailed', () => {
  const fetchSide = clientSource.slice(
    clientSource.indexOf('async function fetchDiffSide'),
    clientSource.indexOf('async function loadDiffPair'),
  )
  assert.ok(fetchSide.includes("if (code === 'cap') return { ok: false, reason: 'response-too-large' }"))
  assert.ok(fetchSide.includes('readCappedResponseText(response, DIFF_MAX_RESPONSE_BYTES, signal)'))
  const load = clientSource.slice(
    clientSource.indexOf('async function loadDiffPair'),
    clientSource.indexOf('// Compute once after the loading frame'),
  )
  assert.ok(load.includes("fail('response-too-large'"))
  const ui = clientSource.slice(
    clientSource.indexOf('const diffStateMessage ='),
    clientSource.indexOf('const diffTable ='),
  )
  assert.ok(ui.includes("dialog.phase === 'response-too-large'"))
  assert.ok(ui.includes("t('editor.diffResponseTooLarge')"))
  assert.ok(ui.includes("t('editor.diffLoadFailed')"))
})

// ---------------------------------------------------------------------------
// H8 diff algorithm
// ---------------------------------------------------------------------------

function reconstructSource(result) {
  return result.rows.filter(row => row.sourceText !== null)
    .map(row => row.sourceText).join('\n')
}

function reconstructLatest(result) {
  return result.rows.filter(row => row.latestText !== null)
    .map(row => row.latestText).join('\n')
}

test('H8 changed-row pairing and leftover one-sided rows use 1-based numbers', () => {
  const result = history.buildRevisionDiff('keep\na\nb\nc', 'keep\nx\ny')
  assert.equal(result.ok, true)
  assert.deepEqual(result.rows.map(row => row.kind), ['equal', 'changed', 'changed', 'removed'])
  assert.deepEqual(result.rows[0], {
    kind: 'equal', sourceLine: 1, latestLine: 1, sourceText: 'keep', latestText: 'keep',
  })
  assert.deepEqual(result.rows[1], {
    kind: 'changed', sourceLine: 2, latestLine: 2, sourceText: 'a', latestText: 'x',
  })
  assert.deepEqual(result.rows[2], {
    kind: 'changed', sourceLine: 3, latestLine: 3, sourceText: 'b', latestText: 'y',
  })
  assert.deepEqual(result.rows[3], {
    kind: 'removed', sourceLine: 4, latestLine: null, sourceText: 'c', latestText: null,
  })
  assert.deepEqual(result.stats, { added: 2, removed: 3, unchanged: 1, changedRows: 2 })
})

test('H8 duplicate-line ties are deterministic and removal-first', () => {
  const removeFirst = history.buildRevisionDiff('a\na', 'a')
  assert.deepEqual(removeFirst.rows.map(row => row.kind), ['removed', 'equal'])
  assert.equal(removeFirst.rows[0].sourceText, 'a')
  assert.equal(removeFirst.rows[1].sourceLine, 2)
  const addLater = history.buildRevisionDiff('a', 'a\na')
  assert.deepEqual(addLater.rows.map(row => row.kind), ['added', 'equal'])
  assert.equal(addLater.rows[0].latestLine, 1)
  assert.equal(addLater.rows[1].latestLine, 2)
  const tie = history.buildRevisionDiff('a\nb', 'b\na')
  assert.deepEqual(tie, history.buildRevisionDiff('a\nb', 'b\na'))
  assert.deepEqual(tie.rows.map(row => row.kind), ['added', 'equal', 'removed'])
  assert.equal(tie.stats.unchanged, 1)
  assert.equal(tie.stats.added, 1)
  assert.equal(tie.stats.removed, 1)
})

test('H8 all-added, all-removed and a long single line are numbered correctly', () => {
  const added = history.buildRevisionDiff('', 'a\nb\nc')
  assert.deepEqual(added.rows.map(row => [row.kind, row.sourceLine, row.latestLine]), [
    ['added', null, 1], ['added', null, 2], ['added', null, 3],
  ])
  const removed = history.buildRevisionDiff('a\nb\nc', '')
  assert.deepEqual(removed.rows.map(row => [row.kind, row.sourceLine, row.latestLine]), [
    ['removed', 1, null], ['removed', 2, null], ['removed', 3, null],
  ])
  const long = 'x'.repeat(200000)
  const changed = history.buildRevisionDiff(long, 'y\nz')
  assert.deepEqual(changed.rows[0], {
    kind: 'changed', sourceLine: 1, latestLine: 1, sourceText: long, latestText: 'y',
  })
})

test('H8 every equal row matches both sides and every row has a valid shape', () => {
  const fixtures = [
    ['a\nb\nc', 'a\nx\nc'],
    ['', ''],
    ['a\nb', 'b'],
    ['a\nb\nc\nd', 'a\nc\nx\nd'],
    ['\n\n', '\n'],
  ]
  for (const [sourceCode, latestCode] of fixtures) {
    const result = history.buildRevisionDiff(sourceCode, latestCode)
    assert.equal(result.ok, true)
    for (const row of result.rows) {
      assert.ok(['equal', 'changed', 'added', 'removed'].includes(row.kind))
      if (row.kind === 'equal') {
        assert.equal(row.sourceText, row.latestText)
        assert.equal(typeof row.sourceLine, 'number')
        assert.equal(typeof row.latestLine, 'number')
      }
      if (row.kind === 'changed') {
        assert.notEqual(row.sourceText, row.latestText)
        assert.equal(typeof row.sourceText, 'string')
        assert.equal(typeof row.latestText, 'string')
      }
      if (row.kind === 'added') {
        assert.equal(row.sourceText, null)
        assert.equal(row.sourceLine, null)
        assert.equal(typeof row.latestLine, 'number')
      }
      if (row.kind === 'removed') {
        assert.equal(row.latestText, null)
        assert.equal(row.latestLine, null)
        assert.equal(typeof row.sourceLine, 'number')
      }
    }
  }
})

test('H8 fixed-seed random cases reconstruct both sides and are deterministic', () => {
  let state = 0x12345678
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
  const alphabet = ['a', 'b', 'c', 'd']
  const make = () => {
    const count = Math.floor(random() * 9)
    const lines = []
    for (let index = 0; index < count; index += 1) {
      lines.push(alphabet[Math.floor(random() * alphabet.length)])
    }
    return { code: lines.join('\n'), lines }
  }
  for (let round = 0; round < 50; round += 1) {
    const source = make()
    const latest = make()
    const first = history.buildRevisionDiff(source.code, latest.code)
    const second = history.buildRevisionDiff(source.code, latest.code)
    assert.deepEqual(second, first)
    assert.equal(first.ok, true)
    const sourceNormalized = history.splitDiffLines(source.code).join('\n')
    const latestNormalized = history.splitDiffLines(latest.code).join('\n')
    assert.equal(reconstructSource(first), sourceNormalized)
    assert.equal(reconstructLatest(first), latestNormalized)
    const totals = first.stats.added + first.stats.removed + first.stats.unchanged
    assert.equal(first.rows.length, first.stats.changedRows + first.stats.unchanged
      + (first.stats.added - first.stats.changedRows) + (first.stats.removed - first.stats.changedRows))
    assert.equal(first.stats.added + first.stats.removed, first.stats.changedRows * 2
      + (first.stats.added - first.stats.changedRows) + (first.stats.removed - first.stats.changedRows))
    assert.ok(totals >= Math.max(source.lines.length, latest.lines.length))
  }
})

test('H8 the 4000x4000 worst case completes within a generous Node allowance', () => {
  const source = Array.from({ length: 4000 }, (_, index) => `source-${String(index)}`).join('\n')
  const latest = Array.from({ length: 4000 }, (_, index) => `latest-${String(index)}`).join('\n')
  const start = Date.now()
  const result = history.buildRevisionDiff(source, latest)
  const elapsed = Date.now() - start
  assert.equal(result.ok, true)
  assert.equal(result.rows.length, 4000)
  assert.equal(result.stats.changedRows, 4000)
  assert.equal(result.stats.unchanged, 0)
  assert.equal(reconstructSource(result), source)
  assert.equal(reconstructLatest(result), latest)
  assert.ok(elapsed < 30000, `4000x4000 took ${String(elapsed)} ms`)
})

test('H8 the diff implementation is dependency-free and pure', () => {
  const start = clientSource.indexOf('function buildRevisionDiff')
  const end = clientSource.indexOf('function classifyRestoreError')
  const section = clientSource.slice(start, end)
  assert.equal(section.includes('import '), false)
  assert.equal(section.includes('require('), false)
  assert.equal((section.match(/Date\.now/g) ?? []).length, 0)
  assert.equal((section.match(/setTimeout/g) ?? []).length, 0)
  assert.ok(section.includes('new Uint8Array(cells)'))
  assert.ok(section.includes('new Uint32Array(width)'))
})

// ---------------------------------------------------------------------------
// H9 client helpers and request contract
// ---------------------------------------------------------------------------

test('H9 newRestoreRequestId is 22 base64url characters and deterministic for a vector', () => {
  const zero = history.newRestoreRequestId(new Uint8Array(16))
  assert.equal(zero, 'A'.repeat(22))
  assert.match(zero, /^[A-Za-z0-9_-]{22}$/)
  const ones = history.newRestoreRequestId(new Uint8Array(16).fill(255))
  assert.equal(ones, `${'_'.repeat(21)}w`)
  assert.match(ones, /^[A-Za-z0-9_-]{22}$/)
  const vector = Uint8Array.from({ length: 16 }, (_, index) => index * 17)
  assert.equal(history.newRestoreRequestId(vector), history.newRestoreRequestId(vector))
  assert.equal(history.newRestoreRequestId(vector).length, 22)
  const unique = new Set()
  for (let index = 0; index < 200; index += 1) unique.add(history.newRestoreRequestId())
  assert.equal(unique.size, 200)
  for (const id of unique) assert.match(id, /^[A-Za-z0-9_-]{22}$/)
  assert.throws(() => history.newRestoreRequestId(new Uint8Array(15)))
  assert.throws(() => history.newRestoreRequestId(new Uint8Array(17)))
  assert.throws(() => history.newRestoreRequestId('x'))
})

test('H9 newRestoreRequestId fails closed without secure random', () => {
  const saved = globalThis.crypto
  try {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true })
    assert.throws(() => history.newRestoreRequestId())
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: saved, configurable: true, writable: true })
  }
})

test('H9 restoreRequestBody has exactly five fields in the frozen order', () => {
  const snapshot = {
    sourceRevision: 3, sourceUpdatedAt: 300, expectedRevision: 9, expectedUpdatedAt: 900,
    requestId: REQUEST_A, extra: 'never', code: 'secret', title: 'secret',
  }
  const body = history.restoreRequestBody(snapshot)
  assert.deepEqual(Object.keys(body), [
    'sourceRevision', 'sourceUpdatedAt', 'expectedRevision', 'expectedUpdatedAt', 'requestId',
  ])
  assert.deepEqual(body, {
    sourceRevision: 3,
    sourceUpdatedAt: 300,
    expectedRevision: 9,
    expectedUpdatedAt: 900,
    requestId: REQUEST_A,
  })
  assert.equal(Object.hasOwn(body, 'sessionId'), false)
  assert.equal(Object.hasOwn(body, 'code'), false)
  assert.equal(Object.hasOwn(body, 'title'), false)
})

test('H9 classifyRestoreError maps every status/code branch and retry policy', () => {
  const cases = [
    [null, null, null, 'editor.restoreOffline', true, undefined],
    [undefined, undefined, undefined, 'editor.restoreOffline', true, undefined],
    [0, null, null, 'editor.restoreOffline', true, undefined],
    [408, 'timeout', null, 'editor.restoreOffline', true, undefined],
    [404, 'session', null, 'editor.restoreSessionGone', false, undefined],
    [404, 'source-revision', null, 'editor.restoreSourceGone', false, undefined],
    [409, 'conflict', null, 'editor.restoreConflict', false, undefined],
    [409, 'source-latest', null, 'editor.restoreFailed', false, undefined],
    [409, 'too-large', null, 'editor.restoreFailed', false, undefined],
    [409, 'idempotency-conflict', null, 'editor.restoreFailed', false, undefined],
    [429, 'rate', '7', 'editor.restoreRate', true, 7],
    [429, 'rate', '0.2', 'editor.restoreRate', true, 1],
    [429, 'rate', '99999', 'editor.restoreRate', true, 3600],
    [429, 'rate', 'not-a-number', 'editor.restoreRate', true, 1],
    [500, 'internal', null, 'editor.restoreOffline', true, undefined],
    [503, 'x', null, 'editor.restoreOffline', true, undefined],
    [400, 'fields', null, 'editor.restoreFailed', false, undefined],
    [403, 'origin', null, 'editor.restoreFailed', false, undefined],
    [200, 'malformed', null, 'editor.restoreFailed', true, undefined],
  ]
  for (const [status, code, retryAfter, noticeKey, retryable, seconds] of cases) {
    const result = history.classifyRestoreError(status, code, retryAfter)
    assert.equal(result.noticeKey, noticeKey)
    assert.equal(result.retryable, retryable)
    if (seconds !== undefined) assert.equal(result.seconds, seconds)
  }
})

test('H9 200 means submitted, never done, and only confirmation emits done', () => {
  const start = clientSource.indexOf('if (outcome.status === 200) {')
  const end = clientSource.indexOf('const code = outcome.data')
  const success = clientSource.slice(start, end)
  assert.equal((success.match(/setViewRevision\(data\.revision\)/g) ?? []).length, 1)
  assert.ok(success.includes('updateRestorePending(pending)'))
  assert.ok(success.includes('scheduleRestoreConfirmation(pending)'))
  assert.equal(success.includes('editor.restoreDone'), false)
  assert.equal(success.includes('updateRestorePending(null)'), false)
  const done = clientSource.slice(clientSource.indexOf('const terminalRestore ='), clientSource.indexOf('const startRestore ='))
  assert.equal((done.match(/editor\.restoreDone/g) ?? []).length, 1)
  assert.ok(done.includes("outcome === 'confirmed'") || done.includes('restoreNoticeRef.current'))
})

test('H9 record retry schedule is exactly 500/1500/3000 ms and record-only', () => {
  assert.deepEqual(history.RESTORE_RECORD_RETRY_DELAYS, [500, 1500, 3000])
  assert.equal(history.RESTORE_STALL_MS, 15000)
  const schedule = clientSource.slice(
    clientSource.indexOf('const scheduleRestoreConfirmation ='),
    clientSource.indexOf('const closeRestoreDialog ='),
  )
  assert.ok(schedule.includes('for (const delay of RESTORE_RECORD_RETRY_DELAYS)'))
  assert.equal((schedule.match(/retryRecord\(\)/g) ?? []).length, 1)
  assert.ok(schedule.includes('retry.attempts += 1'))
  assert.ok(schedule.includes('current.token !== pending.token'))
  assert.ok(schedule.includes('viewRevisionRef.current !== pending.revision'))
  assert.ok(schedule.includes('setTimeout(stallRestore, RESTORE_STALL_MS)'))
  assert.equal((clientSource.match(/retryRecord\(\)/g) ?? []).length, 1)
  assert.equal((clientSource.match(/recordRetryNonce\]/g) ?? []).length, 1)
  assert.ok(clientSource.includes('setRecordRetryNonce(value => value + 1)'))
})

test('H9 historyLocalSummary counts overrides, valid drafts and a full history', () => {
  const record = {
    camera: { position: [0, 0, 0] },
    environment: { preset: 'studio' },
    objects: {
      a: { overrides: { position: [1, 2, 3], visible: false } },
      b: { overrides: { rotation: [0, 1, 0], material: { color: { r: 1 }, metalness: { value: 1 } } } },
      c: null,
    },
  }
  const drafts = {
    1: { text: 'a' },
    2: { text: '' },
    3: { text: 5 },
    4: null,
    bad: 'text',
  }
  assert.deepEqual(history.historyLocalSummary({
    record, drafts, revisions: Array.from({ length: 12 }, (_, index) => ({ revision: index + 1 })),
  }), { overrides: 7, drafts: 2, historyFull: true })
  assert.deepEqual(history.historyLocalSummary({
    record: null, drafts: {}, revisions: [],
  }), { overrides: 0, drafts: 0, historyFull: false })
  assert.deepEqual(history.historyLocalSummary(null), { overrides: 0, drafts: 0, historyFull: false })
})

test('H9 token helpers and restoreFeedMatchesSnapshot are monotonic and strict', () => {
  assert.equal(history.nextHistoryToken(0), 1)
  assert.equal(history.nextHistoryToken(7), 8)
  assert.equal(history.nextHistoryToken(undefined), 1)
  assert.equal(history.nextHistoryToken(-2), 1)
  assert.equal(history.nextHistoryToken(1.5), 1)
  const record = { sceneId: SESSION_A, revision: 3, updatedAt: 300, title: 't', code: 'c' }
  const feed = {
    sessionId: SESSION_A,
    record,
    revisions: [{ revision: 2, updatedAt: 200 }, { revision: 9, updatedAt: 900 }],
    latestRevision: 9,
    viewRevision: 3,
    missing: false,
  }
  const snapshot = {
    sessionId: SESSION_A, sourceRevision: 3, sourceUpdatedAt: 300, expectedRevision: 9, expectedUpdatedAt: 900,
  }
  assert.equal(history.restoreFeedMatchesSnapshot(feed, snapshot), true)
  assert.equal(history.restoreFeedMatchesSnapshot({ ...feed, sessionId: SESSION_B }, snapshot), false)
  assert.equal(history.restoreFeedMatchesSnapshot(feed, { ...snapshot, sourceRevision: 4 }), false)
  assert.equal(history.restoreFeedMatchesSnapshot(feed, { ...snapshot, sourceUpdatedAt: 301 }), false)
  assert.equal(history.restoreFeedMatchesSnapshot({ ...feed, viewRevision: 4 }, snapshot), false)
  assert.equal(history.restoreFeedMatchesSnapshot({ ...feed, latestRevision: 8 }, snapshot), false)
  assert.equal(history.restoreFeedMatchesSnapshot({
    ...feed, revisions: [{ revision: 9, updatedAt: 901 }],
  }, snapshot), false)
  assert.equal(history.restoreFeedMatchesSnapshot({
    ...feed, record: { ...record, sceneId: 'demo' },
  }, snapshot), false)
  assert.equal(history.restoreFeedMatchesSnapshot(null, snapshot), false)
})

// ---------------------------------------------------------------------------
// H10 client state machine and source guards
// ---------------------------------------------------------------------------

test('H10 all required refs exist', () => {
  for (const name of ['restoreOpRef', 'restoreBusyRef', 'restoreSeqRef', 'restoreDialogRef',
    'restorePendingRef', 'restoreFeedRef', 'restoreRecordRetryRef', 'viewRevisionRef',
    'diffOpRef', 'diffAbortRef', 'diffOpenRef', 'diffDialogRef']) {
    assert.ok(clientSource.includes(`const ${name} = React.useRef(`), name)
  }
})

test('H10 submit revalidates refs, sets busy before fetch, and posts five fields', () => {
  const start = clientSource.indexOf('const submitRestore = () => {')
  const end = clientSource.indexOf('const openDiff = () => {')
  const submit = clientSource.slice(start, end)
  const feedGuard = submit.indexOf('restoreFeedMatchesSnapshot(feed, dialog)')
  const viewingGuard = submit.indexOf('viewingHistoryRef.current !== true')
  const busy = submit.indexOf('setRestoreBusy(true)')
  const fetchAt = submit.indexOf('await fetch(`${ROUTE}/scene/restore`')
  assert.ok(feedGuard >= 0 && viewingGuard > feedGuard && busy > viewingGuard && fetchAt > busy)
  assert.ok(submit.includes('restoreRequestBody(dialog)'))
  assert.ok(submit.includes('credentials: \'same-origin\''))
  assert.ok(submit.includes('cache: \'no-store\''))
  assert.ok(submit.includes('referrerPolicy: \'no-referrer\''))
  assert.equal(submit.includes('?token='), false)
  assert.equal(submit.includes('scene/restore?'), false)
  assert.equal(submit.includes('sessionId:'), false)
  assert.equal((submit.match(/new AbortController\(\)/g) ?? []).length, 1)
  assert.ok(submit.includes('restoreOpRef.current !== token'))
  assert.ok(submit.includes('sessionRef.current !== sessionAtStart'))
  assert.ok(submit.includes('readCappedResponseText(response, RESTORE_RESPONSE_MAX_BYTES'))
})

test('H10 status 200 pins once, while pending clears only on terminal/session/unmount', () => {
  const start = clientSource.indexOf('if (outcome.status === 200) {')
  const end = clientSource.indexOf('const code = outcome.data')
  const success = clientSource.slice(start, end)
  assert.equal((success.match(/setViewRevision\(/g) ?? []).length, 1)
  assert.ok(success.includes('setViewRevision(data.revision)'))
  assert.equal((clientSource.match(/updateRestorePending\(null\)/g) ?? []).length, 1)
  const terminal = clientSource.slice(clientSource.indexOf('const terminalRestore ='), clientSource.indexOf('const startRestore ='))
  assert.ok(terminal.includes('restorePendingRef.current = null'))
  assert.ok(terminal.includes('setRestorePendingState(null)'))
  assert.ok(terminal.includes('clearRestoreRetryTimers()'))
  const sessionSwitch = clientSource.slice(clientSource.indexOf('// Session switch discards'), clientSource.indexOf('const restoreDialogErrorKey'))
  assert.ok(sessionSwitch.includes('updateRestorePending(null)'))
  assert.ok(sessionSwitch.includes('clearRestoreRetryTimers()'))
  const unmount = clientSource.slice(clientSource.indexOf('React.useEffect(() => () =>'), clientSource.indexOf('const restoreDialogErrorKey'))
  assert.ok(unmount.includes('restoreOpRef.current = null'))
  assert.ok(unmount.includes('diffOpenRef.current = false'))
})

test('H10 recordIsLatest is strict, non-demo and latest-row-timestamp bound', () => {
  const start = clientSource.indexOf('function recordIsLatestValue')
  const end = clientSource.indexOf('function restoreFeedMatchesSnapshot')
  const predicate = clientSource.slice(start, end)
  assert.ok(predicate.includes('if (!recordMatchesSession(input.sessionId, record)) return false'))
  assert.ok(predicate.includes('if (record.sceneId !== String(input.sessionId)) return false'))
  assert.ok(predicate.includes('const latestRow = Array.isArray(input.revisions)'))
  assert.ok(predicate.includes('if (record.updatedAt !== latestRow.updatedAt) return false'))
  assert.ok(predicate.includes('if (input.viewingHistory !== false) return false'))
  assert.ok(predicate.includes('if (input.busy === true) return false'))
  assert.ok(predicate.includes('if (input.pending !== null && input.pending !== undefined) return false'))
  assert.ok(predicate.includes('if (record.revision !== latestRevision) return false'))
})

test('H10 every latest-only action recomputes latestActionsAllowed before acting', () => {
  const markers = [
    'const startAssetUpload = file => {',
    'const applyEnvironmentOverride = value => {',
    'const deleteAsset = assetId => {',
    'const stateForExport = () => {',
    'const startExport = async format => {',
    'const paramWritable = (notice = true) => {',
    'const allowMutation = ops => {',
    'const toggleLock = node => {',
    'const commitStructure = async (',
    'const commitTracks = async (',
    'const commitGizmo = data => {',
    'const resetAllOverrides = () => {',
    'const sendTweaks = () => {',
    'const setCamera = (fragment, commit, reset) => {',
    'const resetCamera = () => {',
    'const setRenderer = (next, commit, reset) => {',
    'const applyCodeDraft = () => {',
    'const activateStoredDraft = () => {',
    'const revertCodeDraft = () => {',
    'const restoreAgentVersion = revision => {',
    'const discardCodeChanges = () => {',
    'const applyConflictDraft = draftRevision => {',
    'const discardConflictDraft = draftRevision => {',
    'const discardInvalidDrafts = () => {',
    'const sendPicked = () => {',
    'const fixWithAi = () => {',
    'const uploadThumbnail = dataUrl => {',
  ]
  for (const marker of markers) {
    const start = clientSource.lastIndexOf(marker)
    assert.ok(start >= 0, marker)
    assert.ok(clientSource.slice(start, start + 700).includes('latestActionsAllowed()'), marker)
  }
  const openShareStart = clientSource.indexOf('const openShareCreate =')
  assert.ok(openShareStart >= 0)
  const openShare = clientSource.slice(
    openShareStart,
    clientSource.indexOf('const openShareManage =', openShareStart),
  )
  assert.ok(openShare.includes('latestActionsAllowed()'))
  assert.ok(openShare.includes('stateForExport()'))
  const shareDispatch = clientSource.slice(
    clientSource.indexOf('const preFetchIssue = shareRevalidationIssueNow'),
    clientSource.indexOf('const preFetchIssue = shareRevalidationIssueNow') + 500,
  )
  assert.ok(shareDispatch.includes('shareRevalidationIssueNow'))
  assert.ok(clientSource.includes("if (!latestActionsAllowed()) return\n                    setCodeText(event.target.value)"))
})

test('H10 capture message and uploadThumbnail recompute the latest gate before acting', () => {
  const uploadStart = clientSource.indexOf('const uploadThumbnail = dataUrl => {')
  assert.ok(uploadStart >= 0)
  const upload = clientSource.slice(uploadStart, uploadStart + 900)
  const uploadGate = upload.indexOf('if (!latestActionsAllowed()) return')
  const uploadFetch = upload.indexOf('fetch(`${ROUTE}/thumbnail`')
  assert.ok(uploadGate >= 0, 'uploadThumbnail checks latestActionsAllowed')
  assert.ok(uploadFetch > uploadGate, 'the gate precedes the thumbnail POST')
  assert.ok(upload.includes('feed.sessionId !== currentSession'), 'uploadThumbnail binds the feed to the current Session')
  assert.ok(upload.includes('feed.record.revision !== current.revision'), 'uploadThumbnail binds the feed to the current record')
  const handlerStart = clientSource.indexOf("if (data.type === 'three-workbench:capture'")
  assert.ok(handlerStart >= 0)
  const handler = clientSource.slice(handlerStart, handlerStart + 900)
  const handlerGate = handler.indexOf('latestActionsAllowed()')
  const handlerUpload = handler.indexOf('uploadThumbnail(data.dataUrl)')
  assert.ok(handler.includes("data.purpose === 'thumbnail'"))
  assert.ok(handlerGate >= 0 && handlerUpload > handlerGate, 'thumbnail messages are ignored unless the ref gate allows them')
  assert.equal(handler.includes('?token='), false)
})

test('H10 busy/pending lock filmstrip and history actions, and the code field is read-only', () => {
  assert.ok(clientSource.includes('const historyActionsDisabled = restoreBusy || restorePending !== null || diffDialog !== null'))
  assert.ok(clientSource.includes('disabled: restoreBusy || restorePending !== null || diffDialog !== null,'))
  assert.ok(clientSource.includes('onClick: () => { if (!disabled) onSelect(row.revision === latestRevision ? undefined : row.revision) }'))
  assert.ok(clientSource.includes("onClick: () => { if (!disabled) onSelect(undefined) }"))
  assert.ok(clientSource.includes("onClick: openDiff, disabled: historyActionsDisabled"))
  assert.ok(clientSource.includes("onClick: startRestore, disabled: historyActionsDisabled"))
  assert.ok(clientSource.includes('readOnly: !recordIsLatest'))
})

test('H10 restore/diff paths never mutate drafts, v2 overrides or the feed optimistically', () => {
  const restore = clientSource.slice(
    clientSource.indexOf('const startRestore ='),
    clientSource.indexOf('const closeDiff ='),
  )
  for (const forbidden of ['setRevisions(', 'setFeed(', 'deleteCodeDraft(', 'setCodeDrafts(',
    'clearOverrides(', 'setOverride(', 'setCameraOverride(', 'resetParamValues(',
    'localStorage.setItem', 'sessionStorage.setItem', 'appendRevision']) {
    assert.equal(restore.includes(forbidden), false, forbidden)
  }
  assert.equal(restore.includes('innerHTML'), false)
  assert.equal(restore.includes('dangerouslySetInnerHTML'), false)
  assert.equal(restore.includes('postMessage'), false)
  assert.equal(restore.includes('window.open'), false)
  assert.equal(restore.includes('location.href'), false)
  assert.equal(restore.includes('http://'), false)
  assert.equal(restore.includes('https://'), false)
})

test('H10 diff fetch uses capped readers, abort tokens and late-result guards', () => {
  const fetchSide = clientSource.slice(
    clientSource.indexOf('async function fetchDiffSide'),
    clientSource.indexOf('async function loadDiffPair'),
  )
  assert.ok(fetchSide.includes('readCappedResponseText(response, DIFF_MAX_RESPONSE_BYTES, signal)'))
  assert.ok(fetchSide.includes('data.revision !== revision || data.sceneId !== String(session)'))
  assert.ok(fetchSide.includes('data.updatedAt !== updatedAt'))
  assert.ok(fetchSide.includes('signal.aborted === true'))
  const load = clientSource.slice(
    clientSource.indexOf('async function loadDiffPair'),
    clientSource.indexOf('// Compute once after the loading frame'),
  )
  assert.ok(load.includes('new AbortController()'))
  assert.ok(load.includes('DIFF_OP_TIMEOUT_MS'))
  assert.ok(load.includes('if (diffOpRef.current !== op || diffOpenRef.current !== true'))
  assert.ok(load.includes('sessionRef.current !== snapshot.sessionId'))
  assert.ok(load.includes('if (sourceResult.reason === \'missing\' || sourceResult.reason === \'identity\')'))
  assert.ok(load.includes('buildRevisionDiff') === false)
  const close = clientSource.slice(clientSource.indexOf('const closeDiff ='), clientSource.indexOf('// Feed staleness is advisory'))
  assert.ok(close.includes('diffOpenRef.current = false'))
  assert.ok(close.includes('controller.abort()'))
})

test('H10 dialog semantics, focus trap and text-only rendering are present', () => {
  assert.ok(clientSource.includes("role: 'dialog',\n            'aria-modal': 'true',"))
  assert.ok(clientSource.includes("'aria-labelledby': 'three-workbench-restore-title'"))
  assert.ok(clientSource.includes("'aria-describedby': 'three-workbench-restore-keep'"))
  assert.ok(clientSource.includes("if (event.key === 'Escape')"))
  assert.ok(clientSource.includes("if (event.key !== 'Tab' || node === null || node === undefined) return"))
  assert.ok(clientSource.includes('restoreFocusFallback(dialog.trigger)'))
  assert.ok(clientSource.includes('restoreFocusFallback(null)'))
  assert.ok(clientSource.includes("t('editor.restoreCancel')"))
  assert.ok(clientSource.includes("t('editor.diffClose')"))
  assert.ok(clientSource.includes("style: { ...codeCellStyle }") || clientSource.includes('textContent'))
  assert.ok(clientSource.includes("h('td'"))
  assert.equal((clientSource.match(/innerHTML/g) ?? []).length, 0)
  assert.equal((clientSource.match(/dangerouslySetInnerHTML/g) ?? []).length, 0)
})

// ---------------------------------------------------------------------------
// H11 parity and regression gates
// ---------------------------------------------------------------------------

// Recorded on 2026-11-01 immediately before P3-2: node --test
// "tests/**/*.mjs" reported tests 162, pass 162, fail 0, skipped 0.
const PRE_P32_SUITE_BASELINE = 162

test('H11 history constants agree across Host and client', () => {
  assert.equal(history.HISTORY_MAX_REVISIONS, 12)
  assert.equal(history.DIFF_MAX_CODE_BYTES, 262144)
  assert.equal(history.DIFF_MAX_LINES, 4000)
  assert.equal(history.DIFF_MAX_CELLS, 16008001)
  assert.equal(history.DIFF_MAX_RESPONSE_BYTES, 2 * 1024 * 1024)
  assert.equal(history.RESTORE_RESPONSE_MAX_BYTES, 4096)
  assert.equal(history.RESTORE_TIMEOUT_MS, 20000)
  assert.match(indexSource, /const MAX_REVISIONS = 12\b/)
  assert.match(indexSource, /const MAX_CODE_BYTES = 256 \* 1024\b/)
  assert.equal(host.limits.requestIdLength, 22)
  assert.equal(host.limits.maxBodyBytes, history.RESTORE_RESPONSE_MAX_BYTES)
  assert.equal(host.limits.clientTimeoutMs, history.RESTORE_TIMEOUT_MS)
})

test('H11 restore reuses the P3-1 shared validators without changing them', () => {
  assert.equal(host.validateHost, shareHost.validateHost)
  assert.equal(host.originAllowed, shareHost.originAllowed)
  assert.equal(host.jsonContentType, shareHost.jsonContentType)
  assert.equal(host.readBody, shareHost.readBody)
  assert.equal(shareHost.path, `${ROUTE}/share`)
  assert.equal(shareHost.limits.maxShareBytes, 31457280)
  assert.equal(shareHost.limits.sessionShares, 8)
  assert.equal(shareHost.limits.globalShares, 32)
  assert.equal(shareHost.limits.maxJsonDepth, 64)
  assert.equal(host.validateFields === shareHost.validateFields, false)
})

test('H11 the registered route set is unchanged except for the exact restore route', () => {
  const routes = recordingContext().routes
  assert.equal(routes.length, 10)
  assert.deepEqual(routes.map(route => [route.kind, route.path]), [
    ['prefix', ROUTE],
    ['exact', `${ROUTE}/thumbnail`],
    ['exact', `${ROUTE}/assets/upload`],
    ['exact', `${ROUTE}/assets/delete`],
    ['exact', RESTORE_PATH],
    ['exact', `${ROUTE}/assets`],
    ['prefix', `${ROUTE}/assets`],
    ['exact', `${ROUTE}/share/create`],
    ['exact', `${ROUTE}/share/delete`],
    ['prefix', `${ROUTE}/share`],
  ])
  assert.equal(routes.some(route => /\/(public|share)\/restore/.test(route.path)), false)
  assert.equal(routes.some(route => route.path === RESTORE_PATH && route.kind !== 'exact'), false)
})

test('H11 existing test files are not skipped and the recorded baseline is 162', async () => {
  assert.equal(PRE_P32_SUITE_BASELINE, 162)
  const directory = new URL('../tests/', import.meta.url)
  const files = (await readdir(directory)).filter(name => name.endsWith('.test.mjs')).sort()
  assert.equal(files.length >= 7, true)
  assert.ok(files.includes('history.test.mjs'))
  assert.ok(files.includes('share.test.mjs'))
  for (const file of files) {
    const source = await readFile(new URL(file, directory), 'utf8')
    assert.equal(/\.skip\s*\(/.test(source), false, file)
    assert.equal(/\bskip\s*:\s*true/.test(source), false, file)
    assert.equal(/\btodo\s*:/.test(source), false, file)
    assert.ok(source.includes('test('), file)
  }
})

// ---------------------------------------------------------------------------
// H12 i18n
// ---------------------------------------------------------------------------

const P32_I18N = {
  "editor.historyBanner": ["正在查看历史版本 rev {revision}（最新 rev {latest}），当前为只读", "Viewing rev {revision} (latest rev {latest}); read-only"],
  "editor.historyLocalEdits": ["本地覆盖/相机改动 {count} 项仍会应用；历史版本只读", "{count} local override/camera change(s) remain applied; historical revisions are read-only"],
  "editor.historyDrafts": ["本地代码草稿 {count} 个不属于历史版本，也不会被恢复", "{count} local code draft(s) are not part of history and are never restored"],
  "editor.historyDiff": ["与最新版本对比", "Compare with latest"],
  "editor.historyRestore": ["恢复为最新", "Restore as latest"],
  "editor.restoreTitle": ["恢复历史版本", "Restore historical revision"],
  "editor.restoreSource": ["源版本：rev {revision} · {title}", "Source: rev {revision} · {title}"],
  "editor.restoreBody": ["将 rev {source} 的 agent 代码和标题复制为一个新的最新版本。", "Copy the agent code and title from rev {source} into a new latest revision."],
  "editor.restoreKeepNote": ["只恢复 agent 代码和源标题。当前相机、覆盖、参数、轨道、手动对象和本地代码草稿都会保留，不会被覆盖或删除。", "Only the agent code and source title are restored. Your current camera, overrides, parameters, tracks, manual objects and local code drafts are kept; none are overwritten or deleted."],
  "editor.restoreLocalEdits": ["当前有 {count} 项本地覆盖/相机改动；恢复后仍会应用，可能与旧代码不匹配。", "{count} local override/camera change(s) are still applied after restore and may not match the older code."],
  "editor.restoreDrafts": ["当前有 {count} 个本地代码草稿；不会被复制、应用或删除。", "{count} local code draft(s) exist; they are not copied, applied or deleted."],
  "editor.restoreTrim": ["历史已满（{max} 个版本）；恢复会移除最旧版本。", "History is full ({max} revisions); restoring removes the oldest revision."],
  "editor.restoreConfirm": ["恢复", "Restore"],
  "editor.restoreCancel": ["取消", "Cancel"],
  "editor.restoreBusy": ["正在恢复…", "Restoring…"],
  "editor.restoreSubmitted": ["恢复已提交为 rev {revision}；正在等待最新版本与记录就绪", "Restore submitted as rev {revision}; waiting for the latest revision and record"],
  "editor.restoreDone": ["已将 rev {source} 恢复为 rev {revision}", "Restored rev {source} as rev {revision}"],
  "editor.restoreSuperseded": ["已恢复为 rev {revision}，但 agent 随后提交了 rev {latest}", "Restored as rev {revision}, but the agent has since submitted rev {latest}"],
  "editor.restoreConflict": ["场景已变化；本次恢复未执行，请检查最新版本", "The scene changed; this request did not restore. Check the latest revision"],
  "editor.restoreSourceGone": ["该历史版本已不可用（可能已被清理）；本次恢复未执行，请检查最新版本", "That historical revision is no longer available (it may have been trimmed); this request did not restore. Check the latest revision"],
  "editor.restoreSessionGone": ["该场景会话已不可用（会话已清理或 Host 存储不可用）；本次恢复未完成。请让 agent 重新生成后刷新页面。", "This scene session is no longer available (it was cleared or Host storage is unavailable); this restore did not complete. Ask the agent to regenerate it and refresh."],
  "editor.restoreOffline": ["无法连接 Host；恢复结果未知，可安全重试", "Could not reach the Host; the restore result is unknown. Retrying is safe"],
  "editor.restoreRate": ["恢复请求过于频繁；请在 {seconds} 秒后重试", "Too many restore requests; try again in {seconds}s"],
  "editor.restoreFailed": ["恢复失败", "Restore failed"],
  "editor.restoreRetry": ["重试", "Retry"],
  "editor.restoreNotReady": ["编辑器尚未就绪；请回到历史版本后再试", "The editor is not ready; view a historical revision and try again"],
  "editor.restoreUnconfirmed": ["恢复已提交，但最新版本或记录尚未确认；请刷新页面后继续，不要依赖自动恢复。", "The restore was submitted but the latest revision or record is not confirmed; reload the page to continue and do not rely on automatic recovery."],
  "editor.diffTitle": ["版本对比", "Compare revisions"],
  "editor.diffSubtitle": ["rev {source} → rev {latest}", "rev {source} → rev {latest}"],
  "editor.diffAgentOnly": ["仅比较 agent 代码；本地草稿、相机和覆盖不参与对比", "Agent code only; local drafts, camera and overrides are not compared"],
  "editor.diffCaption": ["版本 {source} 与版本 {latest} 的逐行代码对比", "Line-by-line code comparison of rev {source} and rev {latest}"],
  "editor.diffRegionLabel": ["版本差异表格，可滚动", "Revision diff table, scrollable"],
  "editor.diffLoading": ["正在读取两个版本…", "Loading both revisions…"],
  "editor.diffLoadFailed": ["无法读取版本差异", "Could not load the revision diff"],
  "editor.diffResponseTooLarge": ["版本响应过大，无法安全对比", "The revision response is too large to compare safely"],
  "editor.diffTooLarge": ["代码过大，无法安全对比（每侧最多 {lines} 行，最多 {cells} 个比较单元）", "Code is too large to compare safely (at most {lines} lines per side and {cells} comparison cells)"],
  "editor.diffIdentical": ["两个版本的 agent 代码相同（忽略行尾换行符差异）", "Agent code is identical in both revisions (line-ending and final-newline differences are ignored)"],
  "editor.diffEmptySide": ["（空）", "(empty)"],
  "editor.diffStale": ["场景已更新；当前显示打开时的快照", "The scene has changed; showing the snapshot from when this dialog opened"],
  "editor.diffSourceGone": ["源历史版本已不可用", "The source revision is no longer available"],
  "editor.diffRefresh": ["刷新", "Refresh"],
  "editor.diffClose": ["关闭", "Close"],
  "editor.diffNormalization": ["对比忽略 CRLF/CR 与行尾单个换行符的差异；其他空白和 Unicode 字符逐字比较。", "Comparison ignores CRLF/CR and a single final newline; all other whitespace and Unicode characters are compared exactly."],
  "editor.diffStats": ["+{added} −{removed} · {unchanged} 行未变", "+{added} −{removed} · {unchanged} unchanged"],
  "editor.diffRemovedLine": ["删除行 {line}", "Removed line {line}"],
  "editor.diffAddedLine": ["新增行 {line}", "Added line {line}"],
  "editor.diffChangedLine": ["修改行：旧 {sourceLine}，新 {latestLine}", "Changed line: old {sourceLine}, new {latestLine}"],
  "editor.diffOldColumn": ["rev {source}", "rev {source}"],
  "editor.diffNewColumn": ["rev {latest}", "rev {latest}"],
}

function parseI18nDictionary(name) {
  const marker = `    const ${name} = {`
  const start = clientSource.indexOf(marker)
  assert.ok(start >= 0, name)
  const end = clientSource.indexOf('\n    }\n', start)
  assert.ok(end > start, name)
  const section = clientSource.slice(start + marker.length, end)
  const entries = []
  const pattern = /^\s*'([^']+)':\s*'((?:\\.|[^'\\])*)',?\s*$/gm
  let match
  while ((match = pattern.exec(section)) !== null) {
    const value = match[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\').replace(/\\n/g, '\n')
    entries.push([match[1], value])
  }
  const map = new Map(entries)
  return { map, entries }
}

function placeholders(value) {
  return [...value.matchAll(/\{([A-Za-z]+)\}/g)].map(match => match[1]).sort()
}

test('H12 zh and en carry every exact §6.3 string with matching placeholders', () => {
  const zh = parseI18nDictionary('zh')
  const en = parseI18nDictionary('en')
  assert.equal(zh.map.size, en.map.size)
  for (const [key, [zhValue, enValue]] of Object.entries(P32_I18N)) {
    assert.equal(zh.entries.filter(entry => entry[0] === key).length, 1, `zh duplicate ${key}`)
    assert.equal(en.entries.filter(entry => entry[0] === key).length, 1, `en duplicate ${key}`)
    assert.equal(zh.map.get(key), zhValue, `zh ${key}`)
    assert.equal(en.map.get(key), enValue, `en ${key}`)
    const expected = placeholders(zhValue)
    assert.deepEqual(placeholders(zhValue), expected, `zh placeholders ${key}`)
    assert.deepEqual(placeholders(enValue), expected, `en placeholders ${key}`)
  }
  assert.equal(Object.keys(P32_I18N).length, 49)
})

test('H12 no extra history/restore/diff keys, applied is absent and restoredNotice survives', () => {
  const expected = new Set(Object.keys(P32_I18N))
  const allowedExtra = new Set(['editor.restoredNotice'])
  for (const name of ['zh', 'en']) {
    const { map } = parseI18nDictionary(name)
    const extras = [...map.keys()]
      .filter(key => key.startsWith('editor.history') || key.startsWith('editor.restore')
        || key.startsWith('editor.diff'))
      .filter(key => !expected.has(key))
      .sort()
    assert.deepEqual(extras, [...allowedExtra])
    assert.equal(map.has('editor.restoreApplied'), false, name)
    assert.equal(map.has('editor.restoredNotice'), true, name)
  }
  assert.equal(clientSource.includes('editor.restoreApplied'), false)
  assert.ok(clientSource.includes("'editor.restoredNotice':"))
})

test('H12 strings contain no token, tokenized URL, external URL or Session fixture', () => {
  for (const [key, [zhValue, enValue]] of Object.entries(P32_I18N)) {
    for (const value of [zhValue, enValue]) {
      const lower = value.toLowerCase()
      assert.equal(lower.includes('token'), false, key)
      assert.equal(lower.includes('?token='), false, key)
      assert.equal(lower.includes('token%3d'), false, key)
      assert.equal(lower.includes('http://'), false, key)
      assert.equal(lower.includes('https://'), false, key)
      assert.equal(value.includes(SESSION_A), false, key)
      assert.equal(value.includes(SESSION_B), false, key)
      assert.equal(value.includes(REQUEST_A), false, key)
    }
  }
})

test('H12 history/restore/diff buttons have visible and accessible names', () => {
  assert.ok(clientSource.includes("}, t('editor.restoreCancel'))"))
  assert.ok(clientSource.includes("}, busy ? t('editor.restoreBusy') : t('editor.restoreConfirm'))"))
  assert.ok(clientSource.includes("}, t('editor.restoreRetry'))"))
  assert.ok(clientSource.includes("title: t('editor.restoreCancel'), 'aria-label': t('editor.restoreCancel')"))
  assert.ok(clientSource.includes("title: t('editor.diffClose'), 'aria-label': t('editor.diffClose')"))
  assert.ok(clientSource.includes("}, t('editor.diffRefresh'))"))
  assert.ok(clientSource.includes("}, t('editor.diffClose'))"))
  assert.ok(clientSource.includes("t('editor.historyDiff')"))
  assert.ok(clientSource.includes("t('editor.historyRestore')"))
  assert.ok(clientSource.includes("'aria-label': t('code.editorLabel')"))
})
