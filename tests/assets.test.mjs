/**
 * P1-9 asset regression matrix. These tests cover the Host's untrusted-byte
 * sniff/route/store boundaries and the browser half's pure v2/export helpers.
 * Live WebGL behavior (texture pins, HDR environment, upload UI) is exercised
 * by `.preview-tmp/verify-batch5b.mjs`.
 *
 */
// Run: node --test "tests/**/*.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { __assetInternal as host } from '../index.js'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const ROUTE = '/three-workbench/assets'

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: current => ({ current }),
  useCallback: fn => fn,
}
let definition
globalThis.window = { __ModuleLoader__: { load: value => { definition = value } } }
globalThis.document = {
  createElement: () => ({ textContent: '', remove () {} }),
  head: { append () {} },
}
await import(`${pathToFileURL(new URL('../client.js', import.meta.url).pathname).href}?assets=${String(Date.now())}`)
const plugin = definition.factory(name => {
  if (name === 'react') return reactStub
  if (name === '@deepseek-ai/dsh-client-store') {
    return { createSnapshotStore: initial => ({ getSnapshot: () => initial, subscribe: () => () => {}, set: () => {}, update: () => {} }) }
  }
  throw new Error(`unexpected require: ${name}`)
})

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from([0, 0, 0, 13])])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
const GLTF = Buffer.from('{"asset":{"version":"2.0"},"buffers":[{"uri":"data:application/octet-stream;base64,AAAA"}]}')
const HDR = Buffer.concat([Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n', 'latin1'), Buffer.from([0x80, 0x80, 0x80, 0x01])])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
const HTML = Buffer.from('<!doctype html><title>x</title>')
const JS = Buffer.from('alert(document.cookie)')
const ID_A = 'A'.repeat(22)
const ID_B = 'B'.repeat(22)
const ID_C = 'C'.repeat(22)
const ID_D = 'D'.repeat(22)

function webpBytes() {
  const buffer = Buffer.alloc(20)
  buffer.write('RIFF', 0, 'latin1')
  buffer.writeUInt32LE(buffer.length - 8, 4)
  buffer.write('WEBP', 8, 'latin1')
  buffer.write('VP8 ', 12, 'latin1')
  buffer.writeUInt32LE(0, 16)
  return buffer
}

function glbBytes(json = { asset: { version: '2.0' } }) {
  const text = JSON.stringify(json)
  const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20)
  padded.write(text)
  const total = 12 + 8 + padded.length
  const buffer = Buffer.alloc(total)
  buffer.write('glTF', 0, 'latin1')
  buffer.writeUInt32LE(2, 4)
  buffer.writeUInt32LE(total, 8)
  buffer.writeUInt32LE(padded.length, 12)
  buffer.writeUInt32LE(0x4e4f534a, 16)
  padded.copy(buffer, 20)
  return buffer
}

function session(name) {
  const id = `p19-${name}-${String(Date.now())}`
  host.seedSession(id)
  return id
}

function putAsset(sessionId, name, buffer, kind = 'image', mime = 'image/png', ext = '.png', bytes = buffer.length) {
  return host.store.put(sessionId, {
    name,
    nameFold: name.normalize('NFC').toLowerCase(),
    kind, mime, ext, bytes, buffer,
  })
}

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => { data.set(key, String(value)) },
    removeItem: key => { data.delete(key) },
    keys: () => [...data.keys()],
  }
}

function invokeHandler(handler, options = {}) {
  const {
    method = 'POST',
    headers = {},
    body = Buffer.alloc(0),
  } = options
  return new Promise(resolve => {
    const req = Readable.from(body.length === 0 ? [] : [body])
    req.method = method
    req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
    const res = {
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
        this.body = text ?? ''
        resolve(this)
      },
    }
    handler(req, res)
  })
}

function jsonBody(response) {
  try { return JSON.parse(response.body) } catch (error) { void error; return null }
}

