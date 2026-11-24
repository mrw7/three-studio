import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SETUP = `
import { apply, __historyInternal, __diskInternal, __assetInternal, __shareInternal } from './index.js'
const ctx = {
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  tools: { register() { return () => {} } },
  systemPrompt: { section() { return () => {} } },
  inject(names, callback) {
    if (!Array.isArray(names) || !names.includes('webServer')) return
    callback({
      on() { return () => {} },
      effect: ctx.effect,
      webServer: { register() { return () => {} } },
    })
  },
  get(name) {
    return name === 'webServer' ? { register() { return () => {} } } : undefined
  },
}
apply(ctx)
const deadline = Date.now() + 5000
while (!__diskInternal.ready() && Date.now() < deadline) {
  await new Promise(resolveWait => setTimeout(resolveWait, 20))
}
if (__diskInternal.mode() !== 'portable') {
  throw new Error('portable mode not active: ' + __diskInternal.mode())
}
`

const runChild = (home, source, envOverrides = {}) => new Promise((resolveChild, reject) => {
  const child = spawn(process.env.THREE_STUDIO_NODE || process.execPath, ['--input-type=module', '-e', source], {
    cwd: repo,
    env: {
      ...process.env,
      THREE_WORKBENCH_DATA_DIR: join(home, 'scenes'),
      THREE_STUDIO_PORTABLE_STORE: '1',
      NODE_TEST_CONTEXT: '',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    reject(new Error(`child timeout\n${stderr}`))
  }, 15000)
  child.on('exit', code => {
    clearTimeout(timer)
    if (code !== 0) reject(new Error(`child exited ${String(code)}\n${stderr}`))
    else resolveChild(stdout)
  })
})

const lastJsonLine = output => {
  const lines = output.trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

test('portable store persists scene history across process restarts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'three-studio-portable-'))
  try {
    const first = await runChild(home, `${SETUP}
__historyInternal.seedSession('portable-session', [{
  sceneId: 'portable-session',
  revision: 1,
  title: 'Persisted',
  code: 'const value = 1',
  bytes: 15,
  updatedAt: 123456,
}])
const stored = __assetInternal.store.put('portable-session', {
  name: 'pixel.bin',
  nameFold: 'pixel.bin',
  kind: 'binary',
  mime: 'application/octet-stream',
  ext: 'bin',
  bytes: 4,
  buffer: Buffer.from([1, 2, 3, 4]),
})
const shareId = 's'.repeat(22)
const shareDocument = Buffer.from('<html>share</html>')
__shareInternal.store.put({
  id: shareId,
  v: 1,
  ownerSessionHash: __shareInternal.ownerHash('portable-session'),
  revision: 1,
  title: 'Share',
  code: 'const value = 1',
  editorState: {},
  stepFps: 30,
  documentBuffer: shareDocument,
  metadataJson: '{}',
  bytes: shareDocument.length + 30,
  createdAt: Date.now(),
  expiresAt: Date.now() + 86400000,
  deleteKeyHash: __shareInternal.deleteKeyHash('d'.repeat(22)),
})
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([1, 2, 3, 4]),
])
if (__assetInternal.thumbnail({
  sessionId: 'portable-session',
  revision: 1,
  dataUrl: 'data:image/png;base64,' + png.toString('base64'),
}) !== true) throw new Error('thumbnail store failed')
__diskInternal.portable.flush()
console.log(JSON.stringify({
  mode: __diskInternal.mode(),
  snapshot: __diskInternal.portable.snapshot(),
  assetId: stored.asset.id,
  shareId,
}))
`)
    const firstValue = lastJsonLine(first)
    assert.equal(firstValue.mode, 'portable')
    assert.equal(firstValue.snapshot.scenes.length, 1)
    assert.equal(firstValue.snapshot.scenes[0].history[0].title, 'Persisted')
    assert.equal(firstValue.snapshot.assets.length, 1)
    assert.equal(firstValue.snapshot.shares.length, 1)
    assert.equal(firstValue.snapshot.thumbnails.length, 1)

    const second = await runChild(home, `${SETUP}
const asset = __assetInternal.store.get(${JSON.stringify(firstValue.assetId)})
const share = __shareInternal.store.get(${JSON.stringify(firstValue.shareId)})
const thumbnail = __assetInternal.thumbnailBytes('portable-session:1')
console.log(JSON.stringify({
  history: __historyInternal.history('portable-session'),
  asset: asset === undefined ? null : { id: asset.id, bytes: asset.bytes, data: [...asset.buffer] },
  share: share === undefined ? null : { id: share.id, data: [...share.documentBuffer] },
  thumbnail: thumbnail === null ? null : [...thumbnail],
}))
`)
    const secondValue = lastJsonLine(second)
    assert.equal(secondValue.history.history.length, 1)
    assert.equal(secondValue.history.history[0].title, 'Persisted')
    assert.equal(secondValue.history.history[0].code, 'const value = 1')
    assert.equal(secondValue.history.history[0].revision, 1)
    assert.equal(secondValue.asset.bytes, 4)
    assert.deepEqual(secondValue.asset.data, [1, 2, 3, 4])
    assert.equal(secondValue.share.id, firstValue.shareId)
    assert.equal(String.fromCharCode(...secondValue.share.data), '<html>share</html>')
    assert.deepEqual(secondValue.thumbnail, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

const DISK_SEED = `
import { apply, __diskInternal } from './index.js'
const tools = new Map()
const ctx = {
  effect(fn) { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
  tools: { register(definition) { tools.set(definition.name, definition); return () => {} } },
  systemPrompt: { section() { return () => {} } },
  inject(names, callback) {
    if (!Array.isArray(names) || !names.includes('webServer')) return
    callback({
      on() { return () => {} },
      effect: ctx.effect,
      webServer: { register() { return () => {} } },
    })
  },
  get(name) {
    return name === 'webServer' ? { register() { return () => {} } } : undefined
  },
}
apply(ctx)
const ready = await __diskInternal.waitReadyForTests()
if (ready.mode !== 'disk') throw new Error('seed mode ' + ready.mode + ' status ' + ready.status)
const scene = await tools.get('three_scene').execute({
  title: 'Migrated scene',
  code: ${JSON.stringify('const value = 42\n')},
}, { agent: { session: { id: 'migrate-session' } } })
const migration = await __diskInternal.portable.migrateToPortable(process.env.THREE_WORKBENCH_DATA_DIR)
console.log(JSON.stringify({ ready, scene, migration }))
`

test('migrates a Linux disk store into the portable backend', async () => {
  const home = await mkdtemp(join(tmpdir(), 'three-studio-migrate-'))
  try {
    const root = join(home, 'scenes')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'ROOT.json'), JSON.stringify({
      v: 1,
      kind: 'three-workbench-root',
      token: randomBytes(16).toString('hex'),
      createdAt: Date.now(),
    }), { mode: 0o600 })
    const seeded = await runChild(home, DISK_SEED, {
      THREE_STUDIO_PORTABLE_STORE: '0',
      NODE_TEST_CONTEXT: 'migration-test',
    })
    const seedValue = lastJsonLine(seeded)
    assert.equal(seedValue.ready.mode, 'disk')
    assert.equal(seedValue.scene.title, 'Migrated scene')
    assert.equal(seedValue.migration.source.scenes, 1)
    assert.equal(seedValue.migration.written.scenes, 1)

    const verify = await runChild(home, `${SETUP}
console.log(JSON.stringify(__historyInternal.history('migrate-session')))
`, { NODE_TEST_CONTEXT: 'migration-test' })
    const history = lastJsonLine(verify)
    assert.equal(history.history.length, 1)
    assert.equal(history.history[0].title, 'Migrated scene')
    assert.equal(history.history[0].code, 'const value = 42\n')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('merges a portable source into a target with skip and replace policies', async () => {
  const home = await mkdtemp(join(tmpdir(), 'three-studio-merge-'))
  try {
    const targetRoot = join(home, 'target')
    const sourceRoot = join(home, 'source')
    await runChild(home, `${SETUP}
__historyInternal.seedSession('target-session', [{
  sceneId: 'target-session', revision: 1, title: 'Target', code: 'target', bytes: 6, updatedAt: 1,
}])
__diskInternal.portable.flush()
`, { THREE_WORKBENCH_DATA_DIR: targetRoot })
    const sourceSeed = await runChild(home, `${SETUP}
__historyInternal.seedSession('source-session', [{
  sceneId: 'source-session', revision: 1, title: 'Source', code: 'source', bytes: 6, updatedAt: 1,
}])
__historyInternal.seedSession('target-session', [{
  sceneId: 'target-session', revision: 1, title: 'Source conflict', code: 'source-conflict', bytes: 15, updatedAt: 2,
}])
const stored = __assetInternal.store.put('source-session', {
  name: 'source.bin', nameFold: 'source.bin', kind: 'binary',
  mime: 'application/octet-stream', ext: 'bin', bytes: 3, buffer: Buffer.from([9, 9, 9]),
})
const shareId = 'm'.repeat(22)
const document = Buffer.from('<html>merged share</html>')
__shareInternal.store.put({
  id: shareId,
  v: 1,
  ownerSessionHash: __shareInternal.ownerHash('source-session'),
  revision: 1,
  title: 'Merged share',
  code: 'source',
  editorState: {},
  stepFps: 30,
  documentBuffer: document,
  metadataJson: '{}',
  bytes: document.length + 30,
  createdAt: Date.now(),
  expiresAt: Date.now() + 86400000,
  deleteKeyHash: __shareInternal.deleteKeyHash('n'.repeat(22)),
})
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([5, 6, 7, 8]),
])
if (__assetInternal.thumbnail({
  sessionId: 'source-session', revision: 1,
  dataUrl: 'data:image/png;base64,' + png.toString('base64'),
}) !== true) throw new Error('thumbnail store failed')
__diskInternal.portable.flush()
console.log(JSON.stringify({ assetId: stored.asset.id, shareId }))
`, { THREE_WORKBENCH_DATA_DIR: sourceRoot })
    const sourceInfo = lastJsonLine(sourceSeed)

    const mergeSkip = await runChild(home, `${SETUP}
const result = await __diskInternal.portable.importFrom(${JSON.stringify(sourceRoot)}, { conflict: 'skip' })
console.log(JSON.stringify(result))
`, { THREE_WORKBENCH_DATA_DIR: targetRoot })
    const skipResult = lastJsonLine(mergeSkip)
    assert.equal(skipResult.scenes.imported, 1)
    assert.equal(skipResult.scenes.skipped, 1)
    assert.equal(skipResult.assets.imported, 1)
    assert.equal(skipResult.shares.imported, 1)
    assert.equal(skipResult.thumbnails.imported, 1)
    assert.equal(skipResult.saved, true)

    const verifySkip = await runChild(home, `${SETUP}
console.log(JSON.stringify({
  target: __historyInternal.history('target-session'),
  source: __historyInternal.history('source-session'),
  asset: __assetInternal.store.get(${JSON.stringify(sourceInfo.assetId)})?.buffer ?? null,
  share: __shareInternal.store.get(${JSON.stringify(sourceInfo.shareId)})?.documentBuffer ?? null,
  thumbnail: __assetInternal.thumbnailBytes('source-session:1'),
}))
`, { THREE_WORKBENCH_DATA_DIR: targetRoot })
    const skipValue = lastJsonLine(verifySkip)
    assert.equal(skipValue.target.history[0].code, 'target')
    assert.equal(skipValue.source.history[0].code, 'source')
    assert.deepEqual(skipValue.asset.data, [9, 9, 9])
    assert.equal(String.fromCharCode(...skipValue.share.data), '<html>merged share</html>')
    assert.deepEqual(skipValue.thumbnail.data,
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6, 7, 8])

    const mergeReplace = await runChild(home, `${SETUP}
const result = await __diskInternal.portable.importFrom(${JSON.stringify(sourceRoot)}, { conflict: 'replace' })
console.log(JSON.stringify(result))
`, { THREE_WORKBENCH_DATA_DIR: targetRoot })
    const replaceResult = lastJsonLine(mergeReplace)
    assert.equal(replaceResult.scenes.replaced, 2)
    assert.equal(replaceResult.assets.replaced, 1)
    assert.equal(replaceResult.shares.replaced, 1)
    assert.equal(replaceResult.thumbnails.replaced, 1)

    const verifyReplace = await runChild(home, `${SETUP}
console.log(JSON.stringify(__historyInternal.history('target-session')))
`, { THREE_WORKBENCH_DATA_DIR: targetRoot })
    const replaceValue = lastJsonLine(verifyReplace)
    assert.equal(replaceValue.history[0].code, 'source-conflict')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('portable store quarantines a corrupt manifest and starts empty', async () => {
  const home = await mkdtemp(join(tmpdir(), 'three-studio-portable-'))
  try {
    await runChild(home, `${SETUP}
__historyInternal.seedSession('portable-session', [{
  sceneId: 'portable-session', revision: 1, title: 'Persisted', code: 'x', bytes: 1, updatedAt: 1,
}])
__diskInternal.portable.flush()
`)
    const dir = join(home, 'scenes', 'portable')
    const manifest = join(dir, 'portable-store.json')
    await writeFile(manifest, '{', 'utf8')
    const output = await runChild(home, `${SETUP}
console.log(JSON.stringify(__historyInternal.history('portable-session')))
`)
    assert.equal(lastJsonLine(output), null)
    const entries = await readdir(dir)
    assert.equal(entries.some(name => name.startsWith('portable-store.json.invalid-')), true)
    // A fresh save after recovery must produce a readable manifest again.
    await runChild(home, `${SETUP}
__historyInternal.seedSession('recovered', [{
  sceneId: 'recovered', revision: 1, title: 'Recovered', code: 'y', bytes: 1, updatedAt: 1,
}])
__diskInternal.portable.flush()
`)
    const manifestText = await readFile(manifest, 'utf8')
    assert.match(manifestText, /"Recovered"/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
