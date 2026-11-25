/**
 * Example product-content documents stay loadable.
 *
 * `examples/turbofan-manual.json` is a drop-in `presentation` payload for the
 * Manual panel and the host `workbench_proposal` kind `manual`;
 * `examples/lamplighter-film.json` is the matching film document. Both are
 * normalized by the same code the editor uses, so a schema drift here would
 * silently break the examples rather than any product path.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const repoRoot = new URL('../', import.meta.url)
const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8')

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
await import(`${pathToFileURL(new URL('../client.js', import.meta.url).pathname).href}?examples=${String(Date.now())}`)
const plugin = definition.factory(name => {
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

const readJson = async name => JSON.parse(await readFile(new URL(name, repoRoot), 'utf8'))

// Host-side manual proposal rules (index.js `workbench_proposal` kind manual).
const HOST = {
  uidMax: 200,
  vectorMax: 1e7,
  titleMax: 120,
  productMax: 120,
  versionMax: 40,
  stepTitleMax: 80,
  bodyMax: 600,
  partNameMax: 80,
  partNumberMax: 40,
  stepsMax: 64,
  partsMax: 16,
  hiddenMax: 64,
}
const textWithin = (value, max) => typeof value === 'string'
  && (value.length <= max || [...value].length <= max)
const isVector = value => Array.isArray(value) && value.length === 3
  && value.every(part => typeof part === 'number' && Number.isFinite(part))

test('turbofan manual passes the host proposal validation', async () => {
  const doc = await readJson('examples/turbofan-manual.json')
  assert.equal(doc.v, 1)
  const manual = doc.manual
  assert.ok(manual !== null && typeof manual === 'object')
  assert.equal(manual.v, 1)
  assert.ok(textWithin(manual.title, HOST.titleMax))
  assert.ok(textWithin(manual.product, HOST.productMax))
  assert.ok(textWithin(manual.version, HOST.versionMax))
  assert.ok(manual.language === 'zh' || manual.language === 'en')
  assert.ok(Array.isArray(manual.steps))
  assert.ok(manual.steps.length > 0 && manual.steps.length <= HOST.stepsMax)

  const ids = new Set()
  for (const step of manual.steps) {
    const label = 'step ' + String(step.id)
    assert.match(String(step.id), /^[A-Za-z0-9_:.-]{1,100}$/, label + ' id')
    assert.ok(!ids.has(step.id), label + ' id is unique')
    ids.add(step.id)
    assert.ok(textWithin(step.title, HOST.stepTitleMax), label + ' title')
    assert.ok(textWithin(step.body, HOST.bodyMax), label + ' body')
    assert.ok(step.camera !== null && typeof step.camera === 'object')
    assert.ok(isVector(step.camera.position), label + ' camera position')
    assert.ok(isVector(step.camera.target), label + ' camera target')
    assert.ok(step.camera.position.every(value => Math.abs(value) <= HOST.vectorMax))
    assert.ok(step.camera.target.every(value => Math.abs(value) <= HOST.vectorMax))
    assert.ok(step.camera.fov >= 15 && step.camera.fov <= 120, label + ' fov')
    assert.ok(step.time >= 0 && step.time <= 86400, label + ' time')
    assert.ok(Array.isArray(step.hidden) && step.hidden.length <= HOST.hiddenMax)
    for (const uid of step.hidden) {
      assert.ok(typeof uid === 'string' && uid.length > 0 && uid.length <= HOST.uidMax, label + ' hidden uid')
    }
    assert.ok(step.highlight === null || (typeof step.highlight === 'string' && step.highlight.length > 0))
    assert.ok(Array.isArray(step.parts) && step.parts.length <= HOST.partsMax)
    for (const part of step.parts) {
      assert.ok(typeof part.name === 'string' && part.name !== '')
      assert.ok(textWithin(part.name, HOST.partNameMax))
      assert.ok(textWithin(part.number, HOST.partNumberMax))
    }
    assert.ok(step.duration >= 0 && step.duration <= 60, label + ' duration')
    // Hotspots are client-side metadata the host passes through untouched.
    for (const hotspot of Array.isArray(step.hotspots) ? step.hotspots : []) {
      assert.ok(typeof hotspot.id === 'string' && hotspot.id !== '', label + ' hotspot id')
      assert.ok(typeof hotspot.uid === 'string' && hotspot.uid !== '', label + ' hotspot uid')
      assert.ok(typeof hotspot.label === 'string' && hotspot.label !== '', label + ' hotspot label')
    }
  }

  // BOM ids are unique and bounded.
  const bomIds = new Set()
  for (const part of manual.parts) {
    assert.ok(!bomIds.has(part.id), 'BOM id is unique: ' + String(part.id))
    bomIds.add(part.id)
    assert.ok(typeof part.name === 'string' && part.name !== '')
    assert.ok(part.qty >= 0)
  }
})

test('turbofan manual survives the client normalizer unchanged in shape', async () => {
  const doc = await readJson('examples/turbofan-manual.json')
  const normalized = plugin.__normalizePresentationManual(doc.manual, [])
  assert.ok(normalized !== null)
  assert.equal(normalized.steps.length, doc.manual.steps.length)
  assert.equal(normalized.parts.length, doc.manual.parts.length)
  normalized.steps.forEach((step, index) => {
    const source = doc.manual.steps[index]
    assert.equal(step.id, source.id)
    assert.equal(step.title, source.title)
    assert.equal(step.highlight, source.highlight)
    assert.deepEqual(step.camera.position, source.camera.position)
    assert.deepEqual(step.camera.target, source.camera.target)
    assert.equal(step.camera.fov, source.camera.fov)
    assert.deepEqual(step.hidden, source.hidden)
    assert.equal(step.hotspots.length, source.hotspots.length)
    assert.deepEqual(step.parts, source.parts.map(part => ({ name: part.name, number: part.number })))
  })
  // BOM entries keep their UID so the archive link and share viewer can focus.
  normalized.parts.forEach((part, index) => {
    assert.equal(part.id, doc.manual.parts[index].id)
    assert.equal(part.uid, doc.manual.parts[index].uid)
  })
})

test('lamplighter film document normalizes captions and settings', async () => {
  const doc = await readJson('examples/lamplighter-film.json')
  assert.equal(doc.v, 1)
  assert.equal(doc.manual, null)
  const normalized = plugin.__normalizePresentationFilm(doc.film, [])
  assert.ok(normalized !== null)
  assert.equal(normalized.title, doc.film.title)
  assert.equal(normalized.aspect, '16:9')
  assert.equal(normalized.resolution, '1080p')
  assert.equal(normalized.fps, 24)
  assert.equal(normalized.music, null)
  assert.equal(normalized.captions.length, doc.film.captions.length)
  normalized.captions.forEach((caption, index) => {
    assert.equal(caption.text, doc.film.captions[index].text)
  })
  // Captions must be ordered and inside the 60 s film cap.
  for (let index = 1; index < normalized.captions.length; index += 1) {
    assert.ok(normalized.captions[index].start >= normalized.captions[index - 1].start)
  }
  const last = normalized.captions[normalized.captions.length - 1]
  assert.ok(last.end <= 60, 'last caption ends inside the film cap')

  // The SRT sidecar round-trips through the same helpers the Film drawer uses.
  const srt = plugin.__captionsToSrt(normalized.captions)
  assert.deepEqual(plugin.__parseSrt(srt), normalized.captions)
})

test('example scenes use only the documented sandbox globals', async () => {
  for (const file of ['examples/scene-engine.js', 'examples/scene-lamplighter.js']) {
    const source = await readFile(new URL(file, repoRoot), 'utf8')
    assert.doesNotMatch(source, /\bimport\s|\brequire\(/, file + ' has no imports')
    assert.doesNotMatch(source, /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/, file + ' has no network calls')
    assert.doesNotMatch(source, /\beval\(|new Function\b/, file + ' has no dynamic code')
    assert.doesNotMatch(source, /https?:\/\//, file + ' has no external URLs')
    // Every wb.id must be a stable, unique identifier so manual steps and
    // hotspots keep their binding across revisions.
    const ids = [...source.matchAll(/wb\.id\([^,]+,\s*'([^']+)'\s*\)/g)].map(match => match[1])
    assert.equal(new Set(ids).size, ids.length, file + ' wb.id values are unique')
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,64}$/, file + ' wb.id ' + id)
    // The runtime provides these; anything else would be a ReferenceError.
    for (const global of ['THREE', 'scene', 'camera', 'renderer', 'controls', 'onFrame', 'wb']) {
      assert.match(source, new RegExp('\\b' + global + '\\b'), file + ' uses ' + global)
    }
  }

  // The manual's UIDs must exist in the engine scene it ships with.
  const engine = await readFile(new URL('examples/scene-engine.js', repoRoot), 'utf8')
  const manual = await readJson('examples/turbofan-manual.json')
  const usedUids = new Set()
  for (const step of manual.manual.steps) {
    if (step.highlight !== null) usedUids.add(step.highlight)
    for (const uid of step.hidden) usedUids.add(uid)
    for (const hotspot of step.hotspots) usedUids.add(hotspot.uid)
  }
  for (const part of manual.manual.parts) if (part.uid !== null) usedUids.add(part.uid)
  assert.ok(usedUids.size > 0)
  for (const uid of usedUids) {
    const name = uid.replace(/^s:/, '')
    assert.ok(engine.includes("'" + name + "'"), 'engine scene defines ' + name)
  }
})

test('example docs stay documented where users look for them', async () => {
  const readme = await readFile(new URL('examples/README.md', repoRoot), 'utf8')
  for (const file of ['scene-engine.js', 'scene-lamplighter.js', 'turbofan-manual.json', 'lamplighter-film.json']) {
    assert.ok(readme.includes(file), 'examples/README.md lists ' + file)
  }
  // The client exposes the normalizers the examples are verified against.
  assert.match(clientSource, /__normalizePresentationManual/)
  assert.match(indexSource, /const PROPOSAL_MANUAL_STEPS_MAX/)
})