// ---------------------------------------------------------------------------
// 1. Sniffing and extension policy
// ---------------------------------------------------------------------------
test('P1-9 sniffing accepts only exact raster/GLB/GLTF/HDR signatures with matching extensions', () => {
  const expected = [
    [PNG, 'png', 'image', 'image/png', '.png'],
    [JPEG, 'jpeg', 'image', 'image/jpeg', '.jpg'],
    [webpBytes(), 'webp', 'image', 'image/webp', '.webp'],
    [glbBytes(), 'glb', 'model', 'model/gltf-binary', '.glb'],
    [GLTF, 'gltf', 'model', 'model/gltf+json', '.gltf'],
    [HDR, 'hdr', 'hdr', 'image/vnd.radiance', '.hdr'],
  ]
  for (const [bytes, subtype, kind, mime, ext] of expected) {
    const sniffed = host.sniffAssetBytes(bytes)
    assert.equal(sniffed.subtype, subtype)
    assert.equal(sniffed.kind, kind)
    assert.equal(sniffed.mime, mime)
    assert.equal(sniffed.ext, ext)
  }

  for (const bytes of [SVG, HTML, JS, Buffer.from('GIF89a'), Buffer.from('PK\u0003\u0004')]) {
    assert.equal(host.sniffAssetBytes(bytes), null, 'non-allowlisted signatures never sniff')
    assert.equal(host.validateAssetBytes(bytes, 'payload.png').ok, false)
  }
  // Truncated and internally inconsistent containers fail closed instead of
  // matching on a prefix alone.
  assert.equal(host.sniffAssetBytes(Buffer.from([0x89, 0x50, 0x4e])), null)
  assert.equal(host.sniffAssetBytes(Buffer.from([0xff, 0xd8])), null)
  const badWebp = webpBytes()
  badWebp.writeUInt32LE(7, 4)
  assert.equal(host.sniffAssetBytes(badWebp), null)
  const badGlb = glbBytes()
  badGlb.writeUInt32LE(3, 8)
  assert.equal(host.sniffAssetBytes(badGlb), null)
  const truncatedHdr = Buffer.from('#?RADIANCE')
  assert.equal(host.sniffAssetBytes(truncatedHdr), null)

  assert.equal(host.validateAssetBytes(PNG, 'texture.png').mime, 'image/png')
  assert.equal(host.validateAssetBytes(JPEG, 'photo.jpeg').mime, 'image/jpeg')
  assert.equal(host.validateAssetBytes(PNG, 'renamed.jpg').code, 'extension-mismatch')
  assert.equal(host.validateAssetBytes(webpBytes(), 'x.png').code, 'extension-mismatch')
  assert.equal(host.validateAssetBytes(glbBytes(), 'x.gltf').code, 'extension-mismatch')
  const oversizePng = Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)])
  assert.equal(host.validateAssetBytes(oversizePng, 'big.png').code, 'too-large')

  assert.equal(host.validateAssetBytes(GLTF, 'scene.gltf').ok, true)
  assert.equal(host.validateAssetBytes(glbBytes(), 'scene.glb').ok, true)
  const external = Buffer.from('{"asset":{"version":"2.0"},"buffers":[{"uri":"model.bin"}]}')
  assert.equal(host.validateAssetBytes(external, 'external.gltf').code, 'gltf-external-uri')
  const embeddedSvg = Buffer.from('{"asset":{"version":"2.0"},"images":[{"uri":"data:image/svg+xml;base64,PHN2Zz4="}]}')
  assert.equal(host.validateAssetBytes(embeddedSvg, 'svg.gltf').code, 'gltf-external-uri')
  const draco = Buffer.from('{"asset":{"version":"2.0"},"extensionsRequired":["KHR_draco_mesh_compression"]}')
  assert.equal(host.validateAssetBytes(draco, 'draco.gltf').code, 'unsupported-extension')
  assert.equal(host.parseGltfDataUri('data:image/png;base64,AAAA').bytes, 3)
  assert.equal(host.parseGltfDataUri('data:image/png,AAAA'), null)
  assert.equal(host.parseGltfDataUri('data:image/png;base64,AAAAA'), null)
  assert.equal(host.parseGltfDataUri('https://example.test/x.png'), null)
})

// ---------------------------------------------------------------------------
// 2. Names, quotas, deletion, Session eviction
// ---------------------------------------------------------------------------
test('P1-9 names sanitize controls/bidi/path, preserve Unicode, and dedupe case-folded', () => {
  assert.equal(host.sanitizeAssetName('  ../../evil\u202e.png '), 'evil.png')
  assert.equal(host.sanitizeAssetName('C:\\temp\\file.png'), 'Ctempfile.png')
  assert.equal(host.sanitizeAssetName('..'), 'asset')
  assert.equal(host.sanitizeAssetName('café 🚀.png'), 'café 🚀.png')
  assert.equal(host.sanitizeAssetName('a'.repeat(128)), 'a'.repeat(128))
  assert.equal(host.sanitizeAssetName('a'.repeat(129)), null)
  assert.equal(host.decodeAssetNameHeader('caf%C3%A9%20%F0%9F%9A%80.png'), 'café 🚀.png')
  assert.equal(host.decodeAssetNameHeader('%E0%A4%A'), null)

  const sessionId = session('names')
  assert.equal(putAsset(sessionId, 'Hero.png', PNG).ok, true)
  const duplicate = putAsset(sessionId, 'hero.png', PNG)
  assert.equal(duplicate.code, 'duplicate-name')
  const rows = host.store.list(sessionId)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'Hero.png')
})

