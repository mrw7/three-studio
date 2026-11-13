/**
 * P3-3 disk persistence tests. Every fixture uses an isolated temporary root
 * with the required TEST-ROOT marker and a fresh process-level store.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { Readable } from 'node:stream'
import { pathToFileURL, fileURLToPath } from 'node:url'

const tempBase = fs.realpathSync(os.tmpdir())
const root = fs.mkdtempSync(path.join(tempBase, 'twb-disk-test-'))
const testToken = randomBytes(16).toString('hex')
fs.writeFileSync(path.join(root, 'TEST-ROOT'), JSON.stringify({
  v: 1,
  kind: 'three-workbench-test-root',
  token: testToken,
  root,
}), { mode: 0o600 })
process.env.THREE_WORKBENCH_DATA_DIR = root
process.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT || 'disk-test-child'

const indexUrl = pathToFileURL(fileURLToPath(new URL('../index.js', import.meta.url))).href
const host = await import(indexUrl)
const disk = host.__diskInternal
const shareInternal = host.__shareInternal
const assetInternal = host.__assetInternal
const historyInternal = host.__historyInternal
const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))
const readmePath = fileURLToPath(new URL('../README.md', import.meta.url))
const indexSourcePath = fileURLToPath(new URL('../index.js', import.meta.url))

function recordingHostContext() {
  const records = { tool: undefined, tools: {}, section: undefined, sections: {}, route: undefined, upload: undefined, routes: [] }
  const ctx = {
    records,
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    inject(names, callback) {
      assert.deepEqual(names, ['webServer'])
      callback(ctx)
    },
    tools: {
      register(definition) {
        records.tools[definition.name] = definition
        if (records.tool === undefined || definition.name === 'three_scene') records.tool = definition
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        records.sections[section.name] = section
        if (records.section === undefined || section.name === 'tool:three-scene') records.section = section
        return () => {}
      },
    },
    webServer: {
      register(route) {
        records.routes.push(route)
        if (route.kind === 'prefix' && route.path === '/three-workbench') records.route = route
        if (route.kind === 'exact' && route.path === '/three-workbench/thumbnail') records.upload = route
        return () => {}
      },
    },
  }
  return ctx
}

const ctx = recordingHostContext()
host.apply(ctx)

function fakeResponse(resolve) {
  return {
    status: 0,
    headers: {},
    body: '',
    destroyed: false,
    writableEnded: false,
    writeHead(code, headers = {}) {
      this.status = code
      this.headers = Object.fromEntries(Object.entries(headers)
        .map(([key, value]) => [key.toLowerCase(), value]))
    },
    end(text) {
      this.writableEnded = true
      this.body = Buffer.isBuffer(text) ? Buffer.from(text) : String(text ?? '')
      resolve(this)
    },
  }
}

function invoke(handler, options = {}) {
  const { method = 'POST', headers = {}, body = Buffer.alloc(0) } = options
  return new Promise(resolve => {
    const req = Readable.from(body.length === 0 ? [] : [body])
    req.method = method
    req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
    const res = fakeResponse(resolve)
    try {
      const result = handler(req, res)
      if (result !== undefined && typeof result.then === 'function') {
        result.catch(() => {
          if (!res.writableEnded) res.end('')
        })
      }
    } catch (error) {
      void error
      if (!res.writableEnded) res.end('')
    }
  })
}

function uploadThumbnail(payload, method = 'POST') {
  return invoke(ctx.records.upload.handler, {
    method,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(payload)),
  })
}

function restoreSession(session, fields) {
  return invoke(historyInternal.restoreHandler, {
    headers: {
      host: 'localhost:3099',
      'content-type': 'application/json',
      'x-workbench-session': session,
    },
    body: Buffer.from(JSON.stringify(fields)),
  })
}

function jsonBody(response) {
  return JSON.parse(Buffer.isBuffer(response.body) ? response.body.toString('utf8') : response.body)
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

// ---------------------------------------------------------------------------
// D2/D8 durable-state helpers. Tests that precreate crash states close the
// store before touching the namespace; a live-process restart is never used as
// durability evidence.
// ---------------------------------------------------------------------------
const HEX32_RE = /^[a-f0-9]{32}$/
const HEX64_RE = /^[a-f0-9]{64}$/
const SLOT_RE = /^[a-f0-9]{32}$/
const LAYOUT_NAMES = ['tmp', 'trash', 'quarantine', 'scenes', 'thumbnails', 'assets', 'shares']
const INTENT_PREFIX = 'twb:scene-boundary-intent:v1\0'

function diskSha(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalPairsHash(pairs, prefix = 'twb:record:v1\n') {
  const chunks = [Buffer.from(prefix, 'utf8')]
  for (const [name, value] of pairs) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
    chunks.push(Buffer.from(String(name), 'utf8'))
    chunks.push(Buffer.from('\0', 'utf8'))
    chunks.push(Buffer.from(String(bytes.length), 'utf8'))
    chunks.push(Buffer.from('\0', 'utf8'))
    chunks.push(bytes)
    chunks.push(Buffer.from('\n', 'utf8'))
  }
  return diskSha(Buffer.concat(chunks))
}

function intentHashFields(intent) {
  return [
    ['v', 1], ['kind', intent.kind], ['sidHash', intent.sidHash], ['slot', intent.slot],
    ['newEpoch', intent.newEpoch], ['newIncarnation', intent.newIncarnation],
    ['newOrder', intent.newOrder], ['newRevisionRecordSha256', intent.newRevisionRecordSha256],
  ]
}

function makeIntent(session, slot, overrides = {}) {
  const intent = {
    v: 1,
    kind: 'scene-generation-boundary',
    sidHash: overrides.sidHash ?? disk.helpers.sceneSidHash(session),
    slot,
    newEpoch: overrides.newEpoch ?? randomBytes(16).toString('hex'),
    newIncarnation: overrides.newIncarnation ?? randomBytes(16).toString('hex'),
    newOrder: overrides.newOrder ?? 5000,
    newRevisionRecordSha256: overrides.newRevisionRecordSha256 ?? randomBytes(32).toString('hex'),
  }
  intent.recordSha256 = canonicalPairsHash(intentHashFields(intent), INTENT_PREFIX)
  if (overrides.recordSha256 !== undefined) intent.recordSha256 = overrides.recordSha256
  return { object: intent, bytes: Buffer.from(JSON.stringify(intent), 'utf8') }
}

function intentPath(slot) {
  return path.join(root, 'trash', `${slot}.intent.json`)
}

function writeIntent(session, slot, overrides = {}) {
  const built = makeIntent(session, slot, overrides)
  fs.writeFileSync(intentPath(slot), built.bytes, { mode: 0o600 })
  return built
}

function makeRevisionRecord(session, epoch, revision, order, code, title = 'fixture duplicate') {
  const object = {
    v: 1,
    kind: 'scene-revision',
    sceneId: session,
    epoch,
    revision,
    order,
    title,
    code,
    bytes: Buffer.byteLength(code, 'utf8'),
    updatedAt: 1000 + revision,
    sha256: diskSha(Buffer.from(code, 'utf8')),
  }
  object.recordSha256 = canonicalPairsHash([
    ['v', 1], ['kind', object.kind], ['sceneId', object.sceneId], ['epoch', object.epoch],
    ['revision', object.revision], ['order', object.order], ['title', object.title],
    ['code', object.code], ['bytes', object.bytes], ['updatedAt', object.updatedAt],
    ['sha256', object.sha256],
  ])
  return { object, bytes: Buffer.from(JSON.stringify(object), 'utf8'), sha256: object.recordSha256 }
}

function makeMarkerRecord(sidHash, order, revision, recordSha256) {
  const object = {
    v: 1,
    kind: 'scene-commit',
    sidHash,
    order,
    revision,
    recordSha256,
  }
  object.markerSha256 = canonicalPairsHash([
    ['v', 1], ['kind', object.kind], ['sidHash', object.sidHash], ['order', object.order],
    ['revision', object.revision], ['recordSha256', object.recordSha256],
  ], 'twb:scene-commit:v1\0')
  return { object, bytes: Buffer.from(JSON.stringify(object), 'utf8') }
}

function readFileOrNull(file) {
  try { return fs.readFileSync(file) } catch (error) { return null }
}

function treeSnapshot(dir) {
  if (!fs.existsSync(dir)) return null
  const out = {}
  const walk = (current, prefix) => {
    const names = fs.readdirSync(current).sort()
    for (const name of names) {
      const full = path.join(current, name)
      const rel = prefix === '' ? name : `${prefix}/${name}`
      const stat = fs.lstatSync(full)
      if (stat.isSymbolicLink()) {
        out[rel] = { type: 'symlink', target: fs.readlinkSync(full) }
      } else if (stat.isDirectory()) {
        out[rel] = { type: 'dir', mode: stat.mode & 0o777 }
        walk(full, rel)
      } else if (stat.isFile()) {
        out[rel] = { type: 'file', mode: stat.mode & 0o777, bytes: fs.readFileSync(full).toString('base64') }
      } else {
        out[rel] = { type: 'other', mode: stat.mode & 0o777 }
      }
    }
  }
  walk(dir, '')
  return out
}

function copyTree(src, dest) {
  const stat = fs.lstatSync(src)
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { mode: 0o700 })
    for (const name of fs.readdirSync(src).sort()) copyTree(path.join(src, name), path.join(dest, name))
    fs.chmodSync(dest, 0o700)
  } else if (stat.isFile()) {
    fs.copyFileSync(src, dest)
    fs.chmodSync(dest, 0o600)
  } else {
    throw new Error('fixture copy supports only regular files and directories')
  }
}

function sceneDir(session) {
  return path.join(root, 'scenes', disk.helpers.sceneSidHash(session))
}

function trashDir() {
  return path.join(root, 'trash')
}

function slotDir(slot) {
  return path.join(trashDir(), slot)
}

function trashSlots() {
  try { return fs.readdirSync(trashDir()).filter(name => SLOT_RE.test(name)).sort() } catch (error) { return [] }
}

function intentNames() {
  try { return fs.readdirSync(trashDir()).filter(name => name.endsWith('.intent.json')).sort() } catch (error) { return [] }
}

function revisionNames(dir) {
  try { return fs.readdirSync(dir).filter(name => /^[0-9]{16}\.json$/.test(name)).sort() } catch (error) { return [] }
}

function markerNames(dir) {
  try { return fs.readdirSync(dir).filter(name => /^[0-9]{16}\.commit\.json$/.test(name)).sort() } catch (error) { return [] }
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function revisionNamesFromSnapshot(snapshot) {
  return Object.keys(snapshot ?? {}).filter(name => /^[0-9]{16}\.json$/.test(name)).sort()
}

function counters() {
  return disk.stats().counters
}

function fence() {
  return disk.inspect().namespaceFence
}

async function sceneGet(session) {
  return ctx.records.route.resource(
    new Request(`http://localhost/three-workbench/scene/${encodeURIComponent(session)}`))
}

async function sceneJson(session) {
  const response = await sceneGet(session)
  assert.equal(response.status, 200)
  return response.json()
}

function sceneExec(session) {
  return { agent: { session: { id: session } } }
}

async function appendScene(session, code) {
  return ctx.records.tool.execute({ code }, sceneExec(session))
}

async function freshStore() {
  try { await disk.closeForTests() } catch (error) { void error }
  if (disk !== undefined) {
    try {
      disk.faults.clear()
      disk.crashAt('')
      disk.clearFixtureLabelsForTests()
    } catch (error) { void error }
  }
  for (const name of LAYOUT_NAMES) fs.rmSync(path.join(root, name), { recursive: true, force: true })
  for (const name of fs.readdirSync(root)) {
    if (/^(?:LOCK|LOCK\.tmp\.[a-f0-9]{32}|LOCK\.stale\.[a-f0-9]{32}|ROOT\.tmp\.[a-f0-9]{32})$/.test(name)) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
    }
  }
  disk.configureForTests({
    startupDeadlineMs: 60000,
    forceStartupDeadlineAfterScanEntries: null,
    recordFenceEvents: false,
    maxRootBytes: 2 * 1024 * 1024 * 1024,
    maxLoadBytes: 1536 * 1024 * 1024,
    maxStagingBytes: 128 * 1024 * 1024,
    maxSceneReadBytes: 512 * 1024 * 1024,
  })
  const started = await disk.restartForTests()
  assert.equal(started.mode, 'disk')
  return started
}

async function stopStore() {
  await disk.closeForTests()
}

async function seedAcknowledged(session, options = {}) {
  const revisions = options.revisions ?? 1
  const assets = options.assets ?? 0
  const label = options.label ?? 'F'
  const seeded = await disk.seedSceneForTests({
    session, revisions, assets, label,
    ...(options.baseOrder === undefined ? {} : { baseOrder: options.baseOrder }),
    ...(options.epoch === undefined ? {} : { epoch: options.epoch }),
  })
  return seeded
}

async function prepareAdoptionBoundary(session, options = {}) {
  await freshStore()
  await seedAcknowledged(session, { revisions: options.revisions ?? 1, assets: options.assets ?? 1 })
  await disk.restartForTests()
  host.__historyInternal.clearScene(session)
  assert.equal((await sceneGet(session)).status, 404)
  return sceneDir(session)
}

function armFault(op, at, count = 1) {
  assert.equal(disk.faults.set({ op, at, count }), true)
}

function traceFsyncDirs() {
  const original = fs.fsyncSync
  const seen = []
  fs.fsyncSync = function tracedFsync(fd) {
    try { seen.push(fs.readlinkSync(`/proc/self/fd/${String(fd)}`)) } catch (error) { void error }
    return original.call(this, fd)
  }
  syncBuiltinESMExports()
  return {
    seen,
    stop() {
      fs.fsyncSync = original
      syncBuiltinESMExports()
    },
  }
}

async function waitForCondition(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function assetSessionDir(session) {
  return path.join(root, 'assets', disk.helpers.sceneSidHash(session))
}

function ownerRecordPath(session) {
  return path.join(assetSessionDir(session), 'owner.json')
}

async function uploadAsset(session, name = 'fixture.png', body = PNG) {
  return invoke(assetInternal.uploadHandler, {
    headers: {
      'x-workbench-session': session,
      'x-workbench-name': encodeURIComponent(name),
      'content-type': 'image/png',
    },
    body,
  })
}

async function listAssets(session) {
  const response = await assetInternal.listResponse(new Request(
    'http://localhost/three-workbench/assets',
    { headers: { 'x-workbench-session': session } }))
  return { status: response.status, body: await response.json() }
}

function rewriteOneAssetEpochMismatch(session, mismatchedEpoch) {
  const sessionDir = assetSessionDir(session)
  const hashes = fs.readdirSync(sessionDir)
    .filter(name => HEX64_RE.test(name) && fs.existsSync(path.join(sessionDir, name, 'meta.json')))
    .sort()
  assert.ok(hashes.length >= 1)
  const entries = hashes.map(hash => {
    const file = path.join(sessionDir, hash, 'meta.json')
    return { hash, file, meta: JSON.parse(fs.readFileSync(file, 'utf8')) }
  })
  const mismatch = entries[0]
  mismatch.meta.sceneEpoch = mismatchedEpoch
  mismatch.meta.recordSha256 = canonicalPairsHash([
    ['v', 1], ['kind', mismatch.meta.kind], ['sceneId', mismatch.meta.sceneId],
    ['sceneEpoch', mismatch.meta.sceneEpoch], ['id', mismatch.meta.id],
    ['name', mismatch.meta.name], ['nameFold', mismatch.meta.nameFold],
    ['assetKind', mismatch.meta.assetKind], ['mime', mismatch.meta.mime],
    ['ext', mismatch.meta.ext], ['bytes', mismatch.meta.bytes], ['order', mismatch.meta.order],
    ['createdAt', mismatch.meta.createdAt], ['sha256', mismatch.meta.sha256],
  ])
  durableViewAdapter()
    .write(mismatch.file, Buffer.from(JSON.stringify(mismatch.meta), 'utf8'))
    .materialize()
  return { mismatch, matching: entries[1] ?? null }
}

async function waitForCleanupIdle() {
  assert.equal(await disk.cleanupIdleForTests(10000), true)
}

function quarantineSceneEntries() {
  try { return fs.readdirSync(path.join(root, 'quarantine', 'scenes')) } catch (error) { return [] }
}

async function waitForPause(pause, label, timeoutMs = 5000) {
  let timer
  try {
    await Promise.race([
      pause.arrival,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(
          `timed out waiting for ${label}: ${JSON.stringify(disk.inspect())}`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function fenceEventIndex(events, name) {
  return events.indexOf(name)
}

// Durable-view adapter: every materialized entry is a write whose creating
// fsync has explicitly completed; a caller can omit non-durable entries before
// materialization. This models a closed-store durable view, never a live
// process view whose restart is being mistaken for durability evidence.
const FSYNC_DIR = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY
function fsyncFileForFixture(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY)
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function fsyncDirForFixture(dir) {
  const fd = fs.openSync(dir, FSYNC_DIR)
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
function durableViewAdapter() {
  const entries = []
  return {
    write(file, bytes, durable = true) { entries.push({ kind: 'file', file, bytes, durable }); return this },
    mkdir(dir, durable = true) { entries.push({ kind: 'mkdir', dir, durable }); return this },
    copyTree(src, dest, durable = true) { entries.push({ kind: 'copy', src, dest, durable }); return this },
    remove(target, durable = true) { entries.push({ kind: 'remove', target, durable }); return this },
    materialize() {
      for (const entry of entries) {
        if (!entry.durable) continue
        if (entry.kind === 'remove') {
          fs.rmSync(entry.target, { recursive: true, force: true })
          fsyncDirForFixture(path.dirname(entry.target))
          continue
        }
        if (entry.kind === 'mkdir') {
          fs.mkdirSync(entry.dir, { recursive: true, mode: 0o700 })
          fs.chmodSync(entry.dir, 0o700)
          fsyncDirForFixture(entry.dir)
          fsyncDirForFixture(path.dirname(entry.dir))
          continue
        }
        if (entry.kind === 'file') {
          fs.mkdirSync(path.dirname(entry.file), { recursive: true, mode: 0o700 })
          fs.writeFileSync(entry.file, entry.bytes, { mode: 0o600 })
          fsyncFileForFixture(entry.file)
          fsyncDirForFixture(path.dirname(entry.file))
          continue
        }
        copyTree(entry.src, entry.dest)
        const walk = (dir) => {
          for (const name of fs.readdirSync(dir).sort()) {
            const full = path.join(dir, name)
            const stat = fs.lstatSync(full)
            if (stat.isDirectory()) walk(full)
            else fsyncFileForFixture(full)
          }
          fsyncDirForFixture(dir)
        }
        walk(entry.dest)
        fsyncDirForFixture(path.dirname(entry.dest))
      }
      return entries.filter(entry => entry.durable).length
    },
  }
}

after(async () => {
  try { await disk.closeForTests() } catch (error) { void error }
  fs.rmSync(root, { recursive: true, force: true })
})

test('isolated disk store persists acknowledged scene revisions across restart', async () => {
  const started = await disk.restartForTests()
  assert.equal(started.mode, 'disk')
  assert.equal(disk.mode(), 'disk')
  const exec = { agent: { session: { id: 'sess-disk-persist' } } }
  const first = await ctx.records.tool.execute({ title: 'First', code: 'const first = 1' }, exec)
  assert.equal(first.revision, 1)
  const second = await ctx.records.tool.execute({ code: 'const second = 2' }, exec)
  assert.equal(second.revision, 2)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const response = await ctx.records.route.resource(
    new Request('http://localhost/three-workbench/scene/sess-disk-persist'))
  assert.equal(response.status, 200)
  const scene = await response.json()
  assert.equal(scene.revision, 2)
  assert.equal(scene.code, 'const second = 2')
  assert.equal(disk.inspect().namespaceFence.state, 'normal')
})

test('seeded committed history is trimmed to the product revision cap on startup', async () => {
  await disk.restartForTests()
  await disk.seedSceneForTests({ session: 'sess-disk-seed', revisions: 14, label: 'S1' })
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const view = disk.inspect()
  assert.deepEqual(view.keys, ['S1'])
  const fixture = view.fixtures.S1
  assert.equal(fixture.revisionOrderCount, 12)
  assert.equal(Object.keys(fixture.ordersByRevision).length, 12)
  assert.equal(fixture.recordedEntryPresent, false)
  assert.equal(typeof fixture.epoch, 'string')
  assert.match(fixture.epoch, /^[a-f0-9]{32}$/)
  assert.deepEqual(fixture.ordersByRevision, Object.fromEntries(
    Object.entries(fixture.ordersByRevision).sort((left, right) => Number(left[0]) - Number(right[0]))))
})

test('concurrent appends are serialized and both acknowledged revisions survive restart', async () => {
  await disk.restartForTests()
  const exec = { agent: { session: { id: 'sess-disk-concurrent' } } }
  const results = await Promise.all([
    ctx.records.tool.execute({ code: 'const concurrent = 1' }, exec),
    ctx.records.tool.execute({ code: 'const concurrent = 2' }, exec),
  ])
  assert.deepEqual(results.map(item => item.revision).sort((a, b) => a - b), [1, 2])
  await disk.restartForTests()
  const response = await ctx.records.route.resource(
    new Request('http://localhost/three-workbench/scene/sess-disk-concurrent'))
  assert.equal(response.status, 200)
  const scene = await response.json()
  assert.equal(scene.revision, 2)
})

test('marker fault never acknowledges a revision and restart recovers a clean append', async () => {
  await disk.restartForTests()
  const exec = { agent: { session: { id: 'sess-disk-marker-fault' } } }
  assert.equal(disk.faults.set({
    op: 'sceneCommitMarker', at: 'beforeSceneCommitMarker', count: 1,
  }), true)
  await assert.rejects(ctx.records.tool.execute({ code: 'const failed = 1' }, exec))
  assert.equal(counters().sceneWriteDegraded, true)
  assert.equal(counters().sceneWritePreserve, false)
  assert.equal((await sceneGet('sess-disk-marker-fault')).status, 404)
  await assert.rejects(ctx.records.tool.execute({ code: 'const blockedByDegraded = 1' }, exec))
  disk.faults.clear()
  await disk.restartForTests()
  assert.equal(counters().sceneWriteDegraded, false)
  const recovered = await ctx.records.tool.execute({ code: 'const recovered = 1' }, exec)
  assert.equal(recovered.revision, 1)
  await disk.restartForTests()
  const response = await ctx.records.route.resource(
    new Request('http://localhost/three-workbench/scene/sess-disk-marker-fault'))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).revision, 1)
})

test('startup phase fault degrades without throwing and a later restart becomes ready', async () => {
  await disk.restartForTests()
  assert.equal(disk.faults.set({ op: 'startup', at: 'startupScenes', count: 1 }), true)
  const failed = await disk.restartForTests()
  assert.notEqual(failed.mode, 'disk')
  disk.faults.clear()
  const recovered = await disk.restartForTests()
  assert.equal(recovered.mode, 'disk')
  assert.equal(disk.ready(), true)
})

test('thumbnail, asset and share artifacts round-trip through restart and deletion', async () => {
  await disk.restartForTests()
  const exec = { agent: { session: { id: 'sess-disk-media' } } }
  await ctx.records.tool.execute({ title: 'Media', code: 'const media = 1' }, exec)
  const thumb = await uploadThumbnail({
    sessionId: 'sess-disk-media', revision: 1, dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
  })
  assert.equal(thumb.status, 200)
  const uploaded = await invoke(assetInternal.uploadHandler, {
    headers: {
      'x-workbench-session': 'sess-disk-media',
      'x-workbench-name': encodeURIComponent('pixel.png'),
      'content-type': 'image/png',
    },
    body: PNG,
  })
  assert.equal(uploaded.status, 201)
  const assetId = jsonBody(uploaded).asset.id
  await disk.restartForTests()
  const thumbAfter = await ctx.records.route.resource(
    new Request('http://localhost/three-workbench/thumbnail/sess-disk-media/1'))
  assert.equal(thumbAfter.status, 200)
  const listAfter = await assetInternal.listResponse(new Request('http://localhost/three-workbench/assets', {
    headers: { 'x-workbench-session': 'sess-disk-media' },
  }))
  assert.equal(listAfter.status, 200)
  const rows = await listAfter.json()
  assert.equal(rows.assets.length, 1)
  assert.equal(rows.assets[0].name, 'pixel.png')
  const sharePayload = {
    revision: 1,
    document: '<!doctype html><html><body>shared fixture</body></html>',
    editorState: {
      v: 2,
      objects: {},
      tracks: { v: 1, items: [] },
      params: { v: 1, values: {} },
      camera: null,
    },
    stepFps: 30,
  }
  const created = await invoke(shareInternal.createHandler, {
    headers: {
      host: 'localhost:3099',
      'x-workbench-session': 'sess-disk-media',
      'content-type': 'application/json',
    },
    body: Buffer.from(JSON.stringify(sharePayload)),
  })
  assert.equal(created.status, 200)
  const createdShare = jsonBody(created)
  assert.equal(typeof createdShare.id, 'string')
  assert.equal(typeof createdShare.deleteKey, 'string')
  const bytesBeforeDelete = disk.stats().bytes.used
  await disk.restartForTests()
  const bytesAfterRestart = disk.stats().bytes.used
  assert.notEqual(shareInternal.rawShare(createdShare.id), undefined)
  const deletedShare = await invoke(shareInternal.deleteHandler, {
    headers: { host: 'localhost:3099', 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ id: createdShare.id, deleteKey: createdShare.deleteKey })),
  })
  assert.equal(deletedShare.status, 200)
  const bytesAfterShareDelete = disk.stats().bytes.used
  const deletedAsset = await invoke(assetInternal.deleteHandler, {
    headers: { 'x-workbench-session': 'sess-disk-media', 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ id: assetId })),
  })
  assert.equal(deletedAsset.status, 200)
  const bytesAfterAssetDelete = disk.stats().bytes.used
  await disk.restartForTests()
  const bytesAfterFinalRestart = disk.stats().bytes.used
  assert.equal(shareInternal.rawShare(createdShare.id), undefined)
  assert.equal(assetInternal.rawAsset(assetId), undefined)
  assert.ok(bytesAfterFinalRestart < bytesBeforeDelete)
  const thumbAfterDelete = await ctx.records.route.resource(
    new Request('http://localhost/three-workbench/thumbnail/sess-disk-media/1'))
  assert.equal(thumbAfterDelete.status, 200)
})

test('root budget exhaustion fails before acknowledgement and a higher budget recovers', async () => {
  await disk.restartForTests()
  const exec = { agent: { session: { id: 'sess-disk-budget' } } }
  disk.configureForTests({ maxRootBytes: 64 })
  await assert.rejects(ctx.records.tool.execute({ code: 'const budget = 1' }, exec))
  assert.equal((await ctx.records.route.resource(
    new Request('http://localhost/three-workbench/scene/sess-disk-budget'))).status, 404)
  disk.configureForTests({ maxRootBytes: 2 * 1024 * 1024 * 1024 })
  const accepted = await ctx.records.tool.execute({ code: 'const budget = 2' }, exec)
  assert.equal(accepted.revision, 1)
})

test('undrainable trash above the pressure threshold blocks new mutations', async () => {
  await disk.restartForTests()
  const exec = { agent: { session: { id: 'sess-disk-trash-pressure' } } }
  await ctx.records.tool.execute({ code: 'const pressure = 1' }, exec)
  const uploaded = await invoke(assetInternal.uploadHandler, {
    headers: {
      'x-workbench-session': 'sess-disk-trash-pressure',
      'x-workbench-name': encodeURIComponent('pressure.png'),
      'content-type': 'image/png',
    },
    body: PNG,
  })
  assert.equal(uploaded.status, 201)
  const assetId = jsonBody(uploaded).asset.id
  assert.equal(disk.faults.set({
    op: 'deleteRename', at: 'afterDeleteRename', count: 1,
  }), true)
  const failedDelete = await invoke(assetInternal.deleteHandler, {
    headers: { 'x-workbench-session': 'sess-disk-trash-pressure', 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ id: assetId })),
  })
  assert.equal(failedDelete.status, 503)
  const trashDir = path.join(root, 'trash')
  const slots = fs.readdirSync(trashDir).filter(name => /^[a-f0-9]{32}$/.test(name))
  const assetSlot = slots.find(name => fs.existsSync(path.join(trashDir, name, 'meta.json')))
  assert.equal(typeof assetSlot, 'string')
  const blocker = path.join(trashDir, assetSlot, 'pressure-blocker')
  fs.mkdirSync(blocker, { mode: 0o700 })
  const largeFd = fs.openSync(path.join(blocker, 'large.bin'), 'wx', 0o600)
  fs.ftruncateSync(largeFd, 128 * 1024 * 1024 + 1)
  fs.closeSync(largeFd)
  fs.chmodSync(blocker, 0o000)
  try {
    await assert.rejects(ctx.records.tool.execute({ code: 'const blocked = 1' }, exec))
  } finally {
    fs.chmodSync(blocker, 0o700)
  }
  const accepted = await ctx.records.tool.execute({ code: 'const accepted = 2' }, exec)
  assert.equal(accepted.revision, 2)
  await disk.restartForTests()
  const response = await ctx.records.route.resource(
    new Request('http://localhost/three-workbench/scene/sess-disk-trash-pressure'))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).revision, 2)
})

test('an asset directory with an unexpected entry is quarantined rather than loaded', async () => {
  await disk.restartForTests()
  await disk.seedSceneForTests({
    session: 'sess-disk-quarantine', revisions: 1, assets: 1, label: 'Q1',
  })
  const sidHash = disk.helpers.sceneSidHash('sess-disk-quarantine')
  const sessionDir = path.join(root, 'assets', sidHash)
  const assetHashes = fs.readdirSync(sessionDir).filter(name => /^[a-f0-9]{64}$/.test(name))
  assert.equal(assetHashes.length, 1)
  fs.writeFileSync(path.join(sessionDir, assetHashes[0], 'unexpected.bin'), Buffer.from([1]), { mode: 0o600 })
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const response = await assetInternal.listResponse(new Request('http://localhost/three-workbench/assets', {
    headers: { 'x-workbench-session': 'sess-disk-quarantine' },
  }))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).assets.length, 0)
  assert.ok(disk.pathsFor().names.quarantine.length >= 1)
})

test('an isolated runner without TEST-ROOT stays memory-only', () => {
  const childRoot = fs.mkdtempSync(path.join(tempBase, 'twb-disk-memory-'))
  const scriptPath = path.join(childRoot, 'probe.mjs')
  try {
    fs.writeFileSync(scriptPath, [
      `import { apply, __diskInternal } from ${JSON.stringify(indexUrl)}`,
      'const ctx = {',
      '  effect(fn) { fn() },',
      '  inject(names, callback) { callback(ctx) },',
      '  tools: { register() {} },',
      '  systemPrompt: { section() {} },',
      '  webServer: { register() {} },',
      '}',
      'apply(ctx)',
      'await new Promise(resolve => setTimeout(resolve, 50))',
      'process.stdout.write("DISK_PROBE:" + JSON.stringify({ mode: __diskInternal.mode(), status: __diskInternal.status() }) + "\\n")',
    ].join('\n'), { mode: 0o600 })
    const childEnv = {
      ...process.env,
      THREE_WORKBENCH_DATA_DIR: childRoot,
    }
    delete childEnv.NODE_TEST_CONTEXT
    const child = spawnSync(process.execPath, ['--test', scriptPath], {
      env: childEnv,
      encoding: 'utf8',
      timeout: 20000,
    })
    assert.equal(child.status, 0)
    const lines = child.stdout.split('\n').filter(line => line.startsWith('DISK_PROBE:'))
    assert.ok(lines.length >= 1)
    const result = JSON.parse(lines[lines.length - 1].slice('DISK_PROBE:'.length))
    assert.equal(result.mode, 'memory')
    assert.equal(result.status, 'test-memory')
  } finally {
    fs.rmSync(childRoot, { recursive: true, force: true })
  }
})

// ===========================================================================
// D2(i) old-slot classification. Every fixture precreates the durable state.
// ===========================================================================
test('D2(i) old-slot unknown regular entry is fail-closed and preserved byte-for-byte', async () => {
  const session = 'sess-d2i-unknown-regular'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 1 })
  await stopStore()
  const slot = randomBytes(16).toString('hex')
  fs.renameSync(sceneDir(session), slotDir(slot))
  fs.writeFileSync(path.join(slotDir(slot), 'unexpected.bin'), Buffer.from([0, 1, 2, 3]), { mode: 0o600 })
  const intent = writeIntent(session, slot, { newOrder: 7001 })
  const slotBefore = treeSnapshot(slotDir(slot))
  const intentBefore = fs.readFileSync(intentPath(slot))

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupBoundaryIntents, 1)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.startupBoundaryRecovery, 1)
  assert.equal(c.startupBoundaryTruncated, 0)
  assert.equal(c.startupRestored, 0)
  assert.equal(c.startupInert, 0)
  assert.equal(c.sceneWritePreserve, true)
  assert.equal(c.sceneWriteDegraded, false)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 0)
  assert.equal(f.startupRestoreScenesParentFsync, 0)
  assert.equal(f.startupInertScenesParentFsync, 0)
  assert.equal(f.startupTrashParentFsync, 0)
  assert.deepEqual(treeSnapshot(slotDir(slot)), slotBefore)
  assert.deepEqual(fs.readFileSync(intentPath(slot)), intentBefore)
  assert.equal((await sceneGet(session)).status, 404)
  // CON-m-11: a preserved old slot with known valid revisions gets no
  // sceneEpochs/sceneRevisionOrderBySession/deleteAssetSessionRecorded entry.
  const preserved = disk.inspect().fixtures.F
  assert.equal(preserved.epoch, null)
  assert.equal(preserved.revisionOrderCount, 0)
  assert.deepEqual(preserved.ordersByRevision, {})
  assert.equal(preserved.recordedEntryPresent, false)
  assert.equal(preserved.recordedAssetCount, 0)
  await assert.rejects(appendScene(session, 'const mustNotAppend = 1'))
  assert.equal(disk.stats().counters.sceneWritePreserve, true)
  void intent
})

test('D2(i) old-slot real revision plus marker restores acknowledged history', async () => {
  const session = 'sess-d2i-real-generation'
  await freshStore()
  await seedAcknowledged(session, { revisions: 2, assets: 1 })
  await stopStore()
  const slot = randomBytes(16).toString('hex')
  fs.renameSync(sceneDir(session), slotDir(slot))
  const slotBefore = treeSnapshot(slotDir(slot))
  writeIntent(session, slot, { newOrder: 7002 })
  const intentBefore = fs.readFileSync(intentPath(slot))

  const fsyncTrace = traceFsyncDirs()
  let restarted
  try {
    restarted = await disk.restartForTests()
  } finally {
    fsyncTrace.stop()
  }
  assert.equal(fsyncTrace.seen.includes(path.join(root, 'scenes')), true)
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupRestored, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.sceneWritePreserve, false)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 1)
  assert.equal(f.startupTrashParentFsync, 1)
  assert.equal(f.startupInertScenesParentFsync, 0)
  assert.equal(trashSlots().includes(slot), false)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.notDeepEqual(treeSnapshot(sceneDir(session)), null)
  assert.deepEqual(revisionNames(sceneDir(session)), revisionNamesFromSnapshot(slotBefore))
  const scene = await sceneJson(session)
  assert.equal(scene.revision, 2)
  assert.match(scene.code, /revision 2/)
  void intentBefore
})

test('D2(i) old-slot marker-only orphan is preserved, never acknowledged, never deleted by reconciliation', async () => {
  const session = 'sess-d2i-marker-only'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1 })
  await stopStore()
  const slot = randomBytes(16).toString('hex')
  fs.renameSync(sceneDir(session), slotDir(slot))
  for (const name of revisionNames(slotDir(slot))) fs.rmSync(path.join(slotDir(slot), name))
  const markerBefore = markerNames(slotDir(slot)).map(name => [name, fs.readFileSync(path.join(slotDir(slot), name))])
  assert.equal(markerBefore.length, 1)
  writeIntent(session, slot, { newOrder: 7003 })

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupRestored, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.sceneWritePreserve, false)
  const f = fence()
  assert.equal(f.startupRestoreRename, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 1)
  assert.equal(f.startupTrashParentFsync, 1)
  assert.equal(trashSlots().includes(slot), false)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.equal((await sceneGet(session)).status, 404)
  const seen = []
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const stat = fs.lstatSync(full)
      if (stat.isDirectory()) walk(full)
      else if (stat.isFile()) seen.push([name, fs.readFileSync(full)])
    }
  }
  walk(root)
  for (const [, bytes] of markerBefore) {
    assert.equal(seen.some(([, candidate]) => candidate.equals(bytes)), true)
  }
  assert.ok(c.quarantined >= 1)
})

test('D2(i) old-slot corrupt revision is mismatched, preserved and never restored', async () => {
  const session = 'sess-d2i-corrupt-revision'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1 })
  await stopStore()
  const slot = randomBytes(16).toString('hex')
  fs.renameSync(sceneDir(session), slotDir(slot))
  const [revision] = revisionNames(slotDir(slot))
  fs.writeFileSync(path.join(slotDir(slot), revision), Buffer.from('{"v":1,"kind":"scene-revision"}'), { mode: 0o600 })
  writeIntent(session, slot, { newOrder: 7004 })
  const slotBefore = treeSnapshot(slotDir(slot))
  const intentBefore = fs.readFileSync(intentPath(slot))

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupRestored, 0)
  assert.equal(c.startupBoundaryRecovery, 1)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.sceneWritePreserve, true)
  assert.equal(fence().startupRestoreRename, 0)
  assert.equal(fence().startupRestoreScenesParentFsync, 0)
  assert.equal(fence().startupTrashParentFsync, 0)
  assert.deepEqual(treeSnapshot(slotDir(slot)), slotBefore)
  assert.deepEqual(fs.readFileSync(intentPath(slot)), intentBefore)
  assert.equal((await sceneGet(session)).status, 404)
  await assert.rejects(appendScene(session, 'const corruptSlot = 1'))
})

test('D2(i) old-slot empty slot is valid and restores an empty generation', async () => {
  const session = 'sess-d2i-empty-slot'
  await freshStore()
  await stopStore()
  const slot = randomBytes(16).toString('hex')
  fs.mkdirSync(slotDir(slot), { mode: 0o700 })
  writeIntent(session, slot, { newOrder: 7005 })

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupRestored, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.sceneWritePreserve, false)
  const f = fence()
  assert.equal(f.startupRestoreRename, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 1)
  assert.equal(f.startupTrashParentFsync, 1)
  assert.equal(trashSlots().includes(slot), false)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.equal(fs.existsSync(sceneDir(session)), true)
  assert.deepEqual(fs.readdirSync(sceneDir(session)), [])
  assert.equal((await sceneGet(session)).status, 404)
})

test('D2(i) old-slot symlink and directory revision/marker patterns are mismatched and preserved', async () => {
  const sessionA = 'sess-d2i-nonregular-a'
  const sessionB = 'sess-d2i-nonregular-b'
  await freshStore()
  await seedAcknowledged(sessionA, { revisions: 1, label: 'F' })
  await seedAcknowledged(sessionB, { revisions: 1, label: 'F' })
  await stopStore()
  const slotA = randomBytes(16).toString('hex')
  const slotB = randomBytes(16).toString('hex')
  fs.renameSync(sceneDir(sessionA), slotDir(slotA))
  fs.renameSync(sceneDir(sessionB), slotDir(slotB))
  const realRevision = revisionNames(slotDir(slotA))[0]
  fs.symlinkSync(realRevision, path.join(slotDir(slotA), '9999999999999999.json'))
  fs.symlinkSync('9999999999999999.commit.json', path.join(slotDir(slotA), '9999999999999998.commit.json'))
  fs.mkdirSync(path.join(slotDir(slotB), '9999999999999997.json'), { mode: 0o700 })
  fs.mkdirSync(path.join(slotDir(slotB), '9999999999999996.commit.json'), { mode: 0o700 })
  writeIntent(sessionA, slotA, { newOrder: 7006 })
  writeIntent(sessionB, slotB, { newOrder: 7007 })
  const beforeA = treeSnapshot(slotDir(slotA))
  const beforeB = treeSnapshot(slotDir(slotB))
  const intentA = fs.readFileSync(intentPath(slotA))
  const intentB = fs.readFileSync(intentPath(slotB))

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupRestored, 0)
  assert.equal(c.startupBoundaryRecovery, 2)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.sceneWritePreserve, true)
  assert.equal(fence().startupRestoreRename, 0)
  assert.equal(fence().startupRestoreScenesParentFsync, 0)
  assert.equal(fence().startupTrashParentFsync, 0)
  assert.deepEqual(treeSnapshot(slotDir(slotA)), beforeA)
  assert.deepEqual(treeSnapshot(slotDir(slotB)), beforeB)
  assert.deepEqual(fs.readFileSync(intentPath(slotA)), intentA)
  assert.deepEqual(fs.readFileSync(intentPath(slotB)), intentB)
  assert.equal((await sceneGet(sessionA)).status, 404)
  assert.equal((await sceneGet(sessionB)).status, 404)
  assert.equal(fs.lstatSync(path.join(slotDir(slotA), '9999999999999999.json')).isSymbolicLink(), true)
  assert.equal(fs.lstatSync(path.join(slotDir(slotB), '9999999999999997.json')).isDirectory(), true)
})

test('D2(i) invalid boundary intent variants are counted, preserved and never restore or delete', async () => {
  const sessions = [
    'sess-d2i-invalid-extra',
    'sess-d2i-invalid-version',
    'sess-d2i-invalid-kind',
    'sess-d2i-invalid-prefix',
    'sess-d2i-invalid-hash',
    'sess-d2i-invalid-oldform',
    'sess-d2i-invalid-reformatted',
  ]
  await freshStore()
  for (const session of sessions) await seedAcknowledged(session, { revisions: 1, label: 'F' })
  await stopStore()
  const slots = sessions.map(() => randomBytes(16).toString('hex'))
  sessions.forEach((session, index) => fs.renameSync(sceneDir(session), slotDir(slots[index])))
  const written = []
  const addRaw = (filenameSlot, bytes) => {
    const file = path.join(trashDir(), `${filenameSlot}.intent.json`)
    fs.writeFileSync(file, bytes, { mode: 0o600 })
    written.push(file)
  }

  const extra = makeIntent(sessions[0], slots[0], { newOrder: 7101 }).object
  extra.unexpected = 'field'
  addRaw(slots[0], Buffer.from(JSON.stringify(extra)))

  const wrongVersion = makeIntent(sessions[1], slots[1], { newOrder: 7102 }).object
  wrongVersion.v = 2
  addRaw(slots[1], Buffer.from(JSON.stringify(wrongVersion)))

  const wrongKind = makeIntent(sessions[2], slots[2], { newOrder: 7103 }).object
  wrongKind.kind = 'scene-generation-boundary-v2'
  addRaw(slots[2], Buffer.from(JSON.stringify(wrongKind)))

  // The encoded slot does not match the filename prefix. The real slot named
  // by the basename is the one that must be preserved.
  const mismatch = makeIntent(sessions[3], slots[3], { newOrder: 7104 }).object
  mismatch.slot = randomBytes(16).toString('hex')
  addRaw(slots[3], Buffer.from(JSON.stringify(mismatch)))

  const badHash = makeIntent(sessions[4], slots[4], { newOrder: 7105 }).object
  badHash.recordSha256 = randomBytes(32).toString('hex')
  addRaw(slots[4], Buffer.from(JSON.stringify(badHash)))

  const oldForm = makeIntent(sessions[5], slots[5], { newOrder: 7106 }).object
  delete oldForm.newRevisionRecordSha256
  addRaw(slots[5], Buffer.from(JSON.stringify(oldForm)))

  const reformatted = makeIntent(sessions[6], slots[6], { newOrder: 7107 }).object
  addRaw(slots[6], Buffer.from(JSON.stringify(reformatted, null, 2)))

  const intentsBefore = new Map(written.map(file => [file, fs.readFileSync(file)]))
  const slotsBefore = new Map(slots.map(slot => [slot, treeSnapshot(slotDir(slot))]))
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupBoundaryIntents, written.length)
  assert.equal(c.startupBoundaryInvalid, written.length)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.startupBoundaryTruncated, 0)
  assert.equal(c.startupRestored, 0)
  assert.equal(c.startupInert, 0)
  assert.equal(c.sceneWritePreserve, false)
  const f = fence()
  assert.equal(f.startupRestoreRename, 0)
  assert.equal(f.startupRestoreScenesParentFsync, 0)
  assert.equal(f.startupTrashParentFsync, 0)
  for (const [file, before] of intentsBefore) assert.deepEqual(fs.readFileSync(file), before)
  for (const [slot, before] of slotsBefore) assert.deepEqual(treeSnapshot(slotDir(slot)), before)
  for (const session of sessions) assert.equal((await sceneGet(session)).status, 404)
})

// ===========================================================================
// D2(iii)/D8 startup reconciliation. Each durable state is precreated while
// the store is closed; the restart is the evidence.
// ===========================================================================
test('D2(iii)/D8 startup restore rename failure preserves slot and intent, then a clean restart restores', async () => {
  const session = 'sess-d8-restore-rename'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 1 })
  await stopStore()
  const slot = randomBytes(16).toString('hex')
  const intent = makeIntent(session, slot, { newOrder: 7201 })
  durableViewAdapter()
    .copyTree(sceneDir(session), slotDir(slot))
    .remove(sceneDir(session))
    .write(intentPath(slot), intent.bytes)
    .materialize()
  const slotBefore = treeSnapshot(slotDir(slot))
  const intentBefore = fs.readFileSync(intentPath(slot))
  armFault('trashRename', 'scene-generation-boundary-startup-restore', 1)

  const failed = await disk.restartForTests()
  assert.equal(failed.mode, 'disk')
  let c = counters()
  assert.equal(c.startupBoundaryIntents, 1)
  assert.equal(c.startupBoundaryRecovery, 1)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.startupRestored, 0)
  assert.equal(c.startupInert, 0)
  assert.equal(c.sceneWritePreserve, true)
  let f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 0)
  assert.equal(f.startupRestoreScenesParentFsync, 0)
  assert.equal(f.startupInertScenesParentFsync, 0)
  assert.equal(f.startupTrashParentFsync, 0)
  assert.deepEqual(treeSnapshot(slotDir(slot)), slotBefore)
  assert.deepEqual(fs.readFileSync(intentPath(slot)), intentBefore)
  assert.equal((await sceneGet(session)).status, 404)
  await assert.rejects(appendScene(session, 'const preserveAfterRenameFailure = 1'))

  disk.faults.clear()
  const restored = await disk.restartForTests()
  assert.equal(restored.mode, 'disk')
  c = counters()
  assert.equal(c.startupRestored, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.sceneWritePreserve, false)
  f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 1)
  assert.equal(f.startupTrashParentFsync, 1)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.equal(trashSlots().includes(slot), false)
  assert.equal((await sceneJson(session)).revision, 1)

  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(counters().startupBoundaryIntents, 0)
  assert.equal(fs.existsSync(intentPath(slot)), false)
})

test('D2(iii)/D8 startup restore destination fsync failure poisons, preserves the intent, then repairs', async () => {
  const session = 'sess-d8-restore-fsync'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 1 })
  await stopStore()
  const slot = randomBytes(16).toString('hex')
  const intent = makeIntent(session, slot, { newOrder: 7202 })
  durableViewAdapter()
    .copyTree(sceneDir(session), slotDir(slot))
    .remove(sceneDir(session))
    .write(intentPath(slot), intent.bytes)
    .materialize()
  const intentBefore = fs.readFileSync(intentPath(slot))
  const oldFiles = treeSnapshot(slotDir(slot))
  armFault('dirFsync', 'scene-generation-boundary-startup-restore-scenes-parent', 1)

  const failed = await disk.restartForTests()
  assert.equal(failed.mode, 'disk')
  let c = counters()
  assert.equal(c.startupBoundaryRecovery, 1)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.startupRestored, 0)
  assert.equal(c.startupInert, 0)
  assert.equal(c.sceneWritePreserve, true)
  let f = fence()
  assert.equal(f.state, 'namespace-recovery-required')
  assert.equal(f.startupRestoreRename, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 0)
  assert.equal(f.startupInertScenesParentFsync, 0)
  assert.equal(f.startupTrashParentFsync, 0)
  assert.equal(trashSlots().includes(slot), false)
  assert.equal(fs.existsSync(intentPath(slot)), true)
  assert.deepEqual(fs.readFileSync(intentPath(slot)), intentBefore)
  const restoredNames = new Set(Object.keys(treeSnapshot(sceneDir(session))))
  assert.equal(restoredNames.has('owner.json'), false)
  for (const name of revisionNamesFromSnapshot(oldFiles)) assert.equal(restoredNames.has(name), true)
  for (const name of Object.keys(oldFiles).filter(name => /^[0-9]{16}\.commit\.json$/.test(name))) {
    assert.equal(restoredNames.has(name), true)
  }
  assert.equal((await sceneJson(session)).revision, 1)
  await assert.rejects(appendScene(session, 'const poisonedRestore = 1'))

  disk.faults.clear()
  const repaired = await disk.restartForTests()
  assert.equal(repaired.mode, 'disk')
  c = counters()
  assert.equal(c.startupBoundaryIntents, 1)
  assert.equal(c.startupInert, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.startupRestored, 0)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.sceneWritePreserve, false)
  f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupInertScenesParentFsync, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 0)
  assert.equal(f.startupRestoreRename, 0)
  assert.equal(f.startupTrashParentFsync, 1)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.equal(trashSlots().includes(slot), false)
  assert.equal((await sceneJson(session)).revision, 1)

  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(counters().startupBoundaryIntents, 0)
})

test('D2(iii)/D8 startup inert fsync failure poisons, preserves intent and skips ordinary trash cleanup', async () => {
  const session = 'sess-d8-inert-fsync'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 1 })
  await stopStore()
  const slot = randomBytes(16).toString('hex')
  writeIntent(session, slot, { newOrder: 7203 })
  const intentBefore = fs.readFileSync(intentPath(slot))
  const ordinary = randomBytes(16).toString('hex')
  fs.mkdirSync(slotDir(ordinary), { mode: 0o700 })
  fs.writeFileSync(path.join(slotDir(ordinary), 'ordinary.bin'), Buffer.from('ordinary'), { mode: 0o600 })
  const oldScene = treeSnapshot(sceneDir(session))
  armFault('dirFsync', 'scene-generation-boundary-startup-inert-scenes-parent', 1)

  const failed = await disk.restartForTests()
  assert.equal(failed.mode, 'disk')
  let c = counters()
  assert.equal(c.startupBoundaryIntents, 1)
  assert.equal(c.startupBoundaryRecovery, 1)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.startupInert, 0)
  assert.equal(c.startupRestored, 0)
  assert.equal(c.sceneWritePreserve, true)
  let f = fence()
  assert.equal(f.state, 'namespace-recovery-required')
  assert.equal(f.startupInertScenesParentFsync, 0)
  assert.equal(f.startupRestoreScenesParentFsync, 0)
  assert.equal(f.startupRestoreRename, 0)
  assert.equal(f.startupTrashParentFsync, 0)
  assert.deepEqual(fs.readFileSync(intentPath(slot)), intentBefore)
  assert.deepEqual(treeSnapshot(slotDir(ordinary)), {
    'ordinary.bin': { type: 'file', mode: 0o600, bytes: Buffer.from('ordinary').toString('base64') },
  })
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldScene)
  assert.equal((await sceneJson(session)).revision, 1)
  await assert.rejects(appendScene(session, 'const poisonedInert = 1'))

  disk.faults.clear()
  const repaired = await disk.restartForTests()
  assert.equal(repaired.mode, 'disk')
  c = counters()
  assert.equal(c.startupBoundaryIntents, 1)
  assert.equal(c.startupInert, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.sceneWritePreserve, false)
  f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupInertScenesParentFsync, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 0)
  assert.equal(f.startupRestoreRename, 0)
  assert.equal(f.startupTrashParentFsync, 2)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.equal(fs.existsSync(slotDir(ordinary)), false)
  assert.equal((await sceneJson(session)).revision, 1)

  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(counters().startupBoundaryIntents, 0)
})

test('D2(iii)/D8 both-names state preserves both copies, counts recovery, and loads the old name', async () => {
  const session = 'sess-d8-both-names'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 1 })
  await stopStore()
  const slot = randomBytes(16).toString('hex')
  const intent = makeIntent(session, slot, { newOrder: 7204 })
  durableViewAdapter()
    .copyTree(sceneDir(session), slotDir(slot))
    .write(intentPath(slot), intent.bytes)
    .materialize()
  const oldNameBefore = treeSnapshot(sceneDir(session))
  const slotBefore = treeSnapshot(slotDir(slot))
  const intentBefore = fs.readFileSync(intentPath(slot))

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupBoundaryIntents, 1)
  assert.equal(c.startupBoundaryRecovery, 1)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.startupRestored, 0)
  assert.equal(c.startupInert, 0)
  assert.equal(c.sceneWritePreserve, true)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupInertScenesParentFsync, 0)
  assert.equal(f.startupRestoreScenesParentFsync, 0)
  assert.equal(f.startupRestoreRename, 0)
  assert.equal(f.startupTrashParentFsync, 0)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldNameBefore)
  assert.deepEqual(treeSnapshot(slotDir(slot)), slotBefore)
  assert.deepEqual(fs.readFileSync(intentPath(slot)), intentBefore)
  assert.equal((await sceneJson(session)).revision, 1)
  await assert.rejects(appendScene(session, 'const bothNamesPreserve = 1'))

  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.deepEqual(treeSnapshot(slotDir(slot)), slotBefore)
  assert.deepEqual(fs.readFileSync(intentPath(slot)), intentBefore)
  assert.equal(counters().startupBoundaryRecovery, 1)
  assert.equal((await sceneJson(session)).revision, 1)
})

test('D2(iii)/D8 present-empty target is replaced by the restored old generation', async () => {
  const session = 'sess-d8-present-empty'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 1 })
  await stopStore()
  const slot = randomBytes(16).toString('hex')
  const intent = makeIntent(session, slot, { newOrder: 7205 })
  durableViewAdapter()
    .copyTree(sceneDir(session), slotDir(slot))
    .remove(sceneDir(session))
    .mkdir(sceneDir(session))
    .write(intentPath(slot), intent.bytes)
    .materialize()
  const slotBefore = treeSnapshot(slotDir(slot))

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupRestored, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.startupInert, 0)
  assert.equal(c.sceneWritePreserve, false)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 1)
  assert.equal(f.startupTrashParentFsync, 1)
  assert.equal(f.startupInertScenesParentFsync, 0)
  assert.equal(trashSlots().includes(slot), false)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.deepEqual(treeSnapshot(sceneDir(session)), slotBefore)
  assert.equal((await sceneJson(session)).revision, 1)

  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.deepEqual(treeSnapshot(sceneDir(session)), slotBefore)
})

test('D8/R5 4097-intent startup scan is truncated before mutation and preserves every intent and slot', async () => {
  const session = 'sess-d8-intent-truncation'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 1 })
  await stopStore()
  const intentHashes = new Map()
  const count = 4097
  for (let index = 0; index < count; index += 1) {
    const slot = createHash('sha256').update(`truncation-slot:${String(index)}`).digest('hex').slice(0, 32)
    const built = makeIntent(session, slot, { newOrder: 7300 + index })
    const file = intentPath(slot)
    fs.writeFileSync(file, built.bytes, { mode: 0o600 })
    intentHashes.set(file, diskSha(built.bytes))
  }
  const ordinary = randomBytes(16).toString('hex')
  fs.mkdirSync(slotDir(ordinary), { mode: 0o700 })
  fs.writeFileSync(path.join(slotDir(ordinary), 'ordinary.bin'), Buffer.from('keep ordinary trash'), { mode: 0o600 })
  const ordinaryBefore = treeSnapshot(slotDir(ordinary))
  const targetBefore = treeSnapshot(sceneDir(session))

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  let c = counters()
  assert.equal(c.startupBoundaryIntents, 4096)
  assert.equal(c.startupBoundaryTruncated, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.startupRestored, 0)
  assert.equal(c.startupInert, 0)
  assert.equal(c.sceneWritePreserve, true)
  let f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupInertScenesParentFsync, 0)
  assert.equal(f.startupRestoreScenesParentFsync, 0)
  assert.equal(f.startupRestoreRename, 0)
  assert.equal(f.startupTrashParentFsync, 0)
  assert.equal(intentNames().length, count)
  for (const [file, hash] of intentHashes) assert.equal(diskSha(fs.readFileSync(file)), hash)
  assert.deepEqual(treeSnapshot(slotDir(ordinary)), ordinaryBefore)
  assert.deepEqual(treeSnapshot(sceneDir(session)), targetBefore)
  assert.equal((await sceneJson(session)).revision, 1)
  await assert.rejects(appendScene(session, 'const truncatedScan = 1'))

  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  c = counters()
  assert.equal(c.startupBoundaryIntents, 4096)
  assert.equal(c.startupBoundaryTruncated, 1)
  assert.equal(c.sceneWritePreserve, true)
  f = fence()
  assert.equal(f.startupTrashParentFsync, 0)
  assert.equal(intentNames().length, count)
  assert.deepEqual(treeSnapshot(slotDir(ordinary)), ordinaryBefore)
  assert.equal((await sceneJson(session)).revision, 1)
})

// ===========================================================================
// D2(ii) marker failure: synchronous rollback, startup crash reconciliation,
// marker survives, and the self-hash is never a marker authority.
// ===========================================================================
test('D2(ii)(a) boundary marker failure rolls back the old generation synchronously and blocks later appends', async () => {
  const session = 'sess-d2ii-sync-rollback'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  assert.equal(revisionNames(sceneDir(session)).length, 1)
  assert.equal(markerNames(sceneDir(session)).length, 1)
  armFault('sceneCommitMarker', 'beforeSceneCommitMarker', 1)

  await assert.rejects(appendScene(session, 'const boundaryMarkerMustFail = 1'))
  const c = counters()
  assert.equal(c.sceneWriteDegraded, true)
  assert.equal(c.sceneWritePreserve, false)
  assert.equal(trashSlots().length, 0)
  assert.deepEqual(intentNames(), [])
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.equal(revisionNames(sceneDir(session)).length, 1)
  assert.equal(markerNames(sceneDir(session)).length, 1)
  await assert.rejects(appendScene(session, 'const degradedAfterBoundaryMarker = 1'))

  disk.faults.clear()
  await disk.restartForTests()
  assert.equal(counters().sceneWriteDegraded, false)
  const oldScene = await sceneJson(session)
  assert.equal(oldScene.revision, 1)
  assert.match(oldScene.code, /fixture F revision 1/)
  const next = await appendScene(session, 'const afterBoundaryMarkerRecovery = 2')
  assert.equal(next.revision, 2)
  await disk.restartForTests()
  assert.equal((await sceneJson(session)).revision, 2)
})

test('D2(ii)(c) boundary marker survives post-commit fault, keeps new generation, evicts old slot', async () => {
  const variants = [
    ['sceneCommitMarker', 'afterSceneCommitMarker'],
    ['commitMarker', 'afterCommitMarker'],
  ]
  for (const [op, at] of variants) {
    const session = `sess-d2iic-marker-survives-${op}`
    await prepareAdoptionBoundary(session, { assets: 1 })
    armFault(op, at, 1)
    await assert.rejects(appendScene(session, 'const survivingMarker = 1'))
    const c = counters()
    assert.equal(c.sceneWriteDegraded, true)
    assert.equal(c.sceneWritePreserve, false)
    assert.equal(trashSlots().length, 1)
    assert.equal(intentNames().length, 1)
    const [slot] = trashSlots()
    const [intentName] = intentNames()
    const intentObject = readJsonFile(path.join(trashDir(), intentName))
    assert.equal(intentObject.slot, slot)
    const [revisionName] = revisionNames(sceneDir(session))
    const revisionObject = readJsonFile(path.join(sceneDir(session), revisionName))
    assert.equal(intentObject.newRevisionRecordSha256, revisionObject.recordSha256)
    assert.equal(markerNames(sceneDir(session)).length, 1)

    disk.faults.clear()
    await disk.restartForTests()
    const after = counters()
    assert.equal(after.startupBoundaryIntents, 1)
    assert.equal(after.startupBoundaryRecovery, 0)
    assert.equal(after.startupRestored, 0)
    assert.equal(after.startupInert, 0)
    assert.equal(after.sceneWritePreserve, false)
    assert.equal(fence().startupRestoreRename, 0)
    assert.equal(fence().startupRestoreScenesParentFsync, 0)
    assert.equal(intentNames().length, 0)
    assert.equal(trashSlots().includes(slot), false)
    const scene = await sceneJson(session)
    assert.equal(scene.revision, 1)
    assert.match(scene.code, /survivingMarker/)
    assert.equal(disk.inspect().fixtures.F.ordersByRevision['1'] !== undefined, true)
    await disk.restartForTests()
    assert.match((await sceneJson(session)).code, /survivingMarker/)
  }
})

test('D2(ii)(c)/D8 valid new-generation marker is chosen while a marker carrying the intent self-hash is not', async () => {
  const session = 'sess-d2iic-choice'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const accepted = await appendScene(session, 'const chosenNewGeneration = 1')
  assert.equal(accepted.revision, 1)
  const [slot] = trashSlots()
  assert.equal(typeof slot, 'string')
  const fixture = disk.inspect().fixtures.F
  const order = fixture.ordersByRevision['1']
  assert.ok(Number.isSafeInteger(order))
  const newEpoch = fixture.epoch
  const [revisionName] = revisionNames(sceneDir(session))
  const revisionBytes = fs.readFileSync(path.join(sceneDir(session), revisionName))
  const revisionObject = JSON.parse(revisionBytes.toString('utf8'))
  assert.equal(revisionObject.order, order)
  const newRevisionRecordSha256 = revisionObject.recordSha256
  const intent = makeIntent(session, slot, {
    newOrder: order, newEpoch, newRevisionRecordSha256,
  })
  const slotBefore = treeSnapshot(slotDir(slot))

  await stopStore()
  fs.writeFileSync(intentPath(slot), intent.bytes, { mode: 0o600 })
  const restartChosen = await disk.restartForTests()
  assert.equal(restartChosen.mode, 'disk')
  let c = counters()
  assert.equal(c.startupBoundaryIntents, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.startupRestored, 0)
  assert.equal(c.startupInert, 0)
  assert.equal(c.sceneWritePreserve, false)
  let f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 0)
  assert.equal(f.startupRestoreScenesParentFsync, 0)
  assert.equal(f.startupInertScenesParentFsync, 0)
  assert.equal(intentNames().length, 0)
  assert.equal(trashSlots().length, 0)
  let scene = await sceneJson(session)
  assert.match(scene.code, /chosenNewGeneration/)
  assert.equal(disk.inspect().fixtures.F.ordersByRevision['1'], order)
  assert.notEqual(diskSha(revisionBytes), diskSha(Buffer.from(JSON.stringify({ old: true }))))
  void slotBefore

  // A second, identical durable generation whose marker carries the intent's
  // self-hash instead of newRevisionRecordSha256 must not match.
  await freshStore()
  await prepareAdoptionBoundary(session, { assets: 1 })
  const second = await appendScene(session, 'const selfHashMarkerMustNotMatch = 1')
  assert.equal(second.revision, 1)
  const [slot2] = trashSlots()
  const fixture2 = disk.inspect().fixtures.F
  const order2 = fixture2.ordersByRevision['1']
  const epoch2 = fixture2.epoch
  const [revisionName2] = revisionNames(sceneDir(session))
  const revisionObject2 = readJsonFile(path.join(sceneDir(session), revisionName2))
  const hash2 = revisionObject2.recordSha256
  const intent2 = makeIntent(session, slot2, {
    newOrder: order2, newEpoch: epoch2, newRevisionRecordSha256: hash2,
  })
  assert.notEqual(intent2.object.recordSha256, hash2)
  await stopStore()
  const [markerName2] = markerNames(sceneDir(session))
  const markerFile = path.join(sceneDir(session), markerName2)
  const markerObject = readJsonFile(markerFile)
  markerObject.recordSha256 = intent2.object.recordSha256
  markerObject.markerSha256 = canonicalPairsHash([
    ['v', 1], ['kind', markerObject.kind], ['sidHash', markerObject.sidHash],
    ['order', markerObject.order], ['revision', markerObject.revision],
    ['recordSha256', markerObject.recordSha256],
  ], 'twb:scene-commit:v1\0')
  fs.writeFileSync(markerFile, Buffer.from(JSON.stringify(markerObject)), { mode: 0o600 })
  fs.writeFileSync(intentPath(slot2), intent2.bytes, { mode: 0o600 })
  const targetBefore = treeSnapshot(sceneDir(session))
  const slot2Before = treeSnapshot(slotDir(slot2))

  const restartRejected = await disk.restartForTests()
  assert.equal(restartRejected.mode, 'disk')
  c = counters()
  assert.equal(c.startupBoundaryIntents, 1)
  assert.equal(c.startupBoundaryRecovery, 1)
  assert.equal(c.startupRestored, 0)
  assert.equal(c.startupInert, 0)
  assert.equal(c.sceneWritePreserve, true)
  f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupTrashParentFsync, 0)
  assert.equal(f.startupRestoreRename, 0)
  assert.deepEqual(fs.readFileSync(intentPath(slot2)), intent2.bytes)
  assert.deepEqual(treeSnapshot(slotDir(slot2)), slot2Before)
  assert.deepEqual(treeSnapshot(sceneDir(session)), targetBefore)
  assert.equal((await sceneGet(session)).status, 404)
  assert.equal(readJsonFile(markerFile).recordSha256, intent2.object.recordSha256)
})

// ===========================================================================
// D2(iii) destination-first boundary steps and reverse outcomes.
// ===========================================================================
test('D2(iii) forward boundary rename failure leaves old directory and intent reconciliation clean', async () => {
  const session = 'sess-d2iii-forward-rename'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  const assetsBefore = treeSnapshot(path.join(root, 'assets', disk.helpers.sceneSidHash(session)))
  armFault('trashRename', 'scene-generation-boundary', 1)
  await assert.rejects(appendScene(session, 'const forwardRenameFailure = 1'))
  const c = counters()
  assert.equal(c.sceneWritePreserve, false)
  assert.equal(c.sceneWriteDegraded, false)
  assert.equal(c.startupBoundaryRecovery, 0)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.boundaryRename, 0)
  assert.equal(f.boundaryTrashParentFsync, 0)
  assert.equal(f.boundaryScenesParentFsync, 0)
  assert.equal(trashSlots().length, 0)
  assert.deepEqual(intentNames(), [])
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.deepEqual(treeSnapshot(path.join(root, 'assets', disk.helpers.sceneSidHash(session))), assetsBefore)
  await disk.restartForTests()
  assert.equal((await sceneJson(session)).revision, 1)
  assert.match((await sceneJson(session)).code, /fixture F revision 1/)
  assert.equal(counters().startupBoundaryIntents, 0)
})

test('D2(iii)/I-30 first parent fsync failure reverses in destination-first order', async () => {
  const session = 'sess-d2iii-trash-parent'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  armFault('dirFsync', 'scene-generation-boundary-trash-parent', 1)
  await assert.rejects(appendScene(session, 'const trashParentFailure = 1'))
  const c = counters()
  assert.equal(c.sceneWritePreserve, false)
  assert.equal(c.sceneWriteDegraded, false)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.boundaryRename, 1)
  // A destination-first swap would have completed this source fsync before
  // the armed trash-parent fault fired.
  assert.equal(f.boundaryTrashParentFsync, 0)
  assert.equal(f.boundaryScenesParentFsync, 0)
  assert.equal(trashSlots().length, 0)
  assert.equal(intentNames().length, 0)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  await disk.restartForTests()
  const scene = await sceneJson(session)
  assert.equal(scene.revision, 1)
  assert.match(scene.code, /fixture F revision 1/)
  assert.equal(counters().startupBoundaryIntents, 0)
})

test('D2(iii) second parent fsync failure completes the trash barrier then reverses', async () => {
  const session = 'sess-d2iii-scenes-parent'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  armFault('dirFsync', 'scene-generation-boundary-scenes-parent', 1)
  await assert.rejects(appendScene(session, 'const scenesParentFailure = 1'))
  const c = counters()
  assert.equal(c.sceneWritePreserve, false)
  assert.equal(c.sceneWriteDegraded, false)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.boundaryRename, 1)
  assert.equal(f.boundaryTrashParentFsync, 1)
  assert.equal(f.boundaryScenesParentFsync, 0)
  assert.equal(trashSlots().length, 0)
  assert.equal(intentNames().length, 0)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  await disk.restartForTests()
  const scene = await sceneJson(session)
  assert.equal(scene.revision, 1)
  assert.match(scene.code, /fixture F revision 1/)
})

test('D2(iii) reverse-rename failure preserves and counts the slot, then startup restores it', async () => {
  const session = 'sess-d2iii-reverse-rename'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  armFault('dirFsync', 'scene-generation-boundary-scenes-parent', 1)
  armFault('trashRename', 'scene-generation-boundary-reverse', 1)
  await assert.rejects(appendScene(session, 'const reverseRenameFailure = 1'))
  const [slot] = trashSlots()
  assert.equal(typeof slot, 'string')
  assert.equal(intentNames().length, 1)
  const intentBefore = fs.readFileSync(intentPath(slot))
  const c = counters()
  assert.equal(c.sceneWritePreserve, true)
  assert.equal(c.sceneWriteDegraded, false)
  assert.equal(c.startupBoundaryRecovery, 1)
  let f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.boundaryRename, 1)
  assert.equal(f.boundaryTrashParentFsync, 1)
  assert.equal(f.boundaryScenesParentFsync, 0)
  assert.equal(f.startupRestoreRename, 0)
  assert.equal(fs.existsSync(sceneDir(session)), false)
  assert.deepEqual(treeSnapshot(slotDir(slot)), oldBefore)
  assert.equal((await sceneGet(session)).status, 404)
  await assert.rejects(appendScene(session, 'const reverseRenamePreserve = 1'))

  disk.faults.clear()
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const after = counters()
  assert.equal(after.startupRestored, 1)
  assert.equal(after.startupBoundaryRecovery, 0)
  assert.equal(after.sceneWritePreserve, false)
  f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 1)
  assert.equal(f.startupTrashParentFsync, 1)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.equal(trashSlots().includes(slot), false)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.equal((await sceneJson(session)).revision, 1)
})

test('D2(iii) poisoned reverse-rename failure preserves slot and intent and fences later mutations', async () => {
  const session = 'sess-d2iii-poison-rename'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  armFault('dirFsync', 'scene-generation-boundary-trash-parent', 1)
  armFault('trashRename', 'scene-generation-boundary-reverse', 1)
  await assert.rejects(appendScene(session, 'const poisonedReverseRename = 1'))
  const [slot] = trashSlots()
  assert.equal(typeof slot, 'string')
  assert.equal(intentNames().length, 1)
  const intentBefore = fs.readFileSync(intentPath(slot))
  const c = counters()
  assert.equal(c.sceneWritePreserve, true)
  assert.equal(c.startupBoundaryRecovery, 1)
  let f = fence()
  assert.equal(f.state, 'namespace-recovery-required')
  assert.equal(f.boundaryRename, 1)
  assert.equal(f.boundaryTrashParentFsync, 0)
  assert.equal(f.boundaryScenesParentFsync, 0)
  assert.deepEqual(treeSnapshot(slotDir(slot)), oldBefore)
  assert.deepEqual(fs.readFileSync(intentPath(slot)), intentBefore)
  assert.equal((await sceneGet(session)).status, 404)
  await assert.rejects(appendScene(session, 'const poisonedReverseRename2 = 1'))
  assert.equal(trashSlots().includes(slot), true)

  disk.faults.clear()
  await disk.restartForTests()
  const after = counters()
  assert.equal(after.startupRestored, 1)
  assert.equal(after.startupBoundaryRecovery, 0)
  assert.equal(after.sceneWritePreserve, false)
  f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 1)
  assert.equal(f.startupTrashParentFsync, 1)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.equal((await sceneJson(session)).revision, 1)
})

test('D2(iii) reverse fsync failure retry success preserves writes and refuses a second append', async () => {
  const session = 'sess-d2iii-retry-success'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  armFault('dirFsync', 'scene-generation-boundary-scenes-parent', 1)
  armFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent', 1)
  await assert.rejects(appendScene(session, 'const reverseRetrySuccess = 1'))
  const c = counters()
  assert.equal(c.sceneWritePreserve, true)
  assert.equal(c.sceneWriteDegraded, false)
  assert.equal(c.startupBoundaryRecovery, 0)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.boundaryRename, 1)
  assert.equal(f.boundaryTrashParentFsync, 1)
  assert.equal(f.boundaryScenesParentFsync, 0)
  assert.equal(trashSlots().length, 0)
  assert.equal(intentNames().length, 0)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  await assert.rejects(appendScene(session, 'const reverseRetryPreserve = 1'))

  disk.faults.clear()
  await disk.restartForTests()
  assert.equal(counters().sceneWritePreserve, false)
  assert.equal((await sceneJson(session)).revision, 1)
  const next = await appendScene(session, 'const afterReverseRetryRecovery = 2')
  assert.equal(next.revision, 2)
  await disk.restartForTests()
  assert.equal((await sceneJson(session)).revision, 2)
})

test('D2(iii) the reverse-scenes-parent retry budget is exactly one success and exactly one failure', async () => {
  const successSession = 'sess-fix4-reverse-retry-exact-one'
  await prepareAdoptionBoundary(successSession, { assets: 1 })
  const successBefore = treeSnapshot(sceneDir(successSession))
  armFault('dirFsync', 'scene-generation-boundary-scenes-parent', 1)
  armFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent', 1)
  await assert.rejects(appendScene(successSession, 'const exactOneRetrySuccess = 1'))
  assert.equal(counters().reverseScenesFsyncRetries, 1)
  assert.equal(counters().sceneWritePreserve, true)
  assert.equal(counters().sceneWriteDegraded, false)
  assert.equal(fence().state, 'normal')
  assert.deepEqual(treeSnapshot(sceneDir(successSession)), successBefore)
  assert.equal(intentNames().length, 0)
  assert.equal(trashSlots().length, 0)

  const poisonSession = 'sess-fix4-reverse-retry-exact-one-poison'
  await prepareAdoptionBoundary(poisonSession, { assets: 1 })
  const poisonBefore = treeSnapshot(sceneDir(poisonSession))
  armFault('dirFsync', 'scene-generation-boundary-scenes-parent', 1)
  armFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent', 1)
  armFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent-retry', 1)
  await assert.rejects(appendScene(poisonSession, 'const exactOneRetryPoison = 1'))
  // A second retry attempt would both increment this counter past one and
  // succeed (the single armed fault is already consumed), clearing the poison.
  assert.equal(counters().reverseScenesFsyncRetries, 1)
  assert.equal(disk.faultHitsForTests()['dirFsync@scene-generation-boundary-reverse-scenes-parent-retry'], 1)
  assert.equal(counters().sceneWritePreserve, true)
  assert.equal(counters().startupBoundaryRecovery, 1)
  assert.equal(fence().state, 'namespace-recovery-required')
  assert.equal(intentNames().length, 1)
  assert.deepEqual(treeSnapshot(sceneDir(poisonSession)), poisonBefore)
  await assert.rejects(appendScene(poisonSession, 'const exactOneRetryStillPoisoned = 1'))

  disk.faults.clear()
  await disk.restartForTests()
  assert.equal(fence().state, 'normal')
  assert.deepEqual(treeSnapshot(sceneDir(poisonSession)), poisonBefore)
  assert.equal((await sceneJson(poisonSession)).revision, 1)
  const recovered = await appendScene(poisonSession, 'const exactOneRetryRecovered = 2')
  assert.equal(recovered.revision, 2)
})

test('D2(iii)/V10-04 reverse fsync retry failure poisons and never unlinks the inert intent', async () => {
  const session = 'sess-d2iii-retry-poison'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  armFault('dirFsync', 'scene-generation-boundary-scenes-parent', 1)
  armFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent', 1)
  armFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent-retry', 1)
  await assert.rejects(appendScene(session, 'const reverseRetryPoison = 1'))
  const [slot] = trashSlots().length === 0 ? [undefined] : trashSlots()
  assert.equal(slot, undefined)
  assert.equal(intentNames().length, 1)
  const [intentName] = intentNames()
  const intentBefore = fs.readFileSync(path.join(trashDir(), intentName))
  const c = counters()
  assert.equal(c.sceneWritePreserve, true)
  assert.equal(c.sceneWriteDegraded, false)
  assert.equal(c.startupBoundaryRecovery, 1)
  const f = fence()
  assert.equal(f.state, 'namespace-recovery-required')
  assert.equal(f.boundaryRename, 1)
  assert.equal(f.boundaryTrashParentFsync, 1)
  assert.equal(f.boundaryScenesParentFsync, 0)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.deepEqual(fs.readFileSync(path.join(trashDir(), intentName)), intentBefore)
  await assert.rejects(appendScene(session, 'const poisonedRetry2 = 1'))

  disk.faults.clear()
  await disk.restartForTests()
  const after = counters()
  assert.equal(after.startupBoundaryIntents, 1)
  assert.equal(after.startupInert, 1)
  assert.equal(after.startupBoundaryRecovery, 0)
  assert.equal(after.sceneWritePreserve, false)
  assert.equal(fence().state, 'normal')
  assert.equal(fence().startupInertScenesParentFsync, 1)
  assert.equal(fs.existsSync(path.join(trashDir(), intentName)), false)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.equal((await sceneJson(session)).revision, 1)
})

test('D2(iii)/V10-04 poisoned reverse-fsync failure after trash-parent failure also poisons', async () => {
  const session = 'sess-d2iii-double-poison'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  armFault('dirFsync', 'scene-generation-boundary-trash-parent', 1)
  armFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent', 1)
  armFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent-retry', 1)
  await assert.rejects(appendScene(session, 'const doubleParentPoison = 1'))
  assert.equal(trashSlots().length, 0)
  assert.equal(intentNames().length, 1)
  const [intentName] = intentNames()
  const intentBefore = fs.readFileSync(path.join(trashDir(), intentName))
  const c = counters()
  assert.equal(c.sceneWritePreserve, true)
  assert.equal(c.startupBoundaryRecovery, 1)
  const f = fence()
  assert.equal(f.state, 'namespace-recovery-required')
  assert.equal(f.boundaryRename, 1)
  assert.equal(f.boundaryTrashParentFsync, 0)
  assert.equal(f.boundaryScenesParentFsync, 0)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.deepEqual(fs.readFileSync(path.join(trashDir(), intentName)), intentBefore)
  await assert.rejects(appendScene(session, 'const doubleParentPoison2 = 1'))

  disk.faults.clear()
  await disk.restartForTests()
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(counters().startupInert, 1)
  assert.equal(counters().sceneWritePreserve, false)
  assert.equal(fence().state, 'normal')
})

test('D2(iii) marker failure rollback reverse retry failure poisons without unlinking the intent', async () => {
  const session = 'sess-d2iii-marker-rollback-poison'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  armFault('sceneCommitMarker', 'beforeSceneCommitMarker', 1)
  armFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent', 1)
  armFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent-retry', 1)
  await assert.rejects(appendScene(session, 'const markerRollbackPoison = 1'))
  assert.equal(trashSlots().length, 0)
  assert.equal(intentNames().length, 1)
  const [intentName] = intentNames()
  const intentBefore = fs.readFileSync(path.join(trashDir(), intentName))
  const c = counters()
  assert.equal(c.sceneWriteDegraded, true)
  assert.equal(c.sceneWritePreserve, true)
  assert.equal(c.startupBoundaryRecovery, 0)
  const f = fence()
  assert.equal(f.state, 'namespace-recovery-required')
  assert.equal(f.boundaryRename, 1)
  assert.equal(f.boundaryTrashParentFsync, 1)
  assert.equal(f.boundaryScenesParentFsync, 1)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.deepEqual(fs.readFileSync(path.join(trashDir(), intentName)), intentBefore)
  await assert.rejects(appendScene(session, 'const markerRollbackPoison2 = 1'))
  assert.equal(fs.existsSync(path.join(trashDir(), intentName)), true)

  disk.faults.clear()
  await disk.restartForTests()
  const after = counters()
  assert.equal(after.sceneWriteDegraded, false)
  assert.equal(after.sceneWritePreserve, false)
  assert.equal(after.startupBoundaryIntents, 1)
  assert.equal(after.startupInert, 1)
  assert.equal(fence().state, 'normal')
  assert.equal(fence().startupInertScenesParentFsync, 1)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.equal((await sceneJson(session)).revision, 1)
  assert.match((await sceneJson(session)).code, /fixture F revision 1/)
})

test('D2(iii)/V10-04 poisoned reverse retry fails later shared-parent mutations while reads continue', async () => {
  const session = 'sess-d2iii-poison-paths'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const assetsBeforeList = await assetInternal.listResponse(new Request('http://localhost/three-workbench/assets', {
    headers: { 'x-workbench-session': session },
  }))
  assert.equal(assetsBeforeList.status, 200)
  const assetsBefore = await assetsBeforeList.json()
  assert.equal(assetsBefore.assets.length, 1)
  const assetId = assetsBefore.assets[0].id
  assert.notEqual(assetInternal.rawAsset(assetId), undefined)
  armFault('dirFsync', 'scene-generation-boundary-scenes-parent', 1)
  armFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent', 1)
  armFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent-retry', 1)
  await assert.rejects(appendScene(session, 'const poisonPathFixture = 1'))
  assert.equal(fence().state, 'namespace-recovery-required')

  const readList = await assetInternal.listResponse(new Request('http://localhost/three-workbench/assets', {
    headers: { 'x-workbench-session': session },
  }))
  assert.equal(readList.status, 200)
  assert.equal((await readList.json()).assets.length, 1)
  const deleteResponse = await invoke(assetInternal.deleteHandler, {
    method: 'POST',
    headers: { 'x-workbench-session': session, 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ id: assetId })),
  })
  assert.equal(deleteResponse.status, 503)
  assert.notEqual(assetInternal.rawAsset(assetId), undefined)
  assert.equal(assetInternal.rawAsset(assetId).id, assetId)
  const newSession = 'sess-d2iii-poison-new-scene'
  await assert.rejects(appendScene(newSession, 'const poisonNewScene = 1'))
  assert.equal(fs.existsSync(sceneDir(newSession)), false)
  assert.equal(fence().state, 'namespace-recovery-required')

  disk.faults.clear()
  await disk.restartForTests()
  assert.equal(fence().state, 'normal')
  assert.equal((await sceneJson(session)).revision, 1)
  const afterList = await assetInternal.listResponse(new Request('http://localhost/three-workbench/assets', {
    headers: { 'x-workbench-session': session },
  }))
  assert.equal(afterList.status, 200)
  assert.equal((await afterList.json()).assets.length, 1)
})

// ===========================================================================
// D2(ii)(b)/D8 process-crash startup reconciliation. The child process is
// SIGKILLed at a named barrier; the parent restart is the startup evidence.
// ===========================================================================
function spawnCrashAppend(session, barrier) {
  const childRoot = fs.mkdtempSync(path.join(tempBase, 'twb-d2-crash-child-'))
  const scriptPath = path.join(childRoot, 'crash.mjs')
  try {
    fs.writeFileSync(scriptPath, [
      `import { apply, __diskInternal, __historyInternal } from ${JSON.stringify(indexUrl)}`,
      'let tool',
      'const ctx = {',
      '  effect(fn) { fn() },',
      '  inject(names, callback) { callback(ctx) },',
      '  tools: { register(definition) { tool = definition } },',
      '  systemPrompt: { section() {} },',
      '  webServer: { register() {} },',
      '}',
      'apply(ctx)',
      `await __diskInternal.restartForTests()`,
      `__historyInternal.clearScene(${JSON.stringify(session)})`,
      `__diskInternal.crashAt(${JSON.stringify(barrier)})`,
      `try { await tool.execute({ code: ${JSON.stringify(`const crashBarrier = ${JSON.stringify(barrier)}`)} },`,
      `  { agent: { session: { id: ${JSON.stringify(session)} } } }) } catch (error) { void error }`,
      'process.stdout.write("CRASH_DID_NOT_HAPPEN\\n")',
    ].join('\n'), { mode: 0o600 })
    const childEnv = { ...process.env, THREE_WORKBENCH_DATA_DIR: root }
    // A shell parent carries the literal `--test` token required by the test
    // root gate; the script itself runs directly (not via a nested runner).
    const child = spawnSync('/bin/bash', [
      '-c', '"$0" "$1"; exit $?', process.execPath, scriptPath, '--test',
    ], {
      env: childEnv,
      encoding: 'utf8',
      timeout: 30000,
    })
    // The crash is proven by the durable postcondition the caller asserts
    // (intent/slot/revision-without-marker present), not by the shell status.
    assert.equal(child.error?.code === 'ETIMEDOUT', false)
    if (child.stdout.includes('CRASH_DID_NOT_HAPPEN')) {
      throw new Error('crash barrier did not fire')
    }
    return child
  } finally {
    fs.rmSync(childRoot, { recursive: true, force: true })
  }
}

test('D2(ii)(b)/D8 crashAt beforeSceneCommitMarker reconciles the completed boundary on startup', async () => {
  const session = 'sess-d2iib-crash-before-marker'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  await stopStore()
  spawnCrashAppend(session, 'beforeSceneCommitMarker')
  assert.equal(intentNames().length, 1)
  assert.equal(trashSlots().length, 1)
  const [slot] = trashSlots()
  const [revisionName] = revisionNames(sceneDir(session))
  const crashedRevision = readJsonFile(path.join(sceneDir(session), revisionName))
  assert.equal(markerNames(sceneDir(session)).length, 0)
  const intentName = intentNames()[0]
  const crashedIntent = readJsonFile(path.join(trashDir(), intentName))
  assert.equal(crashedIntent.newRevisionRecordSha256, crashedRevision.recordSha256)

  const restarted = await disk.restartForTests()
  if (restarted.mode !== 'disk') {
    throw new Error(`crash restart not disk: ${JSON.stringify({
      restarted, status: disk.status(), inspect: disk.inspect(), paths: disk.pathsFor(),
    })}`)
  }
  const c = counters()
  assert.equal(c.startupBoundaryIntents, 1)
  assert.equal(c.startupRestored, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.startupInert, 0)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.sceneWritePreserve, false)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 1)
  assert.equal(f.startupTrashParentFsync, 1)
  assert.equal(f.startupInertScenesParentFsync, 0)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.equal(trashSlots().includes(slot), false)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  const scene = await sceneJson(session)
  assert.equal(scene.revision, 1)
  assert.match(scene.code, /fixture F revision 1/)
  assert.equal(markerNames(sceneDir(session)).length, 1)

  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.equal(counters().startupBoundaryIntents, 0)
})

test('D8 crashAt afterSceneGenerationBoundary leaves slot-only and startup restores before cleanup', async () => {
  const session = 'sess-d8-crash-completed-boundary'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  await stopStore()
  spawnCrashAppend(session, 'afterSceneGenerationBoundary')
  assert.equal(intentNames().length, 1)
  assert.equal(trashSlots().length, 1)
  const [slot] = trashSlots()
  assert.equal(fs.existsSync(sceneDir(session)), false)
  const slotBefore = treeSnapshot(slotDir(slot))
  const intentBefore = fs.readFileSync(intentPath(slot))

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupBoundaryIntents, 1)
  assert.equal(c.startupRestored, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.sceneWritePreserve, false)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 1)
  assert.equal(f.startupTrashParentFsync, 1)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.equal(trashSlots().includes(slot), false)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(markerNames(sceneDir(session)).length, 1)
  void slotBefore
  void intentBefore

  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
})

// ===========================================================================
// D2(iv)/B1 accepted generation, fresh-epoch no-boundary, and 16-session cap.
// ===========================================================================
test('B1/accepted-generation selects the higher-order same-epoch new r1 and never trims it', async () => {
  const session = 'sess-b1-accepted-generation'
  await freshStore()
  const sharedEpoch = randomBytes(16).toString('hex')
  await seedAcknowledged(session, {
    revisions: 14, epoch: sharedEpoch, baseOrder: 100, label: 'F',
  })
  await disk.seedSceneForTests({
    session, revisions: [{ code: 'const acceptedNewHead = true\n' }],
    epoch: sharedEpoch, baseOrder: 300, label: 'F',
  })
  // Two acknowledged lower-order records duplicate revisions that also exist
  // in the old generation. They are outside the new r1 chain and must never
  // be selected, counted, served, or used as a trim source.
  const sidHash = disk.helpers.sceneSidHash(session)
  const staleDuplicates = [
    makeRevisionRecord(session, sharedEpoch, 2, 90, 'const staleDuplicateTwo = true\n'),
    makeRevisionRecord(session, sharedEpoch, 13, 91, 'const staleDuplicateThirteen = true\n'),
  ]
  const duplicateNames = []
  const adapter = durableViewAdapter()
  for (const record of staleDuplicates) {
    const revisionName = disk.generatedNames.sceneRevision(record.object.order)
    const markerName = disk.generatedNames.sceneMarker(record.object.order)
    duplicateNames.push(revisionName, markerName)
    adapter.write(path.join(sceneDir(session), revisionName), record.bytes)
    adapter.write(path.join(sceneDir(session), markerName), makeMarkerRecord(
      sidHash, record.object.order, record.object.revision, record.sha256).bytes)
  }
  assert.equal(adapter.materialize(), 4)
  assert.equal(revisionNames(sceneDir(session)).length, 17)
  const oldRevisionNames = new Set(revisionNames(sceneDir(session)))
  const quarantinedBefore = counters().quarantined
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const scene = await sceneJson(session)
  assert.equal(scene.revision, 1)
  assert.match(scene.code, /acceptedNewHead/)
  const view = disk.inspect()
  assert.equal(view.fixtures.F.epoch, sharedEpoch)
  assert.deepEqual(view.fixtures.F.ordersByRevision, { 1: 300 })
  assert.equal(view.fixtures.F.revisionOrderCount, 1)
  assert.equal(counters().startupEvictedScenes, 0)
  assert.ok(counters().quarantined - quarantinedBefore >= staleDuplicates.length * 2)
  for (const name of duplicateNames) {
    assert.equal(fs.existsSync(path.join(sceneDir(session), name)), false)
  }
  const newRevisionFile = path.join(sceneDir(session), disk.generatedNames.sceneRevision(300))
  const newMarkerFile = path.join(sceneDir(session), disk.generatedNames.sceneMarker(300))
  assert.equal(fs.existsSync(newRevisionFile), true)
  assert.equal(fs.existsSync(newMarkerFile), true)
  const revisionBefore = fs.readFileSync(newRevisionFile)
  const markerBefore = fs.readFileSync(newMarkerFile)

  const cleanupBeforeAppend = disk.inspect().lastCleanupToken
  const appended = await appendScene(session, 'const afterAcceptedGeneration = 2')
  assert.equal(appended.revision, 2)
  assert.deepEqual(disk.inspect().lastCleanupToken, cleanupBeforeAppend)
  for (const name of duplicateNames) {
    assert.equal(fs.existsSync(path.join(sceneDir(session), name)), false)
  }
  assert.equal(fs.existsSync(newRevisionFile), true)
  assert.equal(fs.existsSync(newMarkerFile), true)
  assert.deepEqual(fs.readFileSync(newRevisionFile), revisionBefore)
  assert.deepEqual(fs.readFileSync(newMarkerFile), markerBefore)
  assert.equal(disk.inspect().fixtures.F.ordersByRevision['1'], 300)
  assert.equal(disk.inspect().fixtures.F.ordersByRevision['2'] !== undefined, true)
  assert.ok(oldRevisionNames.size >= 17)
  const afterRestart = await disk.restartForTests()
  assert.equal(afterRestart.mode, 'disk')
  const stable = await sceneJson(session)
  assert.equal(stable.revision, 2)
  assert.match(stable.code, /afterAcceptedGeneration/)
  assert.equal(disk.inspect().fixtures.F.ordersByRevision['1'], 300)
  assert.equal(fs.existsSync(newRevisionFile), true)
  assert.equal(fs.existsSync(newMarkerFile), true)
})

test('D2(iv)/C2 fresh-epoch path with an old directory performs no boundary under any boundary fault', async () => {
  const variants = [
    ['trashRename', 'scene-generation-boundary'],
    ['dirFsync', 'scene-generation-boundary-trash-parent'],
    ['dirFsync', 'scene-generation-boundary-scenes-parent'],
  ]
  for (const [op, at] of variants) {
    const session = `sess-c2-fresh-${op}-${at}`
    await freshStore()
    const oldEpoch = randomBytes(16).toString('hex')
    await seedAcknowledged(session, { revisions: 2, epoch: oldEpoch, label: 'F', baseOrder: 100 })
    await disk.restartForTests()
    host.__historyInternal.clearScene(session)
    assert.equal((await sceneGet(session)).status, 404)
    const oldRevisionBytes = new Map(revisionNames(sceneDir(session)).map(name => [
      name, fs.readFileSync(path.join(sceneDir(session), name)),
    ]))
    armFault(op, at, 1)
    const accepted = await appendScene(session, 'const freshEpochNoBoundary = 1')
    assert.equal(accepted.revision, 1)
    assert.equal(trashSlots().length, 0)
    assert.equal(intentNames().length, 0)
    for (const [name, bytes] of oldRevisionBytes) {
      assert.deepEqual(fs.readFileSync(path.join(sceneDir(session), name)), bytes)
    }
    assert.equal(fence().boundaryRename, 0)
    assert.equal(fence().boundaryTrashParentFsync, 0)
    assert.equal(fence().boundaryScenesParentFsync, 0)
    const epoch = disk.inspect().fixtures.F.epoch
    assert.equal(typeof epoch, 'string')
    assert.notEqual(epoch, oldEpoch)
    assert.equal((await sceneJson(session)).revision, 1)
    assert.match((await sceneJson(session)).code, /freshEpochNoBoundary/)
    disk.faults.clear()
    await disk.restartForTests()
    assert.equal((await sceneJson(session)).revision, 1)
    assert.equal((await sceneJson(session)).revision, 1)
    assert.equal(disk.inspect().fixtures.F.epoch, epoch)
  }
})

test('D8 17 seeded sessions load the newest 16 and trim the oldest without counting stale generations', async () => {
  await freshStore()
  const order = []
  for (let index = 17; index >= 1; index -= 1) order.push(index)
  const sessions = new Map()
  let baseOrder = 100
  for (const index of order) {
    const session = `sess-d8-lru-${String(index).padStart(2, '0')}`
    sessions.set(index, session)
    await seedAcknowledged(session, {
      revisions: 1, label: `P${String(index).padStart(2, '0')}`, baseOrder,
    })
    baseOrder += 1
  }
  assert.equal(disk.inspect().fixtures.P17.revisionOrderCount, 0)
  assert.equal(disk.inspect().fixtures.P17.epoch, null)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  for (let index = 1; index <= 16; index += 1) {
    const scene = await sceneJson(sessions.get(index))
    assert.equal(scene.revision, 1)
    const fixture = disk.inspect().fixtures[`P${String(index).padStart(2, '0')}`]
    assert.equal(fixture.revisionOrderCount, 1)
    assert.notEqual(fixture.epoch, null)
  }
  assert.equal((await sceneGet(sessions.get(17))).status, 404)
  assert.equal(disk.inspect().fixtures.P17.revisionOrderCount, 0)
  assert.equal(disk.inspect().fixtures.P17.epoch, null)
  for (let index = 1; index <= 16; index += 1) {
    assert.match((await sceneJson(sessions.get(index))).code, new RegExp(`fixture P${String(index).padStart(2, '0')}`))
  }
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  for (let index = 1; index <= 16; index += 1) {
    assert.equal((await sceneJson(sessions.get(index))).revision, 1)
  }
  assert.equal((await sceneGet(sessions.get(17))).status, 404)
})

// ===========================================================================
// B1/D8 intermediate process-crash states. The child is SIGKILLed at the
// named barrier; the parent restart is the only durability evidence.
// ===========================================================================
test('D8 crashAt afterSceneGenerationBoundaryRename leaves old at slot, no new name, and restores', async () => {
  const session = 'sess-d8-crash-after-boundary-rename'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  await stopStore()
  spawnCrashAppend(session, 'afterSceneGenerationBoundaryRename')
  assert.equal(intentNames().length, 1)
  assert.equal(trashSlots().length, 1)
  const [slot] = trashSlots()
  assert.equal(fs.existsSync(sceneDir(session)), false)
  assert.deepEqual(treeSnapshot(slotDir(slot)), oldBefore)
  const [intentName] = intentNames()
  const intent = readJsonFile(path.join(trashDir(), intentName))
  assert.equal(intent.slot, slot)
  assert.equal(markerNames(sceneDir(session)).length, 0)
  assert.equal(revisionNames(sceneDir(session)).length, 0)
  const slotBefore = treeSnapshot(slotDir(slot))
  const intentBefore = fs.readFileSync(intentPath(slot))

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupBoundaryIntents, 1)
  assert.equal(c.startupRestored, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.startupInert, 0)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.sceneWritePreserve, false)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 1)
  assert.equal(f.startupTrashParentFsync, 1)
  assert.equal(f.startupInertScenesParentFsync, 0)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.equal(trashSlots().includes(slot), false)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.equal((await sceneJson(session)).revision, 1)
  assert.match((await sceneJson(session)).code, /fixture F revision 1/)
  assert.equal(markerNames(sceneDir(session)).length, 1)
  void slotBefore
  void intentBefore

  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(counters().startupBoundaryIntents, 0)
})

test('D8 crashAt afterSceneGenerationBoundaryTrashParentFsync leaves the durable split and restores', async () => {
  const session = 'sess-d8-crash-after-trash-parent-fsync'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  await stopStore()
  spawnCrashAppend(session, 'afterSceneGenerationBoundaryTrashParentFsync')
  assert.equal(intentNames().length, 1)
  assert.equal(trashSlots().length, 1)
  const [slot] = trashSlots()
  assert.equal(fs.existsSync(sceneDir(session)), false)
  assert.deepEqual(treeSnapshot(slotDir(slot)), oldBefore)
  assert.equal(markerNames(sceneDir(session)).length, 0)
  assert.equal(revisionNames(sceneDir(session)).length, 0)
  const intent = readJsonFile(path.join(trashDir(), intentNames()[0]))
  assert.equal(intent.slot, slot)

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupBoundaryIntents, 1)
  assert.equal(c.startupRestored, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.startupInert, 0)
  assert.equal(c.sceneWritePreserve, false)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 1)
  assert.equal(f.startupTrashParentFsync, 1)
  assert.equal(f.startupInertScenesParentFsync, 0)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.equal(trashSlots().includes(slot), false)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal((await sceneJson(session)).revision, 1)
  assert.match((await sceneJson(session)).code, /fixture F revision 1/)
  assert.equal(markerNames(sceneDir(session)).length, 1)

  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.equal((await sceneJson(session)).revision, 1)
})

test('B1/D8 crashAt afterSceneCommitMarker preserves the nine-field intent, split hashes, and owner incarnation', async () => {
  const session = 'sess-b1-crash-after-commit-marker'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  await stopStore()
  spawnCrashAppend(session, 'afterSceneCommitMarker')
  assert.equal(intentNames().length, 1)
  assert.equal(trashSlots().length, 1)
  const [slot] = trashSlots()
  const [intentName] = intentNames()
  assert.equal(intentName, `${slot}.intent.json`)
  const intentBytes = fs.readFileSync(intentPath(slot))
  const intent = JSON.parse(intentBytes.toString('utf8'))
  assert.deepEqual(Object.keys(intent), [
    'v', 'kind', 'sidHash', 'slot', 'newEpoch', 'newIncarnation', 'newOrder',
    'newRevisionRecordSha256', 'recordSha256',
  ])
  assert.equal(intent.v, 1)
  assert.equal(intent.kind, 'scene-generation-boundary')
  assert.equal(intent.sidHash, disk.helpers.sceneSidHash(session))
  assert.equal(intent.slot, slot)
  assert.match(intent.newEpoch, HEX32_RE)
  assert.match(intent.newIncarnation, HEX32_RE)
  assert.equal(Number.isSafeInteger(intent.newOrder), true)
  assert.match(intent.newRevisionRecordSha256, HEX64_RE)
  assert.match(intent.recordSha256, HEX64_RE)
  assert.equal(intent.recordSha256, canonicalPairsHash(intentHashFields(intent), INTENT_PREFIX))
  assert.notEqual(intent.recordSha256, intent.newRevisionRecordSha256)
  assert.deepEqual(intentBytes, Buffer.from(JSON.stringify(intent), 'utf8'))
  assert.ok(intentBytes.length <= 462)
  assert.ok(intentBytes.length <= 512)
  const worst = makeIntent(session, 'f'.repeat(32), {
    sidHash: 'a'.repeat(64),
    newEpoch: 'b'.repeat(32),
    newIncarnation: 'c'.repeat(32),
    newOrder: 9007199254740991,
    newRevisionRecordSha256: 'd'.repeat(64),
    recordSha256: 'e'.repeat(64),
  })
  assert.equal(worst.bytes.length, 462)
  assert.equal(worst.bytes.length <= 512, true)

  const [revisionName] = revisionNames(sceneDir(session))
  const [markerName] = markerNames(sceneDir(session))
  assert.equal(revisionName, disk.generatedNames.sceneRevision(intent.newOrder))
  assert.equal(markerName, disk.generatedNames.sceneMarker(intent.newOrder))
  const revisionBytes = fs.readFileSync(path.join(sceneDir(session), revisionName))
  const revision = JSON.parse(revisionBytes.toString('utf8'))
  assert.equal(revision.order, intent.newOrder)
  assert.equal(revision.recordSha256, intent.newRevisionRecordSha256)
  const marker = readJsonFile(path.join(sceneDir(session), markerName))
  assert.equal(marker.order, intent.newOrder)
  assert.equal(marker.revision, 1)
  assert.equal(marker.recordSha256, intent.newRevisionRecordSha256)
  assert.notEqual(marker.recordSha256, intent.recordSha256)

  const sidHash = disk.helpers.sceneSidHash(session)
  const ownerPath = path.join(root, 'assets', sidHash, 'owner.json')
  const ownerBytes = fs.readFileSync(ownerPath)
  const owner = JSON.parse(ownerBytes.toString('utf8'))
  assert.equal(owner.sceneEpoch, intent.newEpoch)
  assert.equal(owner.incarnation, intent.newIncarnation)
  assert.equal(owner.sceneId, undefined)
  assert.equal(sidHash, intent.sidHash)
  assert.deepEqual(treeSnapshot(slotDir(slot)), oldBefore)

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupBoundaryIntents, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.startupRestored, 0)
  assert.equal(c.startupInert, 0)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.sceneWritePreserve, false)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 0)
  assert.equal(f.startupRestoreScenesParentFsync, 0)
  assert.equal(f.startupInertScenesParentFsync, 0)
  assert.equal(intentNames().length, 0)
  assert.equal(trashSlots().includes(slot), false)
  const scene = await sceneJson(session)
  assert.equal(scene.revision, 1)
  assert.match(scene.code, /crashBarrier/)
  assert.equal(disk.inspect().fixtures.F.epoch, intent.newEpoch)
  assert.equal(disk.inspect().fixtures.F.ordersByRevision['1'], intent.newOrder)
  assert.equal(fs.readFileSync(ownerPath).equals(ownerBytes), true)

  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.match((await sceneJson(session)).code, /crashBarrier/)
  assert.equal(disk.inspect().fixtures.F.ordersByRevision['1'], intent.newOrder)
})

// ===========================================================================
// D2(iii)/B1 pre-rename slot-absent inert acceptance, D2(v) clearScene reuse,
// and D2(vi) startup product-eviction rename failure.
// ===========================================================================
test('B1/D2(iii) clean pre-rename slot-absent intent is counted inert and acknowledges nothing new', async () => {
  const session = 'sess-b1-clean-inert'
  await freshStore()
  await seedAcknowledged(session, { revisions: 2, assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  await stopStore()
  const slot = randomBytes(16).toString('hex')
  writeIntent(session, slot, { newOrder: 7301 })
  const intentBefore = fs.readFileSync(intentPath(slot))

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupBoundaryIntents, 1)
  assert.equal(c.startupInert, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.startupRestored, 0)
  assert.equal(c.sceneWritePreserve, false)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupInertScenesParentFsync, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 0)
  assert.equal(f.startupRestoreRename, 0)
  assert.equal(f.startupTrashParentFsync, 1)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.equal(fs.existsSync(slotDir(slot)), false)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  const scene = await sceneJson(session)
  assert.equal(scene.revision, 2)
  assert.match(scene.code, /fixture F revision 2/)
  assert.equal(disk.inspect().fixtures.F.revisionOrderCount, 2)
  assert.equal(disk.inspect().fixtures.F.ordersByRevision['1'] !== undefined, true)
  assert.equal(disk.inspect().fixtures.F.ordersByRevision['3'], undefined)
  void intentBefore

  const appended = await appendScene(session, 'const afterCleanInert = 3')
  assert.equal(appended.revision, 3)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 3)
  assert.match((await sceneJson(session)).code, /afterCleanInert/)
})

test('D2(v) clearScene reuse starts a new generation without merging old files or side tables', async () => {
  const session = 'sess-d2v-clear-reuse'
  await freshStore()
  await seedAcknowledged(session, { revisions: 3, epoch: '1'.repeat(32), baseOrder: 100, label: 'F' })
  const oldRevisionBytes = new Map(revisionNames(sceneDir(session)).map(name => [
    name, fs.readFileSync(path.join(sceneDir(session), name)),
  ]))
  await disk.restartForTests()
  assert.equal((await sceneJson(session)).revision, 3)
  host.__historyInternal.clearScene(session)
  assert.equal((await sceneGet(session)).status, 404)
  const afterClear = disk.inspect().fixtures.F
  assert.equal(afterClear.revisionOrderCount, 0)
  assert.equal(afterClear.epoch, null)
  assert.deepEqual(afterClear.ordersByRevision, {})
  assert.deepEqual(Object.keys(afterClear).sort(), [
    'epoch', 'ordersByRevision', 'preservedCount', 'recordedAssetCount',
    'recordedEntryPresent', 'revisionOrderCount',
  ])
  assert.equal(JSON.stringify(disk.inspect()).includes(session), false)

  const fresh = await appendScene(session, 'const clearSceneReused = 1')
  assert.equal(fresh.revision, 1)
  assert.match((await sceneJson(session)).code, /clearSceneReused/)
  assert.notEqual((await sceneJson(session)).code, 'fixture F revision 1')
  const reused = disk.inspect().fixtures.F
  assert.equal(reused.revisionOrderCount, 1)
  assert.deepEqual(Object.keys(reused.ordersByRevision), ['1'])
  assert.equal(reused.ordersByRevision['1'] > 100, true)
  assert.notEqual(reused.epoch, '1'.repeat(32))
  assert.equal(JSON.stringify(disk.inspect()).includes(session), false)
  for (const [name, bytes] of oldRevisionBytes) {
    assert.deepEqual(fs.readFileSync(path.join(sceneDir(session), name)), bytes)
  }

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const scene = await sceneJson(session)
  assert.equal(scene.revision, 1)
  assert.match(scene.code, /clearSceneReused/)
  assert.equal(disk.inspect().fixtures.F.revisionOrderCount, 1)
  assert.deepEqual(Object.keys(disk.inspect().fixtures.F.ordersByRevision), ['1'])
  assert.equal(disk.inspect().fixtures.F.ordersByRevision['1'], reused.ordersByRevision['1'])
  assert.ok(counters().quarantined >= 3)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.match((await sceneJson(session)).code, /clearSceneReused/)
})

test('D2(vi) startup product-eviction rename failure preserves every acknowledged record, then trims exactly on retry', async () => {
  await freshStore()
  const sessions = []
  let baseOrder = 100
  for (let index = 17; index >= 1; index -= 1) {
    const session = `sess-d2vi-evict-${String(index).padStart(2, '0')}`
    sessions[index] = session
    await seedAcknowledged(session, {
      revisions: 1, baseOrder, label: `V${String(index).padStart(2, '0')}`,
    })
    baseOrder += 1
  }
  const oldestBefore = treeSnapshot(sceneDir(sessions[17]))
  const oldestSidHash = disk.helpers.sceneSidHash(sessions[17])
  await stopStore()
  // Inject the exact eviction rename failure without changing production:
  // throw only for the anchored scenes/<sidHash> -> trash/<32hex> rename.
  const originalRenameSync = fs.renameSync
  fs.renameSync = function injectedRename(from, to) {
    const fromName = path.basename(String(from))
    const toName = path.basename(String(to))
    if (fromName === oldestSidHash && SLOT_RE.test(toName)) {
      const error = new Error('injected startup product-eviction rename failure')
      error.code = 'EIO'
      throw error
    }
    return originalRenameSync.call(this, from, to)
  }
  syncBuiltinESMExports()
  let failed
  try {
    failed = await disk.restartForTests()
  } finally {
    fs.renameSync = originalRenameSync
    syncBuiltinESMExports()
  }
  assert.equal(failed.mode, 'disk')
  let c = counters()
  assert.equal(c.startupEvictedScenes, 1)
  assert.equal(c.sceneWritePreserve, true)
  assert.equal(fence().cleanupRename, 0)
  assert.equal(fence().cleanupScenesParentFsync, 0)
  assert.deepEqual(treeSnapshot(sceneDir(sessions[17])), oldestBefore)
  assert.equal((await sceneGet(sessions[17])).status, 404)
  for (let index = 1; index <= 16; index += 1) {
    const scene = await sceneJson(sessions[index])
    assert.equal(scene.revision, 1)
    assert.match(scene.code, new RegExp(`fixture V${String(index).padStart(2, '0')}`))
  }
  assert.equal(disk.inspect().fixtures.V17.revisionOrderCount, 0)
  assert.equal(disk.inspect().fixtures.V17.epoch, null)

  const retried = await disk.restartForTests()
  assert.equal(retried.mode, 'disk')
  c = counters()
  assert.equal(c.startupEvictedScenes, 1)
  assert.equal(c.sceneWritePreserve, false)
  assert.equal(fence().cleanupRename, 1)
  assert.equal(fence().cleanupScenesParentFsync, 1)
  assert.equal(fs.existsSync(sceneDir(sessions[17])), false)
  for (let index = 1; index <= 16; index += 1) {
    const scene = await sceneJson(sessions[index])
    assert.equal(scene.revision, 1)
    assert.match(scene.code, new RegExp(`fixture V${String(index).padStart(2, '0')}`))
  }
  assert.equal((await sceneGet(sessions[17])).status, 404)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneGet(sessions[17])).status, 404)
  for (let index = 1; index <= 16; index += 1) {
    assert.equal((await sceneJson(sessions[index])).revision, 1)
  }
})

// ===========================================================================
// D2(vii)/V10-02 shared-parent fence concurrency. The pause is a test-only
// barrier seam; production behavior with no pause armed is unchanged.
// ===========================================================================
test('D2(vii) boundary fence holds a positive cleanup waiter across both parent fsyncs', async () => {
  const boundarySession = 'sess-d2vii-fence-boundary'
  await freshStore()
  disk.configureForTests({ recordFenceEvents: true })
  await seedAcknowledged(boundarySession, {
    revisions: 2, assets: 1, baseOrder: 5000, label: 'FB',
  })
  const sessions = []
  for (let index = 1; index <= 15; index += 1) {
    const session = `sess-d2vii-fence-${String(index).padStart(2, '0')}`
    sessions.push(session)
    await seedAcknowledged(session, {
      revisions: 1, baseOrder: 100 + index, label: `FC${String(index).padStart(2, '0')}`,
    })
  }
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  host.__historyInternal.clearScene(boundarySession)
  assert.equal((await sceneGet(boundarySession)).status, 404)
  // The startup keep-set is exactly 16, so two test-only live entries make an
  // existing-session commit evict the Map-oldest loaded fixture through the
  // real commit/eviction/cleanup path.
  host.__historyInternal.seedSession('sess-d2vii-model-x', [{
    sceneId: 'sess-d2vii-model-x', revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1,
  }])
  host.__historyInternal.seedSession('sess-d2vii-model-y', [{
    sceneId: 'sess-d2vii-model-y', revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1,
  }])
  const victimDir = sceneDir(sessions[0])
  const victimBefore = treeSnapshot(victimDir)

  const pause = disk.pauseAtForTests('afterSceneGenerationBoundaryRename')
  const boundaryAppend = appendScene(boundarySession, 'const fencedBoundary = 1')
  await waitForPause(pause, 'boundary rename pause')
  let f = fence()
  assert.equal(f.held, true)
  assert.equal(f.holderKind, 'boundary')
  assert.equal(f.boundaryRename, 1)
  assert.equal(f.boundaryTrashParentFsync, 0)
  assert.equal(f.boundaryScenesParentFsync, 0)
  assert.equal(trashSlots().length, 1)
  assert.equal(intentNames().length, 1)

  const concurrent = await appendScene(sessions[1], 'const concurrentExistingAppend = 1')
  assert.equal(concurrent.revision, 2)
  await waitForCondition(() => fence().waiterCount > 0, 'cleanup fence waiter')
  f = fence()
  assert.equal(f.held, true)
  assert.equal(f.holderKind, 'boundary')
  assert.ok(f.waiterCount > 0)
  assert.equal(f.cleanupRename, 0)
  assert.equal(f.cleanupScenesParentFsync, 0)
  assert.equal(f.boundaryTrashParentFsync, 0)
  assert.equal(f.boundaryScenesParentFsync, 0)
  assert.deepEqual(treeSnapshot(victimDir), victimBefore)

  // Keep the fenced boundary's own commit from creating a second eviction
  // cleanup; the positive waiter under test is the eviction captured above.
  host.__historyInternal.clearScene('sess-d2vii-model-x')
  assert.equal(pause.release(), true)
  const accepted = await boundaryAppend
  assert.equal(accepted.revision, 1)
  await waitForCleanupIdle()
  f = fence()
  assert.equal(f.held, false)
  assert.equal(f.waiterCount, 0)
  assert.equal(f.boundaryTrashParentFsync, 1)
  assert.equal(f.boundaryScenesParentFsync, 1)
  assert.equal(f.cleanupRename, 1)
  assert.equal(f.cleanupScenesParentFsync, 1)
  const events = disk.fenceEventsForTests()
  const trashFsync = fenceEventIndex(events, 'boundaryTrashParentFsync')
  const scenesFsync = fenceEventIndex(events, 'boundaryScenesParentFsync')
  const cleanupFsync = fenceEventIndex(events, 'cleanupScenesParentFsync')
  assert.ok(trashFsync >= 0)
  assert.ok(scenesFsync > trashFsync)
  assert.ok(cleanupFsync > scenesFsync)
  assert.equal(fs.existsSync(victimDir), false)
  assert.equal((await sceneJson(boundarySession)).revision, 1)
  assert.match((await sceneJson(boundarySession)).code, /fencedBoundary/)
  assert.equal((await sceneJson(sessions[1])).revision, 2)

  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.match((await sceneJson(boundarySession)).code, /fencedBoundary/)
  assert.equal((await sceneJson(sessions[1])).revision, 2)
})

test('D2(vii) model-only no-fence interleaving predicts the rev9 lost-name state', () => {
  // Pure state prediction only. This is not a production switch, performs no
  // real namespace mutation, and is never cited as production proof.
  const crashWindow = (fenceEnabled) => {
    const durable = { oldName: true, slot: false }
    // The boundary rename makes only the destination visible. Before the
    // boundary's destination fsync, an unfenced concurrent cleanup could fsync
    // the shared scenes parent and make the source removal durable first.
    if (!fenceEnabled) durable.oldName = false
    // Crash here, before the boundary's trash-parent fsync can make the slot
    // durable. With the fence, no cleanup scenes fsync can enter this window.
    return durable.oldName === false && durable.slot === false
  }
  assert.equal(crashWindow(false), true)
  assert.equal(crashWindow(true), false)
})

// ===========================================================================
// D2(iii)/V10-04 later trash/shared-parent paths after poison.
// ===========================================================================
test('D2(iii) poisoned later eviction cleanup and second boundary fail before mutation', async () => {
  const victim = 'sess-d2iii-later-victim'
  const poisonSession = 'sess-d2iii-later-poison'
  const secondBoundary = 'sess-d2iii-later-second'
  const appendSession = 'sess-d2iii-later-append'
  await freshStore()
  await seedAcknowledged(victim, { revisions: 3, assets: 2, baseOrder: 100, label: 'LV' })
  await seedAcknowledged(secondBoundary, { revisions: 1, assets: 1, baseOrder: 200, label: 'LQ' })
  await seedAcknowledged(poisonSession, { revisions: 1, assets: 1, baseOrder: 9000, label: 'LP' })
  const loaded = []
  for (let index = 1; index <= 12; index += 1) {
    const session = `sess-d2iii-later-c-${String(index).padStart(2, '0')}`
    loaded.push(session)
    await seedAcknowledged(session, {
      revisions: 1, assets: index === 12 ? 1 : 0,
      baseOrder: 300 + index, label: `LC${String(index).padStart(2, '0')}`,
    })
  }
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  host.__historyInternal.clearScene(poisonSession)
  host.__historyInternal.clearScene(secondBoundary)
  for (const extra of ['x', 'y', 'z', 'w']) {
    host.__historyInternal.seedSession(`sess-d2iii-later-model-${extra}`, [{
      sceneId: `sess-d2iii-later-model-${extra}`,
      revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1,
    }])
  }
  const victimBefore = treeSnapshot(sceneDir(victim))
  const victimAssetDir = path.join(root, 'assets', disk.helpers.sceneSidHash(victim))
  const victimAssetsBefore = treeSnapshot(victimAssetDir)
  const secondBefore = treeSnapshot(sceneDir(secondBoundary))
  const ordinary = randomBytes(16).toString('hex')
  fs.mkdirSync(slotDir(ordinary), { mode: 0o700 })
  fs.writeFileSync(path.join(slotDir(ordinary), 'ordinary.bin'), Buffer.from('keep'), { mode: 0o600 })
  const ordinaryBefore = treeSnapshot(slotDir(ordinary))

  const pause = disk.pauseAtForTests('beforeCleanup')
  const appended = await (async () => {
    const promise = appendScene(loaded[11], 'const laterVictimAppend = 1')
    await waitForPause(pause, 'beforeCleanup pause')
    return promise
  })()
  assert.equal(appended.revision, 2)
  let token = disk.inspect().lastCleanupToken
  assert.equal(token.orderCount, 3)
  assert.equal(token.assetCount, 2)
  assert.equal(token.victimSet.LV, true)
  assert.equal(token.victimSet.LC12, false)

  armFault('dirFsync', 'scene-generation-boundary-scenes-parent', 1)
  armFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent', 1)
  armFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent-retry', 1)
  await assert.rejects(appendScene(poisonSession, 'const laterPoison = 1'))
  let f = fence()
  assert.equal(f.state, 'namespace-recovery-required')
  assert.equal(f.cleanupRename, 0)
  assert.equal(f.cleanupScenesParentFsync, 0)
  assert.deepEqual(treeSnapshot(sceneDir(victim)), victimBefore)
  assert.deepEqual(treeSnapshot(victimAssetDir), victimAssetsBefore)
  assert.equal(intentNames().length, 1)
  const poisonIntent = intentNames()[0]
  const intentBefore = fs.readFileSync(path.join(trashDir(), poisonIntent))
  assert.equal(trashSlots().includes(ordinary), true)

  await assert.rejects(appendScene(secondBoundary, 'const laterSecondBoundary = 1'))
  assert.equal(intentNames().length, 1)
  assert.deepEqual(fs.readFileSync(path.join(trashDir(), poisonIntent)), intentBefore)
  assert.deepEqual(treeSnapshot(sceneDir(secondBoundary)), secondBefore)
  assert.deepEqual(treeSnapshot(slotDir(ordinary)), ordinaryBefore)
  assert.equal((await sceneJson(loaded[11])).revision, 2)

  assert.equal(pause.release(), true)
  await waitForCleanupIdle()
  f = fence()
  assert.equal(f.cleanupRename, 0)
  assert.equal(f.cleanupScenesParentFsync, 0)
  assert.equal(f.state, 'namespace-recovery-required')
  assert.deepEqual(treeSnapshot(sceneDir(victim)), victimBefore)
  assert.deepEqual(treeSnapshot(victimAssetDir), victimAssetsBefore)
  assert.deepEqual(fs.readFileSync(path.join(trashDir(), poisonIntent)), intentBefore)
  assert.deepEqual(treeSnapshot(slotDir(ordinary)), ordinaryBefore)
  const readList = await assetInternal.listResponse(new Request('http://localhost/three-workbench/assets', {
    headers: { 'x-workbench-session': loaded[11] },
  }))
  assert.equal(readList.status, 200)
  assert.equal((await readList.json()).assets.length, 1)

  disk.faults.clear()
  const repaired = await disk.restartForTests()
  assert.equal(repaired.mode, 'disk')
  const c = counters()
  assert.equal(c.sceneWritePreserve, false)
  assert.equal(c.startupInert, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(fence().state, 'normal')
  assert.equal(fs.existsSync(path.join(trashDir(), poisonIntent)), false)
  assert.equal((await sceneJson(victim)).revision, 3)
  const victimList = await assetInternal.listResponse(new Request('http://localhost/three-workbench/assets', {
    headers: { 'x-workbench-session': victim },
  }))
  assert.equal(victimList.status, 200)
  assert.equal((await victimList.json()).assets.length, 2)
  assert.deepEqual(treeSnapshot(sceneDir(victim)), victimBefore)
  assert.deepEqual(treeSnapshot(victimAssetDir), victimAssetsBefore)
  assert.equal((await sceneJson(secondBoundary)).revision, 1)
  assert.match((await sceneJson(secondBoundary)).code, /fixture LQ revision 1/)
  assert.equal((await sceneJson(loaded[11])).revision, 2)
  // The unrelated ordinary slot survived every poisoned runtime attempt; a
  // clean restart's bounded ordinary-trash cleanup may now remove it.
  assert.equal(fs.existsSync(slotDir(ordinary)), false)

})

// ===========================================================================
// D2 DF-1/R5/R10 startup scan cap and forced deadline.
// ===========================================================================
test('D2(DF-1) exactly 4096 boundary intents process at the cap without truncation', async () => {
  await freshStore()
  await stopStore()
  const missingSession = 'sess-d2df1-exact-cap-target-absent'
  const count = 4096
  for (let index = 0; index < count; index += 1) {
    const slot = createHash('sha256').update(`exact-cap-slot:${String(index)}`).digest('hex').slice(0, 32)
    const built = makeIntent(missingSession, slot, { newOrder: 7400 + index })
    fs.writeFileSync(intentPath(slot), built.bytes, { mode: 0o600 })
  }
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupBoundaryIntents, count)
  assert.equal(c.startupBoundaryTruncated, 0)
  assert.equal(c.startupBoundaryInvalid, count)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.startupRestored, 0)
  assert.equal(c.startupInert, 0)
  assert.equal(c.sceneWritePreserve, false)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 0)
  assert.equal(f.startupInertScenesParentFsync, 0)
  assert.equal(f.startupRestoreScenesParentFsync, 0)
  assert.equal(f.startupTrashParentFsync, 0)
  assert.equal(intentNames().length, count)
  const session = 'sess-d2df1-exact-cap-healthy-append'
  const appended = await appendScene(session, 'const exactCapHealthy = 1')
  assert.equal(appended.revision, 1)
  assert.equal((await sceneJson(session)).revision, 1)
})

test('D2(DF-1) forced startup deadline truncates before mutation and preserves every entry', async () => {
  const session = 'sess-d2df1-deadline'
  await freshStore()
  await seedAcknowledged(session, { revisions: 2, assets: 1 })
  await stopStore()
  const slot = randomBytes(16).toString('hex')
  fs.renameSync(sceneDir(session), slotDir(slot))
  const builtIntent = writeIntent(session, slot, { newOrder: 7500 })
  const slotBefore = treeSnapshot(slotDir(slot))
  const intentBefore = fs.readFileSync(intentPath(slot))
  const extraIntents = []
  for (let index = 0; index < 7; index += 1) {
    const extraSlot = createHash('sha256').update(`deadline-extra:${String(index)}`).digest('hex').slice(0, 32)
    const built = makeIntent(session, extraSlot, { newOrder: 7501 + index })
    fs.writeFileSync(intentPath(extraSlot), built.bytes, { mode: 0o600 })
    extraIntents.push({ file: intentPath(extraSlot), bytes: built.bytes })
  }
  const ordinary = randomBytes(16).toString('hex')
  fs.mkdirSync(slotDir(ordinary), { mode: 0o700 })
  fs.writeFileSync(path.join(slotDir(ordinary), 'ordinary.bin'), Buffer.from('deadline keep'), { mode: 0o600 })
  const ordinaryBefore = treeSnapshot(slotDir(ordinary))
  disk.configureForTests({ forceStartupDeadlineAfterScanEntries: 0 })

  const truncated = await disk.restartForTests()
  assert.equal(truncated.mode, 'degraded')
  assert.equal(truncated.status, 'startup-deadline')
  let c = counters()
  assert.equal(c.startupBoundaryTruncated, 1)
  assert.equal(c.sceneWritePreserve, true)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.startupRestored, 0)
  assert.equal(c.startupInert, 0)
  let f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 0)
  assert.equal(f.startupInertScenesParentFsync, 0)
  assert.equal(f.startupRestoreScenesParentFsync, 0)
  assert.equal(f.startupTrashParentFsync, 0)
  assert.deepEqual(fs.readFileSync(intentPath(slot)), intentBefore)
  for (const entry of extraIntents) assert.deepEqual(fs.readFileSync(entry.file), entry.bytes)
  assert.deepEqual(treeSnapshot(slotDir(slot)), slotBefore)
  assert.deepEqual(treeSnapshot(slotDir(ordinary)), ordinaryBefore)
  assert.equal(fs.existsSync(sceneDir(session)), false)
  await assert.rejects(appendScene(session, 'const forcedDeadlineAppend = 1'))

  disk.configureForTests({ forceStartupDeadlineAfterScanEntries: null })
  const repaired = await disk.restartForTests()
  assert.equal(repaired.mode, 'disk')
  c = counters()
  assert.equal(c.startupBoundaryTruncated, 0)
  assert.equal(c.sceneWritePreserve, false)
  assert.equal(c.startupRestored, 1)
  assert.equal(c.startupBoundaryRecovery, 0)
  f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 1)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.equal(trashSlots().includes(slot), false)
  assert.equal((await sceneJson(session)).revision, 2)
  assert.deepEqual(treeSnapshot(sceneDir(session)), slotBefore)
})

// ===========================================================================
// D2 C3/D8 exact SIGKILL barriers at the boundary intent and second parent
// fsync. The closed child write and the parent restart are the evidence.
// ===========================================================================
test('D2(i)/D8 crashAt afterSceneGenerationBoundaryIntent leaves durable inert intent and restores old history', async () => {
  const session = 'sess-d2-crash-after-intent'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  await stopStore()
  spawnCrashAppend(session, 'afterSceneGenerationBoundaryIntent')
  assert.equal(intentNames().length, 1)
  assert.equal(trashSlots().length, 0)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  const [intentName] = intentNames()
  const slot = intentName.replace(/\.intent\.json$/, '')
  assert.match(slot, SLOT_RE)
  const intent = readJsonFile(path.join(trashDir(), intentName))
  assert.equal(intent.slot, slot)
  assert.equal(intent.sidHash, disk.helpers.sceneSidHash(session))
  assert.equal(intent.newOrder > 0, true)
  assert.match(intent.newRevisionRecordSha256, HEX64_RE)
  const intentBefore = fs.readFileSync(path.join(trashDir(), intentName))
  assert.equal(diskSha(intentBefore), diskSha(fs.readFileSync(intentPath(slot))))

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupBoundaryIntents, 1)
  assert.equal(c.startupInert, 1)
  assert.equal(c.startupRestored, 0)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.sceneWritePreserve, false)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupInertScenesParentFsync, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 0)
  assert.equal(f.startupRestoreRename, 0)
  assert.equal(f.startupTrashParentFsync, 1)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.equal(trashSlots().includes(slot), false)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.equal((await sceneJson(session)).revision, 1)
  assert.match((await sceneJson(session)).code, /fixture F revision 1/)

  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal(counters().startupBoundaryIntents, 0)
  assert.deepEqual(treeSnapshot(sceneDir(session)), oldBefore)
  assert.equal((await sceneJson(session)).revision, 1)
})

test('D2(i)/D8 crashAt afterSceneGenerationBoundaryScenesParentFsync restores slot-only before cleanup', async () => {
  const session = 'sess-d2-crash-after-scenes-fsync'
  await prepareAdoptionBoundary(session, { assets: 1 })
  const oldBefore = treeSnapshot(sceneDir(session))
  await stopStore()
  spawnCrashAppend(session, 'afterSceneGenerationBoundaryScenesParentFsync')
  assert.equal(intentNames().length, 1)
  assert.equal(trashSlots().length, 1)
  const [slot] = trashSlots()
  const [intentName] = intentNames()
  const intent = readJsonFile(path.join(trashDir(), intentName))
  assert.equal(intent.slot, slot)
  assert.equal(fs.existsSync(sceneDir(session)), false)
  assert.deepEqual(treeSnapshot(slotDir(slot)), oldBefore)
  const slotBefore = treeSnapshot(slotDir(slot))
  const intentBefore = fs.readFileSync(intentPath(slot))

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const c = counters()
  assert.equal(c.startupBoundaryIntents, 1)
  assert.equal(c.startupRestored, 1)
  assert.equal(c.startupInert, 0)
  assert.equal(c.startupBoundaryRecovery, 0)
  assert.equal(c.startupBoundaryInvalid, 0)
  assert.equal(c.sceneWritePreserve, false)
  const f = fence()
  assert.equal(f.state, 'normal')
  assert.equal(f.startupRestoreRename, 1)
  assert.equal(f.startupRestoreScenesParentFsync, 1)
  assert.equal(f.startupTrashParentFsync, 1)
  assert.equal(f.startupInertScenesParentFsync, 0)
  assert.equal(fs.existsSync(intentPath(slot)), false)
  assert.equal(trashSlots().includes(slot), false)
  assert.deepEqual(treeSnapshot(sceneDir(session)), slotBefore)
  assert.equal((await sceneJson(session)).revision, 1)
  assert.match((await sceneJson(session)).code, /fixture F revision 1/)

  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal(counters().startupBoundaryIntents, 0)
  assert.deepEqual(treeSnapshot(sceneDir(session)), slotBefore)
  assert.equal((await sceneJson(session)).revision, 1)
  void intentBefore
})

// ===========================================================================
// N1/N9/N9-R/N10/N11/N16/N17/N19 rows: keep sets, actual-victim authority,
// revision-order side table, epoch publication, asset-only adoption, exact
// public failure, and post-commit scene disappearance.
// ===========================================================================
test('N1/N9-R 12-revision keep set survives a failed r13 and trim deletes only captured r1', async () => {
  const session = 'sess-n1-n9r-trim'
  await freshStore()
  await seedAcknowledged(session, { revisions: 12, assets: 1, baseOrder: 100, label: 'K' })
  await disk.restartForTests()
  assert.equal((await sceneJson(session)).revision, 12)
  const r1Revision = path.join(sceneDir(session), disk.generatedNames.sceneRevision(100))
  const r1Marker = path.join(sceneDir(session), disk.generatedNames.sceneMarker(100))
  const r1Bytes = fs.readFileSync(r1Revision)
  const r1MarkerBytes = fs.readFileSync(r1Marker)
  armFault('sceneCommitMarker', 'beforeSceneCommitMarker', 1)
  await assert.rejects(appendScene(session, 'const failedThirteenth = true'))
  assert.equal(counters().sceneWriteDegraded, true)
  await waitForCleanupIdle()
  for (let revision = 1; revision <= 12; revision += 1) {
    assert.equal(fs.existsSync(path.join(sceneDir(session),
      disk.generatedNames.sceneRevision(99 + revision))), true)
  }
  assert.deepEqual(fs.readFileSync(r1Revision), r1Bytes)
  assert.deepEqual(fs.readFileSync(r1Marker), r1MarkerBytes)
  const failedRestart = await disk.restartForTests()
  assert.equal(failedRestart.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 12)
  assert.equal(disk.inspect().fixtures.K.revisionOrderCount, 12)
  assert.deepEqual(fs.readFileSync(r1Revision), r1Bytes)
  assert.deepEqual(fs.readFileSync(r1Marker), r1MarkerBytes)
  assert.equal(disk.inspect().fixtures.K.ordersByRevision['1'], 100)

  const appended = await appendScene(session, 'const successfulThirteenth = true')
  assert.equal(appended.revision, 13)
  const token = disk.inspect().lastCleanupToken
  assert.equal(token.orderCount, 1)
  assert.equal(token.assetCount, 0)
  assert.equal(token.victimSet.K, true)
  await waitForCleanupIdle()
  assert.equal(fs.existsSync(r1Revision), false)
  assert.equal(fs.existsSync(r1Marker), false)
  assert.equal(disk.inspect().fixtures.K.ordersByRevision['1'], undefined)
  assert.equal(disk.inspect().fixtures.K.revisionOrderCount, 12)
  for (let revision = 2; revision <= 13; revision += 1) {
    assert.equal(fs.existsSync(path.join(sceneDir(session),
      disk.generatedNames.sceneRevision(99 + revision))), true)
  }
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 13)
  assert.equal(disk.inspect().fixtures.K.revisionOrderCount, 12)
  assert.equal(disk.inspect().fixtures.K.ordersByRevision['1'], undefined)
  assert.equal(disk.inspect().fixtures.K.ordersByRevision['2'], 101)
})

test('N1 16-session keep set survives a failed S17 first append and preserves S1 assets', async () => {
  await freshStore()
  const sessions = []
  for (let index = 1; index <= 16; index += 1) {
    const session = `sess-n1-cap-s${String(index).padStart(2, '0')}`
    sessions.push(session)
    await seedAcknowledged(session, {
      revisions: 1,
      assets: index === 1 ? 2 : 0,
      baseOrder: 100 + index,
      label: `S${String(index).padStart(2, '0')}`,
    })
  }
  await disk.restartForTests()
  for (let index = 1; index <= 16; index += 1) {
    const label = `S${String(index).padStart(2, '0')}`
    assert.equal(disk.inspect().fixtures[label].revisionOrderCount, 1)
  }
  assert.equal((await listAssets(sessions[0])).body.assets.length, 2)
  const newSession = 'sess-n1-cap-s17'
  armFault('sceneCommitMarker', 'beforeSceneCommitMarker', 1)
  await assert.rejects(appendScene(newSession, 'const unacknowledgedS17 = true'))
  assert.equal(counters().sceneWriteDegraded, true)
  await assert.rejects(appendScene(newSession, 'const blockedS17 = true'))
  disk.faults.clear()
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal(counters().sceneWriteDegraded, false)
  assert.equal(counters().startupEvictedScenes, 0)
  assert.equal((await sceneGet(newSession)).status, 404)
  for (const session of sessions) assert.equal((await sceneJson(session)).revision, 1)
  const assets = await listAssets(sessions[0])
  assert.equal(assets.status, 200)
  assert.equal(assets.body.assets.length, 2)
  assert.equal(assets.body.usage.count, 2)
  assert.equal(disk.inspect().fixtures.S01.revisionOrderCount, 1)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneGet(newSession)).status, 404)
  assert.equal((await listAssets(sessions[0])).body.assets.length, 2)
})

test('N9/N19 actual victim token names only S2 with its revisions and assets; absent S17 upload is 404', async () => {
  await freshStore()
  const sessions = new Map()
  for (let index = 17; index >= 1; index -= 1) {
    const session = `sess-n9-victim-${String(index).padStart(2, '0')}`
    sessions.set(index, session)
    await seedAcknowledged(session, {
      revisions: 1,
      assets: index === 1 ? 1 : index === 2 ? 2 : 0,
      baseOrder: index === 17 ? 100 : 100 + index,
      label: `V${String(index).padStart(2, '0')}`,
    })
  }
  const firstRestart = await disk.restartForTests()
  assert.equal(firstRestart.mode, 'disk')
  assert.equal(counters().startupEvictedScenes, 1)
  assert.equal((await sceneGet(sessions.get(17))).status, 404)
  assert.equal((await sceneGet(sessions.get(2))).status, 200)
  assert.equal((await listAssets(sessions.get(2))).body.assets.length, 2)
  // Exactly 16 disk-loaded sessions plus one test-only live entry make the
  // existing-session commit evict the real Map-oldest loaded fixture S2.
  host.__historyInternal.seedSession('sess-n9-victim-model', [{
    sceneId: 'sess-n9-victim-model', revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1,
  }])
  const tokenBefore = disk.inspect().lastCleanupToken
  const appended = await appendScene(sessions.get(1), 'const n9ActualVictim = true')
  assert.equal(appended.revision, 2)
  const token = disk.inspect().lastCleanupToken
  assert.notDeepEqual(token, tokenBefore)
  assert.equal(token.orderCount, 1)
  assert.equal(token.assetCount, 2)
  const expectedVictims = {}
  for (let index = 1; index <= 17; index += 1) expectedVictims[`V${String(index).padStart(2, '0')}`] = index === 2
  assert.deepEqual(token.victimSet, expectedVictims)
  await waitForCleanupIdle()
  assert.equal((await sceneGet(sessions.get(2))).status, 404)
  assert.equal(fs.existsSync(sceneDir(sessions.get(2))), false)
  assert.equal((await sceneGet(sessions.get(1))).status, 200)
  assert.equal((await sceneJson(sessions.get(1))).revision, 2)
  const survivorAssets = await listAssets(sessions.get(1))
  assert.equal(survivorAssets.status, 200)
  assert.equal(survivorAssets.body.assets.length, 1)
  assert.equal(disk.inspect().fixtures.V01.revisionOrderCount, 2)
  assert.equal(disk.inspect().fixtures.V02.revisionOrderCount, 0)
  assert.equal(disk.inspect().fixtures.V01.recordedEntryPresent, false)
  assert.equal(disk.inspect().fixtures.V02.recordedEntryPresent, false)
  assert.equal(disk.stats().bytes.staging, 0)
  const missingUpload = await uploadAsset(sessions.get(17), 'missing.png')
  assert.equal(missingUpload.status, 404)
  assert.equal(jsonBody(missingUpload).error.code, 'unknown-session')
  assert.equal((await listAssets(sessions.get(17))).status, 404)
  assert.equal(disk.stats().bytes.staging, 0)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(sessions.get(1))).revision, 2)
  assert.equal((await sceneGet(sessions.get(2))).status, 404)
  assert.equal((await sceneGet(sessions.get(17))).status, 404)
  assert.equal((await listAssets(sessions.get(1))).body.assets.length, 1)
})

test('N9 no-eviction append to a non-oldest session creates no session-eviction token', async () => {
  await freshStore()
  const sessions = []
  for (let index = 1; index <= 16; index += 1) {
    const session = `sess-n9-noevict-${String(index).padStart(2, '0')}`
    sessions.push(session)
    await seedAcknowledged(session, {
      revisions: 1, assets: 0, baseOrder: 200 + index,
      label: `U${String(index).padStart(2, '0')}`,
    })
  }
  await disk.restartForTests()
  const tokenBefore = disk.inspect().lastCleanupToken
  const appended = await appendScene(sessions[7], 'const noEvictionAppend = true')
  assert.equal(appended.revision, 2)
  await waitForCleanupIdle()
  assert.deepEqual(disk.inspect().lastCleanupToken, tokenBefore)
  assert.equal(disk.inspect().fixtures.U08.revisionOrderCount, 2)
  for (const session of sessions) assert.equal((await sceneGet(session)).status, 200)
  assert.equal((await sceneJson(sessions[7])).revision, 2)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal(counters().startupEvictedScenes, 0)
  for (const session of sessions) assert.equal((await sceneGet(session)).status, 200)
  assert.equal((await sceneJson(sessions[7])).revision, 2)
})

test('N10/N16 existing-scene upload publishes the committed epoch, missing epoch is exact 503', async () => {
  const session = 'sess-n10-epoch-window'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'E' })
  await disk.restartForTests()
  const pause = disk.pauseAtForTests('beforeSceneCommitMarker')
  const appendedPromise = appendScene(session, 'const epochPublishedAppend = true')
  await waitForPause(pause, 'existing-scene marker window')
  const uploaded = await uploadAsset(session, 'epoch-window.png')
  assert.equal(uploaded.status, 201)
  const uploadedAsset = jsonBody(uploaded).asset
  pause.release()
  const appended = await appendedPromise
  assert.equal(appended.revision, 2)
  await disk.restartForTests()
  const scene = await sceneJson(session)
  assert.equal(scene.revision, 2)
  const epoch = disk.inspect().fixtures.E.epoch
  assert.match(epoch, HEX32_RE)
  const owner = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  assert.equal(owner.sceneEpoch, epoch)
  const metaPath = path.join(assetSessionDir(session),
    disk.helpers.assetIdHash(uploadedAsset.id), 'meta.json')
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  assert.equal(meta.sceneEpoch, epoch)
  assert.equal(meta.sceneId, session)
  const rows = await listAssets(session)
  assert.equal(rows.status, 200)
  assert.equal(rows.body.assets.length, 1)
  assert.equal(rows.body.assets[0].id, uploadedAsset.id)
  assert.equal(rows.body.usage.count, 1)

  const usedBefore = disk.stats().bytes.used
  const stagingBefore = disk.stats().bytes.staging
  assert.equal(disk.dropSceneEpochForTests(session), true)
  const missing = await uploadAsset(session, 'missing-epoch.png')
  assert.equal(missing.status, 503)
  assert.deepEqual(jsonBody(missing), {
    ok: false,
    error: { code: 'storage', message: 'could not store asset' },
  })
  assert.equal(disk.stats().bytes.used, usedBefore)
  assert.equal(disk.stats().bytes.staging, stagingBefore)
  const afterMissing = await listAssets(session)
  assert.equal(afterMissing.body.assets.length, 1)
  const restored = await disk.restartForTests()
  assert.equal(restored.mode, 'disk')
  assert.equal(disk.inspect().fixtures.E.epoch, epoch)
  assert.equal((await listAssets(session)).body.assets.length, 1)
})

test('N10 new-scene marker window queues a same-session upload until the marker publishes', async () => {
  const session = 'sess-n10-new-marker-window'
  await freshStore()
  const pause = disk.pauseAtForTests('beforeSceneCommitMarker')
  const appendedPromise = appendScene(session, 'const newSceneMarkerWindow = true')
  await waitForPause(pause, 'new-scene marker window')
  const uploadPromise = uploadAsset(session, 'queued-new-scene.png')
  let uploadSettled = false
  uploadPromise.then(() => { uploadSettled = true })
  await delay(100)
  assert.equal(uploadSettled, false)
  assert.equal((await listAssets(session)).body.assets.length, 0)
  pause.release()
  const appended = await appendedPromise
  const uploaded = await uploadPromise
  assert.equal(appended.revision, 1)
  assert.equal(uploaded.status, 201)
  const uploadedAsset = jsonBody(uploaded).asset
  await disk.restartForTests()
  const scene = await sceneJson(session)
  assert.equal(scene.revision, 1)
  assert.match(scene.code, /newSceneMarkerWindow/)
  const epoch = disk.sceneEpochForTests(session)
  assert.match(epoch, HEX32_RE)
  const meta = JSON.parse(fs.readFileSync(path.join(assetSessionDir(session),
    disk.helpers.assetIdHash(uploadedAsset.id), 'meta.json'), 'utf8'))
  assert.equal(meta.sceneEpoch, epoch)
  assert.equal((await listAssets(session)).body.assets.length, 1)
})

test('N17 post-commit scene disappearance rolls back the asset and preserves acknowledged scene state', async () => {
  const session = 'sess-n17-post-commit-disappear'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'D' })
  await disk.restartForTests()
  const sceneBefore = treeSnapshot(sceneDir(session))
  const pause = disk.pauseAtForTests('beforeAssetPostCommitRecheck')
  const uploadPromise = uploadAsset(session, 'disappearing.png')
  await waitForPause(pause, 'asset post-commit recheck')
  host.__historyInternal.clearScene(session)
  assert.equal((await sceneGet(session)).status, 404)
  pause.release()
  const uploaded = await uploadPromise
  assert.equal(uploaded.status, 404)
  assert.equal(jsonBody(uploaded).error.code, 'unknown-session')
  await waitForCleanupIdle()
  assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore)
  assert.equal((await listAssets(session)).status, 404)
  assert.equal(disk.stats().bytes.staging, 0)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const scene = await sceneJson(session)
  assert.equal(scene.revision, 1)
  assert.match(scene.code, /fixture D revision 1/)
  assert.equal(disk.inspect().fixtures.D.revisionOrderCount, 1)
  assert.equal((await listAssets(session)).body.assets.length, 0)
})

test('N11/N10 asset-only restart adopts the owner epoch, and D-SEC-2 owner has exactly seven fields', async () => {
  const session = 'sess-n11-asset-only-adopt'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 2, label: 'A' })
  const oldOwner = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  const oldOwnerEpoch = oldOwner.sceneEpoch
  const oldIncarnation = oldOwner.incarnation
  await stopStore()
  durableViewAdapter().remove(sceneDir(session)).materialize()
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneGet(session)).status, 404)
  let assets = await listAssets(session)
  assert.equal(assets.status, 200)
  assert.equal(assets.body.assets.length, 2)
  assert.equal(assets.body.usage.count, 2)
  const ownerBeforeAdoption = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  assert.deepEqual(Object.keys(ownerBeforeAdoption),
    ['v', 'kind', 'sidHash', 'sceneEpoch', 'incarnation', 'updatedAt', 'recordSha256'])
  const ownerBytes = fs.readFileSync(ownerRecordPath(session))
  assert.ok(ownerBytes.length <= 1024)
  const ownerStat = fs.lstatSync(ownerRecordPath(session))
  assert.equal(ownerStat.isFile(), true)
  assert.equal(ownerStat.isSymbolicLink(), false)
  assert.equal(ownerStat.uid, process.getuid())
  assert.equal(ownerStat.mode & 0o777, 0o600)
  assert.equal(ownerBeforeAdoption.v, 1)
  assert.equal(ownerBeforeAdoption.kind, 'asset-owner')
  assert.equal(ownerBeforeAdoption.sceneEpoch, oldOwnerEpoch)
  assert.match(ownerBeforeAdoption.sceneEpoch, HEX32_RE)
  assert.match(ownerBeforeAdoption.incarnation, HEX32_RE)
  assert.equal(ownerBeforeAdoption.recordSha256, canonicalPairsHash([
    ['v', 1], ['kind', ownerBeforeAdoption.kind], ['sidHash', ownerBeforeAdoption.sidHash],
    ['sceneEpoch', ownerBeforeAdoption.sceneEpoch], ['incarnation', ownerBeforeAdoption.incarnation],
    ['updatedAt', ownerBeforeAdoption.updatedAt],
  ]))
  assert.equal(ownerBytes.includes(Buffer.from(session, 'utf8')), false)
  assert.equal(ownerBeforeAdoption.incarnation, oldIncarnation)
  const missing = await uploadAsset(session, 'no-scene.png')
  assert.equal(missing.status, 404)
  assert.equal(jsonBody(missing).error.code, 'unknown-session')
  assert.equal(disk.stats().bytes.staging, 0)

  const appended = await appendScene(session, 'const adoptedAssetOnlyEpoch = true')
  assert.equal(appended.revision, 1)
  const adoptedEpoch = disk.inspect().fixtures.A.epoch
  assert.equal(adoptedEpoch, oldOwnerEpoch)
  const ownerAfter = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  assert.equal(ownerAfter.sceneEpoch, oldOwnerEpoch)
  assert.match(ownerAfter.incarnation, HEX32_RE)
  assert.notEqual(ownerAfter.incarnation, oldIncarnation)
  assert.equal((await listAssets(session)).body.assets.length, 2)
  const firstStable = await disk.restartForTests()
  assert.equal(firstStable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(disk.inspect().fixtures.A.epoch, oldOwnerEpoch)
  assert.equal((await listAssets(session)).body.assets.length, 2)
  const secondStable = await disk.restartForTests()
  assert.equal(secondStable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(disk.inspect().fixtures.A.epoch, oldOwnerEpoch)
  assert.equal((await listAssets(session)).body.assets.length, 2)
  const secondOwner = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  assert.equal(secondOwner.incarnation, ownerAfter.incarnation)
  assert.equal(secondOwner.sceneEpoch, oldOwnerEpoch)
})

test('B1 accepted-generation exact descending chain quarantines acknowledged duplicates and trims only the captured oldest', async () => {
  const session = 'sess-b1-chain-duplicates'
  await freshStore()
  const epoch = randomBytes(16).toString('hex')
  const revisions = Array.from({ length: 14 }, (_, index) => ({
    code: `const chainRev${String(index + 1)} = ${String(index + 1)}\n`,
  }))
  await disk.seedSceneForTests({
    session, revisions, epoch, baseOrder: 100, label: 'C',
  })
  const sidHash = disk.helpers.sceneSidHash(session)
  const duplicates = [
    makeRevisionRecord(session, epoch, 13, 99, 'const duplicateRev13 = 99\n'),
    makeRevisionRecord(session, epoch, 2, 98, 'const duplicateRev2 = 98\n'),
  ]
  const duplicateNames = []
  const adapter = durableViewAdapter()
  for (const record of duplicates) {
    const revisionName = disk.generatedNames.sceneRevision(record.object.order)
    const markerName = disk.generatedNames.sceneMarker(record.object.order)
    duplicateNames.push(revisionName, markerName)
    adapter.write(path.join(sceneDir(session), revisionName), record.bytes)
    adapter.write(path.join(sceneDir(session), markerName), makeMarkerRecord(
      sidHash, record.object.order, record.object.revision, record.sha256).bytes)
  }
  assert.equal(adapter.materialize(), 4)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 14)
  const view = disk.inspect()
  assert.equal(view.fixtures.C.epoch, epoch)
  assert.equal(view.fixtures.C.revisionOrderCount, 12)
  const expectedOrders = {}
  for (let revision = 3; revision <= 14; revision += 1) expectedOrders[String(revision)] = 99 + revision
  assert.deepEqual(view.fixtures.C.ordersByRevision, expectedOrders)
  for (const name of duplicateNames) {
    assert.equal(fs.existsSync(path.join(sceneDir(session), name)), false)
  }
  assert.equal(fs.existsSync(path.join(sceneDir(session), disk.generatedNames.sceneRevision(99))), false)
  assert.equal(fs.existsSync(path.join(sceneDir(session), disk.generatedNames.sceneRevision(98))), false)
  const selectedR13 = await (await ctx.records.route.resource(new Request(
    `http://localhost/three-workbench/scene/${encodeURIComponent(session)}?rev=13`))).json()
  assert.equal(selectedR13.revision, 13)
  assert.match(selectedR13.code, /chainRev13/)
  assert.equal((await ctx.records.route.resource(new Request(
    `http://localhost/three-workbench/scene/${encodeURIComponent(session)}?rev=2`))).status, 404)
  const r3Revision = path.join(sceneDir(session), disk.generatedNames.sceneRevision(102))
  const r3Marker = path.join(sceneDir(session), disk.generatedNames.sceneMarker(102))
  assert.equal(fs.existsSync(r3Revision), true)
  assert.equal(fs.existsSync(r3Marker), true)
  const appended = await appendScene(session, 'const chainRev15 = 15')
  assert.equal(appended.revision, 15)
  const token = disk.inspect().lastCleanupToken
  assert.equal(token.orderCount, 1)
  assert.equal(token.assetCount, 0)
  assert.equal(token.victimSet.C, true)
  await waitForCleanupIdle()
  assert.equal(fs.existsSync(r3Revision), false)
  assert.equal(fs.existsSync(r3Marker), false)
  assert.equal(disk.inspect().fixtures.C.ordersByRevision['3'], undefined)
  assert.equal(disk.inspect().fixtures.C.ordersByRevision['4'], 103)
  assert.equal(disk.inspect().fixtures.C.ordersByRevision['13'], 112)
  assert.equal(disk.inspect().fixtures.C.ordersByRevision['15'], 114)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 15)
  assert.equal(disk.inspect().fixtures.C.revisionOrderCount, 12)
  assert.equal(disk.inspect().fixtures.C.ordersByRevision['13'], 112)
})

test('N9-R late upload for the actual victim S2 is captured in the eviction token and cleaned exactly', async () => {
  await freshStore()
  const sessions = new Map()
  for (let index = 17; index >= 1; index -= 1) {
    const session = `sess-n9r-late-${String(index).padStart(2, '0')}`
    sessions.set(index, session)
    await seedAcknowledged(session, {
      revisions: 1,
      assets: index === 1 ? 1 : index === 2 ? 2 : 0,
      baseOrder: index === 17 ? 100 : 100 + index,
      label: `L${String(index).padStart(2, '0')}`,
    })
  }
  await disk.restartForTests()
  assert.equal(counters().startupEvictedScenes, 1)
  host.__historyInternal.seedSession('sess-n9r-late-model', [{
    sceneId: 'sess-n9r-late-model', revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1,
  }])
  const pause = disk.pauseAtForTests('afterRevisionDirFsync')
  const appendPromise = appendScene(sessions.get(1), 'const lateVictimAppend = true')
  await waitForPause(pause, 'late-victim append revision fsync')
  const late = await uploadAsset(sessions.get(2), 'late-victim.png')
  assert.equal(late.status, 201)
  const lateAsset = jsonBody(late).asset
  pause.release()
  const appended = await appendPromise
  assert.equal(appended.revision, 2)
  const token = disk.inspect().lastCleanupToken
  assert.equal(token.orderCount, 1)
  assert.equal(token.assetCount, 3)
  const expectedVictims = {}
  for (let index = 1; index <= 17; index += 1) expectedVictims[`L${String(index).padStart(2, '0')}`] = index === 2
  assert.deepEqual(token.victimSet, expectedVictims)
  await waitForCleanupIdle()
  assert.equal((await sceneGet(sessions.get(2))).status, 404)
  assert.equal(fs.existsSync(sceneDir(sessions.get(2))), false)
  assert.equal(fs.existsSync(path.join(assetSessionDir(sessions.get(2)),
    disk.helpers.assetIdHash(lateAsset.id))), false)
  assert.equal((await listAssets(sessions.get(2))).status, 404)
  assert.equal((await sceneJson(sessions.get(1))).revision, 2)
  assert.equal((await listAssets(sessions.get(1))).body.assets.length, 1)
  assert.equal(disk.stats().bytes.staging, 0)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(sessions.get(1))).revision, 2)
  assert.equal((await sceneGet(sessions.get(2))).status, 404)
  assert.equal((await listAssets(sessions.get(1))).body.assets.length, 1)
})

test('N18/N11-R owner epoch stays authoritative through asset-only adoption and two restarts', async () => {
  const session = 'sess-n18-owner-adoption'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 2, label: 'G' })
  const ownerBefore = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  const mismatchedEpoch = randomBytes(16).toString('hex')
  assert.notEqual(mismatchedEpoch, ownerBefore.sceneEpoch)
  await stopStore()
  const { mismatch, matching } = rewriteOneAssetEpochMismatch(session, mismatchedEpoch)
  assert.notEqual(matching, null)
  durableViewAdapter().remove(sceneDir(session)).materialize()
  const assetOnlyRestart = await disk.restartForTests()
  assert.equal(assetOnlyRestart.mode, 'disk')
  assert.equal((await sceneGet(session)).status, 404)
  let rows = await listAssets(session)
  assert.equal(rows.status, 200)
  assert.equal(rows.body.assets.length, 1)
  assert.equal(rows.body.assets[0].id, matching.meta.id)
  assert.equal(rows.body.usage.count, 1)
  assert.equal(rows.body.usage.bytes, matching.meta.bytes)
  assert.equal(disk.inspect().fixtures.G.preservedCount, 1)
  assert.equal(disk.inspect().fixtures.G.epoch, null)

  const appended = await appendScene(session, 'const ownerAuthoritativeAdoption = true')
  assert.equal(appended.revision, 1)
  assert.equal(disk.inspect().fixtures.G.epoch, ownerBefore.sceneEpoch)
  const ownerAfter = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  assert.equal(ownerAfter.sceneEpoch, ownerBefore.sceneEpoch)
  assert.notEqual(ownerAfter.incarnation, ownerBefore.incarnation)
  assert.equal(mismatch.meta.sceneEpoch, mismatchedEpoch)
  rows = await listAssets(session)
  assert.equal(rows.body.assets.length, 1)
  assert.equal(rows.body.assets[0].id, matching.meta.id)
  assert.equal(rows.body.usage.bytes, matching.meta.bytes)
  assert.equal(disk.inspect().fixtures.G.preservedCount, 1)
  for (let restart = 0; restart < 2; restart += 1) {
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk')
    assert.equal((await sceneJson(session)).revision, 1)
    assert.equal(disk.inspect().fixtures.G.epoch, ownerBefore.sceneEpoch)
    rows = await listAssets(session)
    assert.equal(rows.body.assets.length, 1)
    assert.equal(rows.body.assets[0].id, matching.meta.id)
    assert.equal(disk.inspect().fixtures.G.preservedCount, 1)
    const owner = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
    assert.equal(owner.sceneEpoch, ownerBefore.sceneEpoch)
    assert.equal(owner.incarnation, ownerAfter.incarnation)
  }
})

test('N18 eviction token union deletes both matching and preserved owner-mismatched asset directories', async () => {
  const ownerSession = 'sess-n18-evict-owner'
  await freshStore()
  await seedAcknowledged(ownerSession, { revisions: 1, assets: 2, baseOrder: 101, label: 'G' })
  const ownerBefore = JSON.parse(fs.readFileSync(ownerRecordPath(ownerSession), 'utf8'))
  const mismatchedEpoch = randomBytes(16).toString('hex')
  const others = []
  for (let index = 1; index <= 15; index += 1) {
    const session = `sess-n18-evict-${String(index).padStart(2, '0')}`
    others.push(session)
    await seedAcknowledged(session, {
      revisions: 1, assets: 0, baseOrder: 101 + index,
      label: `H${String(index).padStart(2, '0')}`,
    })
  }
  await stopStore()
  const { mismatch, matching } = rewriteOneAssetEpochMismatch(ownerSession, mismatchedEpoch)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(ownerSession)).revision, 1)
  assert.equal(disk.inspect().fixtures.G.epoch, ownerBefore.sceneEpoch)
  assert.equal(disk.inspect().fixtures.G.preservedCount, 1)
  let rows = await listAssets(ownerSession)
  assert.equal(rows.body.assets.length, 1)
  assert.equal(rows.body.assets[0].id, matching.meta.id)
  assert.equal(rows.body.usage.count, 1)
  host.__historyInternal.seedSession('sess-n18-evict-model', [{
    sceneId: 'sess-n18-evict-model', revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1,
  }])
  const appended = await appendScene(others[14], 'const n18VictimAppend = true')
  assert.equal(appended.revision, 2)
  const token = disk.inspect().lastCleanupToken
  assert.equal(token.orderCount, 1)
  assert.equal(token.assetCount, 2)
  const expectedVictims = { G: true }
  for (let index = 1; index <= 15; index += 1) expectedVictims[`H${String(index).padStart(2, '0')}`] = false
  assert.deepEqual(token.victimSet, expectedVictims)
  await waitForCleanupIdle()
  assert.equal((await sceneGet(ownerSession)).status, 404)
  assert.equal(fs.existsSync(sceneDir(ownerSession)), false)
  assert.equal(fs.existsSync(path.join(assetSessionDir(ownerSession), matching.hash)), false)
  assert.equal(fs.existsSync(path.join(assetSessionDir(ownerSession), mismatch.hash)), false)
  assert.equal((await listAssets(ownerSession)).status, 404)
  assert.equal(disk.inspect().fixtures.G.revisionOrderCount, 0)
  assert.equal(disk.inspect().fixtures.G.preservedCount, 0)
  assert.equal((await sceneJson(others[14])).revision, 2)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneGet(ownerSession)).status, 404)
  assert.equal((await sceneJson(others[14])).revision, 2)
})

test('SEC-M-5 new-scene append holds asset/scene queues so old eviction cleanup cannot rename its directory', async () => {
  await freshStore()
  disk.configureForTests({ recordFenceEvents: true })
  const sessions = []
  for (let index = 1; index <= 16; index += 1) {
    const session = `sess-secm5-reuse-${String(index).padStart(2, '0')}`
    sessions.push(session)
    await seedAcknowledged(session, {
      revisions: 1, assets: 0, baseOrder: 100 + index,
      label: `W${String(index).padStart(2, '0')}`,
    })
  }
  await disk.restartForTests()
  host.__historyInternal.seedSession('sess-secm5-model-a', [{
    sceneId: 'sess-secm5-model-a', revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1,
  }])
  const cleanupPause = disk.pauseAtForTests('beforeCleanup')
  const firstEviction = await appendScene(sessions[15], 'const secm5FirstEviction = true')
  assert.equal(firstEviction.revision, 2)
  await waitForPause(cleanupPause, 'first deferred cleanup pause')
  assert.equal((await sceneGet(sessions[0])).status, 404)
  assert.equal(fs.existsSync(sceneDir(sessions[0])), true)
  host.__historyInternal.seedSession('sess-secm5-model-b', [{
    sceneId: 'sess-secm5-model-b', revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1,
  }])
  const secondEviction = await appendScene(sessions[1], 'const secm5SecondEviction = true')
  assert.equal(secondEviction.revision, 2)
  assert.equal((await sceneGet(sessions[2])).status, 404)
  assert.equal(fs.existsSync(sceneDir(sessions[2])), true)
  const oldNames = new Set(revisionNames(sceneDir(sessions[2])))
  const newPause = disk.pauseAtForTests('afterRevisionDirFsync')
  const reusedAppendPromise = appendScene(sessions[2], 'const secm5NewGeneration = true')
  await waitForPause(newPause, 'reused new-scene revision fsync')
  const namesDuringPause = revisionNames(sceneDir(sessions[2]))
  const extraRevision = namesDuringPause.find(name => !oldNames.has(name))
  assert.equal(typeof extraRevision, 'string')
  const extraOrder = Number(extraRevision.slice(0, 16))
  const extraMarker = disk.generatedNames.sceneMarker(extraOrder)
  assert.equal(fs.existsSync(path.join(sceneDir(sessions[2]), extraRevision)), true)
  assert.equal(fs.existsSync(path.join(sceneDir(sessions[2]), extraMarker)), false)
  assert.equal((await sceneGet(sessions[2])).status, 404)
  let reusedSettled = false
  reusedAppendPromise.then(() => { reusedSettled = true })
  await delay(50)
  assert.equal(reusedSettled, false)

  cleanupPause.release()
  await delay(150)
  assert.equal(reusedSettled, false)
  assert.equal(fs.existsSync(sceneDir(sessions[2])), true)
  assert.equal(fs.existsSync(path.join(sceneDir(sessions[2]), extraRevision)), true)
  assert.equal(fs.existsSync(path.join(sceneDir(sessions[2]), extraMarker)), false)
  assert.equal((await sceneGet(sessions[2])).status, 404)
  assert.equal(fence().cleanupRename, 1)
  assert.equal(fence().cleanupScenesParentFsync, 1)

  newPause.release()
  const reusedAppend = await reusedAppendPromise
  assert.equal(reusedAppend.revision, 1)
  await waitForCleanupIdle()
  assert.equal(fs.existsSync(path.join(sceneDir(sessions[2]), extraRevision)), true)
  assert.equal(fs.existsSync(path.join(sceneDir(sessions[2]), extraMarker)), true)
  const reusedScene = await sceneJson(sessions[2])
  assert.equal(reusedScene.revision, 1)
  assert.match(reusedScene.code, /secm5NewGeneration/)
  assert.equal(disk.inspect().fixtures.W03.revisionOrderCount, 1)
  assert.ok(fence().cleanupRename >= 1)
  assert.equal(fs.existsSync(sceneDir(sessions[2])), true)
  assert.equal(fence().state, 'normal')
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  const stableScene = await sceneJson(sessions[2])
  assert.equal(stableScene.revision, 1)
  assert.match(stableScene.code, /secm5NewGeneration/)
  assert.equal(disk.inspect().fixtures.W03.revisionOrderCount, 1)
})

test('N17 failed captured-directory rollback retains the owner and committed asset', async () => {
  const session = 'sess-n17-rollback-failure'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'D2' })
  await disk.restartForTests()
  const sceneBefore = treeSnapshot(sceneDir(session))
  const pause = disk.pauseAtForTests('beforeAssetPostCommitRecheck')
  const uploadPromise = uploadAsset(session, 'retained.png')
  await waitForPause(pause, 'asset post-commit recheck')
  assert.equal(fs.existsSync(ownerRecordPath(session)), true)
  const ownerBefore = fs.readFileSync(ownerRecordPath(session))
  const ownerObject = JSON.parse(ownerBefore.toString('utf8'))
  host.__historyInternal.clearScene(session)
  armFault('deleteRename', 'beforeDeleteRename')
  pause.release()
  const uploaded = await uploadPromise
  assert.equal(uploaded.status, 404)
  assert.equal(jsonBody(uploaded).error.code, 'unknown-session')
  await waitForCleanupIdle()
  assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore)
  assert.equal(fs.existsSync(ownerRecordPath(session)), true)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(session)), ownerBefore)
  const sessionDir = assetSessionDir(session)
  const assetDirs = fs.readdirSync(sessionDir)
    .filter(name => HEX64_RE.test(name) && fs.statSync(path.join(sessionDir, name)).isDirectory())
  assert.equal(assetDirs.length, 1)
  assert.equal(fs.existsSync(path.join(sessionDir, assetDirs[0], 'COMMITTED')), true)
  assert.equal(disk.stats().bytes.staging, 0)
  assert.equal((await listAssets(session)).status, 404)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const scene = await sceneJson(session)
  assert.equal(scene.revision, 1)
  const assets = await listAssets(session)
  assert.equal(assets.status, 200)
  assert.equal(assets.body.assets.length, 1)
  assert.equal(assets.body.assets[0].name, 'retained.png')
  assert.equal(JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8')).incarnation,
    ownerObject.incarnation)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal((await listAssets(session)).body.assets.length, 1)
})

test('SEC-M-5 marker failure rolls back the reused generation while old cleanup waits', async () => {
  await freshStore()
  disk.configureForTests({ recordFenceEvents: true })
  const sessions = []
  for (let index = 1; index <= 16; index += 1) {
    const session = `sess-secm5-fail-reuse-${String(index).padStart(2, '0')}`
    sessions.push(session)
    await seedAcknowledged(session, {
      revisions: 1, assets: 0, baseOrder: 100 + index,
      label: `Y${String(index).padStart(2, '0')}`,
    })
  }
  await disk.restartForTests()
  host.__historyInternal.seedSession('sess-secm5-fail-model-a', [{
    sceneId: 'sess-secm5-fail-model-a', revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1,
  }])
  const cleanupPause = disk.pauseAtForTests('beforeCleanup')
  await appendScene(sessions[15], 'const secm5FailFirstEviction = true')
  await waitForPause(cleanupPause, 'first deferred cleanup pause')
  assert.equal((await sceneGet(sessions[0])).status, 404)
  assert.equal(fs.existsSync(sceneDir(sessions[0])), true)
  host.__historyInternal.seedSession('sess-secm5-fail-model-b', [{
    sceneId: 'sess-secm5-fail-model-b', revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1,
  }])
  await appendScene(sessions[1], 'const secm5FailSecondEviction = true')
  assert.equal((await sceneGet(sessions[2])).status, 404)
  assert.equal(fs.existsSync(sceneDir(sessions[2])), true)
  const oldNames = new Set(revisionNames(sceneDir(sessions[2])))
  armFault('sceneCommitMarker', 'beforeSceneCommitMarker', 1)
  const newPause = disk.pauseAtForTests('afterRevisionDirFsync')
  const failedAppendPromise = appendScene(sessions[2], 'const secm5FailNewGeneration = true')
  await waitForPause(newPause, 'reused failed new-scene revision fsync')
  const namesDuringPause = revisionNames(sceneDir(sessions[2]))
  const extraRevision = namesDuringPause.find(name => !oldNames.has(name))
  assert.equal(typeof extraRevision, 'string')
  const extraOrder = Number(extraRevision.slice(0, 16))
  const extraMarker = disk.generatedNames.sceneMarker(extraOrder)
  assert.equal(fs.existsSync(path.join(sceneDir(sessions[2]), extraRevision)), true)
  assert.equal(fs.existsSync(path.join(sceneDir(sessions[2]), extraMarker)), false)

  cleanupPause.release()
  await delay(150)
  assert.equal(fs.existsSync(sceneDir(sessions[2])), true)
  assert.equal(fs.existsSync(path.join(sceneDir(sessions[2]), extraRevision)), true)
  assert.equal(fs.existsSync(path.join(sceneDir(sessions[2]), extraMarker)), false)
  assert.equal((await sceneGet(sessions[2])).status, 404)
  assert.equal(fence().cleanupRename, 1)
  assert.equal(fence().cleanupScenesParentFsync, 1)

  newPause.release()
  await assert.rejects(failedAppendPromise)
  await waitForCleanupIdle()
  assert.equal((await sceneGet(sessions[2])).status, 404)
  assert.equal(fs.existsSync(sceneDir(sessions[2])), false)
  assert.equal(fence().cleanupRename, 2)
  assert.equal(fence().cleanupScenesParentFsync, 2)
  assert.equal(fence().state, 'normal')

  disk.faults.clear()
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneGet(sessions[0])).status, 404)
  assert.equal((await sceneGet(sessions[2])).status, 404)
  for (const session of [sessions[1], sessions[3], sessions[15]]) {
    const scene = await sceneJson(session)
    assert.equal(typeof scene.revision, 'number')
  }
  assert.equal((await sceneJson(sessions[1])).revision, 2)
  assert.equal((await sceneJson(sessions[15])).revision, 2)
  assert.equal((await sceneJson(sessions[3])).revision, 1)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneGet(sessions[2])).status, 404)
  assert.equal((await sceneJson(sessions[1])).revision, 2)
  assert.equal((await sceneJson(sessions[15])).revision, 2)
})

test('N10 existing-scene marker failure keeps the published epoch and the window upload', async () => {
  const session = 'sess-n10-existing-marker-failure'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'E2' })
  await disk.restartForTests()
  const epochBefore = disk.inspect().fixtures.E2.epoch
  const pause = disk.pauseAtForTests('beforeSceneCommitMarker')
  const failedAppendPromise = appendScene(session, 'const existingMarkerFailure = true')
  await waitForPause(pause, 'existing-scene marker failure window')
  const uploaded = await uploadAsset(session, 'marker-failure-window.png')
  assert.equal(uploaded.status, 201)
  const uploadedAsset = jsonBody(uploaded).asset
  armFault('sceneCommitMarker', 'beforeSceneCommitMarker', 1)
  pause.release()
  await assert.rejects(failedAppendPromise)
  assert.equal(counters().sceneWriteDegraded, true)
  assert.equal((await sceneGet(session)).status, 200)
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(disk.inspect().fixtures.E2.epoch, epochBefore)

  disk.faults.clear()
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const scene = await sceneJson(session)
  assert.equal(scene.revision, 1)
  assert.match(scene.code, /fixture E2 revision 1/)
  assert.equal(disk.inspect().fixtures.E2.epoch, epochBefore)
  const metaPath = path.join(assetSessionDir(session),
    disk.helpers.assetIdHash(uploadedAsset.id), 'meta.json')
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  assert.equal(meta.sceneEpoch, epochBefore)
  assert.equal(meta.sceneId, session)
  const rows = await listAssets(session)
  assert.equal(rows.status, 200)
  assert.equal(rows.body.assets.length, 1)
  assert.equal(rows.body.assets[0].id, uploadedAsset.id)
  assert.equal(rows.body.usage.count, 1)
  assert.equal(disk.inspect().fixtures.E2.preservedCount, 0)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal((await listAssets(session)).body.assets.length, 1)
})

test('N11/N10 adoption marker failure leaves owner I2 and assets asset-only across two restarts', async () => {
  const session = 'sess-n11-adoption-marker-failure'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 2, label: 'A2' })
  await disk.restartForTests()
  const oldOwner = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  const adoptedEpoch = oldOwner.sceneEpoch
  await stopStore()
  durableViewAdapter().remove(sceneDir(session)).materialize()
  await disk.restartForTests()
  assert.equal((await sceneGet(session)).status, 404)
  assert.equal((await listAssets(session)).body.assets.length, 2)
  armFault('sceneCommitMarker', 'beforeSceneCommitMarker', 1)
  await assert.rejects(appendScene(session, 'const adoptionMarkerMustFail = true'))
  assert.equal(counters().sceneWriteDegraded, true)
  assert.equal((await sceneGet(session)).status, 404)
  const failedOwner = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  assert.equal(failedOwner.sceneEpoch, adoptedEpoch)
  assert.notEqual(failedOwner.incarnation, oldOwner.incarnation)

  disk.faults.clear()
  const first = await disk.restartForTests()
  assert.equal(first.mode, 'disk')
  assert.equal((await sceneGet(session)).status, 404)
  const firstAssets = await listAssets(session)
  assert.equal(firstAssets.status, 200)
  assert.equal(firstAssets.body.assets.length, 2)
  assert.equal(firstAssets.body.usage.count, 2)
  assert.equal((await uploadAsset(session, 'asset-only-remains.png')).status, 404)
  const firstOwner = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  assert.equal(firstOwner.sceneEpoch, adoptedEpoch)
  assert.equal(firstOwner.incarnation, failedOwner.incarnation)
  const second = await disk.restartForTests()
  assert.equal(second.mode, 'disk')
  assert.equal((await sceneGet(session)).status, 404)
  assert.equal((await listAssets(session)).body.assets.length, 2)
  const secondOwner = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  assert.equal(secondOwner.sceneEpoch, adoptedEpoch)
  assert.equal(secondOwner.incarnation, failedOwner.incarnation)
})

test('N11 ownerless asset-only fallback adopts the single committed epoch and writes an owner', async () => {
  const session = 'sess-n11-ownerless-fallback'
  await freshStore()
  const seeded = await seedAcknowledged(session, { revisions: 1, assets: 2, label: 'A3' })
  await disk.restartForTests()
  const seededEpoch = disk.inspect().fixtures.A3.epoch
  assert.match(seededEpoch, HEX32_RE)
  assert.equal(seeded.revisions, 1)
  await stopStore()
  durableViewAdapter()
    .remove(sceneDir(session))
    .remove(ownerRecordPath(session))
    .materialize()
  const adopted = await disk.restartForTests()
  assert.equal(adopted.mode, 'disk')
  assert.equal((await sceneGet(session)).status, 404)
  assert.equal(fs.existsSync(ownerRecordPath(session)), false)
  const assets = await listAssets(session)
  assert.equal(assets.status, 200)
  assert.equal(assets.body.assets.length, 2)
  assert.equal(disk.inspect().fixtures.A3.preservedCount, 0)

  const appended = await appendScene(session, 'const ownerlessFallbackEpoch = true')
  assert.equal(appended.revision, 1)
  assert.equal(disk.inspect().fixtures.A3.epoch, seededEpoch)
  const owner = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  assert.equal(owner.sceneEpoch, seededEpoch)
  assert.match(owner.incarnation, HEX32_RE)
  for (const hash of fs.readdirSync(assetSessionDir(session)).filter(name => HEX64_RE.test(name))) {
    const meta = JSON.parse(fs.readFileSync(path.join(assetSessionDir(session), hash, 'meta.json'), 'utf8'))
    assert.equal(meta.sceneEpoch, seededEpoch)
  }
  assert.equal((await listAssets(session)).body.assets.length, 2)
  const first = await disk.restartForTests()
  assert.equal(first.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(disk.inspect().fixtures.A3.epoch, seededEpoch)
  assert.equal(JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8')).incarnation, owner.incarnation)
  assert.equal((await listAssets(session)).body.assets.length, 2)
  const second = await disk.restartForTests()
  assert.equal(second.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal((await listAssets(session)).body.assets.length, 2)
})

// ===========================================================================
// Fix round 3: required crash/fault/source coverage. Existing tests above are
// unchanged; these fixtures assert the same shipped semantics from new angles.
// ===========================================================================

function normalizeParagraph(text) {
  return text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim())
    .join(' ').replace(/\s+/g, ' ').trim()
}

function readmeParagraphContaining(marker) {
  const text = fs.readFileSync(readmePath, 'utf8').replace(/\r\n?/g, '\n')
  const index = text.indexOf(marker)
  assert.ok(index >= 0, `README marker ${marker}`)
  const start = text.lastIndexOf('\n\n', index)
  const end = text.indexOf('\n\n', index)
  assert.ok(end > index)
  return normalizeParagraph(text.slice(start < 0 ? 0 : start + 2, end))
}

test('R-4 synchronous afterSceneEpochPublish restore throw restores epoch and appends nothing', async () => {
  const session = 'sess-r4-restore-epoch-throw'
  await freshStore()
  const first = await appendScene(session, 'const r4RestoreRevision1 = 1')
  const second = await appendScene(session, 'const r4RestoreRevision2 = 2')
  assert.equal(first.revision, 1)
  assert.equal(second.revision, 2)
  const beforeHistory = historyInternal.history(session).history
  assert.equal(beforeHistory.length, 2)
  const epochBefore = disk.sceneEpochForTests(session)
  assert.match(epochBefore, HEX32_RE)
  const recordsBefore = treeSnapshot(sceneDir(session))
  assert.equal(revisionNames(sceneDir(session)).length, 2)
  assert.equal(markerNames(sceneDir(session)).length, 2)

  armFault('sceneMemoryCommit', 'afterSceneEpochPublish')

  const failed = await restoreSession(session, {
    sourceRevision: beforeHistory[0].revision,
    sourceUpdatedAt: beforeHistory[0].updatedAt,
    expectedRevision: beforeHistory[1].revision,
    expectedUpdatedAt: beforeHistory[1].updatedAt,
    requestId: 'R'.repeat(22),
  })
  assert.equal(failed.status, 500)
  assert.deepEqual(jsonBody(failed), { ok: false, code: 'internal' })

  const afterHistory = historyInternal.history(session).history
  assert.deepEqual(afterHistory, beforeHistory)
  assert.equal(afterHistory.length, 2)
  assert.equal(afterHistory.at(-1).revision, 2)
  assert.equal(disk.sceneEpochForTests(session), epochBefore)
  assert.deepEqual(treeSnapshot(sceneDir(session)), recordsBefore)
  assert.equal(revisionNames(sceneDir(session)).length, 2)
  assert.equal(markerNames(sceneDir(session)).length, 2)
  assert.equal(historyInternal.stats().idempotencyEntries, 0)
  assert.equal((await sceneJson(session)).revision, 2)
  assert.deepEqual((await listAssets(session)).body.assets, [])
  assert.equal((await sceneGet('sess-r4-unrelated-visible')).status, 404)

  disk.faults.clear()
  const retry = await appendScene(session, 'const r4RestoreRevision3 = 3')
  assert.equal(retry.revision, 3)
  assert.equal((await sceneJson(session)).revision, 3)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 3)
  assert.equal(historyInternal.history(session).history.length, 3)
  assert.equal(disk.sceneEpochForTests(session), epochBefore)
  assert.equal(revisionNames(sceneDir(session)).length, 3)
  assert.equal(markerNames(sceneDir(session)).length, 3)
  assert.deepEqual((await listAssets(session)).body.assets, [])
  assert.equal(historyInternal.stats().idempotencyEntries, 0)
})

test('R-4 forced changed epoch on restore is rolled back to the old epoch with an unchanged order map', async () => {
  const session = 'sess-fix4-r4-changed-epoch-restore'
  await freshStore()
  await seedAcknowledged(session, { revisions: 2, assets: 0, label: 'R4E', baseOrder: 300 })
  await disk.restartForTests()
  const beforeHistory = historyInternal.history(session).history
  assert.equal(beforeHistory.length, 2)
  const before = disk.inspect().fixtures.R4E
  const epochBefore = before.epoch
  assert.match(epochBefore, HEX32_RE)
  assert.equal(before.revisionOrderCount, 2)
  const recordsBefore = treeSnapshot(sceneDir(session))
  const forced = epochBefore === 'a'.repeat(32) ? 'b'.repeat(32) : 'a'.repeat(32)
  assert.equal(disk.forceNextAppendEpochForTests(forced), true)
  armFault('sceneMemoryCommit', 'afterSceneEpochPublish')

  const failed = await restoreSession(session, {
    sourceRevision: beforeHistory[0].revision,
    sourceUpdatedAt: beforeHistory[0].updatedAt,
    expectedRevision: beforeHistory[1].revision,
    expectedUpdatedAt: beforeHistory[1].updatedAt,
    requestId: 'U'.repeat(22),
  })
  assert.equal(failed.status, 500)
  assert.deepEqual(jsonBody(failed), { ok: false, code: 'internal' })
  disk.faults.clear()

  const after = disk.inspect().fixtures.R4E
  // publishSceneEpochForCommit actually observed the forced epoch; a no-op
  // epochSnapshot restore would leave that forced epoch visible here.
  assert.equal(after.epoch, epochBefore)
  assert.equal(after.revisionOrderCount, 2)
  assert.deepEqual(after.ordersByRevision, before.ordersByRevision)
  assert.deepEqual(historyInternal.history(session).history, beforeHistory)
  assert.equal(historyInternal.stats().idempotencyEntries, 0)
  assert.deepEqual(treeSnapshot(sceneDir(session)), recordsBefore)
  assert.equal((await sceneJson(session)).revision, 2)

  const appended = await appendScene(session, 'const r4ChangedEpochRetry = 1')
  assert.equal(appended.revision, 3)
  assert.equal(disk.sceneEpochForTests(session), epochBefore)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 3)
  assert.equal(disk.sceneEpochForTests(session), epochBefore)
  assert.equal(disk.inspect().fixtures.R4E.epoch, epochBefore)
  assert.equal(disk.inspect().fixtures.R4E.revisionOrderCount, 3)
  assert.equal(historyInternal.stats().idempotencyEntries, 0)
})

test('R-4 forced new-scene epoch on append is cleared to null, leaves no scene, and a later append succeeds', async () => {
  const session = 'sess-fix4-r4-new-epoch-append'
  await freshStore()
  const forced = 'c'.repeat(32)
  assert.equal(disk.forceNextAppendEpochForTests(forced), true)
  armFault('sceneMemoryCommit', 'afterSceneEpochPublish')

  await assert.rejects(appendScene(session, 'const r4NewEpochMustNotCommit = 1'),
    error => error?.code === 'storage-unavailable')
  disk.faults.clear()

  assert.equal(disk.sceneEpochForTests(session), null)
  assert.equal(historyInternal.history(session), null)
  assert.equal((await sceneGet(session)).status, 404)
  assert.equal(fs.existsSync(sceneDir(session)), false)
  assert.equal(historyInternal.stats().idempotencyEntries, 0)

  const appended = await appendScene(session, 'const r4NewEpochRetry = 1')
  assert.equal(appended.revision, 1)
  const epoch = disk.sceneEpochForTests(session)
  assert.match(epoch, HEX32_RE)
  assert.notEqual(epoch, forced)
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(revisionNames(sceneDir(session)).length, 1)
  assert.equal(markerNames(sceneDir(session)).length, 1)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(disk.sceneEpochForTests(session), epoch)
  assert.equal(historyInternal.history(session).history.length, 1)
  assert.equal(historyInternal.stats().idempotencyEntries, 0)
})

test('R-2/N9-R deep side-table snapshot survives a synchronous commit throw and the retry trims exactly', async () => {
  const target = 'sess-r2-deep-snapshot-target'
  const other = 'sess-r2-deep-snapshot-other'
  await freshStore()
  await seedAcknowledged(target, { revisions: 12, assets: 1, baseOrder: 100, label: 'DS' })
  await seedAcknowledged(other, { revisions: 2, assets: 1, baseOrder: 900, label: 'DO' })
  await disk.restartForTests()
  // Populate all three maps and the per-session recorded hand-off entry using
  // the shipped asset seam. Owner records and committed assets stay on disk.
  assetInternal.store.deleteSession(target)
  assetInternal.store.deleteSession(other)
  const ownerTarget = fs.readFileSync(ownerRecordPath(target))
  const assetsTarget = treeSnapshot(assetSessionDir(target))
  const sceneTarget = treeSnapshot(sceneDir(target))
  const before = disk.inspect()
  const targetBefore = before.fixtures.DS
  const otherBefore = before.fixtures.DO
  assert.equal(targetBefore.revisionOrderCount, 12)
  assert.equal(Object.keys(targetBefore.ordersByRevision).length, 12)
  assert.match(targetBefore.epoch, HEX32_RE)
  assert.equal(targetBefore.recordedEntryPresent, true)
  assert.equal(targetBefore.recordedAssetCount, 1)
  assert.equal(otherBefore.revisionOrderCount, 2)
  assert.equal(otherBefore.recordedEntryPresent, true)
  assert.equal(otherBefore.recordedAssetCount, 1)

  armFault('sceneMemoryCommit', 'afterSceneEpochPublish')
  await assert.rejects(appendScene(target, 'const deepSnapshotMustNotCommit = 1'),
    error => error?.code === 'storage-unavailable')
  disk.faults.clear()

  const after = disk.inspect()
  const targetAfter = after.fixtures.DS
  assert.equal(targetAfter.epoch, targetBefore.epoch)
  assert.equal(targetAfter.revisionOrderCount, 12)
  assert.deepEqual(targetAfter.ordersByRevision, targetBefore.ordersByRevision)
  assert.equal(targetAfter.recordedEntryPresent, false)
  assert.equal(targetAfter.recordedAssetCount, 0)
  // The deep snapshot of every candidate map leaves an unrelated session's
  // epoch, revision-order and recorded entries untouched.
  assert.equal(after.fixtures.DO.epoch, otherBefore.epoch)
  assert.equal(after.fixtures.DO.revisionOrderCount, 2)
  assert.deepEqual(after.fixtures.DO.ordersByRevision, otherBefore.ordersByRevision)
  assert.equal(after.fixtures.DO.recordedEntryPresent, true)
  assert.equal(after.fixtures.DO.recordedAssetCount, 1)
  assert.equal(historyInternal.history(target).history.length, 12)
  assert.equal(historyInternal.history(target).history.at(-1).revision, 12)
  assert.deepEqual(treeSnapshot(sceneDir(target)), sceneTarget)
  assert.deepEqual(treeSnapshot(assetSessionDir(target)), assetsTarget)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(target)), ownerTarget)
  assert.equal(revisionNames(sceneDir(target)).length, 12)
  assert.equal(markerNames(sceneDir(target)).length, 12)

  const retried = await appendScene(target, 'const deepSnapshotRetryRevision13 = 13')
  assert.equal(retried.revision, 13)
  const trimmed = disk.inspect().fixtures.DS
  assert.equal(trimmed.epoch, targetBefore.epoch)
  assert.equal(trimmed.revisionOrderCount, 12)
  assert.equal(trimmed.ordersByRevision['1'], undefined)
  assert.equal(trimmed.ordersByRevision['13'] !== undefined, true)
  assert.equal(trimmed.recordedEntryPresent, false)
  await waitForCondition(() => revisionNames(sceneDir(target)).length === 12
    && markerNames(sceneDir(target)).length === 12, 'deep-snapshot trim cleanup')
  assert.equal(revisionNames(sceneDir(target)).length, 12)
  assert.equal(markerNames(sceneDir(target)).length, 12)

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(target)).revision, 13)
  const rebuilt = disk.inspect().fixtures.DS
  assert.equal(rebuilt.epoch, targetBefore.epoch)
  assert.equal(rebuilt.revisionOrderCount, 12)
  assert.equal(rebuilt.ordersByRevision['1'], undefined)
  assert.equal(rebuilt.ordersByRevision['13'] !== undefined, true)
  assert.equal(rebuilt.recordedEntryPresent, false)
  assert.equal(disk.inspect().fixtures.DO.recordedEntryPresent, false)
})

test('R-2 post-order-update restore rollback restores the modified target order map and unrelated side tables', async () => {
  const target = 'sess-fix4-r2-post-order-target'
  const other = 'sess-fix4-r2-post-order-other'
  await freshStore()
  await seedAcknowledged(target, { revisions: 12, assets: 1, baseOrder: 100, label: 'R2P' })
  await seedAcknowledged(other, { revisions: 2, assets: 1, baseOrder: 900, label: 'R2Q' })
  await disk.restartForTests()
  const historyBefore = historyInternal.history(target).history
  assert.equal(historyBefore.length, 12)
  assert.equal(historyBefore.at(-1).revision, 12)
  assetInternal.store.deleteSession(target)
  assetInternal.store.deleteSession(other)
  const before = disk.inspect()
  const targetBefore = before.fixtures.R2P
  const otherBefore = before.fixtures.R2Q
  assert.equal(targetBefore.revisionOrderCount, 12)
  assert.equal(Object.keys(targetBefore.ordersByRevision).length, 12)
  assert.equal(targetBefore.recordedEntryPresent, true)
  assert.equal(targetBefore.recordedAssetCount, 1)
  assert.equal(otherBefore.revisionOrderCount, 2)
  assert.equal(otherBefore.recordedEntryPresent, true)
  assert.equal(otherBefore.recordedAssetCount, 1)
  const sceneBefore = treeSnapshot(sceneDir(target))
  const otherSceneBefore = treeSnapshot(sceneDir(other))
  const ownerBefore = fs.readFileSync(ownerRecordPath(target))
  const assetsBefore = treeSnapshot(assetSessionDir(target))
  const otherOwnerBefore = fs.readFileSync(ownerRecordPath(other))
  const otherAssetsBefore = treeSnapshot(assetSessionDir(other))
  const epochBefore = disk.sceneEpochForTests(target)

  armFault('sceneMemoryCommit', 'afterRevisionOrderUpdate')
  const failed = await restoreSession(target, {
    sourceRevision: historyBefore[0].revision,
    sourceUpdatedAt: historyBefore[0].updatedAt,
    expectedRevision: historyBefore[11].revision,
    expectedUpdatedAt: historyBefore[11].updatedAt,
    requestId: 'S'.repeat(22),
  })
  assert.equal(failed.status, 500)
  assert.deepEqual(jsonBody(failed), { ok: false, code: 'internal' })
  disk.faults.clear()

  const after = disk.inspect()
  const targetAfter = after.fixtures.R2P
  const otherAfter = after.fixtures.R2Q
  assert.equal(targetAfter.epoch, epochBefore)
  assert.equal(targetAfter.revisionOrderCount, 12)
  // This map was actually modified by updateSceneRevisionOrderForCommit before
  // the throw: r13 was added and r1 was removed. A no-op restore helper leaves
  // that mutation visible here.
  assert.equal(targetAfter.ordersByRevision['13'], undefined)
  assert.equal(targetAfter.ordersByRevision['1'], targetBefore.ordersByRevision['1'])
  assert.deepEqual(targetAfter.ordersByRevision, targetBefore.ordersByRevision)
  assert.equal(targetAfter.recordedEntryPresent, false)
  assert.equal(targetAfter.recordedAssetCount, 0)
  assert.equal(otherAfter.epoch, otherBefore.epoch)
  assert.equal(otherAfter.revisionOrderCount, 2)
  assert.deepEqual(otherAfter.ordersByRevision, otherBefore.ordersByRevision)
  assert.equal(otherAfter.recordedEntryPresent, true)
  assert.equal(otherAfter.recordedAssetCount, 1)
  assert.deepEqual(after.keys, ['R2P', 'R2Q'])
  assert.deepEqual(treeSnapshot(sceneDir(target)), sceneBefore)
  assert.deepEqual(treeSnapshot(sceneDir(other)), otherSceneBefore)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(target)), ownerBefore)
  assert.deepEqual(treeSnapshot(assetSessionDir(target)), assetsBefore)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(other)), otherOwnerBefore)
  assert.deepEqual(treeSnapshot(assetSessionDir(other)), otherAssetsBefore)
  assert.equal(revisionNames(sceneDir(target)).length, 12)
  assert.equal(markerNames(sceneDir(target)).length, 12)
  assert.equal(historyInternal.stats().idempotencyEntries, 0)

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(target)).revision, 12)
  assert.equal((await sceneJson(other)).revision, 2)
  assert.deepEqual(disk.inspect().fixtures.R2P.ordersByRevision,
    targetBefore.ordersByRevision)
  assert.equal((await listAssets(target)).body.assets.length, 1)
  assert.equal((await listAssets(other)).body.assets.length, 1)
  assert.deepEqual(treeSnapshot(sceneDir(target)), sceneBefore)
  assert.deepEqual(treeSnapshot(assetSessionDir(target)), assetsBefore)

  // A retry after the identical rollback succeeds and its cleanup trims only
  // r1, proving the failed attempt left no revision-order or disk residue.
  const retried = await restoreSession(target, {
    sourceRevision: historyBefore[0].revision,
    sourceUpdatedAt: historyBefore[0].updatedAt,
    expectedRevision: 12,
    expectedUpdatedAt: historyBefore[11].updatedAt,
    requestId: 'T'.repeat(22),
  })
  assert.equal(retried.status, 200)
  assert.equal(jsonBody(retried).revision, 13)
  await waitForCondition(() => revisionNames(sceneDir(target)).length === 12
    && markerNames(sceneDir(target)).length === 12, 'post-order rollback retry trim')
  assert.equal(disk.inspect().fixtures.R2P.ordersByRevision['1'], undefined)
  assert.equal(disk.inspect().fixtures.R2P.ordersByRevision['13'] !== undefined, true)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(target)).revision, 13)
  assert.equal(historyInternal.history(target).history.length, 12)
  assert.equal(disk.inspect().fixtures.R2P.ordersByRevision['1'], undefined)
  assert.equal(disk.inspect().fixtures.R2P.ordersByRevision['13'] !== undefined, true)
  assert.equal((await sceneJson(other)).revision, 2)
})

async function buildTwoFixtureSeamStore() {
  const a = 'sess-r2-seam-a'
  const b = 'sess-r2-seam-b'
  await freshStore()
  await seedAcknowledged(a, { revisions: 2, assets: 1, label: 'A' })
  await seedAcknowledged(b, { revisions: 2, assets: 1, label: 'B' })
  await disk.restartForTests()
  // Direct real-export calls populate the recorded-deletion side table; this
  // is the shipped `assetInternal.store.deleteSession` seam, not a test alias.
  assetInternal.store.deleteSession(a)
  assetInternal.store.deleteSession(b)
  const before = disk.inspect()
  assert.deepEqual(before.keys, ['A', 'B'])
  for (const label of ['A', 'B']) {
    assert.equal(before.fixtures[label].revisionOrderCount, 2)
    assert.match(before.fixtures[label].epoch, HEX32_RE)
    assert.equal(before.fixtures[label].recordedEntryPresent, true)
    assert.equal(before.fixtures[label].recordedAssetCount, 1)
  }
  return {
    a,
    b,
    ownerA: fs.readFileSync(ownerRecordPath(a)),
    ownerB: fs.readFileSync(ownerRecordPath(b)),
    assetsA: treeSnapshot(assetSessionDir(a)),
    assetsB: treeSnapshot(assetSessionDir(b)),
    scenesA: treeSnapshot(sceneDir(a)),
    scenesB: treeSnapshot(sceneDir(b)),
  }
}

function assertSeamTargetCleared(label) {
  const fixture = disk.inspect().fixtures[label]
  assert.equal(fixture.epoch, null)
  assert.equal(fixture.revisionOrderCount, 0)
  assert.deepEqual(fixture.ordersByRevision, {})
  assert.equal(fixture.recordedEntryPresent, false)
  assert.equal(fixture.recordedAssetCount, 0)
}

function assertSeamOtherIntact(label) {
  const fixture = disk.inspect().fixtures[label]
  assert.match(fixture.epoch, HEX32_RE)
  assert.equal(fixture.revisionOrderCount, 2)
  assert.deepEqual(Object.keys(fixture.ordersByRevision), ['1', '2'])
  assert.equal(fixture.recordedEntryPresent, true)
  assert.equal(fixture.recordedAssetCount, 1)
}

test('R-2/DUR-m-14 __shareInternal.clearScene clears one session and preserves owner/assets', async () => {
  const data = await buildTwoFixtureSeamStore()
  assert.equal(shareInternal.clearScene(data.a), undefined)
  assertSeamTargetCleared('A')
  assertSeamOtherIntact('B')
  assert.equal(historyInternal.history(data.a), null)
  assert.equal((await sceneGet(data.a)).status, 404)
  assert.equal((await sceneJson(data.b)).revision, 2)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(data.a)), data.ownerA)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(data.b)), data.ownerB)
  assert.deepEqual(treeSnapshot(assetSessionDir(data.a)), data.assetsA)
  assert.deepEqual(treeSnapshot(assetSessionDir(data.b)), data.assetsB)
  assert.deepEqual(treeSnapshot(sceneDir(data.a)), data.scenesA)
  assert.deepEqual(treeSnapshot(sceneDir(data.b)), data.scenesB)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(data.a)).revision, 2)
  assert.equal((await sceneJson(data.b)).revision, 2)
  assert.equal((await listAssets(data.a)).body.assets.length, 1)
  assert.equal((await listAssets(data.b)).body.assets.length, 1)
})

test('R-2/DUR-m-14 __shareInternal.resetScenes clears every session and preserves owner/assets', async () => {
  const data = await buildTwoFixtureSeamStore()
  assert.equal(shareInternal.resetScenes(), undefined)
  assertSeamTargetCleared('A')
  assertSeamTargetCleared('B')
  assert.equal(historyInternal.history(data.a), null)
  assert.equal(historyInternal.history(data.b), null)
  assert.equal((await sceneGet(data.a)).status, 404)
  assert.equal((await sceneGet(data.b)).status, 404)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(data.a)), data.ownerA)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(data.b)), data.ownerB)
  assert.deepEqual(treeSnapshot(assetSessionDir(data.a)), data.assetsA)
  assert.deepEqual(treeSnapshot(assetSessionDir(data.b)), data.assetsB)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(data.a)).revision, 2)
  assert.equal((await sceneJson(data.b)).revision, 2)
  assert.equal((await listAssets(data.a)).body.assets.length, 1)
  assert.equal((await listAssets(data.b)).body.assets.length, 1)
})

test('R-2/DUR-m-14 __historyInternal.clearScene clears one session and preserves owner/assets', async () => {
  const data = await buildTwoFixtureSeamStore()
  assert.equal(historyInternal.clearScene(data.a), undefined)
  assertSeamTargetCleared('A')
  assertSeamOtherIntact('B')
  assert.equal(historyInternal.history(data.a), null)
  assert.equal((await sceneGet(data.a)).status, 404)
  assert.equal((await sceneJson(data.b)).revision, 2)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(data.a)), data.ownerA)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(data.b)), data.ownerB)
  assert.deepEqual(treeSnapshot(assetSessionDir(data.a)), data.assetsA)
  assert.deepEqual(treeSnapshot(assetSessionDir(data.b)), data.assetsB)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(data.a)).revision, 2)
  assert.equal((await sceneJson(data.b)).revision, 2)
  assert.equal((await listAssets(data.a)).body.assets.length, 1)
  assert.equal((await listAssets(data.b)).body.assets.length, 1)
})

test('R-2/DUR-m-14 __historyInternal.resetScenes clears every session and preserves owner/assets', async () => {
  const data = await buildTwoFixtureSeamStore()
  assert.equal(historyInternal.resetScenes(), undefined)
  assertSeamTargetCleared('A')
  assertSeamTargetCleared('B')
  assert.equal(historyInternal.history(data.a), null)
  assert.equal(historyInternal.history(data.b), null)
  assert.equal((await sceneGet(data.a)).status, 404)
  assert.equal((await sceneGet(data.b)).status, 404)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(data.a)), data.ownerA)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(data.b)), data.ownerB)
  assert.deepEqual(treeSnapshot(assetSessionDir(data.a)), data.assetsA)
  assert.deepEqual(treeSnapshot(assetSessionDir(data.b)), data.assetsB)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(data.a)).revision, 2)
  assert.equal((await sceneJson(data.b)).revision, 2)
  assert.equal((await listAssets(data.a)).body.assets.length, 1)
  assert.equal((await listAssets(data.b)).body.assets.length, 1)
})

function readmeBlock(marker) {
  const text = fs.readFileSync(readmePath, 'utf8').replace(/\r\n?/g, '\n')
  const index = text.indexOf(marker)
  assert.ok(index >= 0, `README marker ${marker}`)
  const start = text.lastIndexOf('\n', Math.max(0, index - 1)) + 1
  const lines = text.slice(start).split('\n')
  const kept = []
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]
    if (lineIndex > 0 && (line === '' || line.startsWith('- '))) break
    kept.push(line)
  }
  return normalizeParagraph(kept.join('\n'))
}

test('D13 source guard exports the real seams and keeps frozen slices disk-free', () => {
  const indexSource = fs.readFileSync(indexSourcePath, 'utf8')
  assert.ok(indexSource.includes('export const __historyInternal = {'))
  assert.equal(indexSource.includes('__restoreInternal'), false)
  assert.ok(indexSource.includes('resetScenes() {\n'
    + '    scenes.clear()\n'
    + '    sceneEpochs.clear()\n'
    + '    sceneRevisionOrderBySession.clear()\n'
    + '    deleteAssetSessionRecorded.clear()'))
  assert.ok(indexSource.includes('resetScenes() {\n'
    + '    scenes.clear()\n'
    + '    sceneEpochs.clear()\n'
    + '    sceneRevisionOrderBySession.clear()\n'
    + '    deleteAssetSessionRecorded.clear()\n'
    + '    clearAllRestoreState()'))
  assert.ok(indexSource.includes('sceneEpochs.delete(key)\n'
    + '    sceneRevisionOrderBySession.delete(key)\n'
    + '    deleteAssetSessionRecorded.delete(key)'))
  const h1Start = indexSource.indexOf('function reserveRestoreSlot')
  const h1End = indexSource.indexOf(' * POST /three-workbench/share/create.')
  assert.ok(h1Start > 0 && h1End > h1Start)
  const commitStart = indexSource.indexOf('function commitSceneRevision')
  const commitEnd = indexSource.indexOf('function storeThumbnail')
  assert.ok(commitStart > 0 && commitEnd > commitStart)
  const h1 = indexSource.slice(h1Start, h1End)
  const h3 = indexSource.slice(commitStart, commitEnd)
  for (const helper of ['snapshotSceneRevisionOrders', 'updateSceneRevisionOrders',
    'restoreSceneRevisionOrders', 'buildSceneCleanupToken', 'currentIncarnationFor',
    'writeAssetOwnerRecord', 'loadAssetOwnerRecord']) {
    assert.ok(indexSource.includes(`function ${helper}(`), helper)
    assert.equal(h1.includes(`function ${helper}(`), false, `${helper} in H1`)
    assert.equal(h3.includes(`function ${helper}(`), false, `${helper} in H3`)
  }
  assert.equal((indexSource.match(/function commitSceneRevision\w*/g) ?? []).length, 1)
  assert.equal((indexSource.match(/function commitSceneRevision\(/g) ?? []).length, 1)
  assert.ok(indexSource.includes('if (descriptor !== null) publishSceneEpochForCommit(sceneId, descriptor.epoch)\n'
    + '        const scene = commitSceneRevision(sceneId, {'))
  assert.ok(indexSource.includes('if (descriptor !== null) publishSceneEpochForCommit(sessionId, descriptor.epoch)\n'
    + '        const record = commitSceneRevision(sessionId, {'))
  assert.ok(indexSource.includes('if (descriptor !== null) updateSceneRevisionOrderForCommit(descriptor, scene)'))
  assert.ok(indexSource.includes('if (descriptor !== null) updateSceneRevisionOrderForCommit(descriptor, record)'))
  const epochPublishStart = indexSource.indexOf('function publishSceneEpochForCommit')
  const epochPublishEnd = indexSource.indexOf('\n}', epochPublishStart)
  const epochPublish = indexSource.slice(epochPublishStart, epochPublishEnd)
  assert.ok(epochPublish.includes("sceneEpochs.set(sessionId, epoch)\n  diskBarrierSync('afterSceneEpochPublish')\n"
    + "  diskFaultSync('sceneMemoryCommit', 'afterSceneEpochPublish')"))
  assert.equal(epochPublish.includes('await'), false)
  assert.equal((indexSource.match(/sendRestoreJson\(res, 200/g) ?? []).length, 2)
  for (const [label, slice] of [['H1', h1], ['H3', h3]]) {
    for (const literal of ['writeFile', 'appendFile', 'createWriteStream', 'node:fs',
      'readFile', 'textResponse', 'access-control-allow-origin', '?token=', 'token%3D',
      'console.log']) {
      assert.equal(slice.includes(literal), false, `${label} contains ${literal}`)
    }
  }
  assert.equal(h3.includes('await'), false)
  assert.equal(h3.includes('Date.now'), false)
})

test('D13 README carries exact section 14.2 paragraphs and no stale memory-only claim', () => {
  const readme = fs.readFileSync(readmePath, 'utf8')
  assert.equal((readme.match(/\*\*Host half\*\*/g) ?? []).length, 1)
  assert.equal(readme.includes('in-memory scene store'), false)
  assert.equal(readmeBlock('- **Host half** (`index.js`)'), normalizeParagraph(
    '- **Host half** (`index.js`): the `three_scene` tool, prompt guidance, a '
    + 'scene store persisted to the Host data directory on Linux (memory-only '
    + 'elsewhere), the Session-scoped asset store, and '
    + '`/three-workbench/{state,scene,runtime,assets}/*` routes.'))
  assert.equal(readmeBlock('The **Manage shares…** dialog'), normalizeParagraph(
    'The **Manage shares…** dialog lists the links this browser created. Links '
    + 'default to a 7-day lifetime; the allowed TTL is 1 hour to 30 days. Revoking '
    + 'removes the link locally and makes the shell, metadata and document return the '
    + 'same 404 as an expired or unknown id. The delete key lives only in this '
    + "browser's bounded 20-entry registry, alongside the link; losing that registry "
    + 'means waiting for expiry. A successful create that loses its response can leave '
    + 'an orphan that counts against quota until it expires; Close is disabled after '
    + 'the POST is dispatched, but delivery cannot be guaranteed. Shares are persisted '
    + 'on Linux until their TTL expires or the delete key revokes them; restarting the '
    + 'Host retains old links. The delete key remains browser-side, the shared document '
    + 'embeds Session assets, and local drafts and history revisions are never shared.'))
  assert.equal(readmeBlock('Scene history and restore-appended revisions'), normalizeParagraph(
    'Scene history and restore-appended revisions persist across Host restart on '
    + 'Linux; restore idempotency entries and rate/bookkeeping state remain memory-only. '
    + 'A lost restore response can be retried, but the first append may have committed, '
    + 'so `editor.restoreConflict`\'s "this restore did not execute" clause is not '
    + 'guaranteed in that crash window; check the latest revision as the safe recovery. '
    + 'If the append was not committed and the Session persisted: a present source whose '
    + '`updatedAt` matches and an expected head equal to the current head return 409 '
    + '`source-latest` when the source equals the current head, while an older source '
    + 'with the same matching expected head returns the normal 200 append; a stale '
    + 'expected head returns 409 `conflict`; an absent or `updatedAt`-mismatched source '
    + 'returns 404 `source-revision`; a new Session with no committed revision, an '
    + 'LRU-evicted Session, or an explicitly cleared Scene Session returns 404 `session`. '
    + 'A committed append persists, and its retry returns 409 `conflict` or 404 '
    + '`source-revision` (never `source-latest`), with no session-gone notice while the '
    + 'Session remains in the 16-session keep set. A stalled restore still requires reload.'))
  assert.equal(readmeBlock('- Uploaded assets are per Session'), normalizeParagraph(
    '- Uploaded assets are per Session and, on Linux, persisted in the Host data '
    + 'directory: restarting the Host retains them; clearing the Scene Session or '
    + 'evicting it by the 16-session product limit deletes them. On other platforms the '
    + 'Host reports `disk-unsupported` and they are memory-only. Bytes are never '
    + 'persisted to localStorage, scene revisions or export manifests beyond the copies '
    + 'an export snapshots. Uploads are capped at 24 assets / 48 MiB per Session and 128 '
    + 'assets / 256 MiB globally; exports snapshot the assets they contain and do not '
    + 'track later changes.'))
  assert.equal(readmeBlock('- Scenes and thumbnails are persisted'), normalizeParagraph(
    '- Scenes and thumbnails are persisted on Linux (12 revisions per Session, 16 '
    + 'Sessions, 240 thumbnails); restarting the Host retains valid data, and the '
    + 'product caps trim by order. On other platforms they are memory-only and a restart '
    + 'clears them until the agent writes the scene again.'))
  assert.equal(readmeBlock('- A valid store that exceeds'), normalizeParagraph(
    '- A valid store that exceeds the cooperative startup deadline or load/scan/root '
    + 'budgets degrades and preserves data; some valid records or share links may be '
    + 'unavailable until the store is reduced or an operator intervenes. No acknowledged '
    + 'record is deleted.'))
  assert.equal(readmeBlock('- Share links are persisted on Linux'), normalizeParagraph(
    '- Share links are persisted on Linux until their TTL or delete-key deletion; '
    + 'restarting or stopping the Host retains old links, and expiry and revocation are '
    + 'the cleanup paths. The delete key exists only in the creating browser\'s registry. '
    + 'All Session assets (including unreferenced uploads) are embedded in the shared '
    + 'document, so a link holder sees assets the current scene does not use. Local code '
    + 'drafts and history revisions are never shared, and a demo row for a Session with '
    + 'no Host scene is blocked.'))
  for (const stale of [
    'a Host restart or Session eviction cannot be reconciled automatically',
    'the Host is authoritative only while the Session remains in memory.',
    'Shares are **memory-only**',
    'Durable share links are the P3-3 work item',
    'History, restore bookkeeping and idempotency entries are **memory-only**',
    'Uploaded assets are memory-only',
    'Scenes and thumbnails are kept in Host memory',
    'Share links are memory-only until P3-3',
    'Share documents carry the same v2 `parent` metadata and are memory-only until P3-3.',
  ]) assert.equal(readme.includes(stale), false, stale)
  assert.ok(normalizeParagraph(readme).includes(
    'scene store persisted to the Host data directory on Linux (memory-only elsewhere)'))
})

test('D14 PROJECT_README and P1-9 client copy are exact and contain no stale memory-only claim', () => {
  const clientSource = fs.readFileSync(clientPath, 'utf8')
  const exportSentence = 'Assets are kept by the workbench Host (persisted to disk '
    + 'where supported); copies inside an export are snapshots and do not track later changes.'
  const oldExportSentence = 'Assets live only in the workbench Host\'s memory; copies '
    + 'inside an export are snapshots and do not track later workbench changes.'
  assert.equal((clientSource.match(new RegExp(exportSentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 1)
  assert.equal(clientSource.includes(oldExportSentence), false)
  const start = clientSource.indexOf('const PROJECT_README = `')
  const end = clientSource.indexOf('\n`\n', start)
  assert.ok(start >= 0 && end > start)
  const exportTemplate = clientSource.slice(start, end)
  assert.equal((exportTemplate.match(new RegExp(exportSentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 1)
  assert.equal(exportTemplate.includes('?token='), false)
  assert.equal(exportTemplate.includes('token%3D'), false)
  assert.equal(exportTemplate.includes('x-workbench-session'), false)
  assert.equal(exportTemplate.includes('THREE_WORKBENCH_DATA_DIR'), false)
  const en = 'Assets are kept in Host storage; they survive restart where disk '
    + 'persistence is supported (Linux) and are cleared on restart otherwise. '
    + 'Clearing the Scene Session deletes them.'
  const zh = '资产保存在 Host 存储中；支持磁盘持久化的平台（Linux）重启后保留，其他平台重启后清除；清理场景会话会删除对应资产。'
  assert.equal((clientSource.match(new RegExp(en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 1)
  assert.equal((clientSource.match(new RegExp(zh.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 1)
  assert.equal((clientSource.match(/}, t\('assets\.memoryOnly'\)\),/g) ?? []).length, 1)
  assert.ok(clientSource.includes("t('assets.memoryOnly')"))
  assert.equal(clientSource.includes('资产仅保存在 Host 内存，重启后清空'), false)
  assert.equal(clientSource.includes('Assets live in Host memory'), false)
  assert.equal(clientSource.includes('Assets live only in the workbench Host\'s memory'), false)
})

test('D14 corrupt committed asset artifact is quarantined without degrading the scene and new assets work', async () => {
  const session = 'sess-fix4-d14-corrupt-artifact'
  await freshStore()
  assert.equal((await appendScene(session, 'const d14CorruptArtifactScene = 1')).revision, 1)
  const uploaded = await uploadAsset(session, 'd14-corrupt-artifact.png')
  assert.equal(uploaded.status, 201)
  const asset = jsonBody(uploaded).asset
  const assetUrl = `http://localhost/three-workbench/assets/${encodeURIComponent(asset.id)}`
  const servedBefore = await assetInternal.contentResponse(new Request(assetUrl))
  assert.equal(servedBefore.status, 200)
  assert.deepEqual(Buffer.from(await servedBefore.arrayBuffer()), PNG)
  const sessionDir = assetSessionDir(session)
  const hashes = fs.readdirSync(sessionDir).filter(name => HEX64_RE.test(name))
  assert.equal(hashes.length, 1)
  const hashDir = path.join(sessionDir, hashes[0])
  const assetTreeBefore = treeSnapshot(hashDir)
  const bodyFile = path.join(hashDir, 'body.bin')
  const bodyBefore = fs.readFileSync(bodyFile)
  const corrupted = Buffer.from(bodyBefore)
  corrupted[0] ^= 0xff
  assert.notDeepEqual(corrupted, bodyBefore)
  const sceneBefore = treeSnapshot(sceneDir(session))
  const ownerBefore = fs.readFileSync(ownerRecordPath(session))
  await stopStore()
  fs.writeFileSync(bodyFile, corrupted)

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(session)), ownerBefore)
  assert.equal(fs.existsSync(hashDir), false)
  const listed = await listAssets(session)
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.body.assets, [])
  assert.equal((await assetInternal.contentResponse(new Request(assetUrl))).status, 404)
  assert.equal(counters().quarantined, 1)
  assert.equal(counters().quarantineFailures, 0)
  const quarantined = fs.readdirSync(path.join(root, 'quarantine'))
    .map(name => path.join(root, 'quarantine', name, 'artifact'))
    .filter(name => fs.existsSync(name))
  assert.equal(quarantined.length, 1)
  const artifactTree = treeSnapshot(quarantined[0])
  for (const name of Object.keys(assetTreeBefore)) {
    if (name === 'body.bin') continue
    assert.deepEqual(artifactTree[name], assetTreeBefore[name])
  }
  assert.equal(artifactTree['body.bin'].bytes, corrupted.toString('base64'))
  const slot = path.dirname(quarantined[0])
  assert.equal(readJsonFile(path.join(slot, 'reason.json')).reason, 'hash')

  const replacement = await uploadAsset(session, 'd14-corrupt-artifact-replacement.png')
  assert.equal(replacement.status, 201)
  const replacementAsset = jsonBody(replacement).asset
  const listedAfter = await listAssets(session)
  assert.equal(listedAfter.status, 200)
  assert.equal(listedAfter.body.assets.length, 1)
  const replacementUrl = `http://localhost/three-workbench/assets/${encodeURIComponent(replacementAsset.id)}`
  const servedAfter = await assetInternal.contentResponse(new Request(replacementUrl))
  assert.equal(servedAfter.status, 200)
  assert.deepEqual(Buffer.from(await servedAfter.arrayBuffer()), PNG)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal((await listAssets(session)).body.assets.length, 1)
  assert.equal((await assetInternal.contentResponse(new Request(replacementUrl))).status, 200)
  assert.equal((await assetInternal.contentResponse(new Request(assetUrl))).status, 404)
})

test('D14 lost-response restore replay is idempotent, a changed fingerprint conflicts, and restart drops the cache', async () => {
  const session = 'sess-fix4-d14-lost-response'
  await freshStore()
  await seedAcknowledged(session, { revisions: 3, assets: 0, baseOrder: 700, label: 'LRS' })
  await disk.restartForTests()
  const history = historyInternal.history(session).history
  assert.equal(history.length, 3)
  const requestId = 'L'.repeat(22)
  const original = {
    sourceRevision: history[0].revision,
    sourceUpdatedAt: history[0].updatedAt,
    expectedRevision: history[2].revision,
    expectedUpdatedAt: history[2].updatedAt,
    requestId,
  }
  const first = await restoreSession(session, original)
  assert.equal(first.status, 200)
  const firstBody = jsonBody(first)
  assert.equal(firstBody.revision, 4)
  assert.equal(historyInternal.stats().idempotencyEntries, 1)
  const treeAfterFirst = treeSnapshot(sceneDir(session))
  assert.equal(revisionNames(sceneDir(session)).length, 4)
  assert.equal(markerNames(sceneDir(session)).length, 4)

  // Simulate the lost response: the client retries byte-identical fields and
  // receives the cached success without a second append.
  const replay = await restoreSession(session, original)
  assert.equal(replay.status, 200)
  assert.deepEqual(jsonBody(replay), firstBody)
  assert.equal(historyInternal.history(session).history.length, 4)
  assert.deepEqual(treeSnapshot(sceneDir(session)), treeAfterFirst)
  assert.equal(historyInternal.stats().idempotencyEntries, 1)

  // The same request id with a different fingerprint is rejected before any
  // source/head validation or append.
  const conflict = await restoreSession(session, {
    sourceRevision: history[1].revision,
    sourceUpdatedAt: history[1].updatedAt,
    expectedRevision: history[2].revision,
    expectedUpdatedAt: history[2].updatedAt,
    requestId,
  })
  assert.equal(conflict.status, 409)
  assert.deepEqual(jsonBody(conflict), { ok: false, code: 'idempotency-conflict' })
  assert.equal(historyInternal.history(session).history.length, 4)
  assert.deepEqual(treeSnapshot(sceneDir(session)), treeAfterFirst)
  assert.equal(historyInternal.stats().idempotencyEntries, 1)

  // Idempotency is memory-only. After restart the same original retry is no
  // longer cached and its stale expected head is a normal conflict.
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 4)
  assert.equal(historyInternal.stats().idempotencyEntries, 0)
  const stale = await restoreSession(session, original)
  assert.equal(stale.status, 409)
  assert.deepEqual(jsonBody(stale), { ok: false, code: 'conflict' })
  assert.equal((await sceneJson(session)).revision, 4)
  assert.deepEqual(treeSnapshot(sceneDir(session)), treeAfterFirst)
  assert.equal(historyInternal.stats().idempotencyEntries, 0)
})

const CHILD_PREAMBLE = [
  `import { apply, __diskInternal, __assetInternal, __shareInternal, __historyInternal } from ${JSON.stringify(indexUrl)}`,
  'import { Readable } from "node:stream"',
  'import fs from "node:fs"',
  'let tool',
  'let uploadRoute',
  'const routes = []',
  'const ctx = {',
  '  effect(fn) { const disposer = fn(); return typeof disposer === "function" ? disposer : () => {} },',
  '  inject(names, callback) { if (JSON.stringify(names) !== JSON.stringify(["webServer"])) throw new Error("inject"); callback(ctx) },',
  '  tools: { register(definition) { tool = definition; return () => {} } },',
  '  systemPrompt: { section() { return () => {} } },',
  '  webServer: { register(route) { routes.push(route); if (route.kind === "exact" && route.path === "/three-workbench/thumbnail") uploadRoute = route; return () => {} } },',
  '}',
  'apply(ctx)',
  'const disk = __diskInternal',
  'const asset = __assetInternal',
  'const share = __shareInternal',
  'const history = __historyInternal',
  `const PNG = Buffer.from(${JSON.stringify(PNG.toString('base64'))}, "base64")`,
  'function fakeResponse(resolve) {',
  '  return { status: 0, headers: {}, body: "", destroyed: false, writableEnded: false,',
  '    writeHead(code, headers = {}) { this.status = code; this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])) },',
  '    end(text) { this.writableEnded = true; this.body = Buffer.isBuffer(text) ? Buffer.from(text) : String(text ?? ""); resolve(this) },',
  '  }',
  '}',
  'function invoke(handler, options = {}) {',
  '  const { method = "POST", headers = {}, body = Buffer.alloc(0) } = options',
  '  return new Promise(resolve => {',
  '    const req = Readable.from(body.length === 0 ? [] : [body])',
  '    req.method = method',
  '    req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))',
  '    const res = fakeResponse(resolve)',
  '    try { const result = handler(req, res); if (result !== undefined && typeof result.then === "function") result.catch(() => { if (!res.writableEnded) res.end("") }) }',
  '    catch (error) { void error; if (!res.writableEnded) res.end("") }',
  '  })',
  '}',
  'function jsonBody(response) { return JSON.parse(Buffer.isBuffer(response.body) ? response.body.toString("utf8") : response.body) }',
  'function sceneRoute() { return routes.find(route => route.kind === "prefix" && route.path === "/three-workbench") }',
  'async function sceneGet(session) { return sceneRoute().resource(new Request(`http://localhost/three-workbench/scene/${encodeURIComponent(session)}`)) }',
  'async function appendScene(session, code) { return tool.execute({ code }, { agent: { session: { id: session } } }) }',
  'function uploadAsset(session, name = "child.png", body = PNG) {',
  '  return invoke(asset.uploadHandler, { headers: { "x-workbench-session": session, "x-workbench-name": encodeURIComponent(name), "content-type": "image/png" }, body })',
  '}',
  'function uploadThumbnail(payload) {',
  '  return invoke(uploadRoute.handler, { headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(payload)) })',
  '}',
  'async function listAssets(session) {',
  '  const response = await asset.listResponse(new Request("http://localhost/three-workbench/assets", { headers: { "x-workbench-session": session } }))',
  '  return { status: response.status, body: await response.json() }',
  '}',
  'function shareCreate(session, documentText) {',
  '  const payload = { revision: 1, document: documentText, editorState: { v: 2, objects: {}, tracks: { v: 1, items: [] }, params: { v: 1, values: {} }, camera: null }, stepFps: 30 }',
  '  return invoke(share.createHandler, { headers: { host: "localhost:3099", "x-workbench-session": session, "content-type": "application/json" }, body: Buffer.from(JSON.stringify(payload)) })',
  '}',
  'function shareDelete(id, deleteKey) {',
  '  return invoke(share.deleteHandler, { headers: { host: "localhost:3099", "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ id, deleteKey })) })',
  '}',
  'function restoreSession(session, fields) {',
  '  const route = routes.find(item => item.kind === "exact" && item.path === "/three-workbench/scene/restore")',
  '  return invoke(route.handler, { headers: { host: "localhost:3099", "content-type": "application/json", "x-workbench-session": session }, body: Buffer.from(JSON.stringify(fields)) })',
  '}',
  'function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }',
].join('\n')

function runChildScript(bodyLines, options = {}) {
  const childRoot = fs.mkdtempSync(path.join(tempBase, 'twb-fix3-child-'))
  const scriptPath = path.join(childRoot, 'child.mjs')
  try {
    const preamble = options.skipHostApply === true
      ? CHILD_PREAMBLE.split('\n').filter(line => line !== 'apply(ctx)')
      : CHILD_PREAMBLE.split('\n')
    const lines = [...preamble, ...bodyLines, 'process.stdout.write("CHILD_COMPLETED\\n")']
    fs.writeFileSync(scriptPath, `${lines.join('\n')}\n`, { mode: 0o600 })
    const child = spawnSync('/bin/bash', [
      '-c', '"$0" "$1"; exit $?', process.execPath, scriptPath, '--test',
    ], {
      env: { ...process.env, THREE_WORKBENCH_DATA_DIR: root },
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 30000,
    })
    assert.equal(child.error?.code === 'ETIMEDOUT', false)
    const completed = child.stdout.includes('CHILD_COMPLETED')
    if (options.expectCompletion === true) {
      assert.equal(completed, true, 'child did not complete')
      assert.equal(child.status, 0, `child status ${String(child.status)}`)
    } else {
      assert.equal(completed, false,
        `child did not reach the named crash barrier: ${child.stdout} ${child.stderr}`)
      assert.equal(child.status, 137,
        `child was not SIGKILLed: ${String(child.status)} ${child.stdout} ${child.stderr}`)
    }
    return child
  } finally {
    fs.rmSync(childRoot, { recursive: true, force: true })
  }
}

async function seedD6SceneCrashFixture() {
  const sessions = {}
  const s17 = 'sess-d6-crash-s17'
  const s1 = 'sess-d6-crash-s01'
  sessions.s17 = s17
  sessions.s1 = s1
  await freshStore()
  // S17 has the oldest order and is trimmed by the 16-session cap. S1 has the
  // oldest surviving head order and is Map-oldest, matching D6's 17-seed shape.
  await seedAcknowledged(s17, { revisions: 1, label: 'Q17', baseOrder: 1 })
  await seedAcknowledged(s1, { revisions: 12, label: 'Q1', baseOrder: 2 })
  for (let index = 2; index <= 16; index += 1) {
    const session = `sess-d6-crash-s${String(index).padStart(2, '0')}`
    sessions[`s${index}`] = session
    await seedAcknowledged(session, {
      revisions: 1, label: `Q${String(index)}`, baseOrder: 100 + index,
    })
  }
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(s1)).revision, 12)
  assert.equal(disk.inspect().fixtures.Q1.revisionOrderCount, 12)
  assert.equal((await sceneGet(s17)).status, 404)
  sessions.epoch = disk.sceneEpochForTests(s1)
  assert.match(sessions.epoch, HEX32_RE)
  return sessions
}

test('R-1/D6 scene crash matrix asserts marker branches and exact 12/16 keep sets', async () => {
  const rows = [
    'afterRevisionDirFsync',
    'afterSceneEpochPublish',
    'afterSceneMemoryCommit',
    'beforeSceneCommitMarker',
    'afterSceneCommitMarker',
  ]
  const parentProcessId = process.pid
  for (const barrier of rows) {
    const data = await seedD6SceneCrashFixture()
    const dir = sceneDir(data.s1)
    assert.equal(revisionNames(dir).length, 12)
    assert.equal(markerNames(dir).length, 12)
    await stopStore()
    runChildScript([
      'await disk.restartForTests()',
      `disk.crashAt(${JSON.stringify(barrier)})`,
      `try { await appendScene(${JSON.stringify(data.s1)}, ${JSON.stringify(`const crashAt = ${JSON.stringify(barrier)}`)}) } catch (error) { void error }`,
    ])
    const crashedRevisions = revisionNames(dir)
    const crashedMarkers = markerNames(dir)
    assert.equal(crashedRevisions.length, 13, barrier)
    const appendedName = crashedRevisions.at(-1)
    assert.match(appendedName, /^\d{16}\.json$/)
    const appendedOrder = Number(appendedName.slice(0, 16))
    assert.equal(appendedOrder, 117, barrier)
    const appendedBytes = fs.readFileSync(path.join(dir, appendedName))
    const markerPresent = crashedMarkers.includes(appendedName.replace(/\.json$/, '.commit.json'))
    assert.equal(markerPresent, barrier === 'afterSceneCommitMarker', barrier)
    if (barrier === 'afterSceneCommitMarker') assert.equal(crashedMarkers.length, 13, barrier)
    else assert.equal(crashedMarkers.length, 12, barrier)

    const restarted = await disk.restartForTests()
    assert.equal(restarted.mode, 'disk')
    const scene = await sceneJson(data.s1)
    const fixture = disk.inspect().fixtures.Q1
    assert.equal(disk.sceneEpochForTests(data.s1), data.epoch, barrier)
    if (markerPresent) {
      assert.equal(scene.revision, 13, barrier)
      assert.equal(fixture.revisionOrderCount, 12, barrier)
      assert.deepEqual(fixture.ordersByRevision, {
        2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 10: 11, 11: 12, 12: 13, 13: 117,
      }, barrier)
      assert.equal(markerNames(dir).length, 13)
    } else {
      assert.equal(scene.revision, 12, barrier)
      assert.equal(fixture.revisionOrderCount, 12, barrier)
      assert.deepEqual(fixture.ordersByRevision, {
        1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 10: 11, 11: 12, 12: 13,
      }, barrier)
      assert.equal(markerNames(dir).length, 12)
      assert.equal(markerNames(dir).includes(
        appendedName.replace(/\.json$/, '.commit.json')), false)
      assert.deepEqual(fs.readFileSync(path.join(dir, appendedName)), appendedBytes)
    }
    for (let index = 1; index <= 16; index += 1) {
      const session = data[`s${index}`]
      const expected = index === 1 ? (markerPresent ? 13 : 12) : 1
      assert.equal((await sceneJson(session)).revision, expected, `${barrier} s${String(index)}`)
    }
    assert.equal((await sceneGet(data.s17)).status, 404, barrier)
    assert.equal(counters().unacknowledgedSceneSessions, 0, barrier)
    assert.equal(counters().startupTruncatedScenes, 0, barrier)
    assert.equal(disk.inspect().namespaceFence.state, 'normal', barrier)
    assert.equal(process.pid, parentProcessId)
  }
})

test('R-1/D6 startup crash between every named phase preserves the asset-only owner fixture', async () => {
  const session = 'sess-d6-startup-owner-only'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 2, label: 'AO' })
  await disk.restartForTests()
  host.__historyInternal.clearScene(session)
  assert.equal((await sceneGet(session)).status, 404)
  await stopStore()
  durableViewAdapter().remove(sceneDir(session)).materialize()
  const assetOnly = await disk.restartForTests()
  assert.equal(assetOnly.mode, 'disk')
  assert.equal((await sceneGet(session)).status, 404)
  const matchingBefore = await listAssets(session)
  assert.equal(matchingBefore.status, 200)
  assert.equal(matchingBefore.body.assets.length, 2)
  rewriteOneAssetEpochMismatch(session, '0'.repeat(32))
  await disk.restartForTests()
  assert.equal(disk.inspect().fixtures.AO.preservedCount, 1)
  const oneBefore = await listAssets(session)
  assert.equal(oneBefore.status, 200)
  assert.equal(oneBefore.body.assets.length, 1)
  const ownerBefore = fs.readFileSync(ownerRecordPath(session))
  const ownerObject = JSON.parse(ownerBefore.toString('utf8'))
  assert.deepEqual(Object.keys(ownerObject),
    ['v', 'kind', 'sidHash', 'sceneEpoch', 'incarnation', 'updatedAt', 'recordSha256'])
  assert.match(ownerObject.sceneEpoch, HEX32_RE)
  assert.match(ownerObject.incarnation, HEX32_RE)
  const assetTreeBefore = treeSnapshot(assetSessionDir(session))
  const quarantineBefore = treeSnapshot(path.join(root, 'quarantine'))
  await stopStore()

  const phases = [
    'startupBoundaryReconciliation',
    'startupCleanup',
    'startupScenes',
    'startupThumbnails',
    'startupAssets',
    'startupShares',
    'startupIndexRewrite',
    'startupReady',
  ]
  for (const barrier of phases) {
    runChildScript([
      `disk.crashAt(${JSON.stringify(barrier)})`,
      'await disk.restartForTests()',
    ])
    const restarted = await disk.restartForTests()
    assert.equal(restarted.mode, 'disk', barrier)
    assert.equal((await sceneGet(session)).status, 404, barrier)
    const rows = await listAssets(session)
    assert.equal(rows.status, 200, barrier)
    assert.equal(rows.body.assets.length, 1, barrier)
    assert.equal(rows.body.usage.count, 1, barrier)
    assert.equal(rows.body.assets[0].id, oneBefore.body.assets[0].id, barrier)
    assert.equal(rows.body.assets[0].name, oneBefore.body.assets[0].name, barrier)
    const fixture = disk.inspect().fixtures.AO
    assert.equal(fixture.epoch, null, barrier)
    assert.equal(fixture.revisionOrderCount, 0, barrier)
    assert.equal(fixture.recordedEntryPresent, false, barrier)
    assert.equal(fixture.preservedCount, 1, barrier)
    assert.deepEqual(fs.readFileSync(ownerRecordPath(session)), ownerBefore, barrier)
    assert.deepEqual(treeSnapshot(assetSessionDir(session)), assetTreeBefore, barrier)
    assert.deepEqual(treeSnapshot(path.join(root, 'quarantine')), quarantineBefore, barrier)
    assert.equal(fs.existsSync(path.join(root, 'quarantine',
      disk.helpers.sceneSidHash(session))), false, barrier)
    assert.equal(counters().startupTruncatedScenes, 0, barrier)
    assert.equal(counters().startupEvictedScenes, 0, barrier)
    assert.equal(counters().unacknowledgedSceneSessions, 0, barrier)
    assert.equal(counters().startupBoundaryRecovery, 0, barrier)
    assert.equal(counters().startupBoundaryIntents, 0, barrier)
    assert.equal(disk.inspect().namespaceFence.state, 'normal', barrier)
    assert.deepEqual(disk.inspect().keys, ['AO'], barrier)
    await stopStore()
  }
})

async function buildAssetOnlyFixture(session, label = 'R3') {
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 1, label })
  await disk.restartForTests()
  host.__historyInternal.clearScene(session)
  assert.equal((await sceneGet(session)).status, 404)
  await stopStore()
  durableViewAdapter().remove(sceneDir(session)).materialize()
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneGet(session)).status, 404)
  const assets = await listAssets(session)
  assert.equal(assets.status, 200)
  assert.equal(assets.body.assets.length, 1)
  return restarted
}

test('R-1/D6 crash after the asset owner record leaves a valid owner-only subset, then uploads', async () => {
  const session = 'sess-r3-owner-record-crash'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 1, label: 'R3O' })
  await disk.restartForTests()
  const epoch = disk.sceneEpochForTests(session)
  assert.match(epoch, HEX32_RE)
  const original = await listAssets(session)
  assert.equal(original.status, 200)
  assert.equal(original.body.assets.length, 1)
  const deleted = await invoke(assetInternal.deleteHandler, {
    headers: { 'x-workbench-session': session, 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ id: original.body.assets[0].id })),
  })
  assert.equal(deleted.status, 200)
  await waitForCleanupIdle()
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal((await listAssets(session)).body.assets.length, 0)
  assert.equal(fs.existsSync(ownerRecordPath(session)), true)
  await stopStore()
  durableViewAdapter().remove(ownerRecordPath(session)).materialize()
  const ownerless = await disk.restartForTests()
  assert.equal(ownerless.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(fs.existsSync(ownerRecordPath(session)), false)
  assert.equal((await listAssets(session)).body.assets.length, 0)
  await stopStore()
  runChildScript([
    'await disk.restartForTests()',
    `disk.crashAt(${JSON.stringify('afterAssetOwnerRecord')})`,
    `await uploadAsset(${JSON.stringify(session)}, 'owner-record-crash.png')`,
  ])
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(disk.sceneEpochForTests(session), epoch)
  const owner = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  assert.deepEqual(Object.keys(owner),
    ['v', 'kind', 'sidHash', 'sceneEpoch', 'incarnation', 'updatedAt', 'recordSha256'])
  assert.equal(owner.sceneEpoch, epoch)
  assert.match(owner.incarnation, HEX32_RE)
  assert.deepEqual(Object.keys(treeSnapshot(assetSessionDir(session))), ['owner.json'])
  const emptyRows = await listAssets(session)
  assert.equal(emptyRows.status, 200)
  assert.equal(emptyRows.body.assets.length, 0)
  assert.equal(emptyRows.body.usage.count, 0)
  assert.equal(disk.inspect().fixtures.R3O.epoch, epoch)
  assert.equal(disk.inspect().fixtures.R3O.revisionOrderCount, 1)
  assert.equal((await sceneGet(session)).status, 200)
  assert.equal(fs.existsSync(path.join(root, 'quarantine',
    disk.helpers.sceneSidHash(session))), false)

  const uploaded = await uploadAsset(session, 'owner-record-crash.png')
  assert.equal(uploaded.status, 201)
  const asset = jsonBody(uploaded).asset
  assert.equal(JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8')).incarnation,
    owner.incarnation)
  const meta = JSON.parse(fs.readFileSync(path.join(assetSessionDir(session),
    disk.helpers.assetIdHash(asset.id), 'meta.json'), 'utf8'))
  assert.equal(meta.sceneEpoch, epoch)
  const rows = await listAssets(session)
  assert.equal(rows.status, 200)
  assert.equal(rows.body.assets.length, 1)
  assert.equal(rows.body.assets[0].id, asset.id)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal((await listAssets(session)).body.assets.length, 1)
  assert.equal(JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8')).incarnation,
    owner.incarnation)
})

test('R-1/D6 crash after asset owner adoption keeps the asset-only owner and the next scene adopts it', async () => {
  const session = 'sess-r3-owner-adoption-crash'
  await buildAssetOnlyFixture(session, 'R3A')
  const oldOwner = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  const epoch = oldOwner.sceneEpoch
  assert.match(epoch, HEX32_RE)
  assert.equal(disk.inspect().fixtures.R3A.preservedCount, 0)
  await stopStore()
  runChildScript([
    'await disk.restartForTests()',
    `disk.crashAt(${JSON.stringify('afterAssetOwnerAdoption')})`,
    `await appendScene(${JSON.stringify(session)}, 'const ownerAdoptionMustCrash = true')`,
  ])
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneGet(session)).status, 404)
  const assets = await listAssets(session)
  assert.equal(assets.status, 200)
  assert.equal(assets.body.assets.length, 1)
  assert.equal(assets.body.usage.count, 1)
  const failedOwner = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  assert.equal(failedOwner.sceneEpoch, epoch)
  assert.notEqual(failedOwner.incarnation, oldOwner.incarnation)
  assert.match(failedOwner.incarnation, HEX32_RE)
  assert.equal(fs.existsSync(sceneDir(session)), false)
  assert.equal(disk.inspect().fixtures.R3A.epoch, null)
  assert.equal(disk.inspect().fixtures.R3A.revisionOrderCount, 0)
  assert.equal(disk.inspect().fixtures.R3A.recordedEntryPresent, false)
  assert.equal(disk.inspect().fixtures.R3A.preservedCount, 0)
  assert.equal(disk.inspect().keys.includes(session), false)
  assert.equal(disk.sceneEpochForTests(session), null)
  assert.equal(fs.existsSync(path.join(root, 'quarantine',
    disk.helpers.sceneSidHash(session))), false)
  assert.equal(counters().unacknowledgedSceneSessions, 0)

  const adopted = await appendScene(session, 'const ownerAdoptionRetry = true')
  assert.equal(adopted.revision, 1)
  assert.equal(disk.inspect().fixtures.R3A.epoch, epoch)
  const ownerAfter = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  assert.equal(ownerAfter.sceneEpoch, epoch)
  assert.notEqual(ownerAfter.incarnation, failedOwner.incarnation)
  assert.match(ownerAfter.incarnation, HEX32_RE)
  const scene = await sceneJson(session)
  assert.equal(scene.revision, 1)
  assert.match(scene.code, /ownerAdoptionRetry/)
  const rows = await listAssets(session)
  assert.equal(rows.status, 200)
  assert.equal(rows.body.assets.length, 1)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(disk.inspect().fixtures.R3A.epoch, epoch)
  assert.equal(JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8')).incarnation,
    ownerAfter.incarnation)
  assert.equal((await listAssets(session)).body.assets.length, 1)
})

test('R-3 owner-write and owner-fsync faults commit no scene and the retry adopts with a new incarnation', async () => {
  const rows = [
    {
      op: 'assetOwnerWrite', at: 'beforeOwnerWrite', code: 'EROFS',
      label: 'R3W', ownerWritten: false,
    },
    {
      op: 'assetOwnerFsync', at: 'afterOwnerWrite', code: 'EACCES',
      label: 'R3F', ownerWritten: true,
    },
  ]
  for (const row of rows) {
    const session = `sess-r3-owner-fault-${row.op}`
    await buildAssetOnlyFixture(session, row.label)
    const ownerBefore = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
    const epoch = ownerBefore.sceneEpoch
    assert.match(epoch, HEX32_RE)
    assert.equal(ownerBefore.sceneEpoch, epoch)
    assert.match(ownerBefore.incarnation, HEX32_RE)
    const asset = (await listAssets(session)).body.assets[0]
    const assetMetaPath = path.join(assetSessionDir(session),
      disk.helpers.assetIdHash(asset.id), 'meta.json')
    const metaBefore = fs.readFileSync(assetMetaPath)
    const treeBefore = treeSnapshot(assetSessionDir(session))
    assert.equal(disk.faults.set({ op: row.op, at: row.at, count: 1, code: row.code }), true)
    await assert.rejects(appendScene(session, 'const ownerFaultMustNotCommit = true'),
      error => error?.code === row.code)
    assert.equal((await sceneGet(session)).status, 404)
    assert.equal(disk.sceneEpochForTests(session), null)
    assert.equal(disk.inspect().keys.includes(session), false)
    assert.equal(disk.inspect().fixtures[row.label].epoch, null)
    assert.equal(disk.inspect().fixtures[row.label].revisionOrderCount, 0)
    assert.equal(disk.inspect().fixtures[row.label].recordedEntryPresent, false)
    assert.equal(fs.existsSync(sceneDir(session)), false)
    assert.equal(counters().sceneWriteDegraded, false)
    assert.equal(counters().unacknowledgedSceneSessions, 0)
    const rowsAfterFailure = await listAssets(session)
    assert.equal(rowsAfterFailure.status, 200)
    assert.equal(rowsAfterFailure.body.assets.length, 1)
    assert.equal(rowsAfterFailure.body.assets[0].id, asset.id)
    assert.deepEqual(fs.readFileSync(assetMetaPath), metaBefore)
    const ownerAfterFault = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
    if (row.ownerWritten === false) {
      assert.deepEqual(treeSnapshot(assetSessionDir(session)), treeBefore)
      assert.equal(ownerAfterFault.incarnation, ownerBefore.incarnation)
    } else {
      assert.equal(ownerAfterFault.sceneEpoch, epoch)
      assert.notEqual(ownerAfterFault.incarnation, ownerBefore.incarnation)
      assert.match(ownerAfterFault.incarnation, HEX32_RE)
      assert.equal(ownerAfterFault.recordSha256, canonicalPairsHash([
        ['v', 1], ['kind', ownerAfterFault.kind], ['sidHash', ownerAfterFault.sidHash],
        ['sceneEpoch', ownerAfterFault.sceneEpoch],
        ['incarnation', ownerAfterFault.incarnation],
        ['updatedAt', ownerAfterFault.updatedAt],
      ]))
    }
    disk.faults.clear()
    const assetOnlyRestart = await disk.restartForTests()
    assert.equal(assetOnlyRestart.mode, 'disk')
    assert.equal((await sceneGet(session)).status, 404)
    assert.equal((await listAssets(session)).body.assets.length, 1)
    const beforeRetryOwner = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
    assert.equal(beforeRetryOwner.sceneEpoch, epoch)
    const retried = await appendScene(session, 'const ownerFaultRetry = true')
    assert.equal(retried.revision, 1)
    assert.equal(disk.inspect().fixtures[row.label].epoch, epoch)
    const ownerAfterRetry = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
    assert.equal(ownerAfterRetry.sceneEpoch, epoch)
    assert.notEqual(ownerAfterRetry.incarnation, beforeRetryOwner.incarnation)
    assert.match(ownerAfterRetry.incarnation, HEX32_RE)
    const scene = await sceneJson(session)
    assert.equal(scene.revision, 1)
    assert.match(scene.code, /ownerFaultRetry/)
    assert.equal((await listAssets(session)).body.assets.length, 1)
    assert.deepEqual(fs.readFileSync(assetMetaPath), metaBefore)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk')
    assert.equal((await sceneJson(session)).revision, 1)
    assert.equal(disk.inspect().fixtures[row.label].epoch, epoch)
    assert.equal(JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8')).incarnation,
      ownerAfterRetry.incarnation)
    assert.equal((await listAssets(session)).body.assets.length, 1)
  }
})

async function buildOwnerOnlyEvictionFixture() {
  const victim = 'sess-n11-deferred-victim'
  const others = []
  await freshStore()
  await seedAcknowledged(victim, { revisions: 1, assets: 1, baseOrder: 1, label: 'N11B' })
  for (let index = 1; index <= 15; index += 1) {
    const session = `sess-n11-deferred-other-${String(index).padStart(2, '0')}`
    others.push(session)
    await seedAcknowledged(session, {
      revisions: 1, assets: 0, baseOrder: 100 + index,
      label: `N11O${String(index).padStart(2, '0')}`,
    })
  }
  await disk.restartForTests()
  assert.equal((await sceneJson(victim)).revision, 1)
  const listed = await listAssets(victim)
  assert.equal(listed.status, 200)
  assert.equal(listed.body.assets.length, 1)
  const deleted = await invoke(assetInternal.deleteHandler, {
    headers: { 'x-workbench-session': victim, 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ id: listed.body.assets[0].id })),
  })
  assert.equal(deleted.status, 200)
  await waitForCleanupIdle()
  assert.equal((await listAssets(victim)).body.assets.length, 0)
  const ownerBytesBefore = fs.readFileSync(ownerRecordPath(victim))
  const ownerBefore = JSON.parse(ownerBytesBefore.toString('utf8'))
  const oldOrder = disk.inspect().fixtures.N11B.ordersByRevision['1']
  assert.equal(typeof oldOrder, 'number')
  const oldRevisionName = disk.generatedNames.sceneRevision(oldOrder)
  const oldMarkerName = disk.generatedNames.sceneMarker(oldOrder)
  const oldRevisionBytes = fs.readFileSync(path.join(sceneDir(victim), oldRevisionName))
  const oldMarkerBytes = fs.readFileSync(path.join(sceneDir(victim), oldMarkerName))
  assert.equal(revisionNames(sceneDir(victim)).length, 1)
  assert.equal(markerNames(sceneDir(victim)).length, 1)
  host.__historyInternal.seedSession('sess-n11-deferred-model', [{
    sceneId: 'sess-n11-deferred-model', revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1,
  }])
  const cleanupPause = disk.pauseAtForTests('beforeCleanupQueue')
  const trigger = await appendScene(others[14], 'const n11TriggerDeferredCleanup = true')
  assert.equal(trigger.revision, 2)
  await waitForPause(cleanupPause, 'N11 deferred cleanup queue pause')
  assert.equal((await sceneGet(victim)).status, 404)
  assert.equal(fs.existsSync(sceneDir(victim)), true)
  assert.equal((await listAssets(victim)).status, 404)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(victim)), ownerBytesBefore)
  const token = disk.inspect().lastCleanupToken
  assert.equal(token.orderCount, 1)
  assert.equal(token.assetCount, 0)
  assert.equal(token.epoch, ownerBefore.sceneEpoch)
  const expectedVictims = { N11B: true }
  for (let index = 1; index <= 15; index += 1) {
    expectedVictims[`N11O${String(index).padStart(2, '0')}`] = false
  }
  assert.deepEqual(token.victimSet, expectedVictims)
  return {
    victim, others, cleanupPause, ownerBefore, ownerBytesBefore,
    oldRevisionName, oldMarkerName, oldRevisionBytes, oldMarkerBytes,
  }
}

async function buildCommittedAssetEvictionFixture() {
  const victim = 'sess-fix4-n11-committed-victim'
  const others = []
  await freshStore()
  await seedAcknowledged(victim, {
    revisions: 1, assets: 1, baseOrder: 1, label: 'N11C',
  })
  for (let index = 1; index <= 15; index += 1) {
    const session = `sess-fix4-n11-committed-other-${String(index).padStart(2, '0')}`
    others.push(session)
    await seedAcknowledged(session, {
      revisions: 1, assets: 0, baseOrder: 100 + index,
      label: `N11E${String(index).padStart(2, '0')}`,
    })
  }
  await disk.restartForTests()
  assert.equal((await sceneJson(victim)).revision, 1)
  const listed = await listAssets(victim)
  assert.equal(listed.status, 200)
  assert.equal(listed.body.assets.length, 1)
  const assetHashes = fs.readdirSync(assetSessionDir(victim))
    .filter(name => HEX64_RE.test(name) && fs.existsSync(path.join(assetSessionDir(victim), name, 'body.bin')))
  assert.equal(assetHashes.length, 1)
  const assetHash = assetHashes[0]
  const assetTreeBefore = treeSnapshot(path.join(assetSessionDir(victim), assetHash))
  const ownerBytesBefore = fs.readFileSync(ownerRecordPath(victim))
  const ownerBefore = JSON.parse(ownerBytesBefore.toString('utf8'))
  const oldOrder = disk.inspect().fixtures.N11C.ordersByRevision['1']
  assert.equal(typeof oldOrder, 'number')
  const oldRevisionName = disk.generatedNames.sceneRevision(oldOrder)
  const oldMarkerName = disk.generatedNames.sceneMarker(oldOrder)
  host.__historyInternal.seedSession('sess-fix4-n11-committed-model', [{
    sceneId: 'sess-fix4-n11-committed-model', revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1,
  }])
  const cleanupPause = disk.pauseAtForTests('beforeCleanupQueue')
  const trigger = await appendScene(others[14], 'const n11CommittedTrigger = true')
  assert.equal(trigger.revision, 2)
  await waitForPause(cleanupPause, 'N11 committed asset cleanup queue pause')
  assert.equal((await sceneGet(victim)).status, 404)
  assert.equal((await listAssets(victim)).status, 404)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(victim)), ownerBytesBefore)
  assert.deepEqual(treeSnapshot(path.join(assetSessionDir(victim), assetHash)), assetTreeBefore)
  const token = disk.inspect().lastCleanupToken
  assert.equal(token.orderCount, 1)
  assert.equal(token.assetCount, 1)
  assert.equal(token.ownerEpoch, ownerBefore.sceneEpoch)
  assert.equal(token.ownerIncarnation, ownerBefore.incarnation)
  assert.equal(token.victimSet.N11C, true)
  return {
    victim, others, cleanupPause, ownerBefore, ownerBytesBefore, oldOrder,
    oldRevisionName, oldMarkerName, assetHash, assetTreeBefore,
  }
}

test('R-3/N11 a committed victim asset stays preserved unserved under a fresh owner epoch with I2 before the marker', async () => {
  const fixture = await buildCommittedAssetEvictionFixture()
  const { victim, ownerBefore, assetHash, assetTreeBefore } = fixture
  const oldEpoch = ownerBefore.sceneEpoch
  const oldToken = disk.inspect().lastCleanupToken
  assert.equal(oldToken.assetCount, 1)
  assert.equal(oldToken.ownerEpoch, oldEpoch)
  assert.equal(oldToken.ownerIncarnation, ownerBefore.incarnation)
  host.__historyInternal.clearScene('sess-fix4-n11-committed-model')
  const assetDir = path.join(assetSessionDir(victim), assetHash)
  const markerPause = disk.pauseAtForTests('beforeSceneCommitMarker')
  const appendPromise = appendScene(victim, 'const n11CommittedFreshEpoch = true')
  await waitForPause(markerPause, 'N11 committed asset marker window')
  const ownerDuringBytes = fs.readFileSync(ownerRecordPath(victim))
  const ownerDuring = JSON.parse(ownerDuringBytes.toString('utf8'))
  const freshEpoch = ownerDuring.sceneEpoch
  assert.match(freshEpoch, HEX32_RE)
  assert.notEqual(freshEpoch, oldEpoch)
  assert.notEqual(ownerDuring.incarnation, ownerBefore.incarnation)
  assert.match(ownerDuring.incarnation, HEX32_RE)
  assert.deepEqual(Object.keys(ownerDuring),
    ['v', 'kind', 'sidHash', 'sceneEpoch', 'incarnation', 'updatedAt', 'recordSha256'])
  assert.equal(disk.sceneEpochForTests(victim), freshEpoch)
  assert.equal(disk.inspect().fixtures.N11C.epoch, freshEpoch)
  const newOrder = disk.inspect().fixtures.N11C.ordersByRevision['1']
  assert.equal(typeof newOrder, 'number')
  assert.notEqual(newOrder, fixture.oldOrder)
  assert.equal(fs.existsSync(path.join(sceneDir(victim),
    disk.generatedNames.sceneRevision(newOrder))), true)
  assert.equal(fs.existsSync(path.join(sceneDir(victim),
    disk.generatedNames.sceneMarker(newOrder))), false)
  // The fresh owner I2 is already durable at the marker pause. Only the
  // existing B directory remains at legacy I1/oldEpoch; it was removed from
  // the current in-memory committed rows by product eviction.
  assert.deepEqual(fs.readFileSync(ownerRecordPath(victim)), ownerDuringBytes)
  const sceneDuring = await sceneJson(victim)
  assert.equal(sceneDuring.revision, 1)
  assert.match(sceneDuring.code, /n11CommittedFreshEpoch/)
  assert.equal((await listAssets(victim)).body.assets.length, 0)
  assert.deepEqual(treeSnapshot(assetDir), assetTreeBefore)
  fixture.cleanupPause.release()
  await delay(150)
  assert.deepEqual(treeSnapshot(assetDir), assetTreeBefore)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(victim)), ownerDuringBytes)
  let appendSettled = false
  appendPromise.then(() => { appendSettled = true })
  await delay(50)
  assert.equal(appendSettled, false)
  markerPause.release()
  const appended = await appendPromise
  assert.equal(appended.revision, 1)
  await waitForCleanupIdle()
  // The old eviction token captured oldEpoch/I1. The fresh-owner append
  // superseded it with I2, so the token's asset/owner part skips and B stays
  // byte-preserved but unserved.
  assert.deepEqual(treeSnapshot(assetDir), assetTreeBefore)
  const ownerAfter = JSON.parse(fs.readFileSync(ownerRecordPath(victim), 'utf8'))
  assert.equal(ownerAfter.sceneEpoch, freshEpoch)
  assert.equal(ownerAfter.incarnation, ownerDuring.incarnation)
  assert.equal((await listAssets(victim)).body.assets.length, 0)
  assert.equal((await sceneJson(victim)).revision, 1)
  assert.equal(disk.sceneEpochForTests(victim), freshEpoch)
  assert.equal(disk.inspect().fixtures.N11C.epoch, freshEpoch)
  assert.equal(disk.inspect().fixtures.N11C.revisionOrderCount, 1)
  assert.equal(disk.inspect().fixtures.N11C.recordedEntryPresent, false)
  for (let restart = 0; restart < 2; restart += 1) {
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk')
    const scene = await sceneJson(victim)
    assert.equal(scene.revision, 1)
    assert.match(scene.code, /n11CommittedFreshEpoch/)
    assert.equal(disk.sceneEpochForTests(victim), freshEpoch)
    assert.equal(disk.inspect().fixtures.N11C.epoch, freshEpoch)
    assert.equal(disk.inspect().fixtures.N11C.revisionOrderCount, 1)
    assert.equal(disk.inspect().fixtures.N11C.preservedCount, 1)
    const assetsAfter = await listAssets(victim)
    assert.equal(assetsAfter.status, 200)
    assert.equal(assetsAfter.body.assets.length, 0)
    assert.deepEqual(treeSnapshot(assetDir), assetTreeBefore)
    const stableOwner = JSON.parse(fs.readFileSync(ownerRecordPath(victim), 'utf8'))
    assert.equal(stableOwner.sceneEpoch, freshEpoch)
    assert.equal(stableOwner.incarnation, ownerDuring.incarnation)
    for (const other of fixture.others) assert.equal((await sceneGet(other)).status, 200)
  }
})

test('R-3/N11 ownerless assets with disagreeing epochs refuse a new scene and preserve every asset byte', async () => {
  const session = 'sess-fix4-n11-ownerless-disagree'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 2, baseOrder: 1, label: 'N11F' })
  await disk.restartForTests()
  assert.equal((await listAssets(session)).body.assets.length, 2)
  await stopStore()
  rewriteOneAssetEpochMismatch(session, 'e'.repeat(32))
  fs.rmSync(sceneDir(session), { recursive: true, force: true })
  fs.rmSync(ownerRecordPath(session), { force: true })
  const assetsBefore = treeSnapshot(assetSessionDir(session))
  const assetHashNames = fs.readdirSync(assetSessionDir(session)).filter(name => HEX64_RE.test(name)).sort()
  assert.equal(assetHashNames.length, 2)
  const refusedOnLoad = await disk.restartForTests()
  assert.equal(refusedOnLoad.mode, 'disk')
  assert.equal((await sceneGet(session)).status, 404)
  assert.deepEqual(treeSnapshot(assetSessionDir(session)), assetsBefore)
  assert.equal(fs.existsSync(ownerRecordPath(session)), false)
  await assert.rejects(appendScene(session, 'const n11OwnerlessDisagree = 1'))
  assert.equal(fs.existsSync(sceneDir(session)), false)
  assert.deepEqual(treeSnapshot(assetSessionDir(session)), assetsBefore)
  assert.equal(fs.existsSync(ownerRecordPath(session)), false)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneGet(session)).status, 404)
  assert.deepEqual(treeSnapshot(assetSessionDir(session)), assetsBefore)
  await assert.rejects(appendScene(session, 'const n11OwnerlessDisagreeRetry = 1'))
  assert.equal(fs.existsSync(sceneDir(session)), false)
  assert.deepEqual(treeSnapshot(assetSessionDir(session)), assetsBefore)
})

test('R-3/N11 startupIndexRewrite removes an owner-only hint after the generation check and creates no scene', async () => {
  const session = 'sess-fix4-n11-owner-hint'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 1, baseOrder: 1, label: 'N11G' })
  await disk.restartForTests()
  const ownerBefore = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
  const oldEpoch = ownerBefore.sceneEpoch
  await stopStore()
  fs.rmSync(sceneDir(session), { recursive: true, force: true })
  const sessionDir = assetSessionDir(session)
  for (const name of fs.readdirSync(sessionDir)) {
    if (HEX64_RE.test(name)) fs.rmSync(path.join(sessionDir, name), { recursive: true, force: true })
  }
  assert.equal(fs.existsSync(ownerRecordPath(session)), true)
  const rewritten = await disk.restartForTests()
  assert.equal(rewritten.mode, 'disk')
  assert.equal((await sceneGet(session)).status, 404)
  assert.equal(fs.existsSync(sceneDir(session)), false)
  assert.equal(fs.existsSync(ownerRecordPath(session)), false)
  assert.equal(fs.existsSync(sessionDir), false)
  assert.equal(disk.inspect().fixtures.N11G.recordedEntryPresent, false)
  const appended = await appendScene(session, 'const n11OwnerHintFresh = 1')
  assert.equal(appended.revision, 1)
  const freshEpoch = disk.sceneEpochForTests(session)
  assert.match(freshEpoch, HEX32_RE)
  assert.notEqual(freshEpoch, oldEpoch)
  assert.equal(fs.existsSync(ownerRecordPath(session)), false)
  assert.equal((await listAssets(session)).status, 200)
  assert.equal((await listAssets(session)).body.assets.length, 0)
  assert.equal(disk.inspect().fixtures.N11G.epoch, freshEpoch)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.match((await sceneJson(session)).code, /n11OwnerHintFresh/)
  assert.equal(disk.sceneEpochForTests(session), freshEpoch)
  assert.equal(fs.existsSync(ownerRecordPath(session)), false)
})

test('R-3/N11 owner-only eviction token skips after adoption while owner I2 precedes the marker', async () => {
  const fixture = await buildOwnerOnlyEvictionFixture()
  const { victim, ownerBefore, oldRevisionName, oldMarkerName } = fixture
  const oldEpoch = ownerBefore.sceneEpoch
  host.__historyInternal.clearScene('sess-n11-deferred-model')
  const markerPause = disk.pauseAtForTests('beforeSceneCommitMarker')
  const appendPromise = appendScene(victim, 'const n11OwnerOnlyFreshEpoch = true')
  await waitForPause(markerPause, 'N11 owner-only new-scene marker window')
  const ownerDuring = JSON.parse(fs.readFileSync(ownerRecordPath(victim), 'utf8'))
  const freshEpoch = ownerDuring.sceneEpoch
  assert.match(freshEpoch, HEX32_RE)
  assert.notEqual(freshEpoch, oldEpoch)
  assert.notEqual(ownerDuring.incarnation, ownerBefore.incarnation)
  assert.deepEqual(Object.keys(ownerDuring),
    ['v', 'kind', 'sidHash', 'sceneEpoch', 'incarnation', 'updatedAt', 'recordSha256'])
  assert.equal(disk.sceneEpochForTests(victim), freshEpoch)
  assert.equal(disk.inspect().fixtures.N11B.epoch, freshEpoch)
  assert.equal(disk.inspect().fixtures.N11B.revisionOrderCount, 1)
  const sceneDuring = await sceneJson(victim)
  assert.equal(sceneDuring.revision, 1)
  assert.match(sceneDuring.code, /n11OwnerOnlyFreshEpoch/)
  assert.equal(revisionNames(sceneDir(victim)).length, 2)
  assert.equal(markerNames(sceneDir(victim)).length, 1)
  assert.equal(fs.existsSync(path.join(sceneDir(victim), oldRevisionName)), true)
  assert.equal(fs.existsSync(path.join(sceneDir(victim), oldMarkerName)), true)
  assert.equal((await listAssets(victim)).body.assets.length, 0)

  fixture.cleanupPause.release()
  await delay(150)
  assert.equal(fs.existsSync(sceneDir(victim)), true)
  assert.equal(fs.existsSync(path.join(sceneDir(victim), oldRevisionName)), true)
  assert.equal(fs.existsSync(path.join(sceneDir(victim), oldMarkerName)), true)
  assert.deepEqual(fs.readFileSync(ownerRecordPath(victim)),
    Buffer.from(JSON.stringify(ownerDuring), 'utf8'))
  assert.equal((await sceneJson(victim)).revision, 1)
  let appendSettled = false
  appendPromise.then(() => { appendSettled = true })
  await delay(50)
  assert.equal(appendSettled, false)

  markerPause.release()
  const appended = await appendPromise
  assert.equal(appended.revision, 1)
  await waitForCleanupIdle()
  const ownerAfter = JSON.parse(fs.readFileSync(ownerRecordPath(victim), 'utf8'))
  assert.equal(ownerAfter.sceneEpoch, freshEpoch)
  assert.equal(ownerAfter.incarnation, ownerDuring.incarnation)
  assert.equal(fs.existsSync(path.join(sceneDir(victim), oldRevisionName)), false)
  assert.equal(fs.existsSync(path.join(sceneDir(victim), oldMarkerName)), false)
  assert.equal(revisionNames(sceneDir(victim)).length, 1)
  assert.equal(markerNames(sceneDir(victim)).length, 1)
  const sceneAfter = await sceneJson(victim)
  assert.equal(sceneAfter.revision, 1)
  assert.match(sceneAfter.code, /n11OwnerOnlyFreshEpoch/)
  assert.equal(disk.inspect().fixtures.N11B.epoch, freshEpoch)
  assert.equal(disk.inspect().fixtures.N11B.revisionOrderCount, 1)
  assert.equal(disk.inspect().fixtures.N11B.recordedEntryPresent, false)
  assert.equal((await listAssets(victim)).body.assets.length, 0)

  for (let restart = 0; restart < 2; restart += 1) {
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk')
    const scene = await sceneJson(victim)
    assert.equal(scene.revision, 1)
    assert.match(scene.code, /n11OwnerOnlyFreshEpoch/)
    assert.equal(disk.inspect().fixtures.N11B.epoch, freshEpoch)
    assert.equal(disk.inspect().fixtures.N11B.revisionOrderCount, 1)
    assert.equal(disk.inspect().fixtures.N11B.recordedEntryPresent, false)
    assert.equal((await listAssets(victim)).body.assets.length, 0)
    const stableOwner = JSON.parse(fs.readFileSync(ownerRecordPath(victim), 'utf8'))
    assert.equal(stableOwner.sceneEpoch, freshEpoch)
    assert.equal(stableOwner.incarnation, ownerDuring.incarnation)
    for (const other of fixture.others) assert.equal((await sceneGet(other)).status, 200)
  }
})

test('R-3/N11 cleanup that completes before adoption leaves a fresh scene with no stale owner', async () => {
  const fixture = await buildOwnerOnlyEvictionFixture()
  const { victim, ownerBefore } = fixture
  const oldEpoch = ownerBefore.sceneEpoch
  fixture.cleanupPause.release()
  await waitForCleanupIdle()
  assert.equal(fs.existsSync(sceneDir(victim)), false)
  assert.equal(fs.existsSync(ownerRecordPath(victim)), false)
  assert.equal((await sceneGet(victim)).status, 404)
  host.__historyInternal.clearScene('sess-n11-deferred-model')
  const appended = await appendScene(victim, 'const n11CleanupBeforeAdoption = true')
  assert.equal(appended.revision, 1)
  const freshEpoch = disk.sceneEpochForTests(victim)
  assert.match(freshEpoch, HEX32_RE)
  assert.notEqual(freshEpoch, oldEpoch)
  assert.equal(fs.existsSync(ownerRecordPath(victim)), false)
  assert.equal((await sceneJson(victim)).revision, 1)
  assert.match((await sceneJson(victim)).code, /n11CleanupBeforeAdoption/)
  assert.equal((await listAssets(victim)).status, 200)
  assert.equal((await listAssets(victim)).body.assets.length, 0)
  assert.equal(disk.inspect().fixtures.N11B.epoch, freshEpoch)
  assert.equal(disk.inspect().fixtures.N11B.revisionOrderCount, 1)
  assert.equal(disk.inspect().fixtures.N11B.recordedEntryPresent, false)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  const scene = await sceneJson(victim)
  assert.equal(scene.revision, 1)
  assert.match(scene.code, /n11CleanupBeforeAdoption/)
  assert.equal(disk.sceneEpochForTests(victim), freshEpoch)
  assert.equal(fs.existsSync(ownerRecordPath(victim)), false)
  assert.equal((await listAssets(victim)).body.assets.length, 0)
  const second = await disk.restartForTests()
  assert.equal(second.mode, 'disk')
  assert.equal(disk.sceneEpochForTests(victim), freshEpoch)
  assert.equal(disk.inspect().fixtures.N11B.revisionOrderCount, 1)
  assert.equal(disk.inspect().fixtures.N11B.recordedEntryPresent, false)
})

function sharePayload(documentText) {
  return {
    revision: 1,
    document: documentText,
    editorState: {
      v: 2,
      objects: {},
      tracks: { v: 1, items: [] },
      params: { v: 1, values: {} },
      camera: null,
    },
    stepFps: 30,
  }
}

async function createShare(session, documentText = '<!doctype html><html><body>share fixture</body></html>') {
  return invoke(shareInternal.createHandler, {
    headers: {
      host: 'localhost:3099',
      'x-workbench-session': session,
      'content-type': 'application/json',
    },
    body: Buffer.from(JSON.stringify(sharePayload(documentText))),
  })
}

async function thumbnailGet(session, revision) {
  return ctx.records.route.resource(new Request(
    `http://localhost/three-workbench/thumbnail/${encodeURIComponent(session)}/${String(revision)}`))
}

test('R-1/D6 asset and share commit-marker crashes leave the committed record after restart', async () => {
  const assetSession = 'sess-r1-asset-commit-crash'
  await freshStore()
  await seedAcknowledged(assetSession, { revisions: 1, assets: 0, label: 'AC' })
  await disk.restartForTests()
  await stopStore()
  runChildScript([
    'await disk.restartForTests()',
    `disk.crashAt(${JSON.stringify('afterAssetCommitMarker')})`,
    `await uploadAsset(${JSON.stringify(assetSession)}, 'asset-commit-crash.png')`,
  ])
  const assetRestart = await disk.restartForTests()
  assert.equal(assetRestart.mode, 'disk')
  const assets = await listAssets(assetSession)
  assert.equal(assets.status, 200)
  assert.equal(assets.body.assets.length, 1)
  assert.equal(assets.body.assets[0].name, 'asset-commit-crash.png')
  assert.equal(assets.body.usage.count, 1)
  assert.notEqual(assetInternal.rawAsset(assets.body.assets[0].id), undefined)
  const assetMeta = JSON.parse(fs.readFileSync(path.join(assetSessionDir(assetSession),
    disk.helpers.assetIdHash(assets.body.assets[0].id), 'meta.json'), 'utf8'))
  assert.equal(assetMeta.sceneEpoch, disk.sceneEpochForTests(assetSession))
  assert.equal(counters().startupTruncatedScenes, 0)
  assert.equal((await sceneJson(assetSession)).revision, 1)
  await stopStore()

  const shareSession = 'sess-r1-share-commit-crash'
  await freshStore()
  await disk.restartForTests()
  await appendScene(shareSession, 'const shareCommitCrashScene = true')
  await stopStore()
  runChildScript([
    'await disk.restartForTests()',
    `disk.crashAt(${JSON.stringify('afterShareCommitMarker')})`,
    `await shareCreate(${JSON.stringify(shareSession)}, '<!doctype html><html><body>committed share crash</body></html>')`,
  ])
  const shareRestart = await disk.restartForTests()
  assert.equal(shareRestart.mode, 'disk')
  const shareStats = shareInternal.stats()
  assert.equal(shareStats.shares, 1)
  assert.equal(shareStats.owners, 1)
  assert.ok(shareStats.bytes > 0)
  const shareDirs = fs.readdirSync(path.join(root, 'shares'))
    .filter(name => HEX64_RE.test(name))
  assert.equal(shareDirs.length, 1)
  assert.equal(fs.existsSync(path.join(root, 'shares', shareDirs[0], 'COMMITTED')), true)
  assert.equal(fs.existsSync(path.join(root, 'shares', shareDirs[0], 'record.json')), true)
  assert.equal(fs.existsSync(path.join(root, 'shares', shareDirs[0], 'document.bin')), true)
  assert.equal(counters().startupTruncatedScenes, 0)
})

test('R-1/D6 asset and share delete-rename crashes keep the deletion committed after restart', async () => {
  const assetSession = 'sess-r1-asset-delete-crash'
  await freshStore()
  await seedAcknowledged(assetSession, { revisions: 1, assets: 0, label: 'AD' })
  await disk.restartForTests()
  const uploaded = await uploadAsset(assetSession, 'delete-crash.png')
  assert.equal(uploaded.status, 201)
  const assetId = jsonBody(uploaded).asset.id
  await stopStore()
  runChildScript([
    'await disk.restartForTests()',
    `disk.crashAt(${JSON.stringify('afterDeleteRename')})`,
    `await invoke(asset.deleteHandler, { headers: { "x-workbench-session": ${JSON.stringify(assetSession)}, "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ id: ${JSON.stringify(assetId)} })) })`,
  ])
  const assetRestart = await disk.restartForTests()
  assert.equal(assetRestart.mode, 'disk')
  assert.equal(assetInternal.rawAsset(assetId), undefined)
  const assetRows = await listAssets(assetSession)
  assert.equal(assetRows.status, 200)
  assert.equal(assetRows.body.assets.length, 0)
  assert.equal(assetRows.body.usage.count, 0)
  assert.equal((await sceneJson(assetSession)).revision, 1)
  await stopStore()

  const shareSession = 'sess-r1-share-delete-crash'
  await freshStore()
  await disk.restartForTests()
  await appendScene(shareSession, 'const shareDeleteCrashScene = true')
  const created = await createShare(shareSession, '<!doctype html><html><body>delete crash share</body></html>')
  assert.equal(created.status, 200)
  const share = jsonBody(created)
  await stopStore()
  runChildScript([
    'await disk.restartForTests()',
    `disk.crashAt(${JSON.stringify('afterDeleteRename')})`,
    `await shareDelete(${JSON.stringify(share.id)}, ${JSON.stringify(share.deleteKey)})`,
  ])
  const shareRestart = await disk.restartForTests()
  assert.equal(shareRestart.mode, 'disk')
  assert.equal(shareInternal.stats().shares, 0)
  assert.equal(shareInternal.rawShare(share.id), undefined)
  assert.equal(fs.existsSync(path.join(root, 'shares', diskSha(Buffer.concat([
    Buffer.from('twb:share:v1\0', 'utf8'), Buffer.from(share.id, 'utf8')])))), false)
})

test('R-1/D6 thumbnail PNG and index rename crashes resolve the correct committed branch', async () => {
  const session = 'sess-r1-thumbnail-crash'
  await freshStore()
  await disk.restartForTests()
  await appendScene(session, 'const thumbnailCrashScene = true')
  await stopStore()
  runChildScript([
    'await disk.restartForTests()',
    `disk.crashAt(${JSON.stringify('afterThumbnailPublish')})`,
    `await uploadThumbnail({ sessionId: ${JSON.stringify(session)}, revision: 1, dataUrl: \`data:image/png;base64,\${PNG.toString("base64")}\` })`,
  ])
  const pngCrashRestart = await disk.restartForTests()
  assert.equal(pngCrashRestart.mode, 'disk')
  assert.equal((await thumbnailGet(session, 1)).status, 404)
  assert.equal(counters().startupTruncatedScenes, 0)
  const retried = await uploadThumbnail({
    sessionId: session, revision: 1, dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
  })
  assert.equal(retried.status, 200)
  assert.equal((await thumbnailGet(session, 1)).status, 200)
  assert.equal((await disk.restartForTests()).mode, 'disk')
  assert.equal((await thumbnailGet(session, 1)).status, 200)
  await stopStore()

  await freshStore()
  await disk.restartForTests()
  await appendScene(session, 'const thumbnailCrashScene = true')
  await stopStore()
  runChildScript([
    'await disk.restartForTests()',
    `disk.crashAt(${JSON.stringify('afterIndexRename')})`,
    `await uploadThumbnail({ sessionId: ${JSON.stringify(session)}, revision: 1, dataUrl: \`data:image/png;base64,\${PNG.toString("base64")}\` })`,
  ])
  const indexCrashRestart = await disk.restartForTests()
  assert.equal(indexCrashRestart.mode, 'disk')
  assert.equal((await thumbnailGet(session, 1)).status, 200)
  const indexBytes = fs.readFileSync(path.join(root, 'thumbnails', 'index.json'))
  assert.ok(indexBytes.length > 0)
  assert.equal((await disk.restartForTests()).mode, 'disk')
  assert.equal((await thumbnailGet(session, 1)).status, 200)
})


async function seedTrimCrashFixture(session, label) {
  await freshStore()
  await seedAcknowledged(session, { revisions: 12, assets: 1, baseOrder: 100, label })
  await disk.restartForTests()
  assert.equal((await sceneJson(session)).revision, 12)
  assert.equal(disk.inspect().fixtures[label].revisionOrderCount, 12)
  const oldOrder = disk.inspect().fixtures[label].ordersByRevision['1']
  assert.equal(oldOrder, 100)
  const oldRevisionName = disk.generatedNames.sceneRevision(oldOrder)
  const oldMarkerName = disk.generatedNames.sceneMarker(oldOrder)
  return { oldOrder, oldRevisionName, oldMarkerName }
}

test('R-1/D6 trim cleanup unlink and marker windows survive a child crash with the exact keep set', async () => {
  const rows = ['afterSceneRevisionUnlink', 'beforeSceneMarkerUnlink']
  for (const barrier of rows) {
    const session = `sess-r1-trim-unlink-${barrier}`
    const fixture = await seedTrimCrashFixture(session, barrier === rows[0] ? 'TU1' : 'TU2')
    await stopStore()
    runChildScript([
      'await disk.restartForTests()',
      `disk.crashAt(${JSON.stringify(barrier)})`,
      `await appendScene(${JSON.stringify(session)}, 'const trimUnlinkCrash = true')`,
      'await delay(1500)',
    ])
    assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldRevisionName)), false, barrier)
    assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldMarkerName)), true, barrier)
    assert.equal(revisionNames(sceneDir(session)).length, 12, barrier)
    assert.equal(markerNames(sceneDir(session)).length, 13, barrier)
    const data = await disk.restartForTests()
    assert.equal(data.mode, 'disk', barrier)
    const scene = await sceneJson(session)
    assert.equal(scene.revision, 13, barrier)
    assert.match(scene.code, /trimUnlinkCrash/, barrier)
    const label = barrier === rows[0] ? 'TU1' : 'TU2'
    assert.equal(disk.inspect().fixtures[label].revisionOrderCount, 12, barrier)
    assert.equal(disk.inspect().fixtures[label].ordersByRevision['1'], undefined, barrier)
    const expectedOrders = {}
    for (let revision = 2; revision <= 13; revision += 1) expectedOrders[String(revision)] = 99 + revision
    assert.deepEqual(disk.inspect().fixtures[label].ordersByRevision, expectedOrders, barrier)
    assert.equal(revisionNames(sceneDir(session)).length, 12, barrier)
    assert.equal(markerNames(sceneDir(session)).length, 12, barrier)
    assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldRevisionName)), false, barrier)
    assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldMarkerName)), false, barrier)
    assert.equal((await listAssets(session)).body.assets.length, 1, barrier)
    assert.equal(counters().startupTruncatedScenes, 0, barrier)
    assert.equal(counters().unacknowledgedSceneSessions, 0, barrier)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', barrier)
    assert.equal((await sceneJson(session)).revision, 13, barrier)
    assert.equal(disk.inspect().fixtures[label].revisionOrderCount, 12, barrier)
  }
})

test('R-1/D6 cleanup beforeCleanup and afterCleanup crashes both converge on 12 acknowledged revisions', async () => {
  const rows = [
    { barrier: 'beforeCleanup', oldPresent: true, label: 'CB' },
    { barrier: 'afterCleanup', oldPresent: false, label: 'CA' },
  ]
  for (const row of rows) {
    const session = `sess-r1-trim-cleanup-${row.barrier}`
    const fixture = await seedTrimCrashFixture(session, row.label)
    await stopStore()
    runChildScript([
      'await disk.restartForTests()',
      `disk.crashAt(${JSON.stringify(row.barrier)})`,
      `await appendScene(${JSON.stringify(session)}, 'const trimCleanupCrash = true')`,
      'await delay(1500)',
    ])
    assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldRevisionName)),
      row.oldPresent, row.barrier)
    assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldMarkerName)),
      row.oldPresent, row.barrier)
    assert.equal(revisionNames(sceneDir(session)).length, row.oldPresent ? 13 : 12, row.barrier)
    assert.equal(markerNames(sceneDir(session)).length, row.oldPresent ? 13 : 12, row.barrier)
    const data = await disk.restartForTests()
    assert.equal(data.mode, 'disk', row.barrier)
    const scene = await sceneJson(session)
    assert.equal(scene.revision, 13, row.barrier)
    assert.match(scene.code, /trimCleanupCrash/, row.barrier)
    assert.equal(disk.inspect().fixtures[row.label].revisionOrderCount, 12, row.barrier)
    const expectedOrders = {}
    for (let revision = 2; revision <= 13; revision += 1) expectedOrders[String(revision)] = 99 + revision
    assert.deepEqual(disk.inspect().fixtures[row.label].ordersByRevision, expectedOrders, row.barrier)
    // beforeCleanup crashes before the token runs: startup trims the in-memory
    // keep set but does not delete the old acknowledged revision file. The
    // afterCleanup branch has already unlinked both captured files.
    assert.equal(revisionNames(sceneDir(session)).length, row.oldPresent ? 13 : 12, row.barrier)
    assert.equal(markerNames(sceneDir(session)).length, row.oldPresent ? 13 : 12, row.barrier)
    assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldRevisionName)),
      row.oldPresent, row.barrier)
    assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldMarkerName)),
      row.oldPresent, row.barrier)
    assert.equal((await listAssets(session)).body.assets.length, 1, row.barrier)
    assert.equal(counters().startupTruncatedScenes, 0, row.barrier)
    assert.equal(counters().unacknowledgedSceneSessions, 0, row.barrier)
    assert.equal(counters().startupEvictedScenes, 0, row.barrier)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', row.barrier)
    assert.equal((await sceneJson(session)).revision, 13, row.barrier)
    assert.equal((await listAssets(session)).body.assets.length, 1, row.barrier)
  }
})

test('R-1/D6 eviction revision-unlink and marker-unlink windows skip a reused live scene', async () => {
  const rows = ['afterSceneRevisionUnlink', 'beforeSceneMarkerUnlink']
  for (const barrier of rows) {
    const sessions = []
    await freshStore()
    for (let index = 0; index < 16; index += 1) {
      const session = `sess-r1-evict-unlink-${String(index).padStart(2, '0')}`
      sessions.push(session)
      await seedAcknowledged(session, {
        revisions: 1, assets: 0, baseOrder: 100 + index,
        label: `EU${String(index).padStart(2, '0')}`,
      })
    }
    await disk.restartForTests()
    const victimOrder = disk.inspect().fixtures.EU00.ordersByRevision['1']
    assert.equal(victimOrder, 100)
    const victimRevisionName = disk.generatedNames.sceneRevision(victimOrder)
    const victimMarkerName = disk.generatedNames.sceneMarker(victimOrder)
    await stopStore()
    runChildScript([
      'await disk.restartForTests()',
      `history.seedSession('sess-r1-evict-unlink-model', [{ sceneId: 'sess-r1-evict-unlink-model', revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1 }])`,
      `const cleanupPause = disk.pauseAtForTests('beforeCleanupQueue')`,
      `const trigger = await appendScene(${JSON.stringify(sessions[15])}, 'const evictionTriggerAppend = true'); if (trigger.revision !== 2) throw new Error('trigger revision')`,
      'await cleanupPause.arrival',
      `history.clearScene('sess-r1-evict-unlink-model')`,
      `disk.crashAt(${JSON.stringify(barrier)})`,
      `const reused = await appendScene(${JSON.stringify(sessions[0])}, 'const evictionReuseCrash = true'); if (reused.revision !== 1) throw new Error('reuse revision')`,
      'cleanupPause.release()',
      'await delay(1500)',
    ])
    assert.equal(revisionNames(sceneDir(sessions[0])).length, 1, barrier)
    assert.equal(markerNames(sceneDir(sessions[0])).length, 2, barrier)
    assert.equal(fs.existsSync(path.join(sceneDir(sessions[0]), victimRevisionName)), false, barrier)
    assert.equal(fs.existsSync(path.join(sceneDir(sessions[0]), victimMarkerName)), true, barrier)
    const data = await disk.restartForTests()
    assert.equal(data.mode, 'disk', barrier)
    const reusedScene = await sceneJson(sessions[0])
    assert.equal(reusedScene.revision, 1, barrier)
    assert.match(reusedScene.code, /evictionReuseCrash/, barrier)
    assert.equal(revisionNames(sceneDir(sessions[0])).length, 1, barrier)
    assert.equal(markerNames(sceneDir(sessions[0])).length, 1, barrier)
    assert.equal(fs.existsSync(path.join(sceneDir(sessions[0]), victimRevisionName)), false, barrier)
    assert.equal(fs.existsSync(path.join(sceneDir(sessions[0]), victimMarkerName)), false, barrier)
    for (let index = 1; index <= 15; index += 1) {
      const scene = await sceneJson(sessions[index])
      assert.equal(scene.revision, index === 15 ? 2 : 1, barrier)
    }
    assert.equal(disk.inspect().fixtures.EU00.revisionOrderCount, 1, barrier)
    assert.equal(disk.inspect().fixtures.EU00.ordersByRevision['1'] === victimOrder, false, barrier)
    assert.equal(disk.inspect().fixtures.EU01.revisionOrderCount, 1, barrier)
    assert.equal(counters().startupTruncatedScenes, 0, barrier)
    assert.equal(counters().unacknowledgedSceneSessions, 0, barrier)
    assert.equal(counters().startupEvictedScenes, 0, barrier)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', barrier)
    assert.equal((await sceneJson(sessions[0])).revision, 1, barrier)
    assert.match((await sceneJson(sessions[0])).code, /evictionReuseCrash/, barrier)
    assert.equal((await sceneJson(sessions[15])).revision, 2, barrier)
    assert.equal(disk.inspect().fixtures.EU00.revisionOrderCount, 1, barrier)
  }
})

// ===========================================================================
// D11 named failure-injection matrix. Each row names the exact durable site
// and a distinct errno code; the assertions are fail-closed and per-row.
// ===========================================================================
test('D11 scene write/fileFsync/rename/dirFsync faults fail closed and the retry appends once', async () => {
  const rows = [
    { name: 'scene-write-EROFS', op: 'revisionWrite', at: 'beforeRevisionWrite', code: 'EROFS' },
    { name: 'scene-write-hook-EROFS', op: 'write', at: 'scene-revision', code: 'EROFS' },
    { name: 'scene-file-fsync-EACCES', op: 'fileFsync', at: 'afterCandidateFsync', code: 'EACCES' },
    { name: 'scene-rename-EDQUOT', op: 'rename', at: 'afterRename', code: 'EDQUOT' },
    { name: 'scene-dir-fsync-ENOSPC', op: 'dirFsync', at: 'afterRevisionDirFsync', code: 'ENOSPC' },
  ]
  for (const row of rows) {
    const session = `sess-d11-${row.name}`
    await freshStore()
    await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'D11S' })
    await disk.restartForTests()
    const before = treeSnapshot(sceneDir(session))
    assert.equal(revisionNames(sceneDir(session)).length, 1, row.name)
    assert.equal(markerNames(sceneDir(session)).length, 1, row.name)
    const headBefore = await sceneJson(session)
    assert.equal(headBefore.revision, 1, row.name)
    assert.equal(disk.faults.set({ op: row.op, at: row.at, count: 1, code: row.code }), true)
    await assert.rejects(appendScene(session, `const ${row.name.replace(/-/g, '_')} = true`),
      error => error?.code === row.code)
    assert.equal(counters().sceneWriteDegraded, false, row.name)
    assert.equal(counters().sceneWritePreserve, false, row.name)
    assert.deepEqual(treeSnapshot(sceneDir(session)), before, row.name)
    assert.equal(revisionNames(sceneDir(session)).length, 1, row.name)
    assert.equal(markerNames(sceneDir(session)).length, 1, row.name)
    assert.equal((await sceneJson(session)).revision, 1, row.name)
    assert.equal(disk.inspect().fixtures.D11S.revisionOrderCount, 1, row.name)
    assert.equal(disk.inspect().fixtures.D11S.recordedEntryPresent, false, row.name)
    disk.faults.clear()
    const retry = await appendScene(session, `const ${row.name.replace(/-/g, '_')}Retry = 2`)
    assert.equal(retry.revision, 2, row.name)
    assert.equal((await sceneJson(session)).revision, 2, row.name)
    assert.equal(revisionNames(sceneDir(session)).length, 2, row.name)
    assert.equal(markerNames(sceneDir(session)).length, 2, row.name)
    const restarted = await disk.restartForTests()
    assert.equal(restarted.mode, 'disk', row.name)
    assert.equal((await sceneJson(session)).revision, 2, row.name)
    assert.equal(disk.inspect().fixtures.D11S.revisionOrderCount, 2, row.name)
    assert.equal(disk.inspect().fixtures.D11S.recordedEntryPresent, false, row.name)
  }
})

test('D11 scene marker before/after faults are fail-closed with the defined marker-absent and marker-survives branches', async () => {
  const rows = [
    {
      name: 'scene-marker-before-EROFS', op: 'commitMarker', at: 'beforeCommitMarker', code: 'EROFS',
      survives: false,
    },
    {
      name: 'scene-marker-after-EACCES', op: 'commitMarker', at: 'afterCommitMarker', code: 'EACCES',
      survives: true,
    },
  ]
  for (const row of rows) {
    const session = `sess-d11-${row.name}`
    await freshStore()
    await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'D11M' })
    await disk.restartForTests()
    const oldOrder = disk.inspect().fixtures.D11M.ordersByRevision['1']
    assert.equal(Number.isSafeInteger(oldOrder), true, row.name)
    assert.equal(disk.faults.set({ op: row.op, at: row.at, count: 1, code: row.code }), true)
    await assert.rejects(appendScene(session, `const ${row.name.replace(/-/g, '_')} = true`),
      error => error?.code === 'storage-unavailable')
    assert.equal(counters().sceneWriteDegraded, true, row.name)
    assert.equal(counters().sceneWritePreserve, false, row.name)
    assert.equal(revisionNames(sceneDir(session)).length, 2, row.name)
    assert.equal(markerNames(sceneDir(session)).length, row.survives ? 2 : 1, row.name)
    assert.equal(fs.existsSync(path.join(sceneDir(session),
      disk.generatedNames.sceneMarker(oldOrder))), true, row.name)
    const newMarkers = markerNames(sceneDir(session))
      .filter(name => name !== disk.generatedNames.sceneMarker(oldOrder))
    assert.equal(newMarkers.length, row.survives ? 1 : 0, row.name)
    assert.equal((await sceneJson(session)).revision, row.survives ? 2 : 1, row.name)
    await assert.rejects(appendScene(session, 'const stillDegraded = true'),
      error => error?.code === 'storage-unavailable')
    disk.faults.clear()
    const restarted = await disk.restartForTests()
    assert.equal(restarted.mode, 'disk', row.name)
    assert.equal(counters().sceneWriteDegraded, false, row.name)
    const expectedRestartRevision = row.survives ? 2 : 1
    const staleMarkerAbsentRevision = row.survives ? 0 : 1
    assert.equal((await sceneJson(session)).revision, expectedRestartRevision, row.name)
    // The marker-absent branch leaves its unacknowledged revision file on
    // disk; it is never selected. The marker-survives branch has two valid
    // marker-bound revisions.
    assert.equal(revisionNames(sceneDir(session)).length,
      expectedRestartRevision + staleMarkerAbsentRevision, row.name)
    assert.equal(markerNames(sceneDir(session)).length, expectedRestartRevision, row.name)
    const retry = await appendScene(session, `const after${row.name.replace(/-/g, '_')} = 3`)
    assert.equal(retry.revision, expectedRestartRevision + 1, row.name)
    assert.equal(revisionNames(sceneDir(session)).length,
      expectedRestartRevision + 1 + staleMarkerAbsentRevision, row.name)
    assert.equal(markerNames(sceneDir(session)).length, expectedRestartRevision + 1, row.name)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', row.name)
    assert.equal((await sceneJson(session)).revision, expectedRestartRevision + 1, row.name)
    assert.equal(markerNames(sceneDir(session)).length, expectedRestartRevision + 1, row.name)
  }
})

test('D11 asset mkdir/commit-marker faults never publish and the retry uploads exactly once', async () => {
  const rows = [
    { name: 'asset-mkdir-EACCES', op: 'mkdirDurable', at: 'beforeMkdir', code: 'EACCES', marker: false },
    { name: 'asset-marker-before-ENOSPC', op: 'commitMarker', at: 'beforeAssetCommitMarker', code: 'ENOSPC', marker: true },
    { name: 'asset-marker-after-EDQUOT', op: 'commitMarker', at: 'afterAssetCommitMarker', code: 'EDQUOT', marker: true },
  ]
  for (const row of rows) {
    const session = `sess-d11-${row.name}`
    await freshStore()
    await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'D11A' })
    await disk.restartForTests()
    assert.equal(disk.faults.set({ op: row.op, at: row.at, count: 1, code: row.code }), true)
    const failed = await uploadAsset(session, `${row.name}.png`)
    assert.equal(failed.status, 503, row.name)
    assert.deepEqual(jsonBody(failed), {
      ok: false, error: { code: 'storage', message: 'could not store asset' },
    }, row.name)
    assert.equal((await listAssets(session)).body.assets.length, 0, row.name)
    if (row.marker === false) {
      assert.equal(fs.existsSync(assetSessionDir(session)), false, row.name)
    }
    disk.faults.clear()
    const restarted = await disk.restartForTests()
    assert.equal(restarted.mode, 'disk', row.name)
    assert.equal((await listAssets(session)).body.assets.length, 0, row.name)
    const retried = await uploadAsset(session, `${row.name}-retry.png`)
    assert.equal(retried.status, 201, row.name)
    const retriedId = jsonBody(retried).asset.id
    assert.equal((await listAssets(session)).body.assets.length, 1, row.name)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', row.name)
    assert.equal((await listAssets(session)).body.assets.length, 1, row.name)
    assert.equal(assetInternal.rawAsset(retriedId).id, retriedId, row.name)
  }
})

test('D11 share commit-marker faults publish no share and the retry succeeds once', async () => {
  const rows = [
    { name: 'share-marker-before-ENOSPC', op: 'commitMarker', at: 'beforeShareCommitMarker', code: 'ENOSPC' },
    { name: 'share-marker-after-EROFS', op: 'commitMarker', at: 'afterShareCommitMarker', code: 'EROFS' },
  ]
  for (const row of rows) {
    const session = `sess-d11-${row.name}`
    await freshStore()
    await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'D11H' })
    await disk.restartForTests()
    assert.equal(shareInternal.stats().shares, 0, row.name)
    assert.equal(disk.faults.set({ op: row.op, at: row.at, count: 1, code: row.code }), true)
    const failed = await createShare(session, `<!doctype html><html><body>${row.name}</body></html>`)
    assert.equal(failed.status, 500, row.name)
    assert.deepEqual(jsonBody(failed), { ok: false, code: 'internal' }, row.name)
    assert.equal(shareInternal.stats().shares, 0, row.name)
    disk.faults.clear()
    const restarted = await disk.restartForTests()
    assert.equal(restarted.mode, 'disk', row.name)
    const committedAfterCrash = row.at === 'afterShareCommitMarker' ? 1 : 0
    assert.equal(shareInternal.stats().shares, committedAfterCrash, row.name)
    const retried = await createShare(session, `<!doctype html><html><body>${row.name}-retry</body></html>`)
    assert.equal(retried.status, 200, row.name)
    const body = jsonBody(retried)
    assert.equal(shareInternal.stats().shares, committedAfterCrash + 1, row.name)
    assert.notEqual(shareInternal.rawShare(body.id), undefined, row.name)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', row.name)
    assert.equal(shareInternal.stats().shares, committedAfterCrash + 1, row.name)
    assert.notEqual(shareInternal.rawShare(body.id), undefined, row.name)
  }
})

test('D11 asset delete before/after rename faults preserve the exact pre/post outcome across restart', async () => {
  const rows = [
    { name: 'asset-delete-before-ENOSPC', at: 'beforeDeleteRename', code: 'ENOSPC', renamed: false },
    { name: 'asset-delete-after-EDQUOT', at: 'afterDeleteRename', code: 'EDQUOT', renamed: true },
  ]
  for (const row of rows) {
    const session = `sess-d11-${row.name}`
    await freshStore()
    await seedAcknowledged(session, { revisions: 1, assets: 1, label: 'D11D' })
    await disk.restartForTests()
    const before = (await listAssets(session)).body.assets
    assert.equal(before.length, 1, row.name)
    const assetId = before[0].id
    assert.equal(disk.faults.set({ op: 'deleteRename', at: row.at, count: 1, code: row.code }), true)
    const failed = await invoke(assetInternal.deleteHandler, {
      headers: { 'x-workbench-session': session, 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ id: assetId })),
    })
    assert.equal(failed.status, 503, row.name)
    assert.deepEqual(jsonBody(failed), {
      ok: false, error: { code: 'storage', message: 'could not delete asset' },
    }, row.name)
    // The handler does not acknowledge or drop the row on either branch. The
    // post-rename branch has already committed the durable move; restart alone
    // resolves it.
    assert.notEqual(assetInternal.rawAsset(assetId), undefined, row.name)
    assert.equal((await listAssets(session)).body.assets.length, 1, row.name)
    disk.faults.clear()
    const restarted = await disk.restartForTests()
    assert.equal(restarted.mode, 'disk', row.name)
    if (row.renamed) {
      assert.equal((await listAssets(session)).body.assets.length, 0, row.name)
      assert.equal(assetInternal.rawAsset(assetId), undefined, row.name)
    } else {
      assert.equal((await listAssets(session)).body.assets.length, 1, row.name)
      const retried = await invoke(assetInternal.deleteHandler, {
        headers: { 'x-workbench-session': session, 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ id: assetId })),
      })
      assert.equal(retried.status, 200, row.name)
      assert.equal((await listAssets(session)).body.assets.length, 0, row.name)
    }
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', row.name)
    assert.equal((await listAssets(session)).body.assets.length, 0, row.name)
  }
})

test('D11 share delete before/after rename faults preserve the exact pre/post outcome across restart', async () => {
  const rows = [
    { name: 'share-delete-before-EACCES', at: 'beforeDeleteRename', code: 'EACCES', renamed: false },
    { name: 'share-delete-after-EROFS', at: 'afterDeleteRename', code: 'EROFS', renamed: true },
  ]
  for (const row of rows) {
    const session = `sess-d11-${row.name}`
    await freshStore()
    await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'D11K' })
    await disk.restartForTests()
    const created = await createShare(session, `<!doctype html><html><body>${row.name}</body></html>`)
    assert.equal(created.status, 200, row.name)
    const createdBody = jsonBody(created)
    assert.notEqual(shareInternal.rawShare(createdBody.id), undefined, row.name)
    assert.equal(disk.faults.set({ op: 'deleteRename', at: row.at, count: 1, code: row.code }), true)
    const failed = await invoke(shareInternal.deleteHandler, {
      headers: { host: 'localhost:3099', 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ id: createdBody.id, deleteKey: createdBody.deleteKey })),
    })
    assert.equal(failed.status, 500, row.name)
    assert.deepEqual(jsonBody(failed), { ok: false, code: 'internal' }, row.name)
    assert.notEqual(shareInternal.rawShare(createdBody.id), undefined, row.name)
    disk.faults.clear()
    const restarted = await disk.restartForTests()
    assert.equal(restarted.mode, 'disk', row.name)
    if (row.renamed) {
      assert.equal(shareInternal.stats().shares, 0, row.name)
      assert.equal(shareInternal.rawShare(createdBody.id), undefined, row.name)
    } else {
      assert.equal(shareInternal.stats().shares, 1, row.name)
      assert.notEqual(shareInternal.rawShare(createdBody.id), undefined, row.name)
      const retried = await invoke(shareInternal.deleteHandler, {
        headers: { host: 'localhost:3099', 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ id: createdBody.id, deleteKey: createdBody.deleteKey })),
      })
      assert.equal(retried.status, 200, row.name)
      assert.equal(shareInternal.rawShare(createdBody.id), undefined, row.name)
    }
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', row.name)
    assert.equal(shareInternal.stats().shares, 0, row.name)
  }
})

test('D11 thumbnail indexRename fault never acknowledges and the retry publishes once', async () => {
  const session = 'sess-d11-thumbnail-index-rename'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'D11T' })
  await disk.restartForTests()
  const payload = {
    sessionId: session, revision: 1, dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
  }
  assert.equal(disk.faults.set({ op: 'indexRename', at: 'afterIndexRename', count: 1, code: 'EACCES' }), true)
  const failed = await uploadThumbnail(payload)
  assert.equal(failed.status, 503)
  assert.equal(Buffer.from(failed.body).toString('utf8'), 'thumbnail storage failed')
  assert.equal((await thumbnailGet(session, 1)).status, 404)
  disk.faults.clear()
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await thumbnailGet(session, 1)).status, 404)
  const retried = await uploadThumbnail(payload)
  assert.equal(retried.status, 200)
  assert.equal((await thumbnailGet(session, 1)).status, 200)
  const before = await thumbnailGet(session, 1)
  const bytes = Buffer.from(await before.arrayBuffer())
  assert.deepEqual(bytes, PNG)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  const after = await thumbnailGet(session, 1)
  assert.equal(after.status, 200)
  assert.deepEqual(Buffer.from(await after.arrayBuffer()), bytes)
})

test('D11/D12 durable mkdir child crashes at the child and parent fsync barriers recover cleanly', async () => {
  for (const barrier of ['afterMkdirChildFsync', 'afterMkdirParentFsync']) {
    const session = `sess-d11-mkdir-${barrier}`
    await freshStore()
    await stopStore()
    runChildScript([
      'await disk.restartForTests()',
      `disk.crashAt(${JSON.stringify(barrier)})`,
      `await appendScene(${JSON.stringify(session)}, 'const mkdirCrash = 1')`,
    ])
    const dir = sceneDir(session)
    assert.equal(fs.existsSync(dir), true, barrier)
    assert.equal(fs.lstatSync(dir).isDirectory(), true, barrier)
    assert.equal(fs.lstatSync(dir).isSymbolicLink(), false, barrier)
    assert.equal(revisionNames(dir).length, 0, barrier)
    assert.equal(markerNames(dir).length, 0, barrier)
    assert.equal((await sceneGet(session)).status, 404, barrier)
    const restarted = await disk.restartForTests()
    assert.equal(restarted.mode, 'disk', barrier)
    assert.equal((await sceneGet(session)).status, 404, barrier)
    assert.equal(disk.inspect().keys.length, 0, barrier)
    assert.equal(counters().startupTruncatedScenes, 0, barrier)
    assert.equal(counters().unacknowledgedSceneSessions, 1, barrier)
    const retried = await appendScene(session, 'const mkdirCrashRetry = 2')
    assert.equal(retried.revision, 1, barrier)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', barrier)
    assert.equal((await sceneJson(session)).revision, 1, barrier)
    assert.match((await sceneJson(session)).code, /mkdirCrashRetry/, barrier)
    assert.equal(revisionNames(sceneDir(session)).length, 1, barrier)
    assert.equal(markerNames(sceneDir(session)).length, 1, barrier)
    assert.match(disk.sceneEpochForTests(session), HEX32_RE, barrier)
    assert.equal(disk.inspect().keys.length, 0, barrier)
  }
})

function lockArtifactNames() {
  try {
    return fs.readdirSync(root).filter(name =>
      name === 'LOCK' || /^(?:LOCK\.tmp\.|LOCK\.stale\.)/.test(name)
      || /^[a-f0-9]{32}$/.test(name)
      || name === 'LOCK.recover').sort()
  } catch (error) {
    return []
  }
}

// A live writer owns exactly one LOCK. Startup may leave a bare candidate
// hard-link orphan (a legitimate crash artifact); it must never leave a
// fail-closed guard, a stale rename, or a generated LOCK.tmp candidate.
function assertLockControlOnly(label) {
  const names = lockArtifactNames()
  assert.equal(names.filter(name => name === 'LOCK').length, 1, label)
  assert.equal(names.some(name => name === 'LOCK.recover'
    || /^LOCK\.(?:tmp|stale)\./.test(name)), false, label)
  for (const name of names) assert.match(name, /^(?:LOCK|[a-f0-9]{32})$/, label)
}

test('D12 lock acquisition crashes at every candidate/link/verify barrier leave one recoverable writer', async () => {
  const barriers = ['beforeCandidate', 'afterCandidateFsync', 'afterLink', 'afterDirFsync', 'afterLockVerify']
  for (const barrier of barriers) {
    const session = `sess-d12-lock-acquire-${barrier}`
    await freshStore()
    await seedAcknowledged(session, { revisions: 1, assets: 1, label: 'LKA' })
    await disk.restartForTests()
    await stopStore()
    runChildScript([
      `disk.crashAt(${JSON.stringify(barrier)})`,
      'await disk.restartForTests()',
    ])
    const afterCrash = lockArtifactNames()
    if (barrier === 'beforeCandidate') {
      assert.deepEqual(afterCrash, [], barrier)
    } else if (barrier === 'afterCandidateFsync') {
      assert.equal(afterCrash.some(name => /^[a-f0-9]{32}$/.test(name)), true, barrier)
      assert.equal(afterCrash.includes('LOCK'), false, barrier)
    } else {
      assert.equal(afterCrash.includes('LOCK'), true, barrier)
      assert.equal(afterCrash.some(name => /^[a-f0-9]{32}$/.test(name)), true, barrier)
    }
    const data = await disk.restartForTests()
    assert.equal(data.mode, 'disk', barrier)
    assertLockControlOnly(barrier)
    assert.equal((await sceneJson(session)).revision, 1, barrier)
    assert.equal((await listAssets(session)).body.assets.length, 1, barrier)
    const appended = await appendScene(session, 'const lockAcquireRecovered = 2')
    assert.equal(appended.revision, 2, barrier)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', barrier)
    assert.equal((await sceneJson(session)).revision, 2, barrier)
    assertLockControlOnly(barrier)
  }
})

test('D12 guarded recovery crashes fail closed until the guard is removed, then take over without data loss', async () => {
  const barriers = [
    'afterLink', 'afterDirFsync',
    'afterRename', 'recoveryBeforeCandidate', 'recoveryAfterCandidateFsync',
    'recoveryAfterLink', 'recoveryAfterDirFsync', 'afterLockVerify',
  ]
  for (const barrier of barriers) {
    const session = `sess-d12-lock-recovery-${barrier}`
    await freshStore()
    await seedAcknowledged(session, { revisions: 1, assets: 1, label: 'LKR' })
    await disk.restartForTests()
    const sceneBefore = treeSnapshot(sceneDir(session))
    const assetsBefore = treeSnapshot(assetSessionDir(session))
    await stopStore()
    // Leave a genuine stale-dead lock holder, then crash inside guarded
    // recovery at the named step. Both children skip `apply()` so the crash
    // name is armed before startup reaches lock acquisition/recovery.
    runChildScript([
      'disk.crashAt("afterLockVerify")',
      'await disk.restartForTests()',
    ], { skipHostApply: true })
    runChildScript([
      `disk.crashAt(${JSON.stringify(barrier)})`,
      'await disk.restartForTests()',
    ], { skipHostApply: true })
    const crashedNames = lockArtifactNames()
    assert.equal(crashedNames.includes('LOCK.recover'), true, `${barrier} ${JSON.stringify(crashedNames)}`)
    const staleExpected = barrier !== 'afterLink' && barrier !== 'afterDirFsync'
    assert.equal(crashedNames.some(name => /^LOCK\.stale\./.test(name)), staleExpected,
      `${barrier} ${JSON.stringify(crashedNames)}`)
    if (barrier === 'afterRename' || barrier === 'recoveryBeforeCandidate'
      || barrier === 'recoveryAfterCandidateFsync') {
      assert.equal(crashedNames.includes('LOCK'), false, `${barrier} ${JSON.stringify(crashedNames)}`)
    } else {
      assert.equal(crashedNames.includes('LOCK'), true, `${barrier} ${JSON.stringify(crashedNames)}`)
    }
    const crashedNamesBeforeFailedRestart = lockArtifactNames()
    const failed = await disk.restartForTests()
    assert.notEqual(failed.mode, 'disk', barrier)
    assert.equal(failed.status, 'disk-locked', barrier)
    assert.equal(disk.inspect().status, 'disk-locked', barrier)
    // Fail-closed: startup mutates nothing and deletes no acknowledged data.
    assert.deepEqual(lockArtifactNames(), crashedNamesBeforeFailedRestart, barrier)
    assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore, barrier)
    assert.deepEqual(treeSnapshot(assetSessionDir(session)), assetsBefore, barrier)
    // An operator/fixture removes only the recovery guard; the stale holder
    // and candidates are still reconciled by the regular takeover path.
    fs.unlinkSync(path.join(root, 'LOCK.recover'))
    const recovered = await disk.restartForTests()
    assert.equal(recovered.mode, 'disk', barrier)
    assertLockControlOnly(barrier)
    assert.equal((await sceneJson(session)).revision, 1, barrier)
    assert.equal((await listAssets(session)).body.assets.length, 1, barrier)
    assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore, barrier)
    const appended = await appendScene(session, 'const guardedRecoveryRetry = 2')
    assert.equal(appended.revision, 2, barrier)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', barrier)
    assert.equal((await sceneJson(session)).revision, 2, barrier)
    assertLockControlOnly(barrier)
  }
})

test('D12 recovery kills before the guard is linked leave the stale holder retryable without data loss', async () => {
  for (const barrier of ['beforeCandidate', 'afterCandidateFsync']) {
    const session = `sess-fix4-lock-early-${barrier}`
    await freshStore()
    await seedAcknowledged(session, { revisions: 1, assets: 1, label: 'LKE' })
    await disk.restartForTests()
    const sceneBefore = treeSnapshot(sceneDir(session))
    const assetsBefore = treeSnapshot(assetSessionDir(session))
    await stopStore()
    // Leave a genuine stale-dead lock holder.
    runChildScript([
      'disk.crashAt("afterLockVerify")',
      'await disk.restartForTests()',
    ], { skipHostApply: true })
    assert.equal(lockArtifactNames().includes('LOCK'), true, barrier)
    assert.equal(lockArtifactNames().includes('LOCK.recover'), false, barrier)
    // Kill the next recovery while it is publishing the guard candidate,
    // before that guard is linked. There is no fail-closed guard to inherit.
    runChildScript([
      `disk.crashAt(${JSON.stringify(barrier)})`,
      'await disk.restartForTests()',
    ], { skipHostApply: true })
    const crashedNames = lockArtifactNames()
    assert.equal(crashedNames.includes('LOCK'), true, barrier)
    assert.equal(crashedNames.includes('LOCK.recover'), false, barrier)
    assert.equal(crashedNames.some(name => /^LOCK\.stale\./.test(name)), false, barrier)
    assert.equal(crashedNames.some(name => /^[a-f0-9]{32}$/.test(name)), true, barrier)
    assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore, barrier)
    assert.deepEqual(treeSnapshot(assetSessionDir(session)), assetsBefore, barrier)
    const recovered = await disk.restartForTests()
    assert.equal(recovered.mode, 'disk', barrier)
    assertLockControlOnly(barrier)
    assert.equal((await sceneJson(session)).revision, 1, barrier)
    assert.equal((await listAssets(session)).body.assets.length, 1, barrier)
    assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore, barrier)
    assert.deepEqual(treeSnapshot(assetSessionDir(session)), assetsBefore, barrier)
    const appended = await appendScene(session, 'const earlyRecoveryRetry = 2')
    assert.equal(appended.revision, 2, barrier)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', barrier)
    assert.equal((await sceneJson(session)).revision, 2, barrier)
    assert.equal((await listAssets(session)).body.assets.length, 1, barrier)
    assertLockControlOnly(barrier)
  }
})

test('D11 asset publish staging and rename faults fail closed and restart removes the uncommitted subset', async () => {
  const rows = [
    { name: 'asset-publish-before-staging-EROFS', at: 'beforeAssetStaging', code: 'EROFS', renamed: false },
    { name: 'asset-publish-after-staging-ENOSPC', at: 'afterAssetStaging', code: 'ENOSPC', renamed: false },
    { name: 'asset-publish-after-rename-EDQUOT', at: 'afterAssetRename', code: 'EDQUOT', renamed: true },
  ]
  for (const row of rows) {
    const session = `sess-d11-${row.name}`
    await freshStore()
    await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'D11AP' })
    await disk.restartForTests()
    const sceneBefore = treeSnapshot(sceneDir(session))
    const epoch = disk.sceneEpochForTests(session)
    assert.match(epoch, HEX32_RE, row.name)
    assert.equal(disk.faults.set({ op: 'publish', at: row.at, count: 1, code: row.code }), true)
    const failed = await uploadAsset(session, `${row.name}.png`)
    assert.equal(failed.status, 503, row.name)
    assert.deepEqual(jsonBody(failed), {
      ok: false, error: { code: 'storage', message: 'could not store asset' },
    }, row.name)
    assert.equal((await listAssets(session)).body.assets.length, 0, row.name)
    assert.equal(assetInternal.globalUsage().count, 0, row.name)
    assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore, row.name)
    const owner = JSON.parse(fs.readFileSync(ownerRecordPath(session), 'utf8'))
    assert.equal(owner.sceneEpoch, epoch, row.name)
    assert.match(owner.incarnation, HEX32_RE, row.name)
    assert.equal(owner.recordSha256, canonicalPairsHash([
      ['v', 1], ['kind', owner.kind], ['sidHash', owner.sidHash],
      ['sceneEpoch', owner.sceneEpoch], ['incarnation', owner.incarnation],
      ['updatedAt', owner.updatedAt],
    ]), row.name)
    const assetDirs = fs.readdirSync(assetSessionDir(session))
      .filter(name => /^[a-f0-9]{64}$/.test(name))
    assert.equal(assetDirs.length, row.renamed ? 1 : 0, row.name)
    assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')), [], row.name)
    disk.faults.clear()
    const restarted = await disk.restartForTests()
    assert.equal(restarted.mode, 'disk', row.name)
    assert.equal((await listAssets(session)).body.assets.length, 0, row.name)
    assert.equal(assetInternal.globalUsage().count, 0, row.name)
    assert.deepEqual(fs.readdirSync(assetSessionDir(session))
      .filter(name => /^[a-f0-9]{64}$/.test(name)), [], row.name)
    assert.deepEqual(fs.readFileSync(ownerRecordPath(session)),
      Buffer.from(JSON.stringify(owner), 'utf8'), row.name)
    const retried = await uploadAsset(session, `${row.name}-retry.png`)
    assert.equal(retried.status, 201, row.name)
    const retriedId = jsonBody(retried).asset.id
    assert.equal((await listAssets(session)).body.assets.length, 1, row.name)
    assert.equal(assetInternal.globalUsage().count, 1, row.name)
    assert.equal(assetInternal.rawAsset(retriedId).id, retriedId, row.name)
    assert.equal(disk.sceneEpochForTests(session), epoch, row.name)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', row.name)
    assert.equal((await listAssets(session)).body.assets.length, 1, row.name)
    assert.equal((await sceneJson(session)).revision, 1, row.name)
    assert.equal(disk.sceneEpochForTests(session), epoch, row.name)
  }
})

test('D11 share publish path faults publish nothing and the retry succeeds once', async () => {
  const rows = [
    { name: 'share-publish-before-EACCES', at: 'beforeSharePublish', code: 'EACCES' },
    { name: 'share-publish-after-EDQUOT', at: 'afterSharePublish', code: 'EDQUOT' },
  ]
  for (const row of rows) {
    const session = `sess-d11-${row.name}`
    await freshStore()
    await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'D11SP' })
    await disk.restartForTests()
    assert.equal(shareInternal.stats().shares, 0, row.name)
    assert.equal(disk.faults.set({ op: 'publish', at: row.at, count: 1, code: row.code }), true)
    const failed = await createShare(session,
      `<!doctype html><html><body>${row.name}</body></html>`)
    assert.equal(failed.status, 500, row.name)
    assert.deepEqual(jsonBody(failed), { ok: false, code: 'internal' }, row.name)
    assert.equal(shareInternal.stats().shares, 0, row.name)
    assert.deepEqual(fs.readdirSync(path.join(root, 'tmp')), [], row.name)
    disk.faults.clear()
    const restarted = await disk.restartForTests()
    assert.equal(restarted.mode, 'disk', row.name)
    assert.equal(shareInternal.stats().shares, 0, row.name)
    const retried = await createShare(session,
      `<!doctype html><html><body>${row.name}-retry</body></html>`)
    assert.equal(retried.status, 200, row.name)
    const body = jsonBody(retried)
    assert.equal(shareInternal.stats().shares, 1, row.name)
    assert.notEqual(shareInternal.rawShare(body.id), undefined, row.name)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', row.name)
    assert.equal(shareInternal.stats().shares, 1, row.name)
    assert.notEqual(shareInternal.rawShare(body.id), undefined, row.name)
  }
})

test('D11 thumbnail identical content and post-publish failure keep one committed PNG and other stores', async () => {
  const session = 'sess-d11-thumbnail-content'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'D11TC' })
  await disk.restartForTests()
  const thumbDir = path.join(root, 'thumbnails')
  const indexFile = path.join(thumbDir, 'index.json')
  const payload = {
    sessionId: session, revision: 1, dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
  }
  const first = await uploadThumbnail(payload)
  assert.equal(first.status, 200)
  const firstIndex = fs.readFileSync(indexFile)
  const firstParsed = JSON.parse(firstIndex.toString('utf8'))
  assert.equal(firstParsed.entries.length, 1)
  const entry = firstParsed.entries[0]
  const pngNames = () => fs.readdirSync(thumbDir).filter(name => name.endsWith('.png')).sort()
  assert.equal(pngNames().length, 1)
  const firstPng = fs.readFileSync(path.join(thumbDir, pngNames()[0]))
  const same = await uploadThumbnail(payload)
  assert.equal(same.status, 200)
  const secondIndex = fs.readFileSync(indexFile)
  const secondParsed = JSON.parse(secondIndex.toString('utf8'))
  assert.equal(secondParsed.entries.length, 1)
  assert.deepEqual(secondParsed.entries[0], entry)
  assert.equal(secondParsed.nextOrder, firstParsed.nextOrder)
  assert.deepEqual(secondIndex, firstIndex)
  assert.equal(pngNames().length, 1)
  assert.deepEqual(fs.readFileSync(path.join(thumbDir, pngNames()[0])), firstPng)
  const identicalGet = await thumbnailGet(session, 1)
  assert.equal(identicalGet.status, 200)
  assert.deepEqual(Buffer.from(await identicalGet.arrayBuffer()), firstPng)

  const appended = await appendScene(session, 'const thumbnailOtherStores = 2')
  assert.equal(appended.revision, 2)
  assert.equal((await uploadAsset(session, 'thumbnail-other.png')).status, 201)
  assert.equal((await createShare(session,
    '<!doctype html><html><body>thumbnail other stores</body></html>')).status, 200)
  assert.equal(shareInternal.stats().shares, 1)

  const variant = Buffer.concat([PNG, Buffer.from('variant')])
  const variantPayload = {
    sessionId: session, revision: 2,
    dataUrl: `data:image/png;base64,${variant.toString('base64')}`,
  }
  assert.equal(disk.faults.set({
    op: 'barrier', at: 'afterThumbnailPublish', count: 1, code: 'EDQUOT',
  }), true)
  const failed = await uploadThumbnail(variantPayload)
  assert.equal(failed.status, 503)
  assert.equal(Buffer.from(failed.body).toString('utf8'), 'thumbnail storage failed')
  assert.equal((await thumbnailGet(session, 2)).status, 404)
  assert.equal((await thumbnailGet(session, 1)).status, 200)
  assert.deepEqual(fs.readFileSync(indexFile), firstIndex)
  // The post-publish barrier throws before the in-memory PNG-created flag is
  // set, so the new PNG is an unreferenced orphan until restart reconciliation.
  assert.equal(pngNames().length, 2)
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8')).entries.length, 1)
  assert.equal((await listAssets(session)).body.assets.length, 1)
  assert.equal(shareInternal.stats().shares, 1)
  assert.equal((await sceneJson(session)).revision, 2)
  disk.faults.clear()

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await thumbnailGet(session, 2)).status, 404)
  const restoredGet = await thumbnailGet(session, 1)
  assert.equal(restoredGet.status, 200)
  assert.deepEqual(Buffer.from(await restoredGet.arrayBuffer()), firstPng)
  assert.equal(pngNames().length, 1)
  const retried = await uploadThumbnail(variantPayload)
  assert.equal(retried.status, 200)
  const variantGet = await thumbnailGet(session, 2)
  assert.equal(variantGet.status, 200)
  assert.deepEqual(Buffer.from(await variantGet.arrayBuffer()), variant)
  const stableGet = await thumbnailGet(session, 1)
  assert.deepEqual(Buffer.from(await stableGet.arrayBuffer()), firstPng)
  assert.equal(pngNames().length, 2)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await thumbnailGet(session, 1)).status, 200)
  assert.equal((await thumbnailGet(session, 2)).status, 200)
  assert.deepEqual(Buffer.from(await (await thumbnailGet(session, 2)).arrayBuffer()), variant)
  assert.equal((await listAssets(session)).body.assets.length, 1)
  assert.equal(shareInternal.stats().shares, 1)
  assert.equal((await sceneJson(session)).revision, 2)
})

test('D11 cleanup enqueue failure keeps the acknowledged append and restart rebuilds the keep set', async () => {
  const session = 'sess-d11-cleanup-enqueue'
  const fixture = await seedTrimCrashFixture(session, 'D11CQ')
  const expectedOrders = {}
  for (let revision = 2; revision <= 13; revision += 1) {
    expectedOrders[String(revision)] = 99 + revision
  }
  assert.equal(disk.faults.set({
    op: 'barrier', at: 'beforeCleanupQueue', count: 1, code: 'ENOSPC',
  }), true)
  const appended = await appendScene(session, 'const cleanupEnqueueFailure = true')
  assert.equal(appended.revision, 13)
  await waitForCleanupIdle()
  assert.equal(counters().sceneWriteDegraded, false)
  assert.equal(counters().sceneWritePreserve, false)
  assert.equal(revisionNames(sceneDir(session)).length, 13)
  assert.equal(markerNames(sceneDir(session)).length, 13)
  assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldRevisionName)), true)
  assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldMarkerName)), true)
  assert.equal(disk.inspect().fixtures.D11CQ.revisionOrderCount, 12)
  assert.equal(disk.inspect().fixtures.D11CQ.ordersByRevision['1'], undefined)
  assert.deepEqual(disk.inspect().fixtures.D11CQ.ordersByRevision, expectedOrders)
  const token = disk.inspect().lastCleanupToken
  assert.equal(token.orderCount, 1)
  assert.equal(token.assetCount, 0)
  assert.equal(token.victimSet.D11CQ, true)
  const live = await sceneJson(session)
  assert.equal(live.revision, 13)
  assert.match(live.code, /cleanupEnqueueFailure/)
  assert.equal((await listAssets(session)).body.assets.length, 1)
  disk.faults.clear()
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const reconciled = await sceneJson(session)
  assert.equal(reconciled.revision, 13)
  assert.match(reconciled.code, /cleanupEnqueueFailure/)
  // The lost enqueue token is not a destructive-cleanup mandate: restart
  // rebuilds the 12-revision keep set but preserves the old acknowledged files.
  assert.equal(revisionNames(sceneDir(session)).length, 13)
  assert.equal(markerNames(sceneDir(session)).length, 13)
  assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldRevisionName)), true)
  assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldMarkerName)), true)
  assert.equal(disk.inspect().fixtures.D11CQ.revisionOrderCount, 12)
  assert.deepEqual(disk.inspect().fixtures.D11CQ.ordersByRevision, expectedOrders)
  assert.equal((await listAssets(session)).body.assets.length, 1)
  assert.equal(counters().startupTruncatedScenes, 0)
  assert.equal(counters().unacknowledgedSceneSessions, 0)
  assert.equal(counters().startupEvictedScenes, 0)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 13)
  assert.equal(revisionNames(sceneDir(session)).length, 13)
  assert.equal(markerNames(sceneDir(session)).length, 13)
  assert.equal(disk.inspect().fixtures.D11CQ.revisionOrderCount, 12)
  assert.deepEqual(disk.inspect().fixtures.D11CQ.ordersByRevision, expectedOrders)
})

test('D11 cleanup enqueue after stop is discarded without deleting acknowledged data', async () => {
  const session = 'sess-d11-cleanup-stopping'
  const fixture = await seedTrimCrashFixture(session, 'D11CS')
  const expectedOrders = {}
  for (let revision = 2; revision <= 13; revision += 1) {
    expectedOrders[String(revision)] = 99 + revision
  }
  const cleanupPause = disk.pauseAtForTests('beforeCleanupQueue')
  const appended = await appendScene(session, 'const cleanupStopping = true')
  assert.equal(appended.revision, 13)
  await waitForPause(cleanupPause, 'cleanup stopping queue pause')
  const treeBeforeStop = treeSnapshot(sceneDir(session))
  assert.equal(revisionNames(sceneDir(session)).length, 13)
  assert.equal(markerNames(sceneDir(session)).length, 13)
  assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldRevisionName)), true)
  assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldMarkerName)), true)

  // Closing the store while the pump is waiting to enqueue the token closes
  // each operation queue; the resumed enqueue must fail `stopping` and the
  // write-behind token must be discarded rather than deleting acknowledged
  // revisions after shutdown.
  await stopStore()
  cleanupPause.release()
  await waitForCleanupIdle()
  assert.deepEqual(treeSnapshot(sceneDir(session)), treeBeforeStop)
  assert.equal(revisionNames(sceneDir(session)).length, 13)
  assert.equal(markerNames(sceneDir(session)).length, 13)
  assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldRevisionName)), true)
  assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldMarkerName)), true)

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const scene = await sceneJson(session)
  assert.equal(scene.revision, 13)
  assert.match(scene.code, /cleanupStopping/)
  assert.equal(revisionNames(sceneDir(session)).length, 13)
  assert.equal(markerNames(sceneDir(session)).length, 13)
  assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldRevisionName)), true)
  assert.equal(fs.existsSync(path.join(sceneDir(session), fixture.oldMarkerName)), true)
  assert.equal(disk.inspect().fixtures.D11CS.revisionOrderCount, 12)
  assert.equal(disk.inspect().fixtures.D11CS.ordersByRevision['1'], undefined)
  assert.deepEqual(disk.inspect().fixtures.D11CS.ordersByRevision, expectedOrders)
  assert.equal((await listAssets(session)).body.assets.length, 1)
  assert.equal(counters().startupTruncatedScenes, 0)
  assert.equal(counters().unacknowledgedSceneSessions, 0)
  assert.equal(counters().startupEvictedScenes, 0)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 13)
  assert.equal(revisionNames(sceneDir(session)).length, 13)
  assert.equal(markerNames(sceneDir(session)).length, 13)
  assert.equal((await listAssets(session)).body.assets.length, 1)
})

test('D11/D12 link afterLink faults fail closed through acquisition and a recovery guard', async () => {
  const acquireSession = 'sess-d11-link-acquire'
  await freshStore()
  await seedAcknowledged(acquireSession, { revisions: 1, assets: 1, label: 'LKA2' })
  await disk.restartForTests()
  const acquireSceneBefore = treeSnapshot(sceneDir(acquireSession))
  const acquireAssetsBefore = treeSnapshot(assetSessionDir(acquireSession))
  await stopStore()
  runChildScript([
    'disk.faults.set({ op: "link", at: "afterLink", count: 1, code: "EACCES" })',
    'const started = await disk.restartForTests()',
    'if (started.mode === "disk") throw new Error("link fault did not degrade")',
    'if (started.status !== "EACCES") throw new Error(`unexpected status ${started.status}`)',
  ], { expectCompletion: true })
  let names = lockArtifactNames()
  assert.equal(names.includes('LOCK'), true)
  assert.equal(names.some(name => /^[a-f0-9]{32}$/.test(name)), true)
  assert.equal(names.includes('LOCK.recover'), false)
  let restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assertLockControlOnly('link acquire')
  assert.deepEqual(treeSnapshot(sceneDir(acquireSession)), acquireSceneBefore)
  assert.deepEqual(treeSnapshot(assetSessionDir(acquireSession)), acquireAssetsBefore)
  assert.equal((await sceneJson(acquireSession)).revision, 1)
  assert.equal((await listAssets(acquireSession)).body.assets.length, 1)
  assert.equal((await appendScene(acquireSession, 'const linkAcquireRecovered = 2')).revision, 2)
  const acquireStable = await disk.restartForTests()
  assert.equal(acquireStable.mode, 'disk')
  assert.equal((await sceneJson(acquireSession)).revision, 2)
  assert.equal((await listAssets(acquireSession)).body.assets.length, 1)
  assertLockControlOnly('link acquire stable')

  const recoverySession = 'sess-d11-link-recovery-guard'
  await freshStore()
  await seedAcknowledged(recoverySession, { revisions: 1, assets: 1, label: 'LKR2' })
  await disk.restartForTests()
  const recoverySceneBefore = treeSnapshot(sceneDir(recoverySession))
  const recoveryAssetsBefore = treeSnapshot(assetSessionDir(recoverySession))
  await stopStore()
  runChildScript([
    'disk.crashAt("afterLockVerify")',
    'await disk.restartForTests()',
  ])
  names = lockArtifactNames()
  assert.equal(names.includes('LOCK'), true)
  runChildScript([
    'if (disk.markTestModeForTests() !== true) throw new Error("test mode unavailable")',
    'if (disk.faults.set({ op: "link", at: "afterLink", count: 1, code: "EACCES" }) !== true) throw new Error("link fault not armed")',
    'const started = await disk.restartForTests()',
    'if (started.mode === "disk") throw new Error("recovery link fault did not degrade")',
    'if (started.status !== "EACCES") throw new Error(`unexpected status ${started.status}`)',
  ], { skipHostApply: true, expectCompletion: true })
  const crashedNames = lockArtifactNames()
  assert.equal(crashedNames.includes('LOCK'), true)
  assert.equal(crashedNames.includes('LOCK.recover'), true)
  assert.equal(crashedNames.some(name => /^LOCK\.stale\./.test(name)), false)
  const failed = await disk.restartForTests()
  assert.notEqual(failed.mode, 'disk')
  assert.equal(failed.status, 'disk-locked')
  assert.deepEqual(lockArtifactNames(), crashedNames)
  assert.deepEqual(treeSnapshot(sceneDir(recoverySession)), recoverySceneBefore)
  assert.deepEqual(treeSnapshot(assetSessionDir(recoverySession)), recoveryAssetsBefore)
  fs.unlinkSync(path.join(root, 'LOCK.recover'))
  const recovered = await disk.restartForTests()
  assert.equal(recovered.mode, 'disk')
  assertLockControlOnly('link recovery guard')
  assert.equal((await sceneJson(recoverySession)).revision, 1)
  assert.equal((await listAssets(recoverySession)).body.assets.length, 1)
  assert.deepEqual(treeSnapshot(sceneDir(recoverySession)), recoverySceneBefore)
  assert.deepEqual(treeSnapshot(assetSessionDir(recoverySession)), recoveryAssetsBefore)
  assert.equal((await appendScene(recoverySession, 'const linkRecoveryRecovered = 2')).revision, 2)
  const recoveryStable = await disk.restartForTests()
  assert.equal(recoveryStable.mode, 'disk')
  assert.equal((await sceneJson(recoverySession)).revision, 2)
  assert.equal((await listAssets(recoverySession)).body.assets.length, 1)
  assertLockControlOnly('link recovery stable')
})

test('D12 over-cap thumbnail index is quarantined as size and a valid thumbnail can be republished', async () => {
  const session = 'sess-d12-thumbnail-index-cap'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'TIC' })
  await disk.restartForTests()
  await stopStore()
  const entry = {
    key: 's:1', sceneId: 's', revision: 1, order: 1, bytes: 1,
    sha256: '0'.repeat(64), createdAt: 0,
  }
  const entries = Array.from({ length: 4097 }, () => ({ ...entry }))
  const indexBytes = Buffer.from(JSON.stringify({
    v: 1, kind: 'thumbnail-index', nextOrder: 2, entries, recordSha256: '0'.repeat(64),
  }), 'utf8')
  assert.ok(indexBytes.length < 1024 * 1024)
  const indexFile = path.join(root, 'thumbnails', 'index.json')
  fs.writeFileSync(indexFile, indexBytes, { mode: 0o600 })
  const started = await disk.restartForTests()
  assert.equal(started.mode, 'disk')
  assert.equal(counters().quarantined, 1)
  assert.equal(counters().quarantineFailures, 0)
  const rewritten = readJsonFile(indexFile)
  assert.equal(rewritten.kind, 'thumbnail-index')
  assert.deepEqual(rewritten.entries, [])
  assert.equal(rewritten.recordSha256, canonicalPairsHash([
    ['v', 1], ['kind', rewritten.kind], ['nextOrder', rewritten.nextOrder],
    ['entries', JSON.stringify(rewritten.entries)],
  ]))
  const slots = fs.readdirSync(path.join(root, 'quarantine'))
  assert.equal(slots.length, 1)
  const slot = path.join(root, 'quarantine', slots[0])
  assert.deepEqual(fs.readFileSync(path.join(slot, 'artifact')), indexBytes)
  const reason = readJsonFile(path.join(slot, 'reason.json'))
  assert.equal(reason.category, 'size')
  assert.equal(reason.reason, 'size')
  assert.equal((await thumbnailGet(session, 1)).status, 404)
  assert.equal((await sceneJson(session)).revision, 1)
  const payload = {
    sessionId: session, revision: 1, dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
  }
  const republished = await uploadThumbnail(payload)
  assert.equal(republished.status, 200)
  const served = await thumbnailGet(session, 1)
  assert.equal(served.status, 200)
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  const afterRestart = await thumbnailGet(session, 1)
  assert.equal(afterRestart.status, 200)
  assert.deepEqual(Buffer.from(await afterRestart.arrayBuffer()), PNG)
})

test('D12 scene directory cap truncates, preserves every directory, and refuses appends until repaired', async () => {
  await freshStore()
  await stopStore()
  const scenesPath = path.join(root, 'scenes')
  const dirs = []
  for (let index = 0; index < 257; index += 1) {
    const name = createHash('sha256').update(`d12-scene-dir:${String(index)}`).digest('hex')
    fs.mkdirSync(path.join(scenesPath, name), { mode: 0o700 })
    dirs.push(name)
  }
  const before = treeSnapshot(scenesPath)
  const truncated = await disk.restartForTests()
  assert.equal(truncated.mode, 'disk')
  assert.equal(counters().startupTruncatedScenes, 2)
  assert.equal(counters().sceneWritePreserve, true)
  await assert.rejects(appendScene('sess-d12-scene-dir-cap', 'const tooManySceneDirs = 1'))
  assert.deepEqual(treeSnapshot(scenesPath), before)
  fs.rmdirSync(path.join(scenesPath, dirs.pop()))
  const repaired = await disk.restartForTests()
  assert.equal(repaired.mode, 'disk')
  assert.equal(counters().startupTruncatedScenes, 0)
  assert.equal(counters().sceneWritePreserve, false)
  const appended = await appendScene('sess-d12-scene-dir-cap', 'const sceneDirCapRepaired = 1')
  assert.equal(appended.revision, 1)
  assert.equal((await sceneJson('sess-d12-scene-dir-cap')).revision, 1)
})

test('D12 256 scene dirs x many revision/marker files stop at the directory and global scan caps without reads or deletion', async () => {
  await freshBoundedStore()
  const scenesPath = path.join(root, 'scenes')
  const dirs = []
  for (let index = 0; index < 257; index += 1) {
    const name = createHash('sha256').update(`d12-combined-scene-dir:${String(index)}`).digest('hex')
    fs.mkdirSync(path.join(scenesPath, name), { mode: 0o700 })
    dirs.push(name)
  }
  // Every scene directory advertises 130 revision and 130 marker entries
  // (above the 256-entry per-directory cap), so the 257th directory is refused
  // by the 256-dir cap while the admitted entries reach the global scan cap.
  assert.equal(disk.setVirtualDirentsForTests(dirs.map(name => ({
    dir: path.join(scenesPath, name),
    specs: [
      { repeat: 130, start: 1, pad: 16, suffix: '.json', kind: 'file' },
      { repeat: 130, start: 1, pad: 16, suffix: '.commit.json', kind: 'file' },
    ],
  }))), true)
  try { fs.unlinkSync(path.join(root, 'thumbnails', 'index.json')) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const before = treeSnapshot(scenesPath)
  const truncated = await disk.restartForTests()
  assert.equal(truncated.mode, 'disk')
  const scan = disk.scanForTests()
  assert.equal(scan.scanEntries, 65537)
  assert.equal(scan.counters.sceneRootEntries, 257)
  assert.equal(scan.counters.sceneDirs, 256)
  assert.equal(scan.counters.sceneSessionEntries, 65269)
  assert.equal(scan.counters.sceneCandidateOrders, 0)
  assert.equal(scan.counters.sceneRevisionReads, 0)
  assert.equal(scan.counters.sceneMarkerReads, 0)
  assert.equal(counters().startupTruncatedScenes, 254)
  assert.equal(counters().startupEvictedScenes, 0)
  assert.equal(counters().sceneWritePreserve, true)
  await assert.rejects(appendScene('sess-d12-combined-dir-cap', 'const tooManyCombinedDirs = 1'))
  assert.deepEqual(treeSnapshot(scenesPath), before)
  assert.equal(fs.readdirSync(scenesPath).length, 257)
  assert.equal(quarantineSceneEntries().length, 0)
  fs.rmdirSync(path.join(scenesPath, dirs.pop()))
  disk.clearVirtualDirentsForTests()
  const repaired = await disk.restartForTests()
  assert.equal(repaired.mode, 'disk')
  assert.equal(counters().startupTruncatedScenes, 0)
  assert.equal(counters().sceneWritePreserve, false)
  const appended = await appendScene('sess-d12-combined-dir-cap', 'const combinedDirCapRepaired = 1')
  assert.equal(appended.revision, 1)
  assert.equal((await sceneJson('sess-d12-combined-dir-cap')).revision, 1)
})

test('D12 share directory cap scans at most 256 directories and preserves the unscanned one', async () => {
  const session = 'sess-d12-share-dir-cap'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'SDC' })
  await disk.restartForTests()
  await stopStore()
  const sharesPath = path.join(root, 'shares')
  const names = []
  for (let index = 0; index < 257; index += 1) {
    const name = createHash('sha256').update(`d12-share-dir:${String(index)}`).digest('hex')
    fs.mkdirSync(path.join(sharesPath, name), { mode: 0o700 })
    names.push(name)
  }
  names.sort()
  const started = await disk.restartForTests()
  assert.equal(started.mode, 'disk')
  assert.deepEqual(fs.readdirSync(sharesPath), [names[256]])
  const share = await createShare(session,
    '<!doctype html><html><body>share directory cap</body></html>')
  assert.equal(share.status, 200)
  assert.equal(shareInternal.stats().shares, 1)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal(shareInternal.stats().shares, 1)
  assert.notEqual(shareInternal.rawShare(jsonBody(share).id), undefined)
  assert.equal((await sceneJson(session)).revision, 1)
})

test('D12 FIFO revision entry is never opened, the Session is preserved, and removal repairs it', async () => {
  const session = 'sess-d12-fifo'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 1, label: 'FIFO' })
  await disk.restartForTests()
  const epoch = disk.sceneEpochForTests(session)
  assert.match(epoch, HEX32_RE)
  const revisionName = revisionNames(sceneDir(session))[0]
  const markerName = markerNames(sceneDir(session))[0]
  assert.match(revisionName, /^[0-9]{16}\.json$/)
  assert.match(markerName, /^[0-9]{16}\.commit\.json$/)
  const revisionBytes = fs.readFileSync(path.join(sceneDir(session), revisionName))
  const markerBytes = fs.readFileSync(path.join(sceneDir(session), markerName))
  await stopStore()
  const fifoPath = path.join(sceneDir(session), '0000000000009000.json')
  const made = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' })
  assert.equal(made.status, 0, `mkfifo failed: ${String(made.stderr)}`)
  assert.equal(fs.lstatSync(fifoPath).isFIFO(), true)
  const truncated = await disk.restartForTests()
  assert.equal(truncated.mode, 'disk')
  assert.equal(counters().sceneWritePreserve, true)
  assert.ok(counters().startupTruncatedScenes >= 1)
  assert.equal((await sceneGet(session)).status, 404)
  assert.equal(fs.existsSync(fifoPath), true)
  assert.deepEqual(fs.readFileSync(path.join(sceneDir(session), revisionName)), revisionBytes)
  assert.deepEqual(fs.readFileSync(path.join(sceneDir(session), markerName)), markerBytes)
  assert.equal((await listAssets(session)).body.assets.length, 1)
  await assert.rejects(appendScene(session, 'const fifoPreserved = 1'))
  fs.unlinkSync(fifoPath)
  const repaired = await disk.restartForTests()
  assert.equal(repaired.mode, 'disk')
  assert.equal(counters().sceneWritePreserve, false)
  assert.equal(counters().startupTruncatedScenes, 0)
  assert.equal(disk.sceneEpochForTests(session), epoch)
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal((await listAssets(session)).body.assets.length, 1)
  const appended = await appendScene(session, 'const fifoRepaired = 2')
  assert.equal(appended.revision, 2)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 2)
  assert.equal(disk.sceneEpochForTests(session), epoch)
  assert.equal((await listAssets(session)).body.assets.length, 1)
})

// ===========================================================================
// Fix round 4: required restore/late-victim/bounds/lock/rollback coverage.
// ===========================================================================

function spawnChildScript(bodyLines, options = {}) {
  const childRoot = fs.mkdtempSync(path.join(tempBase, 'twb-fix4-child-'))
  const scriptPath = path.join(childRoot, 'child.mjs')
  const preamble = options.skipHostApply === true
    ? CHILD_PREAMBLE.split('\n').filter(line => line !== 'apply(ctx)')
    : CHILD_PREAMBLE.split('\n')
  const lines = [
    'fs.writeSync(1, "CHILD_PID:" + process.pid + "\\n")',
    ...preamble, ...bodyLines, 'process.stdout.write("CHILD_COMPLETED\\n")',
  ]
  fs.writeFileSync(scriptPath, `${lines.join('\n')}\n`, { mode: 0o600 })
  // The persistent shell keeps its command line (including --test) as the
  // child's parent, which is part of the production isolated-test guard.
  const child = spawn('/bin/bash', [
    '-c', '"$0" "$1"; exit $?', process.execPath, scriptPath, '--test',
  ], {
    env: { ...process.env, THREE_WORKBENCH_DATA_DIR: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
  const exit = new Promise(resolve => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    fs.rmSync(childRoot, { recursive: true, force: true })
  }
  return {
    child,
    get stdout() { return stdout },
    get stderr() { return stderr },
    get nodePid() {
      const line = stdout.split('\n').find(item => item.startsWith('CHILD_PID:'))
      if (line === undefined) return null
      const pid = Number(line.slice('CHILD_PID:'.length))
      return Number.isSafeInteger(pid) && pid > 1 ? pid : null
    },
    async waitForOutput(text, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (stdout.includes(text)) return true
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`child exited before ${text}: ${stdout} ${stderr}`)
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error(`timed out waiting for child ${text}: ${stdout} ${stderr}`)
    },
    async waitExit(timeoutMs = 20000) {
      let timer
      try {
        return await Promise.race([
          exit,
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`child exit timeout: ${stdout} ${stderr}`)), timeoutMs)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    },
    async cleanupAfterExit() {
      await exit.catch(() => {})
      cleanup()
    },
  }
}

function procStartTimeForTest(pid) {
  const raw = fs.readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
  const close = raw.lastIndexOf(')')
  assert.ok(close >= 0)
  return Number(raw.slice(close + 2).trim().split(/\s+/)[19])
}

function lockRecordForTest(overrides = {}) {
  return {
    v: 1,
    kind: 'three-workbench-lock',
    pid: process.pid,
    procStartTime: procStartTimeForTest(process.pid),
    bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    pidNamespace: fs.readlinkSync('/proc/self/ns/pid'),
    startedAt: Date.now(),
    token: 'a'.repeat(32),
    ...overrides,
  }
}

function writeLockBytesForTest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), 'utf8')
  fs.writeFileSync(path.join(root, 'LOCK'), bytes, { mode: 0o600 })
}

function lockEntrySnapshotForTest() {
  const lockPath = path.join(root, 'LOCK')
  const stat = fs.lstatSync(lockPath)
  if (stat.isSymbolicLink()) return { type: 'symlink', target: fs.readlinkSync(lockPath) }
  return {
    type: stat.isFile() ? 'file' : 'other',
    mode: stat.mode & 0o777,
    bytes: fs.readFileSync(lockPath).toString('base64'),
  }
}

function deadPidForTest() {
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0)
  const pid = Number(result.stdout)
  assert.ok(Number.isSafeInteger(pid) && pid > 1)
  assert.throws(() => process.kill(pid, 0), error => error?.code === 'ESRCH')
  return pid
}

test('D12 live, partial, empty, unreadable and malformed lock holders degrade fail-closed and preserve every byte', async () => {
  const rows = [
    { name: 'live', install: () => writeLockBytesForTest(lockRecordForTest()) },
    { name: 'partial', install: () => writeLockBytesForTest(Buffer.from('{"v":1,"kind":"three-workbench-lock"')) },
    { name: 'empty', install: () => writeLockBytesForTest(Buffer.alloc(0)) },
    {
      name: 'unreadable',
      install: () => {
        const target = path.join(tempBase, `twb-fix4-unreadable-lock-${String(process.pid)}`)
        fs.writeFileSync(target, Buffer.from(JSON.stringify(lockRecordForTest()), 'utf8'), { mode: 0o600 })
        fs.symlinkSync(target, path.join(root, 'LOCK'))
        return () => fs.rmSync(target, { force: true })
      },
    },
    {
      name: 'malformed',
      install: () => writeLockBytesForTest({ ...lockRecordForTest(), unexpected: true }),
    },
  ]
  for (const row of rows) {
    const session = `sess-fix4-lock-degrade-${row.name}`
    await freshStore()
    await seedAcknowledged(session, { revisions: 1, assets: 1, label: 'LK0' })
    await disk.restartForTests()
    const sceneBefore = treeSnapshot(sceneDir(session))
    const assetsBefore = treeSnapshot(assetSessionDir(session))
    await stopStore()
    const cleanup = row.install()
    const lockBefore = lockEntrySnapshotForTest()
    try {
      const started = await disk.restartForTests()
      assert.equal(started.mode, 'degraded', row.name)
      assert.equal(started.status, 'disk-locked', row.name)
      assert.equal(started.reason, 'disk-locked', row.name)
      assert.equal(disk.ready(), true, row.name)
      assert.deepEqual(lockEntrySnapshotForTest(), lockBefore, row.name)
      assert.equal(fs.existsSync(path.join(root, 'LOCK.recover')), false, row.name)
      assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore, row.name)
      assert.deepEqual(treeSnapshot(assetSessionDir(session)), assetsBefore, row.name)
      await assert.rejects(appendScene(session, 'const lockDegradedMustNotWrite = 1'), undefined, row.name)
      assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore, row.name)
      assert.deepEqual(treeSnapshot(assetSessionDir(session)), assetsBefore, row.name)
    } finally {
      fs.rmSync(path.join(root, 'LOCK'), { recursive: true, force: true })
      if (typeof cleanup === 'function') cleanup()
    }
    const recovered = await disk.restartForTests()
    assert.equal(recovered.mode, 'disk', row.name)
    assert.equal((await sceneJson(session)).revision, 1, row.name)
    assert.equal((await listAssets(session)).body.assets.length, 1, row.name)
    assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore, row.name)
    assert.deepEqual(treeSnapshot(assetSessionDir(session)), assetsBefore, row.name)
    const appended = await appendScene(session, 'const lockDegradeRecovered = 2')
    assert.equal(appended.revision, 2, row.name)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', row.name)
    assert.equal((await sceneJson(session)).revision, 2, row.name)
    assert.equal((await listAssets(session)).body.assets.length, 1, row.name)
  }
})

test('D12 dead same-boot and different-boot lock holders recover through the guard without data loss', async () => {
  const deadSession = 'sess-fix4-lock-dead-recover'
  await freshStore()
  await seedAcknowledged(deadSession, { revisions: 1, assets: 1, label: 'LK1' })
  await disk.restartForTests()
  const deadSceneBefore = treeSnapshot(sceneDir(deadSession))
  const deadAssetsBefore = treeSnapshot(assetSessionDir(deadSession))
  await stopStore()
  writeLockBytesForTest(lockRecordForTest({
    pid: deadPidForTest(), procStartTime: 1, token: 'b'.repeat(32),
  }))
  const deadRecovered = await disk.restartForTests()
  assert.equal(deadRecovered.mode, 'disk')
  assertLockControlOnly('dead same-boot')
  assert.equal((await sceneJson(deadSession)).revision, 1)
  assert.equal((await listAssets(deadSession)).body.assets.length, 1)
  assert.deepEqual(treeSnapshot(sceneDir(deadSession)), deadSceneBefore)
  assert.deepEqual(treeSnapshot(assetSessionDir(deadSession)), deadAssetsBefore)
  assert.equal((await appendScene(deadSession, 'const deadLockRecovered = 2')).revision, 2)
  const deadStable = await disk.restartForTests()
  assert.equal(deadStable.mode, 'disk')
  assert.equal((await sceneJson(deadSession)).revision, 2)
  assertLockControlOnly('dead same-boot stable')

  const bootSession = 'sess-fix4-lock-other-boot'
  await freshStore()
  await seedAcknowledged(bootSession, { revisions: 1, assets: 1, label: 'LK2' })
  await disk.restartForTests()
  const bootSceneBefore = treeSnapshot(sceneDir(bootSession))
  const bootAssetsBefore = treeSnapshot(assetSessionDir(bootSession))
  await stopStore()
  writeLockBytesForTest(lockRecordForTest({
    bootId: '00000000-0000-4000-8000-000000000000', token: 'c'.repeat(32),
  }))
  const bootRecovered = await disk.restartForTests()
  assert.equal(bootRecovered.mode, 'disk')
  assertLockControlOnly('different boot')
  assert.equal((await sceneJson(bootSession)).revision, 1)
  assert.equal((await listAssets(bootSession)).body.assets.length, 1)
  assert.deepEqual(treeSnapshot(sceneDir(bootSession)), bootSceneBefore)
  assert.deepEqual(treeSnapshot(assetSessionDir(bootSession)), bootAssetsBefore)
  assert.equal((await appendScene(bootSession, 'const otherBootLockRecovered = 2')).revision, 2)
  const bootStable = await disk.restartForTests()
  assert.equal(bootStable.mode, 'disk')
  assert.equal((await sceneJson(bootSession)).revision, 2)
  assertLockControlOnly('different boot stable')
})

test('D12 a same-boot lock from another PID namespace stays ambiguous and fail-closed', async () => {
  const session = 'sess-fix4-lock-ambiguous-namespace'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 1, label: 'LK3' })
  await disk.restartForTests()
  const sceneBefore = treeSnapshot(sceneDir(session))
  const assetsBefore = treeSnapshot(assetSessionDir(session))
  await stopStore()
  writeLockBytesForTest(lockRecordForTest({
    pidNamespace: 'pid:[999999999]', token: 'd'.repeat(32),
  }))
  const lockBefore = lockEntrySnapshotForTest()
  const started = await disk.restartForTests()
  assert.equal(started.mode, 'degraded')
  assert.equal(started.status, 'disk-locked')
  assert.deepEqual(lockEntrySnapshotForTest(), lockBefore)
  assert.equal(fs.existsSync(path.join(root, 'LOCK.recover')), false)
  assert.equal(lockArtifactNames().some(name => /^LOCK\.stale\./.test(name)), false)
  assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore)
  assert.deepEqual(treeSnapshot(assetSessionDir(session)), assetsBefore)
  fs.rmSync(path.join(root, 'LOCK'), { force: true })
  const recovered = await disk.restartForTests()
  assert.equal(recovered.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal((await listAssets(session)).body.assets.length, 1)
  assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore)
  assert.deepEqual(treeSnapshot(assetSessionDir(session)), assetsBefore)
})

test('D12 a mismatched release token leaves LOCK and the writer intact', async () => {
  const session = 'sess-fix4-lock-release-token'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 1, label: 'LK4' })
  await disk.restartForTests()
  const sceneBefore = treeSnapshot(sceneDir(session))
  const lockBefore = lockEntrySnapshotForTest()
  assert.equal(disk.releaseLockTokenForTests('f'.repeat(32)), false)
  assert.deepEqual(lockEntrySnapshotForTest(), lockBefore)
  assert.equal(disk.lockHeldForTests(), true)
  assert.equal(disk.inspect().status, 'ready')
  assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore)
  assert.equal((await appendScene(session, 'const mismatchStillWriter = 2')).revision, 2)
  const appendedScene = await sceneJson(session)
  assert.match(appendedScene.code, /mismatchStillWriter/)
  await stopStore()
  assert.equal(fs.existsSync(path.join(root, 'LOCK')), false)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 2)
  assert.equal((await listAssets(session)).body.assets.length, 1)
  assertLockControlOnly('mismatched release token')
})

test('D12 a two-process acquisition race pauses the first writer after candidate fsync and the loser degrades', async () => {
  const session = 'sess-fix4-lock-race'
  await freshStore()
  await seedAcknowledged(session, { revisions: 1, assets: 1, label: 'LK5' })
  await disk.restartForTests()
  const sceneBefore = treeSnapshot(sceneDir(session))
  const assetsBefore = treeSnapshot(assetSessionDir(session))
  await stopStore()
  const child = spawnChildScript([
    'const first = await disk.restartForTests()',
    'if (first.mode !== "disk") throw new Error("child initial mode")',
    `if (disk.pauseSyncAtForTests('afterCandidateFsync') !== true) throw new Error('pause arm failed')`,
    'await disk.closeForTests()',
    'const started = await disk.restartForTests()',
    'fs.writeSync(1, "SYNC_RACE:" + JSON.stringify({ mode: started.mode, status: started.status }) + "\\n")',
  ])
  try {
    await child.waitForOutput('CHILD_PID:')
    assert.ok(child.nodePid !== null)
    await child.waitForOutput('SYNC_PAUSE:afterCandidateFsync')
    const pausedNames = lockArtifactNames()
    assert.equal(pausedNames.includes('LOCK'), false)
    assert.equal(pausedNames.some(name => /^[a-f0-9]{32}$/.test(name)), true)
    assert.equal(pausedNames.includes('LOCK.recover'), false)
    const parentStarted = await disk.restartForTests()
    assert.equal(parentStarted.mode, 'disk')
    assert.equal(disk.lockHeldForTests(), true)
    assert.equal(fs.existsSync(path.join(root, 'LOCK')), true)
    process.kill(child.nodePid, 'SIGCONT')
    await child.waitForOutput('SYNC_RACE:')
    const line = child.stdout.split('\n').find(item => item.startsWith('SYNC_RACE:'))
    const result = JSON.parse(line.slice('SYNC_RACE:'.length))
    assert.deepEqual(result, { mode: 'degraded', status: 'disk-locked' })
    assert.equal(disk.lockHeldForTests(), true)
    assert.equal(fs.existsSync(path.join(root, 'LOCK')), true)
    assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore)
    assert.deepEqual(treeSnapshot(assetSessionDir(session)), assetsBefore)
    const exit = await child.waitExit()
    assert.equal(exit.code, 0)
    assert.match(child.stdout, /CHILD_COMPLETED/)
    const appended = await appendScene(session, 'const raceParentStillWriter = 2')
    assert.equal(appended.revision, 2)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk')
    assert.equal((await sceneJson(session)).revision, 2)
    assert.equal((await listAssets(session)).body.assets.length, 1)
    assertLockControlOnly('race parent')
  } finally {
    if (child.child.exitCode === null) {
      try { process.kill(child.nodePid, 'SIGKILL') } catch (error) { void error }
      child.child.kill('SIGKILL')
    }
    await child.cleanupAfterExit()
  }
})

test('D6 restore SIGKILL at each scene barrier preserves branch bytes and the exact 12/16 keep sets', async () => {
  const barriers = [
    'afterRevisionDirFsync',
    'afterSceneEpochPublish',
    'afterSceneMemoryCommit',
    'beforeSceneCommitMarker',
    'afterSceneCommitMarker',
  ]
  for (const barrier of barriers) {
    const data = await seedD6SceneCrashFixture()
    const dir = sceneDir(data.s1)
    const beforeRevisionNames = revisionNames(dir)
    const beforeMarkerNames = markerNames(dir)
    assert.equal(beforeRevisionNames.length, 12, barrier)
    assert.equal(beforeMarkerNames.length, 12, barrier)
    await stopStore()
    runChildScript([
      'await disk.restartForTests()',
      `const restoreHistory = history.history(${JSON.stringify(data.s1)}).history`,
      `process.stdout.write("RESTORE_BARRIER:${barrier}\\n")`,
      `disk.crashAt(${JSON.stringify(barrier)})`,
      `try { const restoreResponse = await restoreSession(${JSON.stringify(data.s1)}, { sourceRevision: restoreHistory[0].revision, sourceUpdatedAt: restoreHistory[0].updatedAt, expectedRevision: restoreHistory[restoreHistory.length - 1].revision, expectedUpdatedAt: restoreHistory[restoreHistory.length - 1].updatedAt, requestId: ${JSON.stringify(barrier.length >= 22 ? barrier.slice(0, 22) : barrier.padEnd(22, 'X'))} }); process.stdout.write("RESTORE_RESPONSE:"+String(restoreResponse.status)+":"+Buffer.from(restoreResponse.body).toString("utf8")+"\\n") } catch (error) { process.stdout.write("RESTORE_THROW:"+String(error)+"\\n") }`,
    ])
    const crashedRevisions = revisionNames(dir)
    const crashedMarkers = markerNames(dir)
    const appendedName = crashedRevisions.find(name => !beforeRevisionNames.includes(name))
    assert.match(appendedName, /^\d{16}\.json$/, barrier)
    assert.equal(Number(appendedName.slice(0, 16)), 117, barrier)
    assert.equal(crashedRevisions.length, 13, barrier)
    const appendedMarker = appendedName.replace(/\.json$/, '.commit.json')
    const markerPresent = crashedMarkers.includes(appendedMarker)
    assert.equal(markerPresent, barrier === 'afterSceneCommitMarker', barrier)
    assert.equal(crashedMarkers.length, markerPresent ? 13 : 12, barrier)
    const appendedBytes = markerPresent ? null : fs.readFileSync(path.join(dir, appendedName))

    const restarted = await disk.restartForTests()
    assert.equal(restarted.mode, 'disk', barrier)
    const scene = await sceneJson(data.s1)
    const fixture = disk.inspect().fixtures.Q1
    assert.equal(disk.sceneEpochForTests(data.s1), data.epoch, barrier)
    if (markerPresent) {
      assert.equal(scene.revision, 13, barrier)
      assert.deepEqual(fixture.ordersByRevision, {
        2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 10: 11, 11: 12, 12: 13, 13: 117,
      }, barrier)
      assert.equal(fixture.revisionOrderCount, 12, barrier)
      assert.equal(markerNames(dir).length, 13, barrier)
    } else {
      assert.equal(scene.revision, 12, barrier)
      assert.deepEqual(fixture.ordersByRevision, {
        1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 10: 11, 11: 12, 12: 13,
      }, barrier)
      assert.equal(fixture.revisionOrderCount, 12, barrier)
      assert.equal(markerNames(dir).length, 12, barrier)
      assert.equal(fs.existsSync(path.join(dir, appendedMarker)), false, barrier)
      assert.deepEqual(fs.readFileSync(path.join(dir, appendedName)), appendedBytes, barrier)
    }
    for (let index = 1; index <= 16; index += 1) {
      const session = data[`s${index}`]
      const expected = index === 1 ? (markerPresent ? 13 : 12) : 1
      const expectedRevisionFiles = index === 1 && !markerPresent ? 13 : expected
      assert.equal((await sceneJson(session)).revision, expected, `${barrier} s${String(index)}`)
      assert.equal(revisionNames(sceneDir(session)).length, expectedRevisionFiles, `${barrier} s${String(index)} files`)
      assert.equal(markerNames(sceneDir(session)).length, expected, `${barrier} s${String(index)} markers`)
    }
    assert.equal((await sceneGet(data.s17)).status, 404, barrier)
    assert.equal(counters().startupTruncatedScenes, 0, barrier)
    assert.equal(counters().unacknowledgedSceneSessions, 0, barrier)
    assert.equal(disk.inspect().namespaceFence.state, 'normal', barrier)
    await stopStore()
  }
})

async function seedLateVictimFixture() {
  await freshStore()
  const sessions = new Map()
  const labels = new Map()
  for (let index = 17; index >= 1; index -= 1) {
    const session = `sess-fix4-late-${String(index).padStart(2, '0')}`
    const label = `Z${String(index).padStart(2, '0')}`
    sessions.set(index, session)
    labels.set(index, label)
    await seedAcknowledged(session, {
      revisions: index === 1 ? 12 : 1,
      assets: index === 1 ? 1 : index === 2 ? 2 : 0,
      baseOrder: index === 17 ? 100 : 100 + index,
      label,
    })
  }
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(sessions.get(1))).revision, 12)
  assert.equal((await sceneGet(sessions.get(17))).status, 404)
  const expectedVictims = {}
  for (let index = 1; index <= 17; index += 1) expectedVictims[labels.get(index)] = index === 2
  return {
    sessions,
    expectedVictims,
    s1: sessions.get(1),
    s2: sessions.get(2),
    s2Owner: JSON.parse(fs.readFileSync(ownerRecordPath(sessions.get(2)), 'utf8')),
    s2AssetTree: treeSnapshot(assetSessionDir(sessions.get(2))),
    s2SceneTree: treeSnapshot(sceneDir(sessions.get(2))),
  }
}

test('D6/N9-R child SIGKILL after late-victim cleanup proves the token carried assets and pre-commit orders, then restart', async () => {
  const fixture = await seedLateVictimFixture()
  const { s1, s2 } = fixture
  assert.equal(revisionNames(sceneDir(s1)).length, 12)
  assert.equal(markerNames(sceneDir(s1)).length, 12)
  const s2OldOrder = disk.inspect().fixtures.Z02.ordersByRevision['1']
  assert.equal(s2OldOrder, 102)
  await stopStore()
  const child = runChildScript([
    'await disk.restartForTests()',
    'if (!(await disk.cleanupIdleForTests(10000))) throw new Error("startup cleanup")',
    `history.seedSession('sess-fix4-late-model', [{ sceneId: 'sess-fix4-late-model', revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1 }])`,
    `disk.clearCleanupTokensForTests()`,
    `const revisionPause = disk.pauseAtForTests('afterRevisionDirFsync')`,
    `const trimCleanupPause = disk.pauseAtForTests('beforeCleanupQueue')`,
    `const victimCleanupPause = disk.pauseAtForTests('beforeCleanupQueue')`,
    `const appendPromise = appendScene(${JSON.stringify(s1)}, 'const fix4LateVictim = true')`,
    `await revisionPause.arrival`,
    `const late = await uploadAsset(${JSON.stringify(s2)}, 'fix4-late.png')`,
    `if (late.status !== 201) throw new Error('late upload status ' + String(late.status))`,
    `const lateHash = disk.helpers.assetIdHash(jsonBody(late).asset.id)`,
    'revisionPause.release()',
    `const appended = await appendPromise`,
    `if (appended.revision !== 13) throw new Error('append revision ' + String(appended.revision))`,
    `await trimCleanupPause.arrival`,
    'trimCleanupPause.release()',
    `await victimCleanupPause.arrival`,
    `fs.writeSync(1, "FIX4_TOKEN:" + JSON.stringify({ lateHash, tokens: disk.inspect().lastCleanupTokens }) + "\\n")`,
    `disk.crashAt('afterCleanup')`,
    'victimCleanupPause.release()',
    'await delay(1500)',
  ])
  const tokenLine = child.stdout.split('\n').find(line => line.startsWith('FIX4_TOKEN:'))
  assert.equal(typeof tokenLine, 'string')
  const printed = JSON.parse(tokenLine.slice('FIX4_TOKEN:'.length))
  assert.equal(printed.tokens.length, 2)
  const token = printed.tokens.find(entry => entry.assetCount === 3)
  const trimToken = printed.tokens.find(entry => entry.assetCount === 0)
  assert.equal(token.orderCount, 1)
  assert.deepEqual(token.revisionOrders, [{ revision: 1, order: 102 }])
  assert.equal(token.assetHashes.includes(printed.lateHash), true)
  assert.equal(token.ownerEpoch, fixture.s2Owner.sceneEpoch)
  assert.equal(token.ownerIncarnation, fixture.s2Owner.incarnation)
  assert.deepEqual(trimToken.revisionOrders, [{ revision: 1, order: 101 }])
  assert.equal(fs.existsSync(sceneDir(s2)), false)
  assert.equal(fs.existsSync(assetSessionDir(s2)), false)
  assert.equal(revisionNames(sceneDir(s1)).length, 12)
  assert.equal(markerNames(sceneDir(s1)).length, 12)

  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(s1)).revision, 13)
  assert.match((await sceneJson(s1)).code, /fix4LateVictim/)
  assert.equal(revisionNames(sceneDir(s1)).length, 12)
  assert.equal(markerNames(sceneDir(s1)).length, 12)
  assert.equal((await sceneGet(s2)).status, 404)
  assert.equal(fs.existsSync(sceneDir(s2)), false)
  assert.equal(fs.existsSync(assetSessionDir(s2)), false)
  const s2Rows = await listAssets(s2)
  assert.equal(s2Rows.status, 404)
  assert.equal((await listAssets(s1)).body.assets.length, 1)
  assert.equal((await sceneGet(fixture.sessions.get(17))).status, 404)
  assert.equal(counters().startupTruncatedScenes, 0)
  assert.equal(counters().unacknowledgedSceneSessions, 0)
  assert.equal(disk.stats().bytes.staging, 0)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(s1)).revision, 13)
  assert.equal((await sceneGet(s2)).status, 404)
  assert.equal(fs.existsSync(assetSessionDir(s2)), false)
})

test('D6/N9-R marker failure after a late victim upload drops the token and deletes nothing; restart keeps 12/16', async () => {
  const fixture = await seedLateVictimFixture()
  const { s1, s2 } = fixture
  host.__historyInternal.seedSession('sess-fix4-late-marker-model', [{
    sceneId: 'sess-fix4-late-marker-model', revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1,
  }])
  disk.clearCleanupTokensForTests()
  const revisionPause = disk.pauseAtForTests('afterRevisionDirFsync')
  const appendPromise = appendScene(s1, 'const fix4LateMarkerFailure = true')
  appendPromise.catch(() => {})
  await waitForPause(revisionPause, 'marker failure late victim revision fsync')
  const late = await uploadAsset(s2, 'fix4-marker-failure-late.png')
  assert.equal(late.status, 201)
  const lateHash = disk.helpers.assetIdHash(jsonBody(late).asset.id)
  const s2TreeDuringWindow = treeSnapshot(assetSessionDir(s2))
  assert.equal(Object.keys(s2TreeDuringWindow).length > Object.keys(fixture.s2AssetTree).length, true)
  armFault('sceneCommitMarker', 'beforeSceneCommitMarker', 1, 'ENOSPC')
  revisionPause.release()
  await assert.rejects(appendPromise, error => error?.code === 'storage-unavailable')
  await waitForCleanupIdle()
  assert.equal(counters().sceneWriteDegraded, true)
  const captured = disk.inspect().lastCleanupTokens
  assert.equal(captured.length, 2)
  const victimToken = captured.find(entry => entry.victimSet.Z02 === true)
  const trimToken = captured.find(entry => entry.victimSet.Z01 === true)
  assert.equal(victimToken.assetCount, 3)
  assert.deepEqual(victimToken.revisionOrders, [{ revision: 1, order: 102 }])
  assert.equal(victimToken.assetHashes.includes(lateHash), true)
  assert.deepEqual(trimToken.revisionOrders, [{ revision: 1, order: 101 }])
  assert.equal((await sceneGet(s2)).status, 404)
  assert.deepEqual(treeSnapshot(sceneDir(s2)), fixture.s2SceneTree)
  assert.deepEqual(treeSnapshot(assetSessionDir(s2)), s2TreeDuringWindow)
  assert.equal(revisionNames(sceneDir(s1)).length, 13)
  assert.equal(markerNames(sceneDir(s1)).length, 12)
  assert.equal((await sceneJson(s1)).revision, 12)
  assert.equal(fs.existsSync(path.join(sceneDir(s1), disk.generatedNames.sceneMarker(117))), false)

  disk.faults.clear()
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(s1)).revision, 12)
  assert.equal(revisionNames(sceneDir(s1)).length, 13)
  assert.equal(markerNames(sceneDir(s1)).length, 12)
  assert.equal((await sceneJson(s2)).revision, 1)
  assert.deepEqual(treeSnapshot(sceneDir(s2)), fixture.s2SceneTree)
  const rows = await listAssets(s2)
  assert.equal(rows.status, 200)
  assert.equal(rows.body.assets.length, 3)
  assert.deepEqual(disk.inspect().fixtures.Z02.ordersByRevision, { 1: 102 })
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(s2)).revision, 1)
  assert.equal((await listAssets(s2)).body.assets.length, 3)
  assert.equal((await sceneJson(s1)).revision, 12)
})

test('SEC-M-5 restore path holds the victim asset queue through a late upload and cleans the exact victim', async () => {
  const fixture = await seedLateVictimFixture()
  const { s1, s2 } = fixture
  host.__historyInternal.seedSession('sess-fix4-restore-late-model', [{
    sceneId: 'sess-fix4-restore-late-model', revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1,
  }])
  const history = historyInternal.history(s1).history
  assert.equal(history.length, 12)
  disk.clearCleanupTokensForTests()
  const revisionPause = disk.pauseAtForTests('afterRevisionDirFsync')
  const restorePromise = restoreSession(s1, {
    sourceRevision: history[0].revision,
    sourceUpdatedAt: history[0].updatedAt,
    expectedRevision: history.at(-1).revision,
    expectedUpdatedAt: history.at(-1).updatedAt,
    requestId: 'M'.repeat(22),
  })
  await waitForPause(revisionPause, 'SEC-M-5 restore revision fsync')
  const late = await uploadAsset(s2, 'fix4-restore-late.png')
  assert.equal(late.status, 201)
  const lateAsset = jsonBody(late).asset
  revisionPause.release()
  const restored = await restorePromise
  assert.equal(restored.status, 200)
  assert.deepEqual(jsonBody(restored), {
    ok: true, revision: 13, sourceRevision: history[0].revision, updatedAt: jsonBody(restored).updatedAt,
  })
  const tokens = disk.inspect().lastCleanupTokens
  assert.equal(tokens.length, 2)
  const token = tokens.find(entry => entry.victimSet.Z02 === true)
  const trimToken = tokens.find(entry => entry.victimSet.Z01 === true)
  assert.equal(token.orderCount, 1)
  assert.equal(token.assetCount, 3)
  assert.deepEqual(token.revisionOrders, [{ revision: 1, order: 102 }])
  assert.equal(token.ownerEpoch, fixture.s2Owner.sceneEpoch)
  assert.equal(token.ownerIncarnation, fixture.s2Owner.incarnation)
  assert.equal(token.assetHashes.includes(disk.helpers.assetIdHash(lateAsset.id)), true)
  assert.deepEqual(trimToken.revisionOrders, [{ revision: 1, order: 101 }])
  assert.equal(trimToken.assetCount, 0)
  await waitForCleanupIdle()
  assert.equal((await sceneGet(s2)).status, 404)
  assert.equal(fs.existsSync(sceneDir(s2)), false)
  assert.equal(fs.existsSync(path.join(assetSessionDir(s2), disk.helpers.assetIdHash(lateAsset.id))), false)
  assert.equal(fs.existsSync(assetSessionDir(s2)), false)
  assert.equal((await sceneJson(s1)).revision, 13)
  assert.equal(revisionNames(sceneDir(s1)).length, 12)
  assert.equal(markerNames(sceneDir(s1)).length, 12)
  assert.equal((await listAssets(s1)).body.assets.length, 1)
  assert.equal(disk.stats().bytes.staging, 0)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(s1)).revision, 13)
  assert.equal((await sceneGet(s2)).status, 404)
  assert.equal((await listAssets(s1)).body.assets.length, 1)
})

// ===========================================================================
// MAJOR-3: complete errno x durable-site matrix and runtime degrade/recovery.
// ===========================================================================
const D11_CODES = ['EROFS', 'EACCES', 'ENOSPC', 'EDQUOT']

test('D11 full errno matrix at scene write, fileFsync, dirFsync, rename and commitMarker sites', async () => {
  const sites = [
    { key: 'write', op: 'write', at: 'scene-revision', marker: false },
    { key: 'file-fsync', op: 'fileFsync', at: 'afterCandidateFsync', marker: false },
    { key: 'dir-fsync', op: 'dirFsync', at: 'afterRevisionDirFsync', marker: false },
    { key: 'rename', op: 'rename', at: 'afterRename', marker: false },
    { key: 'commit-marker', op: 'commitMarker', at: 'beforeCommitMarker', marker: true },
  ]
  for (const site of sites) {
    for (const code of D11_CODES) {
      const name = `${site.key}-${code}`
      await freshStore()
      const session = `sess-fix4-d11-scene-${site.key}-${code.toLowerCase()}`
      await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'D11F' })
      await disk.restartForTests()
      const before = treeSnapshot(sceneDir(session))
      assert.equal(revisionNames(sceneDir(session)).length, 1, name)
      assert.equal(markerNames(sceneDir(session)).length, 1, name)
      assert.equal(disk.faults.set({ op: site.op, at: site.at, count: 1, code }), true, name)
      if (site.marker) {
        await assert.rejects(appendScene(session, `const fix4D11${code} = true`),
          error => error?.code === 'storage-unavailable', name)
        assert.equal(disk.faultHitsForTests()[`${site.op}@${site.at}`], 1, name)
        assert.equal(counters().sceneWriteDegraded, true, name)
        assert.equal(revisionNames(sceneDir(session)).length, 2, name)
        assert.equal(markerNames(sceneDir(session)).length, 1, name)
        assert.equal((await sceneJson(session)).revision, 1, name)
        assert.equal(disk.inspect().fixtures.D11F.revisionOrderCount, 1, name)
        disk.faults.clear()
        const restarted = await disk.restartForTests()
        assert.equal(restarted.mode, 'disk', name)
        assert.equal(counters().sceneWriteDegraded, false, name)
        assert.equal((await sceneJson(session)).revision, 1, name)
        assert.equal(revisionNames(sceneDir(session)).length, 2, name)
        assert.equal(markerNames(sceneDir(session)).length, 1, name)
        const retried = await appendScene(session, `const fix4D11${code}Retry = 2`)
        assert.equal(retried.revision, 2, name)
        assert.equal(markerNames(sceneDir(session)).length, 2, name)
        const stable = await disk.restartForTests()
        assert.equal(stable.mode, 'disk', name)
        assert.equal((await sceneJson(session)).revision, 2, name)
        assert.equal(disk.inspect().fixtures.D11F.revisionOrderCount, 2, name)
      } else {
        await assert.rejects(appendScene(session, `const fix4D11${code} = true`),
          error => error?.code === code, name)
        assert.equal(disk.faultHitsForTests()[`${site.op}@${site.at}`], 1, name)
        assert.equal(counters().sceneWriteDegraded, false, name)
        assert.equal(counters().sceneWritePreserve, false, name)
        assert.deepEqual(treeSnapshot(sceneDir(session)), before, name)
        assert.equal(revisionNames(sceneDir(session)).length, 1, name)
        assert.equal(markerNames(sceneDir(session)).length, 1, name)
        assert.equal((await sceneJson(session)).revision, 1, name)
        assert.equal(disk.inspect().fixtures.D11F.revisionOrderCount, 1, name)
        disk.faults.clear()
        const retried = await appendScene(session, `const fix4D11${code}Retry = 2`)
        assert.equal(retried.revision, 2, name)
        const restarted = await disk.restartForTests()
        assert.equal(restarted.mode, 'disk', name)
        assert.equal((await sceneJson(session)).revision, 2, name)
        assert.equal(revisionNames(sceneDir(session)).length, 2, name)
        assert.equal(markerNames(sceneDir(session)).length, 2, name)
        assert.equal(disk.inspect().fixtures.D11F.revisionOrderCount, 2, name)
      }
    }
  }
})

test('D11 full errno matrix at mkdirDurable, indexRename, deleteRename and lock link sites', async () => {
  // mkdirDurable: a failed asset-session mkdir publishes nothing and never
  // touches the pre-existing scene or existing assets.
  for (const code of D11_CODES) {
    const name = `mkdir-${code}`
    await freshStore()
    const session = `sess-fix4-d11-mkdir-${code.toLowerCase()}`
    await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'D11G' })
    await disk.restartForTests()
    const before = treeSnapshot(sceneDir(session))
    assert.equal(fs.existsSync(assetSessionDir(session)), false, name)
    assert.equal(disk.faults.set({ op: 'mkdirDurable', at: 'beforeMkdir', count: 1, code }), true, name)
    const failed = await uploadAsset(session, `${name}.png`)
    assert.equal(failed.status, 503, name)
    assert.deepEqual(jsonBody(failed), {
      ok: false, error: { code: 'storage', message: 'could not store asset' },
    }, name)
    assert.equal(disk.faultHitsForTests()['mkdirDurable@beforeMkdir'], 1, name)
    assert.equal((await listAssets(session)).body.assets.length, 0, name)
    assert.equal(fs.existsSync(assetSessionDir(session)), false, name)
    assert.deepEqual(treeSnapshot(sceneDir(session)), before, name)
    disk.faults.clear()
    const restarted = await disk.restartForTests()
    assert.equal(restarted.mode, 'disk', name)
    assert.equal((await sceneJson(session)).revision, 1, name)
    assert.equal((await listAssets(session)).body.assets.length, 0, name)
    const retried = await uploadAsset(session, `${name}-retry.png`)
    assert.equal(retried.status, 201, name)
    assert.equal((await listAssets(session)).body.assets.length, 1, name)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', name)
    assert.equal((await sceneJson(session)).revision, 1, name)
    assert.equal((await listAssets(session)).body.assets.length, 1, name)
  }

  // indexRename: the thumbnail publishes only after its index rename, so every
  // errno leaves the thumbnail unserved and the retry publishes exactly once.
  for (const code of D11_CODES) {
    const name = `index-rename-${code}`
    await freshStore()
    const session = `sess-fix4-d11-index-${code.toLowerCase()}`
    await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'D11I' })
    await disk.restartForTests()
    const payload = {
      sessionId: session, revision: 1, dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
    }
    assert.equal(disk.faults.set({ op: 'indexRename', at: 'afterIndexRename', count: 1, code }), true, name)
    const failed = await uploadThumbnail(payload)
    assert.equal(failed.status, 503, name)
    assert.equal(Buffer.from(failed.body).toString('utf8'), 'thumbnail storage failed', name)
    assert.equal(disk.faultHitsForTests()['indexRename@afterIndexRename'], 1, name)
    assert.equal((await thumbnailGet(session, 1)).status, 404, name)
    disk.faults.clear()
    const restarted = await disk.restartForTests()
    assert.equal(restarted.mode, 'disk', name)
    assert.equal((await thumbnailGet(session, 1)).status, 404, name)
    assert.equal((await sceneJson(session)).revision, 1, name)
    const retried = await uploadThumbnail(payload)
    assert.equal(retried.status, 200, name)
    const served = await thumbnailGet(session, 1)
    assert.equal(served.status, 200, name)
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG, name)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', name)
    const after = await thumbnailGet(session, 1)
    assert.equal(after.status, 200, name)
    assert.deepEqual(Buffer.from(await after.arrayBuffer()), PNG, name)
  }

  // deleteRename: no acknowledgement, the in-memory row stays until restart,
  // and the durable pre-rename state is exactly one live asset.
  for (const code of D11_CODES) {
    const name = `delete-rename-${code}`
    await freshStore()
    const session = `sess-fix4-d11-delete-${code.toLowerCase()}`
    await seedAcknowledged(session, { revisions: 1, assets: 1, label: 'D11J' })
    await disk.restartForTests()
    const assetId = (await listAssets(session)).body.assets[0].id
    const beforeTree = treeSnapshot(assetSessionDir(session))
    assert.equal(disk.faults.set({ op: 'deleteRename', at: 'beforeDeleteRename', count: 1, code }), true, name)
    const failed = await invoke(assetInternal.deleteHandler, {
      headers: { 'x-workbench-session': session, 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ id: assetId })),
    })
    assert.equal(failed.status, 503, name)
    assert.deepEqual(jsonBody(failed), {
      ok: false, error: { code: 'storage', message: 'could not delete asset' },
    }, name)
    assert.equal(disk.faultHitsForTests()['deleteRename@beforeDeleteRename'], 1, name)
    assert.notEqual(assetInternal.rawAsset(assetId), undefined, name)
    assert.equal((await listAssets(session)).body.assets.length, 1, name)
    assert.deepEqual(treeSnapshot(assetSessionDir(session)), beforeTree, name)
    disk.faults.clear()
    const restarted = await disk.restartForTests()
    assert.equal(restarted.mode, 'disk', name)
    assert.equal((await listAssets(session)).body.assets.length, 1, name)
    assert.equal((await sceneJson(session)).revision, 1, name)
    const retried = await invoke(assetInternal.deleteHandler, {
      headers: { 'x-workbench-session': session, 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ id: assetId })),
    })
    assert.equal(retried.status, 200, name)
    assert.equal((await listAssets(session)).body.assets.length, 0, name)
    const stable = await disk.restartForTests()
    assert.equal(stable.mode, 'disk', name)
    assert.equal((await listAssets(session)).body.assets.length, 0, name)
    assert.equal((await sceneJson(session)).revision, 1, name)
  }

  // link: a fault after the final LOCK link leaves a candidate LOCK with no
  // owner. Both the local restart and a second start fail closed; pre-existing
  // scene bytes stay untouched until an operator resolves the lock.
  for (const code of D11_CODES) {
    const name = `lock-link-${code}`
    await freshStore()
    const session = `sess-fix4-d11-link-${code.toLowerCase()}`
    await seedAcknowledged(session, { revisions: 1, assets: 1, label: 'D11L' })
    await disk.restartForTests()
    const sceneBefore = treeSnapshot(sceneDir(session))
    const assetBefore = treeSnapshot(assetSessionDir(session))
    assert.equal(disk.faults.set({ op: 'link', at: 'afterLink', count: 1, code }), true, name)
    const failed = await disk.restartForTests()
    assert.notEqual(failed.mode, 'disk', name)
    assert.equal(disk.inspect().status, code, name)
    assert.equal(disk.faultHitsForTests()['link@afterLink'], 1, name)
    assert.equal(fs.existsSync(path.join(root, 'LOCK')), true, name)
    disk.faults.clear()
    const stillLocked = await disk.restartForTests()
    assert.notEqual(stillLocked.mode, 'disk', name)
    assert.equal(disk.inspect().status, 'disk-locked', name)
    assert.equal(fs.existsSync(path.join(root, 'LOCK')), true, name)
    assert.equal(fs.existsSync(path.join(root, 'LOCK.recover')), false, name)
    assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore, name)
    assert.deepEqual(treeSnapshot(assetSessionDir(session)), assetBefore, name)
  }
})

test('D1 runtime root budget exhaustion and a read-only scene directory preserve pre-existing data and recover', async () => {
  // Runtime disk-full: the budget rejects before any scene write, the existing
  // scene and asset remain readable, and a raised budget accepts the append.
  await freshStore()
  const budgetSession = 'sess-fix4-runtime-budget'
  await seedAcknowledged(budgetSession, { revisions: 1, assets: 1, label: 'RTB' })
  await disk.restartForTests()
  const budgetSceneBefore = treeSnapshot(sceneDir(budgetSession))
  const budgetAssetBefore = treeSnapshot(assetSessionDir(budgetSession))
  const used = disk.stats().bytes.used
  assert.equal(disk.stats().bytes.staging, 0)
  disk.configureForTests({ maxRootBytes: used + 8 })
  await assert.rejects(appendScene(budgetSession, 'const fix4RuntimeFull = true'),
    error => error?.code === 'storage-full')
  assert.equal((await sceneJson(budgetSession)).revision, 1)
  assert.equal((await listAssets(budgetSession)).body.assets.length, 1)
  assert.deepEqual(treeSnapshot(sceneDir(budgetSession)), budgetSceneBefore)
  assert.deepEqual(treeSnapshot(assetSessionDir(budgetSession)), budgetAssetBefore)
  await assert.rejects(appendScene(budgetSession, 'const fix4RuntimeFullAgain = true'),
    error => error?.code === 'storage-full')
  assert.equal(disk.stats().bytes.staging, 0)
  disk.configureForTests({ maxRootBytes: 2 * 1024 * 1024 * 1024 })
  const accepted = await appendScene(budgetSession, 'const fix4RuntimeFullRecovered = true')
  assert.equal(accepted.revision, 2)
  const budgetRestarted = await disk.restartForTests()
  assert.equal(budgetRestarted.mode, 'disk')
  assert.equal((await sceneJson(budgetSession)).revision, 2)
  assert.match((await sceneJson(budgetSession)).code, /fix4RuntimeFullRecovered/)
  assert.equal((await listAssets(budgetSession)).body.assets.length, 1)

  // Runtime read-only staging directory: an actual filesystem EACCES is not a
  // logical marker failure. Every durable scene write stages in root/tmp, so a
  // read-only tmp fails the append while the acknowledged head and its bytes
  // stay intact; restoring write permission allows the retry.
  const roSession = 'sess-fix4-runtime-readonly'
  await seedAcknowledged(roSession, { revisions: 1, assets: 1, label: 'RTO' })
  await disk.restartForTests()
  const roSceneBefore = treeSnapshot(sceneDir(roSession))
  const roAssetBefore = treeSnapshot(assetSessionDir(roSession))
  const stagingDir = path.join(root, 'tmp')
  fs.chmodSync(stagingDir, 0o500)
  try {
    assert.throws(() => fs.writeFileSync(path.join(stagingDir, 'probe-readonly.tmp'), 'x'),
      error => error?.code === 'EACCES')
    await assert.rejects(appendScene(roSession, 'const fix4RuntimeReadOnly = true'))
    assert.equal((await sceneJson(roSession)).revision, 1)
    assert.equal((await listAssets(roSession)).body.assets.length, 1)
    assert.deepEqual(treeSnapshot(sceneDir(roSession)), roSceneBefore)
    assert.deepEqual(treeSnapshot(assetSessionDir(roSession)), roAssetBefore)
    assert.equal(revisionNames(sceneDir(roSession)).length, 1)
    assert.equal(markerNames(sceneDir(roSession)).length, 1)
  } finally {
    fs.chmodSync(stagingDir, 0o700)
  }
  const roRetry = await appendScene(roSession, 'const fix4RuntimeReadOnlyRecovered = true')
  assert.equal(roRetry.revision, 2)
  assert.equal((await sceneJson(roSession)).revision, 2)
  assert.equal((await listAssets(roSession)).body.assets.length, 1)
  const roRestarted = await disk.restartForTests()
  assert.equal(roRestarted.mode, 'disk')
  assert.equal((await sceneJson(roSession)).revision, 2)
  assert.equal((await listAssets(roSession)).body.assets.length, 1)
})

test('D1 cleanup enqueue finds the victim asset queue full, drops only deferred work, and restart reconciles the bytes', async () => {
  await freshStore()
  const sessions = []
  for (let index = 1; index <= 16; index += 1) {
    const session = `sess-fix4-cleanup-full-${String(index).padStart(2, '0')}`
    sessions.push(session)
    await seedAcknowledged(session, {
      revisions: 1, assets: index === 1 ? 1 : 0, baseOrder: 100 + index,
      label: `CF${String(index).padStart(2, '0')}`,
    })
  }
  await disk.restartForTests()
  host.__historyInternal.seedSession('sess-fix4-cleanup-full-model', [{
    sceneId: 'sess-fix4-cleanup-full-model', revision: 1, title: 'model', code: '0', bytes: 1, updatedAt: 1,
  }])
  const victim = sessions[0]
  const victimSidHash = disk.helpers.sceneSidHash(victim)
  const active = await disk.holdQueueForTests('asset', victimSidHash)
  const waiters = []
  for (let index = 0; index < 8; index += 1) {
    waiters.push(disk.holdQueueForTests('asset', victimSidHash))
  }
  const victimSceneBefore = treeSnapshot(sceneDir(victim))
  const victimAssetBefore = treeSnapshot(assetSessionDir(victim))
  const cleanupPause = disk.pauseAtForTests('beforeCleanupQueue')
  const trigger = await appendScene(sessions[15], 'const fix4CleanupQueueFull = true')
  assert.equal(trigger.revision, 2)
  await waitForPause(cleanupPause, 'cleanup queue full pause')
  assert.equal((await sceneGet(victim)).status, 404)
  cleanupPause.release()
  // The pump shifts the token, then its asset-queue acquire fails with busy.
  // The held test queue is intentionally non-idle, so allow the rejection to
  // settle without using cleanupIdleForTests (which waits for that queue).
  await delay(250)
  assert.equal(fs.existsSync(sceneDir(victim)), true)
  assert.deepEqual(treeSnapshot(sceneDir(victim)), victimSceneBefore)
  assert.deepEqual(treeSnapshot(assetSessionDir(victim)), victimAssetBefore)
  assert.equal((await sceneGet(victim)).status, 404)
  assert.equal((await sceneJson(sessions[15])).revision, 2)
  // Drain the exact held queue without releasing any other test task.
  active()
  for (const waiter of waiters) {
    const release = await waiter
    release()
  }
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(victim)).revision, 1)
  assert.equal((await listAssets(victim)).body.assets.length, 1)
  assert.equal((await sceneJson(sessions[15])).revision, 2)
  assert.equal(counters().unacknowledgedSceneSessions, 0)
  assert.equal(counters().startupTruncatedScenes, 0)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(victim)).revision, 1)
  assert.equal((await listAssets(victim)).body.assets.length, 1)
})

test('D1 stop timeout defers the lock, a child cannot become a second writer, and a late durable write settles before restart', async () => {
  await freshStore()
  const session = 'sess-fix4-stop-timeout'
  await seedAcknowledged(session, {
    revisions: 1, assets: 1, baseOrder: 200, label: 'STP',
  })
  await disk.restartForTests()
  const epoch = disk.inspect().fixtures.STP.epoch
  assert.equal(HEX32_RE.test(epoch), true)
  const sidHash = disk.helpers.sceneSidHash(session)
  const lateOrder = 500
  const lateRecord = makeRevisionRecord(session, epoch, 2, lateOrder,
    'const fix4LateStopWrite = true', 'late stop write')
  const lateMarker = makeMarkerRecord(sidHash, lateOrder, 2, lateRecord.sha256)
  let openGate
  const gate = new Promise(resolve => { openGate = resolve })
  let settled = false
  const task = disk.withDiskTaskForTests(async () => {
    await gate
    const dir = sceneDir(session)
    fs.writeFileSync(path.join(dir, disk.generatedNames.sceneRevision(lateOrder)),
      lateRecord.bytes, { mode: 0o600 })
    const fd = fs.openSync(path.join(dir, disk.generatedNames.sceneRevision(lateOrder)), 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.writeFileSync(path.join(dir, disk.generatedNames.sceneMarker(lateOrder)),
      lateMarker.bytes, { mode: 0o600 })
    const markerFd = fs.openSync(path.join(dir, disk.generatedNames.sceneMarker(lateOrder)), 'r')
    try { fs.fsyncSync(markerFd) } finally { fs.closeSync(markerFd) }
    const dirFd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY)
    try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
    settled = true
  })
  const stopPromise = disk.closeForTests()
  const stopStartedAt = Date.now()
  await stopPromise // resolves after the bounded 5s timeout with the lock deferred
  assert.equal(Date.now() - stopStartedAt >= 4500, true)
  assert.equal(disk.lockHeldForTests(), true)
  assert.equal(settled, false)
  assert.equal(fs.existsSync(path.join(root, 'LOCK')), true)
  const child = runChildScript([
    'const started = await disk.restartForTests()',
    `let appendCode = null`,
    `try { await appendScene(${JSON.stringify(session)}, 'const childSecondWriter = true') } catch (error) { appendCode = error?.code ?? 'other' }`,
    `fs.writeSync(1, "CHILD_LOCK:" + JSON.stringify({ mode: started.mode, status: started.status, appendCode }) + "\\n")`,
  ], { expectCompletion: true, timeoutMs: 30000 })
  const childLine = child.stdout.split('\n').find(line => line.startsWith('CHILD_LOCK:'))
  assert.equal(typeof childLine, 'string')
  const childResult = JSON.parse(childLine.slice('CHILD_LOCK:'.length))
  assert.notEqual(childResult.mode, 'disk')
  assert.equal(childResult.appendCode, 'storage-unavailable')
  assert.equal(revisionNames(sceneDir(session)).length, 1)
  openGate()
  await task
  assert.equal(settled, true)
  await waitForCondition(() => disk.lockHeldForTests() === false, 'deferred lock release')
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const scene = await sceneJson(session)
  assert.equal(scene.revision, 2)
  assert.match(scene.code, /fix4LateStopWrite/)
  assert.equal((await listAssets(session)).body.assets.length, 1)
  assert.equal(revisionNames(sceneDir(session)).length, 2)
  assert.equal(markerNames(sceneDir(session)).length, 2)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 2)
  assert.equal((await listAssets(session)).body.assets.length, 1)
})

// ===========================================================================
// MAJOR-4: bounded startup scans. The virtual dirent source feeds the exact
// production scan loops; only the readdir source is test-only.
// ===========================================================================
async function freshBoundedStore() {
  try { disk.clearVirtualDirentsForTests() } catch (error) { void error }
  await freshStore()
  disk.clearVirtualDirentsForTests()
  // The global-cap rows count every root entry startupCleanup sees before the
  // scene scan. Remove unrelated root-level leftovers from prior tests while
  // preserving the live lock and the root marker/layout.
  for (const name of fs.readdirSync(root)) {
    if (name === 'TEST-ROOT' || name === 'LOCK' || name === 'ROOT.json'
      || name === 'VERSION' || LAYOUT_NAMES.includes(name)) continue
    fs.rmSync(path.join(root, name), { recursive: true, force: true })
  }
  return disk
}

test('D12 millions of scene-root dirents stop at the exact global scan cap without deleting acknowledged data', async () => {
  await freshBoundedStore()
  const session = 'sess-fix4-bound-global'
  await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'BND0' })
  await disk.restartForTests()
  const before = treeSnapshot(sceneDir(session))
  // A clean restart may have written an empty thumbnail index. Remove it so
  // this scene-root test isolates the exact point where the global scan cap
  // stops loadScenesPhase instead of also consuming the cap in the next phase.
  try { fs.unlinkSync(path.join(root, 'thumbnails', 'index.json')) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  assert.equal(disk.setVirtualDirentsForTests([{
    dir: path.join(root, 'scenes'),
    specs: [{ repeat: 2_000_000, start: 1, prefix: 'v', kind: 'file' }],
  }]), true)
  const truncated = await disk.restartForTests()
  assert.equal(truncated.mode, 'disk')
  const scan = disk.scanForTests()
  // noteScanEntry() increments before applying the limit, so the first entry
  // past MAX_SCAN_ENTRIES (65,536) is counted and stops the scan.
  assert.equal(scan.scanEntries, 65537)
  assert.equal(scan.counters.sceneRootEntries, 65526)
  assert.equal(scan.counters.sceneDirs, 1)
  assert.equal(scan.counters.sceneSessionEntries, 0)
  assert.equal(scan.counters.sceneRevisionReads, 0)
  assert.equal(scan.counters.sceneMarkerReads, 0)
  assert.equal(scan.counters.assetRootEntries, 0)
  assert.equal(scan.counters.shareRootEntries, 0)
  assert.equal(counters().startupTruncatedScenes, 1)
  assert.equal(counters().startupEvictedScenes, 0)
  assert.equal((await sceneGet(session)).status, 404)
  assert.deepEqual(treeSnapshot(sceneDir(session)), before)
  assert.equal(revisionNames(sceneDir(session)).length, 1)
  assert.equal(markerNames(sceneDir(session)).length, 1)
  assert.equal(quarantineSceneEntries().length, 0)
  disk.clearVirtualDirentsForTests()
  const recovered = await disk.restartForTests()
  assert.equal(recovered.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(revisionNames(sceneDir(session)).length, 1)
  assert.equal(markerNames(sceneDir(session)).length, 1)
  assert.equal(counters().startupTruncatedScenes, 0)
})

test('D12 combined revision and marker entries above 256 truncate the session before any read or deletion', async () => {
  await freshBoundedStore()
  const session = 'sess-fix4-bound-entry-cap'
  await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'BND1' })
  await disk.restartForTests()
  const before = treeSnapshot(sceneDir(session))
  assert.equal(disk.setVirtualDirentsForTests([{
    dir: sceneDir(session),
    specs: [
      { repeat: 300, start: 9000, pad: 16, suffix: '.json', kind: 'file' },
      { repeat: 300, start: 9000, pad: 16, suffix: '.commit.json', kind: 'file' },
    ],
  }]), true)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const scan = disk.scanForTests()
  assert.equal(scan.counters.sceneDirs, 1)
  assert.equal(scan.counters.sceneSessionEntries, 602)
  assert.equal(scan.counters.sceneCandidateOrders, 0)
  assert.equal(scan.counters.sceneRevisionReads, 0)
  assert.equal(scan.counters.sceneMarkerReads, 0)
  assert.equal(counters().startupTruncatedScenes, 1)
  assert.equal(counters().startupEvictedScenes, 0)
  assert.equal((await sceneGet(session)).status, 404)
  assert.deepEqual(treeSnapshot(sceneDir(session)), before)
  assert.equal(revisionNames(sceneDir(session)).length, 1)
  assert.equal(markerNames(sceneDir(session)).length, 1)
  assert.equal(quarantineSceneEntries().length, 0)
  disk.clearVirtualDirentsForTests()
  const recovered = await disk.restartForTests()
  assert.equal(recovered.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
})

test('D12 the 32-candidate read cap accepts exactly 32 pairs and truncates 33 without reads or deletion', async () => {
  await freshBoundedStore()
  const atCap = 'sess-fix4-bound-candidates-32'
  await seedAcknowledged(atCap, { revisions: 32, assets: 0, baseOrder: 700, label: 'BND2' })
  const accepted = await disk.restartForTests()
  assert.equal(accepted.mode, 'disk')
  let scan = disk.scanForTests()
  assert.equal(scan.counters.sceneRevisionReads, 32)
  assert.equal(scan.counters.sceneMarkerReads, 32)
  assert.equal(scan.counters.sceneCandidateOrders, 32)
  assert.equal(counters().startupTruncatedScenes, 0)
  assert.equal((await sceneJson(atCap)).revision, 32)
  assert.equal(revisionNames(sceneDir(atCap)).length, 32)
  assert.equal(markerNames(sceneDir(atCap)).length, 32)

  await freshBoundedStore()
  const overCap = 'sess-fix4-bound-candidates-33'
  await seedAcknowledged(overCap, { revisions: 33, assets: 0, baseOrder: 900, label: 'BND3' })
  const before = treeSnapshot(sceneDir(overCap))
  const refused = await disk.restartForTests()
  assert.equal(refused.mode, 'disk')
  scan = disk.scanForTests()
  assert.equal(scan.counters.sceneRevisionReads, 32)
  assert.equal(scan.counters.sceneMarkerReads, 32)
  assert.equal(scan.counters.sceneCandidateOrders, 33)
  assert.equal(counters().startupTruncatedScenes, 1)
  assert.equal((await sceneGet(overCap)).status, 404)
  assert.deepEqual(treeSnapshot(sceneDir(overCap)), before)
  assert.equal(revisionNames(sceneDir(overCap)).length, 33)
  assert.equal(markerNames(sceneDir(overCap)).length, 33)
  assert.equal(quarantineSceneEntries().length, 0)
  const recovered = await disk.restartForTests()
  assert.equal(recovered.mode, 'disk')
  assert.equal((await sceneGet(overCap)).status, 404)
  scan = disk.scanForTests()
  assert.equal(scan.counters.sceneCandidateOrders, 33)
  assert.equal(scan.counters.sceneRevisionReads, 32)
  assert.equal(scan.counters.sceneMarkerReads, 32)
  assert.equal(counters().startupTruncatedScenes, 1)
  assert.equal(revisionNames(sceneDir(overCap)).length, 33)
})

test('D12 the scene read-byte bound stops before an unread order, preserves bytes, and a larger bound recovers', async () => {
  await freshBoundedStore()
  const session = 'sess-fix4-bound-read-bytes'
  await seedAcknowledged(session, { revisions: 2, assets: 0, baseOrder: 1200, label: 'BND4' })
  const before = treeSnapshot(sceneDir(session))
  disk.configureForTests({ maxSceneReadBytes: 8 })
  const truncated = await disk.restartForTests()
  assert.equal(truncated.mode, 'disk')
  const scan = disk.scanForTests()
  assert.equal(scan.maxSceneReadBytes, 8)
  assert.equal(scan.sceneReadBytes > 8, true)
  assert.equal(scan.counters.sceneRevisionReads, 1)
  assert.equal(scan.counters.sceneMarkerReads, 0)
  assert.equal(counters().startupTruncatedScenes, 2)
  assert.equal(counters().startupEvictedScenes, 0)
  assert.equal((await sceneGet(session)).status, 404)
  assert.deepEqual(treeSnapshot(sceneDir(session)), before)
  assert.equal(revisionNames(sceneDir(session)).length, 2)
  assert.equal(markerNames(sceneDir(session)).length, 2)
  assert.equal(quarantineSceneEntries().length, 0)
  disk.configureForTests({ maxSceneReadBytes: 512 * 1024 * 1024 })
  const recovered = await disk.restartForTests()
  assert.equal(recovered.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 2)
  const recoveredScan = disk.scanForTests()
  assert.equal(recoveredScan.counters.sceneRevisionReads, 2)
  assert.equal(recoveredScan.counters.sceneMarkerReads, 2)
  assert.equal(counters().startupTruncatedScenes, 0)
})

test('D12 the default 512 MiB scene read bound stops at exact bytes and every unread record is preserved', async () => {
  await freshBoundedStore()
  const cap = 512 * 1024 * 1024
  const recordTarget = 2 * 1024 * 1024
  const spaces = Buffer.alloc(recordTarget, 0x20)
  const epoch = 'a'.repeat(32)
  const sessions = []
  await stopStore()
  // Nine sessions x 32 candidates of exactly 2 MiB each exceed the default
  // 512 MiB read bound. The JSON tail is whitespace so each file is a valid
  // revision record at the named per-file ceiling. Markers carry a detached
  // revision number, so the reads count but no session is acknowledged,
  // imported into scene history, or product-evicted.
  for (let index = 0; index < 9; index += 1) {
    const session = `sess-fix4-bound-read-512-${String(index).padStart(2, '0')}`
    sessions.push(session)
    const dir = sceneDir(session)
    const sidHash = disk.helpers.sceneSidHash(session)
    fs.mkdirSync(dir, { mode: 0o700 })
    for (let revision = 1; revision <= 32; revision += 1) {
      const order = revision
      const built = makeRevisionRecord(session, epoch, revision, order, 'const readBound = 1')
      const padding = spaces.subarray(0, recordTarget - built.bytes.length)
      fs.writeFileSync(path.join(dir, `${String(order).padStart(16, '0')}.json`),
        Buffer.concat([built.bytes, padding]), { mode: 0o600 })
      const marker = makeMarkerRecord(sidHash, order, 999, built.sha256)
      fs.writeFileSync(path.join(dir, `${String(order).padStart(16, '0')}.commit.json`),
        marker.bytes, { mode: 0o600 })
    }
  }
  const firstDir = sceneDir(sessions[0])
  const revisionBytesByOrder = new Map(revisionNames(firstDir).map(name => [
    Number(name.slice(0, 16)), fs.statSync(path.join(firstDir, name)).size,
  ]))
  const markerBytesByOrder = new Map(markerNames(firstDir).map(name => [
    Number(name.slice(0, 16)), fs.statSync(path.join(firstDir, name)).size,
  ]))
  const orderDesc = [...revisionBytesByOrder.keys()].sort((a, b) => b - a)
  let expectedBytes = 0
  let expectedRevisionReads = 0
  let expectedMarkerReads = 0
  let completeSessions = 0
  let crossed = false
  for (let index = 0; index < sessions.length && !crossed; index += 1) {
    for (const order of orderDesc) {
      expectedBytes += revisionBytesByOrder.get(order)
      expectedRevisionReads += 1
      if (expectedBytes > cap) { crossed = true; break }
    }
    if (crossed) break
    for (const order of orderDesc) {
      expectedBytes += markerBytesByOrder.get(order)
      expectedMarkerReads += 1
      if (expectedBytes > cap) { crossed = true; break }
    }
    if (crossed) break
    completeSessions += 1
  }
  assert.equal(crossed, true)
  const scannedSessions = completeSessions + 1
  const metadata = () => sessions.map(session => {
    const dir = sceneDir(session)
    return {
      revisions: revisionNames(dir).map(name => [name, fs.statSync(path.join(dir, name)).size]),
      markers: markerNames(dir).map(name => [name, fs.statSync(path.join(dir, name)).size]),
    }
  })
  const sampleDigest = session => {
    const dir = sceneDir(session)
    const hash = createHash('sha256')
    hash.update(fs.readFileSync(path.join(dir, revisionNames(dir)[0])))
    hash.update(fs.readFileSync(path.join(dir, markerNames(dir)[0])))
    return hash.digest('hex')
  }
  const beforeMetadata = metadata()
  const beforeSample = sampleDigest(sessions[0])
  const truncated = await disk.restartForTests()
  assert.equal(truncated.mode, 'disk')
  const scan = disk.scanForTests()
  assert.equal(scan.maxSceneReadBytes, cap)
  assert.equal(scan.sceneReadBytes, expectedBytes)
  assert.equal(scan.sceneReadBytes > cap, true)
  assert.equal(scan.sceneReadBytes - cap <= 2 * 1024 * 1024, true)
  assert.equal(scan.counters.sceneDirs, sessions.length)
  assert.equal(scan.counters.sceneSessionEntries, scannedSessions * 64)
  assert.equal(scan.counters.sceneCandidateOrders, scannedSessions * 32)
  assert.equal(scan.counters.sceneRevisionReads, expectedRevisionReads)
  assert.equal(scan.counters.sceneMarkerReads, expectedMarkerReads)
  assert.equal(counters().startupTruncatedScenes, 2)
  assert.equal(counters().startupEvictedScenes, 0)
  assert.equal(counters().unacknowledgedSceneSessions, completeSessions)
  assert.equal(quarantineSceneEntries().length, 0)
  assert.equal((await sceneGet(sessions[0])).status, 404)
  await assert.rejects(appendScene('sess-fix4-bound-read-512-new', 'const blockedByReadBound = 1'))
  assert.deepEqual(metadata(), beforeMetadata)
  assert.equal(sampleDigest(sessions[0]), beforeSample)
  // Reduce the store below the default bound, reattach one session's markers,
  // and prove the previously unread acknowledged records return intact.
  await stopStore()
  for (const session of sessions.slice(4)) {
    fs.rmSync(sceneDir(session), { recursive: true, force: true })
  }
  const recoveredDir = sceneDir(sessions[0])
  const recoveredSidHash = disk.helpers.sceneSidHash(sessions[0])
  for (const name of revisionNames(recoveredDir)) {
    const record = readJsonFile(path.join(recoveredDir, name))
    const marker = makeMarkerRecord(recoveredSidHash, record.order, record.revision, record.recordSha256)
    fs.writeFileSync(path.join(recoveredDir, `${name.slice(0, 16)}.commit.json`), marker.bytes)
  }
  const recovered = await disk.restartForTests()
  assert.equal(recovered.mode, 'disk')
  const recoveredScan = disk.scanForTests()
  assert.equal(recoveredScan.sceneReadBytes < cap, true)
  assert.equal(recoveredScan.counters.sceneDirs, 4)
  assert.equal(recoveredScan.counters.sceneSessionEntries, 4 * 64)
  assert.equal(counters().startupTruncatedScenes, 0)
  assert.equal(counters().startupEvictedScenes, 0)
  assert.equal(quarantineSceneEntries().length, 0)
  assert.equal((await sceneJson(sessions[0])).revision, 32)
  assert.equal(revisionNames(recoveredDir).length, 32)
  assert.equal(markerNames(recoveredDir).length, 32)
  assert.equal((await sceneGet(sessions[1])).status, 404)
})

test('D12 the load budget quarantines an over-budget asset without deleting bytes and a raised budget recovers', async () => {
  await freshBoundedStore()
  const session = 'sess-fix4-bound-load-budget'
  await seedAcknowledged(session, { revisions: 1, assets: 1, label: 'BND5' })
  await disk.restartForTests()
  const sceneBefore = treeSnapshot(sceneDir(session))
  const assetHashes = fs.readdirSync(assetSessionDir(session))
    .filter(name => HEX64_RE.test(name) && fs.existsSync(path.join(assetSessionDir(session), name, 'body.bin')))
  assert.equal(assetHashes.length, 1)
  const assetHash = assetHashes[0]
  const assetBefore = treeSnapshot(path.join(assetSessionDir(session), assetHash))
  disk.configureForTests({ maxLoadBytes: 1 })
  const started = await disk.restartForTests()
  assert.equal(started.mode, 'disk')
  assert.equal(disk.ready(), true)
  // noteLoadBytes() is caught per asset: the asset is quarantined, the scene
  // stays served, and startup itself remains writable.
  assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore)
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal((await listAssets(session)).body.assets.length, 0)
  assert.equal(revisionNames(sceneDir(session)).length, 1)
  assert.equal(markerNames(sceneDir(session)).length, 1)
  assert.equal(quarantineSceneEntries().length, 0)
  const remainingHashes = fs.readdirSync(assetSessionDir(session))
    .filter(name => HEX64_RE.test(name) && fs.existsSync(path.join(assetSessionDir(session), name, 'body.bin')))
  assert.deepEqual(remainingHashes, [])
  assert.equal(counters().quarantined, 1)
  assert.equal(counters().quarantineFailures, 0)
  const quarantineSlots = fs.readdirSync(path.join(root, 'quarantine'))
    .filter(name => fs.existsSync(path.join(root, 'quarantine', name, 'artifact')))
  assert.equal(quarantineSlots.length, 1)
  const artifact = path.join(root, 'quarantine', quarantineSlots[0], 'artifact')
  assert.deepEqual(treeSnapshot(artifact), assetBefore)
  assert.equal(treeSnapshot(assetSessionDir(session))['owner.json'].type, 'file')
  disk.configureForTests({ maxLoadBytes: 1536 * 1024 * 1024 })
  const recovered = await disk.restartForTests()
  assert.equal(recovered.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  // The quarantined copy is preserved, not resurrected. New work succeeds.
  assert.equal((await listAssets(session)).body.assets.length, 0)
  assert.deepEqual(treeSnapshot(artifact), assetBefore)
  const uploaded = await uploadAsset(session, 'load-budget-recovered.png')
  assert.equal(uploaded.status, 201)
  const appended = await appendScene(session, 'const fix4LoadBudgetRecovered = true')
  assert.equal(appended.revision, 2)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 2)
  assert.equal((await listAssets(session)).body.assets.length, 1)
  assert.equal(revisionNames(sceneDir(session)).length, 2)
  assert.equal(markerNames(sceneDir(session)).length, 2)
  assert.deepEqual(treeSnapshot(artifact), assetBefore)
})

test('D12 the staging budget rejects a runtime append and asset upload before acknowledgement, then recovers', async () => {
  await freshBoundedStore()
  const session = 'sess-fix4-bound-staging'
  await seedAcknowledged(session, { revisions: 1, assets: 1, label: 'BND6' })
  await disk.restartForTests()
  const sceneBefore = treeSnapshot(sceneDir(session))
  const assetBefore = treeSnapshot(assetSessionDir(session))
  disk.configureForTests({ maxStagingBytes: 1 })
  await assert.rejects(appendScene(session, 'const fix4StagingFull = true'),
    error => error?.code === 'storage-full')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.deepEqual(treeSnapshot(sceneDir(session)), sceneBefore)
  const assetFailed = await uploadAsset(session, 'staging-full.png')
  assert.equal(assetFailed.status, 503)
  assert.deepEqual(treeSnapshot(assetSessionDir(session)), assetBefore)
  assert.equal((await listAssets(session)).body.assets.length, 1)
  assert.equal(disk.stats().bytes.staging, 0)
  disk.configureForTests({ maxStagingBytes: 128 * 1024 * 1024 })
  const appended = await appendScene(session, 'const fix4StagingRecovered = true')
  assert.equal(appended.revision, 2)
  const uploaded = await uploadAsset(session, 'staging-recovered.png')
  assert.equal(uploaded.status, 201)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 2)
  assert.equal((await listAssets(session)).body.assets.length, 2)
  assert.equal(disk.stats().bytes.staging, 0)
})

test('D12 an asset dir cap of 4096 is exact and leaves the real committed asset served and undeleted', async () => {
  await freshBoundedStore()
  const session = 'sess-fix4-bound-asset-dirs'
  await seedAcknowledged(session, { revisions: 1, assets: 1, label: 'BND7' })
  await disk.restartForTests()
  const before = treeSnapshot(assetSessionDir(session))
  assert.equal(disk.setVirtualDirentsForTests([{
    dir: assetSessionDir(session),
    specs: [{
      repeat: 5000, start: 1, pad: 8, prefix: 'a'.repeat(56), suffix: '', kind: 'directory',
    }],
  }]), true)
  const restarted = await disk.restartForTests()
  assert.equal(restarted.mode, 'disk')
  const scan = disk.scanForTests()
  assert.equal(scan.counters.assetDirs, 4096)
  assert.equal(scan.counters.assetSessions, 1)
  assert.equal(scan.counters.assetRootEntries, 1)
  assert.equal((await listAssets(session)).body.assets.length, 1)
  assert.equal((await sceneJson(session)).revision, 1)
  assert.deepEqual(treeSnapshot(assetSessionDir(session)), before)
  assert.equal(fs.readdirSync(assetSessionDir(session)).filter(name => HEX64_RE.test(name)).length, 1)
  disk.clearVirtualDirentsForTests()
  const recovered = await disk.restartForTests()
  assert.equal(recovered.mode, 'disk')
  assert.equal((await listAssets(session)).body.assets.length, 1)
  assert.deepEqual(treeSnapshot(assetSessionDir(session)), before)
})

test('D12 a read-hang gate blocks startup until released, then the deadline truncates without deletion and a clean restart recovers', async () => {
  await freshBoundedStore()
  const session = 'sess-fix4-bound-read-hang'
  await seedAcknowledged(session, { revisions: 1, assets: 0, label: 'BND8' })
  await disk.restartForTests()
  const before = treeSnapshot(sceneDir(session))
  assert.equal(disk.faults.set({ op: 'read', at: 'scene-revision', behavior: 'hang' }), true)
  const begun = await disk.restartBeginForTests()
  assert.equal(begun.ready, false)
  await waitForCondition(() => disk.hangWaiterCountForTests() === 1, 'scene revision read hang')
  assert.equal(disk.ready(), false)
  assert.equal(disk.inspect().loaded, false)
  assert.equal(disk.faultHitsForTests()['read@scene-revision'], 1)
  disk.configureForTests({ startupDeadlineMs: 1 })
  await delay(20)
  assert.equal(disk.releaseHangsForTests(), 1)
  const ready = await disk.waitReadyForTests()
  // The hung read resumes after the deadline. loadScenesPhase truncates the
  // session rather than serving it, and the next startup phase fails closed on
  // the expired deadline instead of mutating an incompletely scanned store.
  assert.equal(ready.mode, 'degraded')
  assert.equal(disk.ready(), true)
  assert.equal(disk.inspect().status, 'startup-deadline')
  assert.equal(counters().startupTruncatedScenes, 1)
  assert.equal(counters().startupEvictedScenes, 0)
  assert.equal((await sceneGet(session)).status, 404)
  assert.deepEqual(treeSnapshot(sceneDir(session)), before)
  assert.equal(revisionNames(sceneDir(session)).length, 1)
  assert.equal(markerNames(sceneDir(session)).length, 1)
  assert.equal(quarantineSceneEntries().length, 0)
  disk.faults.clear()
  disk.configureForTests({ startupDeadlineMs: 60000 })
  const recovered = await disk.restartForTests()
  assert.equal(recovered.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(revisionNames(sceneDir(session)).length, 1)
})

test('MINOR test-only fault arming requires testMode and the read gate stays inert without faults', async () => {
  await disk.resetForTests()
  assert.equal(disk.faults.set({ op: 'read', at: 'scene-revision', count: 1 }), false)
  assert.equal(disk.faults.set({ op: 'read', at: 'scene-revision', behavior: 'hang' }), false)
  assert.equal(disk.hangWaiterCountForTests(), 0)
  assert.deepEqual(disk.faultHitsForTests(), {})
  assert.equal(disk.markTestModeForTests(), true)
  assert.equal(disk.faults.set({ op: 'read', at: 'scene-revision', count: 1 }), true)
  disk.faults.clear()
  const started = await freshStore()
  assert.equal(started.mode, 'disk')
  assert.equal(disk.faults.set({ op: 'read', at: 'scene-revision-probe', count: 1 }), true)
  disk.faults.clear()
  const session = 'sess-minor-fault-gate'
  assert.equal((await appendScene(session, 'const minorFaultGate = true')).revision, 1)
  const stable = await disk.restartForTests()
  assert.equal(stable.mode, 'disk')
  assert.equal((await sceneJson(session)).revision, 1)
  assert.equal(disk.hangWaiterCountForTests(), 0)
  assert.deepEqual(disk.faultHitsForTests(), {})
})