test('P1-9 per-file/Session/global quotas reject atomically and deletion frees capacity', () => {
  const countId = session('quota-count')
  const ids = []
  for (let index = 0; index < host.limits.sessionAssets; index += 1) {
    const stored = putAsset(countId, `a-${String(index)}.png`, PNG)
    assert.equal(stored.ok, true)
    ids.push(stored.asset.id)
  }
  assert.deepEqual(host.usage(countId), { count: 24, bytes: PNG.length * 24 })
  const overflow = putAsset(countId, 'overflow.png', PNG)
  assert.equal(overflow.code, 'session-quota')
  assert.equal(overflow.limit, 'session-assets')
  assert.equal(host.usage(countId).count, 24, 'a rejected asset changes no counter')
  assert.equal(host.rawAsset(overflow.asset?.id), undefined)

  assert.equal(host.store.delete(countId, ids[0]), true)
  assert.equal(host.usage(countId).count, 23)
  assert.equal(putAsset(countId, 'replacement.png', PNG).ok, true, 'a delete frees count and name slots')

  const byteId = session('quota-bytes')
  assert.equal(putAsset(byteId, 'huge.png', PNG, 'image', 'image/png', '.png', 47 * 1024 * 1024).ok, true)
  const byteOverflow = putAsset(byteId, 'another.png', PNG, 'image', 'image/png', '.png', 2 * 1024 * 1024)
  assert.equal(byteOverflow.code, 'session-quota')
  assert.equal(byteOverflow.limit, 'session-bytes')
  assert.equal(host.usage(byteId).count, 1)
  assert.equal(host.store.delete(byteId, host.store.list(byteId)[0].id), true)
  assert.deepEqual(host.usage(byteId), { count: 0, bytes: 0 })

  const evictId = session('quota-evict')
  const first = putAsset(evictId, 'one.png', PNG)
  const second = putAsset(evictId, 'two.png', PNG)
  const before = host.globalUsage()
  host.store.deleteSession(evictId)
  assert.deepEqual(host.usage(evictId), { count: 0, bytes: 0 })
  assert.equal(host.rawAsset(first.asset.id), undefined)
  assert.equal(host.rawAsset(second.asset.id), undefined)
  assert.equal(host.globalUsage().count, before.count - 2)
  assert.equal(host.store.list(evictId).length, 0)
})

// ---------------------------------------------------------------------------
// 3. Route helpers and content headers
// ---------------------------------------------------------------------------
test('P1-9 routes expose Session-scoped lists, capability content, ETag/HEAD and 404s', async () => {
  const sessionA = session('route-a')
  const sessionB = session('route-b')
  const a = putAsset(sessionA, 'a.png', PNG).asset
  const b = putAsset(sessionB, 'b.png', PNG).asset

  const listA = await host.listResponse(new Request(`http://localhost${ROUTE}`, {
    headers: { 'x-workbench-session': sessionA },
  }))
  assert.equal(listA.status, 200)
  const listPayload = await listA.json()
  assert.equal(listPayload.ok, true)
  assert.deepEqual(listPayload.assets.map(row => row.id), [a.id], 'lists never leak another Session')
  assert.deepEqual(listPayload.usage, { count: 1, bytes: PNG.length })

  const listB = await host.listResponse(new Request(`http://localhost${ROUTE}`, {
    headers: { 'x-workbench-session': sessionB },
  }))
  assert.deepEqual((await listB.json()).assets.map(row => row.id), [b.id])

  const unknown = await host.listResponse(new Request(`http://localhost${ROUTE}`, {
    headers: { 'x-workbench-session': 'unknown-session' },
  }))
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).error.code, 'unknown-session')
  const noSession = await host.listResponse(new Request(`http://localhost${ROUTE}`))
  assert.equal(noSession.status, 404)

  const method = await host.listResponse(new Request(`http://localhost${ROUTE}`, { method: 'POST' }))
  assert.equal(method.status, 405)
  assert.equal(method.headers.get('allow'), 'GET, HEAD')

  const head = await host.listResponse(new Request(`http://localhost${ROUTE}`, {
    method: 'HEAD', headers: { 'x-workbench-session': sessionA },
  }))
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(JSON.stringify(listPayload))))

  const content = await host.contentResponse(new Request(`http://localhost${ROUTE}/${a.id}`))
  assert.equal(content.status, 200)
  assert.equal(content.headers.get('content-type'), 'image/png')
  assert.equal(content.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(content.headers.get('access-control-allow-origin'), '*')
  assert.equal(content.headers.get('cross-origin-resource-policy'), 'cross-origin')
  assert.match(content.headers.get('content-disposition'), /^inline; filename="asset-[A-Za-z0-9_-]{22}\.png"$/)
  assert.equal(content.headers.get('content-security-policy'), "default-src 'none'; sandbox")
  assert.equal(content.headers.get('referrer-policy'), 'no-referrer')
  assert.match(content.headers.get('etag'), /^"a-[A-Za-z0-9_-]{22}-\d+"$/)
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), PNG)

  const ifNoneMatch = await host.contentResponse(new Request(`http://localhost${ROUTE}/${a.id}`, {
    headers: { 'if-none-match': content.headers.get('etag') },
  }))
  assert.equal(ifNoneMatch.status, 304)
  assert.equal(ifNoneMatch.headers.get('etag'), content.headers.get('etag'))
  assert.equal(ifNoneMatch.headers.get('content-type'), null)

  const headContent = await host.contentResponse(new Request(`http://localhost${ROUTE}/${a.id}`, { method: 'HEAD' }))
  assert.equal(headContent.status, 200)
  assert.equal(await headContent.text(), '')
  assert.equal(headContent.headers.get('content-length'), String(PNG.length))

  assert.equal((await host.contentResponse(new Request(`http://localhost${ROUTE}/${a.id}`, { method: 'POST' }))).status, 405)
  assert.equal((await host.contentResponse(new Request(`http://localhost${ROUTE}/bad-id`))).status, 404)
  assert.equal((await host.contentResponse(new Request(`http://localhost${ROUTE}/${ID_D}`))).status, 404)

  const crossDelete = await invokeHandler(host.deleteHandler, {
    headers: { 'x-workbench-session': sessionA, 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ id: b.id })),
  })
  assert.equal(crossDelete.status, 404)
  assert.equal(host.rawAsset(b.id).id, b.id, 'cross-Session delete never drops the target')

  const deleted = await invokeHandler(host.deleteHandler, {
    headers: { 'x-workbench-session': sessionA, 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ id: a.id })),
  })
  assert.equal(deleted.status, 200)
  assert.equal(host.rawAsset(a.id), undefined)
  assert.equal((await host.contentResponse(new Request(`http://localhost${ROUTE}/${a.id}`))).status, 404)
  assert.deepEqual(host.usage(sessionA), { count: 0, bytes: 0 })

  const wrongDeleteMethod = await invokeHandler(host.deleteHandler, { method: 'GET' })
  assert.equal(wrongDeleteMethod.status, 405)
  assert.equal(wrongDeleteMethod.headers.allow, 'POST')
  const wrongUploadMethod = await invokeHandler(host.uploadHandler, { method: 'GET' })
  assert.equal(wrongUploadMethod.status, 405)
  assert.equal(wrongUploadMethod.headers.allow, 'POST')
})

test('P1-9 upload handler enforces sniff/ext/duplicate/name/rate rules without partial state', async () => {
  const sessionId = session('upload')
  const upload = (name, bytes, headers = {}) => invokeHandler(host.uploadHandler, {
    headers: {
      'x-workbench-session': sessionId,
      'x-workbench-name': encodeURIComponent(name),
      ...headers,
    },
    body: bytes,
  })

  const ok = await upload('Hero.png', PNG)
  assert.equal(ok.status, 201)
  const payload = jsonBody(ok)
  assert.equal(payload.ok, true)
  assert.equal(payload.asset.name, 'Hero.png')
  assert.equal(host.idPattern.test(payload.asset.id), true)
  assert.deepEqual(host.usage(sessionId), { count: 1, bytes: PNG.length })

  const duplicate = await upload('hero.png', PNG)
  assert.equal(duplicate.status, 409)
  assert.equal(jsonBody(duplicate).error.code, 'duplicate-name')
  assert.deepEqual(host.usage(sessionId), { count: 1, bytes: PNG.length })

  const mismatch = await upload('fake.jpg', PNG)
  assert.equal(mismatch.status, 415)
  assert.equal(jsonBody(mismatch).error.code, 'extension-mismatch')

  const svg = await upload('bad.svg', SVG)
  assert.equal(svg.status, 415)
  assert.equal(jsonBody(svg).error.code, 'unsupported-type')
  const html = await upload('bad.png', HTML)
  assert.equal(html.status, 415)
  assert.equal(jsonBody(html).error.code, 'unsupported-type')
  const js = await upload('bad.png', JS)
  assert.equal(js.status, 415)
  assert.equal(jsonBody(js).error.code, 'unsupported-type')
  assert.deepEqual(host.usage(sessionId), { count: 1, bytes: PNG.length }, 'failures never mutate the store')

  const unicode = await upload('café 🚀.png', PNG)
  assert.equal(unicode.status, 201)
  assert.equal(jsonBody(unicode).asset.name, 'café 🚀.png')
  const list = await host.listResponse(new Request(`http://localhost${ROUTE}`, {
    headers: { 'x-workbench-session': sessionId },
  }))
  assert.deepEqual((await list.json()).assets.map(row => row.name), ['Hero.png', 'café 🚀.png'])

  const missingName = await invokeHandler(host.uploadHandler, {
    headers: { 'x-workbench-session': sessionId },
    body: PNG,
  })
  assert.equal(missingName.status, 400)
  assert.equal(jsonBody(missingName).error.code, 'invalid-name')
  const unknownSession = await invokeHandler(host.uploadHandler, {
    headers: { 'x-workbench-session': 'unknown-session', 'x-workbench-name': 'x.png' },
    body: PNG,
  })
  assert.equal(unknownSession.status, 404)
  assert.equal(jsonBody(unknownSession).error.code, 'unknown-session')

  const rateId = session('rate')
  let last = null
  for (let index = 0; index <= host.limits.uploadsPerSessionPerMinute; index += 1) {
    last = await invokeHandler(host.uploadHandler, {
      headers: { 'x-workbench-session': rateId, 'x-workbench-name': encodeURIComponent(`r-${String(index)}.png`) },
      body: PNG,
    })
    if (index < host.limits.uploadsPerSessionPerMinute) assert.equal(last.status, 201)
  }
  assert.equal(last.status, 429)
  assert.equal(jsonBody(last).error.code, 'rate-limited')
  assert.equal(host.usage(rateId).count, host.limits.uploadsPerSessionPerMinute)
})

// ---------------------------------------------------------------------------
// 4. v2 normalization, save/load, clear, badges
// ---------------------------------------------------------------------------
test('P1-9 v2 texture/environment fields normalize, persist and clear atomically', () => {
  const texture = plugin.__normalizeMaterialTextureRefs({
    map: ID_A,
    normalMap: null,
    roughnessMap: 'short',
    unknownSlot: ID_B,
    emissiveMap: 42,
  })
  assert.deepEqual(texture.textures, { map: ID_A, normalMap: null })
  assert.deepEqual(texture.issues, [
    { kind: 'malformed-texture', slot: 'roughnessMap' },
    { kind: 'malformed-texture', slot: 'unknownSlot' },
    { kind: 'malformed-texture', slot: 'emissiveMap' },
  ])
  assert.deepEqual(plugin.__MATERIAL_TEXTURE_SLOTS, [
    'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'aoMap',
  ])

  assert.deepEqual(plugin.__normalizeEditorEnvironmentField(null), { environment: null, issues: [] })
  assert.deepEqual(plugin.__normalizeEditorEnvironmentField({ assetId: ID_C }), { environment: { assetId: ID_C }, issues: [] })
  assert.deepEqual(plugin.__normalizeEditorEnvironmentField({ assetId: null }), { environment: { assetId: null }, issues: [] })
  assert.deepEqual(plugin.__normalizeEditorEnvironmentField({ assetId: 'nope' }), {
    environment: null, issues: [{ kind: 'malformed-environment' }],
  })
  assert.deepEqual(plugin.__normalizeEditorEnvironmentField([]), {
    environment: null, issues: [{ kind: 'malformed-environment' }],
  })

  const base = plugin.__emptyEditorRecord(1)
  assert.equal(base.environment, null)
  const withEnv = plugin.__setEditorEnvironment(base, { assetId: ID_C }, 5)
  assert.equal(withEnv.ok, true)
  assert.deepEqual(withEnv.record.environment, { assetId: ID_C })
  assert.equal(base.environment, null, 'input record is not mutated')
  assert.equal(plugin.__editorHasOverrides(withEnv.record), true, 'environment alone counts')
  assert.equal(plugin.__setEditorEnvironment(base, null, 6).record.environment, null)

  const issues = []
  const normalized = plugin.__normalizeEditorRecord({
    v: 2,
    updatedAt: 8,
    environment: { assetId: ID_C },
    objects: {
      's:mesh': {
        uid: 's:mesh', origin: 'script', type: 'Mesh', anchor: 't:Mesh', parentUid: null,
        overrides: {
          material: {
            '0': { color: '#112233', textures: { map: ID_A, normalMap: 'bad', stray: ID_B } },
            '1': { textures: {} },
          },
        },
      },
    },
    params: { v: 1, values: { keep: 1 } },
  }, 9, issues)
  assert.equal(normalized.environment.assetId, ID_C)
  assert.deepEqual(normalized.objects['s:mesh'].overrides.material['0'].textures, { map: ID_A })
  assert.equal(Object.prototype.hasOwnProperty.call(normalized.objects['s:mesh'].overrides.material['1'], 'textures'), false)
  assert.deepEqual(issues, [
    { kind: 'malformed-texture', slot: 'normalMap', uid: 's:mesh', target: '0' },
    { kind: 'malformed-texture', slot: 'stray', uid: 's:mesh', target: '0' },
  ])

  const storage = memoryStorage()
  assert.equal(plugin.__saveEditorSession(storage, 'session-assets', normalized, { now: 10 }).ok, true)
  const loaded = plugin.__loadEditorSession(storage, 'session-assets', { now: 11, makeUid: prefix => prefix + ':x' })
  assert.equal(loaded.source, 'v2')
  assert.deepEqual(loaded.record.environment, { assetId: ID_C })
  assert.deepEqual(loaded.record.objects['s:mesh'].overrides.material['0'].textures, { map: ID_A })

  const textureOnly = Object.assign({}, base, {
    objects: {
      's:mesh': {
        uid: 's:mesh', origin: 'script', type: 'Mesh', anchor: 't:Mesh', parentUid: null,
        overrides: { material: { '0': { textures: { map: ID_A } } } },
      },
    },
  })
  assert.equal(plugin.__editorHasOverrides(textureOnly), true, 'a texture-only override counts')
  const cleared = plugin.__clearEditorOverrides(normalized, 20)
  assert.equal(cleared.environment, null)
  assert.deepEqual(cleared.objects, {})
  assert.deepEqual(cleared.params, { v: 1, values: { keep: 1 } })
  assert.equal(plugin.__editorHasOverrides(cleared), false)

  const runtimeStart = clientSource.indexOf('const applyEnvironmentOverride = value => {')
  const runtimeEnd = clientSource.indexOf('const disposeRuntimeAssets = () => {', runtimeStart)
  const runtimeBody = clientSource.slice(runtimeStart, runtimeEnd)
  assert.ok(runtimeBody.indexOf('releaseEnvironmentBinding()') < runtimeBody.indexOf('scene.environment = scriptEnvironment'),
    'reset restores the script environment without disposing it')
  assert.ok(runtimeBody.includes("if (asset === undefined || asset.kind !== 'hdr')"))
  const applyStateStart = clientSource.indexOf('function applyEditorState(state) {')
  const applyStateEnd = clientSource.indexOf('// Initialize the runtime-only structure maps', applyStateStart)
  const applyStateBody = clientSource.slice(applyStateStart, applyStateEnd)
  assert.ok(applyStateBody.indexOf('applyCamera(state.camera)') < applyStateBody.indexOf('applyEnvironmentOverride(state.environment'),
    'environment applies after the camera')
  assert.ok(clientSource.includes('manifestHasAsset(asset)'), 'deleted assets dispose late results')
})

// ---------------------------------------------------------------------------
// 5. Runtime template wiring and initial-manifest readiness
// ---------------------------------------------------------------------------
test('P1-9 runtime template defines its slot set and the first document waits for the asset list', () => {
  const slotsLine = clientSource.indexOf('const MATERIAL_TEXTURE_SLOTS = ${JSON.stringify(MATERIAL_TEXTURE_SLOTS)}')
  assert.ok(slotsLine > 0, 'slot list is injected into the runtime source')
  const slotSetLine = clientSource.indexOf('const MATERIAL_TEXTURE_SLOT_SET = new Set(MATERIAL_TEXTURE_SLOTS)', slotsLine)
  assert.ok(slotSetLine > slotsLine, 'the runtime template constructs the Set it reads at load time')
  assert.ok(clientSource.indexOf('if (!MATERIAL_TEXTURE_SLOT_SET.has(textureSlot)) return', slotSetLine) > slotSetLine,
    'texture application resolves slots through the injected set')

  const hostKnownLine = clientSource.indexOf('const assetHostKnown = latestRevision !== undefined')
  assert.ok(hostKnownLine > 0, 'asset requests are gated on a stored scene pair')
  const emptyManifestLine = clientSource.indexOf('setAssetListReady(sceneMissing || failed)', hostKnownLine)
  assert.ok(emptyManifestLine > hostKnownLine, 'a missing Session gets an empty manifest without a request')
  const docGateLine = clientSource.indexOf('!editorLoaded || !assetListReady')
  assert.ok(docGateLine > 0, 'the sandbox document is not mounted before the first list settles')

  // An empty glTF must take the normal failure path: the scene is inspected
  // before finishLoad() settles the holder, so fail() still posts the failure
  // state, calls onError and resolves ready(null) exactly once.
  const modelStart = clientSource.indexOf('model(name, onLoad, onError) {')
  const modelEnd = clientSource.indexOf('hdri(name, onLoad, onError) {', modelStart)
  assert.ok(modelStart > 0 && modelEnd > modelStart, 'assets.model source is locatable')
  const modelBody = clientSource.slice(modelStart, modelEnd)
  const rootLine = modelBody.indexOf('const root = gltf === null || gltf === undefined ? null : gltf.scene')
  const emptyFailLine = modelBody.indexOf("fail(new Error('glTF scene is empty'))", rootLine)
  const settleLine = modelBody.indexOf('if (!finishLoad()) return', rootLine)
  assert.ok(rootLine > 0, 'the GLTFLoader callback inspects gltf.scene')
  assert.ok(emptyFailLine > rootLine, 'an empty scene fails before anything settles')
  assert.ok(settleLine > emptyFailLine, 'the holder settles only after a usable root is confirmed')
})

// ---------------------------------------------------------------------------
// 5. Export URL modes, caps, missing refs, ZIP content
// ---------------------------------------------------------------------------
const EXPORT_SESSION = 'session-export-SECRET-do-not-leak'
const EXPORT_ROWS = [
  { id: ID_A, name: 'albedo.png', kind: 'image', mime: 'image/png', bytes: 3, createdAt: 1 },
  { id: ID_B, name: 'mesh.glb', kind: 'model', mime: 'model/gltf-binary', bytes: 2, createdAt: 2 },
  { id: ID_C, name: 'studio.hdr', kind: 'hdr', mime: 'image/vnd.radiance', bytes: 4, createdAt: 3 },
]
const EXPORT_BYTES = new Map([
  [ID_A, Buffer.from([1, 2, 3])],
  [ID_B, Buffer.from([4, 5])],
  [ID_C, Buffer.from([6, 7, 8, 9])],
])
const EXPORT_STATE = {
  v: 2,
  updatedAt: 1,
  camera: null,
  environment: { assetId: ID_C },
  objects: {
    's:mesh': {
      uid: 's:mesh', origin: 'script', type: 'Mesh', anchor: 't:Mesh', parentUid: null,
      overrides: { material: { '0': { textures: { map: ID_A, normalMap: null } } } },
    },
  },
}

function installExportFetch() {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url)
    calls.push({ url: href, options })
    if (href.endsWith('/assets')) {
      return new Response(JSON.stringify({ ok: true, assets: EXPORT_ROWS, usage: { count: 3, bytes: 9 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    const id = href.slice(href.lastIndexOf('/') + 1)
    const bytes = EXPORT_BYTES.get(id)
    return bytes === undefined
      ? new Response('Not found.', { status: 404 })
      : new Response(bytes, { status: 200 })
  }
  return {
    calls,
    restore() { globalThis.fetch = original },
    setRows(rows) {
      globalThis.fetch = async (url, options = {}) => {
        const href = String(url)
        calls.push({ url: href, options })
        if (href.endsWith('/assets')) {
          return new Response(JSON.stringify({ ok: true, assets: rows, usage: { count: rows.length, bytes: 9 } }), { status: 200 })
        }
        const id = href.slice(href.lastIndexOf('/') + 1)
        return new Response(EXPORT_BYTES.get(id) || Buffer.from([0]), { status: 200 })
      }
    },
  }
}

test('P1-9 export helpers rewrite live/data/relative URLs and fail closed on missing refs/caps', async () => {
  const mock = installExportFetch()
  try {
    const live = await plugin.__buildExportAssets('live', EXPORT_SESSION, EXPORT_STATE)
    assert.deepEqual(live.map(asset => asset.url), [
      `${ROUTE}/${ID_A}`, `${ROUTE}/${ID_B}`, `${ROUTE}/${ID_C}`,
    ])
    assert.deepEqual(live.map(asset => Buffer.from(asset.data)), [...EXPORT_BYTES.values()])
    const listCall = mock.calls.find(call => call.url.endsWith('/assets'))
    assert.equal(listCall.options.headers['x-workbench-session'], EXPORT_SESSION)
    assert.equal(mock.calls.filter(call => call.url.includes(`/assets/${ID_A}`)).every(call => call.options.headers === undefined),
      true, 'content requests never carry the Session header')

    const data = await plugin.__buildExportAssets('data', EXPORT_SESSION, EXPORT_STATE)
    assert.equal(data[0].url.startsWith('data:image/png;base64,'), true)
    assert.equal(Buffer.from(data[0].url.split(',')[1], 'base64').equals(Buffer.from([1, 2, 3])), true)
    assert.equal(data[1].url.startsWith('data:model/gltf-binary;base64,'), true)
    assert.equal(data[2].url.startsWith('data:image/vnd.radiance;base64,'), true)

    const relative = await plugin.__buildExportAssets('relative', EXPORT_SESSION, EXPORT_STATE)
    assert.deepEqual(relative.map(asset => asset.url), [
      `./assets/${ID_A}.png`, `./assets/${ID_B}.glb`, `./assets/${ID_C}.hdr`,
    ])
    assert.equal(relative.every(asset => !asset.url.includes(EXPORT_SESSION)), true)

    const missingEnv = Object.assign({}, EXPORT_STATE, { environment: { assetId: ID_D } })
    await assert.rejects(plugin.__buildExportAssets('live', EXPORT_SESSION, missingEnv), error => {
      assert.equal(error.code, 'asset-missing')
      assert.equal(error.assetId, ID_D)
      return true
    })
    const missingTexture = Object.assign({}, EXPORT_STATE, {
      objects: {
        's:mesh': {
          uid: 's:mesh', origin: 'script', type: 'Mesh', anchor: 't:Mesh', parentUid: null,
          overrides: { material: { '0': { textures: { map: ID_D } } } },
        },
      },
    })
    await assert.rejects(plugin.__buildExportAssets('data', EXPORT_SESSION, missingTexture), error => error.code === 'asset-missing')
    await assert.rejects(plugin.__buildExportAssets('live', undefined, EXPORT_STATE), error => error.code === 'asset-session')

    const caps = plugin.__ASSET_EXPORT_CAPS
    assert.deepEqual(caps, {
      standaloneDecodedBytes: 16 * 1024 * 1024,
      standaloneEncodedBytes: 24 * 1024 * 1024,
      zipAssetBytes: 64 * 1024 * 1024,
      zipTotalBytes: 128 * 1024 * 1024,
    })
    const saved = { ...caps }
    try {
      caps.standaloneDecodedBytes = 1
      await assert.rejects(plugin.__buildExportAssets('data', EXPORT_SESSION, { v: 2, objects: {} }), error => {
        assert.equal(error.code, 'asset-export-too-large')
        assert.equal(error.limit, 1)
        return true
      })
      caps.standaloneDecodedBytes = saved.standaloneDecodedBytes
      caps.standaloneEncodedBytes = 1
      await assert.rejects(plugin.__buildExportAssets('data', EXPORT_SESSION, { v: 2, objects: {} }), error => error.code === 'asset-export-too-large')
      caps.standaloneEncodedBytes = saved.standaloneEncodedBytes
      caps.zipAssetBytes = 1
      await assert.rejects(plugin.__buildExportAssets('relative', EXPORT_SESSION, { v: 2, objects: {} }), error => {
        assert.equal(error.code, 'asset-export-too-large')
        assert.equal(error.limit, 1)
        return true
      })
    } finally {
      Object.assign(caps, saved)
    }

    const manifest = {
      revision: 7,
      assets: plugin.__assetManifestForExport(data),
    }
    assert.equal(manifest.assets.every(asset => asset.data === undefined && asset.extension === undefined), true)
    const html = plugin.__standaloneHtml({ title: 'Export', revision: 3, code: 'scene.add(new THREE.Mesh())' }, EXPORT_STATE, manifest)
    assert.match(html, /"three":"https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.186\.1\/build\/three\.module\.js"/)
    assert.match(html, /"three\/addons\/":"https:\/\/cdn\.jsdelivr\.net\/npm\/three@0\.186\.1\/examples\/jsm\/"/)
    assert.ok(html.includes('const INITIAL_ASSETS = {"revision":7'))
    assert.ok(html.includes('data:image/png;base64,'))
    assert.equal(html.includes('/three-workbench/runtime'), false)
    assert.equal(html.includes(EXPORT_SESSION), false, 'standalone export carries no Session id')
    assert.equal(html.includes('x-workbench-session'), false, 'standalone export carries no Session header')

    const relativeManifest = {
      revision: 8,
      assets: plugin.__assetManifestForExport(relative),
    }
    const zipHtml = plugin.__previewDocument(
      { title: 'Export', revision: 3, code: 'scene.add(new THREE.Mesh())' }, null, EXPORT_STATE, relativeManifest,
    )
    assert.ok(zipHtml.includes(`./assets/${ID_A}.png`))
    assert.ok(zipHtml.includes(`./assets/${ID_B}.glb`))
    assert.ok(zipHtml.includes(`./assets/${ID_C}.hdr`))
    assert.equal(zipHtml.includes(EXPORT_SESSION), false, 'ZIP document carries no Session id')

    assert.deepEqual(plugin.__PROJECT_RUNTIME_FILES, [
      'three.module.js', 'three.core.js', 'OrbitControls.js', 'TransformControls.js',
      'loaders/GLTFLoader.js', 'loaders/HDRLoader.js', 'loaders/RGBELoader.js',
      'utils/BufferGeometryUtils.js', 'utils/SkeletonUtils.js',
    ])
    const zipped = await plugin.__createZip([
      ...relative.map(asset => ({ name: `assets/${asset.id}.${asset.extension}`, bytes: asset.data })),
      ...plugin.__PROJECT_RUNTIME_FILES.map(name => ({ name: `runtime/${name}`, bytes: new Uint8Array([1]) })),
      { name: 'runtime/THREE-LICENSE.txt', bytes: new TextEncoder().encode('The MIT License') },
      { name: 'README.md', bytes: new TextEncoder().encode('readme') },
    ]).arrayBuffer()
    const archiveText = Buffer.from(zipped).toString('latin1')
    for (const name of plugin.__PROJECT_RUNTIME_FILES) assert.ok(archiveText.includes(`runtime/${name}`))
    assert.ok(archiveText.includes(`assets/${ID_A}.png`))
    assert.ok(archiveText.includes(`assets/${ID_B}.glb`))
    assert.ok(archiveText.includes(`assets/${ID_C}.hdr`))
    assert.ok(archiveText.includes('runtime/THREE-LICENSE.txt'))
    assert.ok(archiveText.includes('README.md'))
    assert.equal(archiveText.includes(EXPORT_SESSION), false)

    assert.ok(clientSource.includes('files.push({ name: `assets/${asset.id}.${asset.extension}`, bytes: asset.data })'))
    assert.ok(clientSource.includes('const runtimeNames = PROJECT_RUNTIME_FILES'))
    assert.ok(clientSource.includes('zip.size > ASSET_EXPORT_CAPS.zipTotalBytes'))
    assert.ok(clientSource.indexOf('buildExportAssets(\'data\'') < clientSource.indexOf('download(new Blob([html]'),
      'standalone builds assets before downloading')
    assert.ok(clientSource.indexOf('buildExportAssets(\'relative\'') < clientSource.indexOf('download(zip'),
      'ZIP builds assets and checks caps before downloading')
  } finally {
    mock.restore()
  }
})

// ---------------------------------------------------------------------------
// 6. Vendored dependency closure and license
// ---------------------------------------------------------------------------
test('P1-9 vendored loader closure resolves under runtime and the MIT notice is present', async () => {
  const runtimeFiles = plugin.__PROJECT_RUNTIME_FILES
  const loaderFiles = runtimeFiles.filter(name => name.startsWith('loaders/') || name.startsWith('utils/'))
  assert.deepEqual(loaderFiles, [
    'loaders/GLTFLoader.js', 'loaders/HDRLoader.js', 'loaders/RGBELoader.js',
    'utils/BufferGeometryUtils.js', 'utils/SkeletonUtils.js',
  ])
  const seen = new Set()
  const visit = async name => {
    if (seen.has(name)) return
    seen.add(name)
    const raw = await readFile(new URL(`../runtime/${name}`, import.meta.url), 'utf8')
    // Strip block/line comments so `@three_import` docs never look like imports.
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const specifiers = [...source.matchAll(/^\s*import\s+(?:[\s\S]*?\bfrom\s+)?['"]([^'"]+)['"]/gm)].map(match => match[1])
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        const resolved = new URL(specifier, new URL(`../runtime/${name}`, import.meta.url))
        const resolvedName = resolved.pathname.slice(resolved.pathname.indexOf('/runtime/') + '/runtime/'.length)
        assert.ok(runtimeFiles.includes(resolvedName), `${name} -> ${resolvedName} is in the ZIP list`)
        await visit(resolvedName)
      } else {
        assert.equal(specifier, 'three', `${name} imports only the import-mapped three core (saw ${specifier})`)
      }
    }
  }
  for (const name of loaderFiles) await visit(name)
  assert.deepEqual([...seen].sort(), [...loaderFiles].sort(), 'the five assets are a closed dependency set')

  const license = await readFile(new URL('../runtime/THREE-LICENSE.txt', import.meta.url), 'utf8')
  assert.match(license, /The MIT License/)
  assert.match(license, /three\.js authors/)
  await access(new URL('../runtime/loaders/GLTFLoader.js', import.meta.url))
  await access(new URL('../runtime/loaders/HDRLoader.js', import.meta.url))
  await access(new URL('../runtime/loaders/RGBELoader.js', import.meta.url))
  await access(new URL('../runtime/utils/BufferGeometryUtils.js', import.meta.url))
  await access(new URL('../runtime/utils/SkeletonUtils.js', import.meta.url))

  const zipRuntime = clientSource.includes('runtime/THREE-LICENSE.txt')
  const cdnPin = clientSource.includes("const THREE_VERSION = '0.186.1'")
  assert.equal(zipRuntime && cdnPin, true, 'ZIP license notice and pinned CDN version are present')
})
