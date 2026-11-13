/**
 * P2-1 track model, history, protocol, embedding and animated-export tests.
 * These are pure Node checks over the same source injected into the sandboxed
 * runtime; the browser probe covers DOM, capture and live evaluation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
// The detailed contract lives in the optional Harness-plugin design doc; the
// root README is the concise project entry point.
const readmeSource = await readFile(new URL('../docs/HARNESS-PLUGIN.md', import.meta.url), 'utf8')

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
await import(`${pathToFileURL(new URL('../client.js', import.meta.url).pathname).href}?tracks=${String(Date.now())}`)
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

const key = (t, v, e = 'linear') => ({ t, v, e })
const track = (uid, path, keys, enabled = true) => ({ uid, path, enabled, keys })
const set = (...items) => ({ v: 1, items })
const close = (actual, expected, epsilon = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected} (${epsilon})`)
}
const normalize = tracks => plugin.__normalizeTrackSet(tracks, { strict: false })
const normalizedItems = tracks => normalize(tracks).tracks.items
const M = plugin.__TRACK_MAX_TRACKS
const K = plugin.__TRACK_MAX_KEYS_PER_TRACK

test('P2-1 track paths, normalization, quarantine, limits and record round-trip', () => {
  const position = plugin.__parseTrackPath('position')
  const rotation = plugin.__parseTrackPath('rotation')
  const visible = plugin.__parseTrackPath('visible')
  const texture = plugin.__parseTrackPath('material.15.map')
  assert.deepEqual([position.group, position.components, position.stepOnly], ['transform', 3, false])
  assert.deepEqual([rotation.group, rotation.components], ['transform', 4])
  assert.deepEqual([visible.group, visible.kind, visible.stepOnly], ['visibility', 'boolean', true])
  assert.deepEqual([texture.kind, texture.slot, texture.stepOnly], ['asset', 15, true])
  for (const bad of ['', 'Position', 'material.16.color', 'material.01.color', 'material.0.bogus',
    '__proto__', 'light.bogus', 'position.extra', 'x'.repeat(121)]) {
    assert.equal(plugin.__parseTrackPath(bad), null, `rejects path ${bad}`)
  }

  const raw = set(
    track('s:quad', 'rotation', [key(0, [0, 0, 0, 2]), key(0, [0, 0, 0, 4]), key(2, [0, 0, 0, 1])]),
    track('s:mat', 'material.0.roughness', [key(0, 2), key(1, -1)]),
    track('s:vis', 'visible', [key(0, false, 'easeIn'), key(1, true)]),
    track('s:quad', 'rotation', [key(3, [0, 0, 0, 1])]),
    track('', 'position', [key(0, [0, 0, 0])]),
    track('s:quad', 'not-a-path', [key(0, 1)]),
    track('s:quad', 'position', []),
    null,
  )
  const result = normalize(raw)
  assert.equal(result.ok, true)
  assert.equal(result.tracks.items.length, 3)
  const quad = result.tracks.items.find(item => item.uid === 's:quad')
  assert.deepEqual(quad.keys.map(item => item.t), [0, 2])
  assert.deepEqual(quad.keys[0].v, [0, 0, 0, 1], 'duplicate last wins and quaternion normalizes')
  const material = result.tracks.items.find(item => item.path === 'material.0.roughness')
  assert.deepEqual(material.keys.map(item => item.v), [1, 0], 'numeric values clamp')
  const vis = result.tracks.items.find(item => item.path === 'visible')
  assert.equal(vis.keys[0].e, 'step', 'step-only paths coerce easing')

  const unknownEasing = normalize(set(track('s:ease', 'position', [
    key(0, [0, 0, 0], 'bogus'), { t: 1, v: [1, 1, 1] }, key(2, [2, 2, 2], 'easeIn'),
  ])))
  assert.deepEqual(unknownEasing.tracks.items[0].keys.map(item => item.e), ['linear', 'linear', 'easeIn'],
    'unknown or missing easing falls back to linear')
  const unknownStep = normalize(set(track('s:ease-step', 'visible', [
    { t: 0, v: false, e: 'bogus' }, { t: 1, v: true },
  ])))
  assert.deepEqual(unknownStep.tracks.items[0].keys.map(item => item.e), ['step', 'step'],
    'step-only paths force step regardless of easing')
  const codes = result.issues.map(issue => issue.code)
  for (const code of ['duplicate-track', 'duplicate-key', 'value-clamped', 'track-uid', 'track-path', 'empty-track', 'track-invalid']) {
    assert.ok(codes.includes(code), `reports ${code}`)
  }

  const unknownVersion = plugin.__normalizeTrackSet({ v: 2, items: [raw.items[0]] })
  assert.deepEqual(unknownVersion.tracks.items, [], 'unknown tracks version fails closed')
  assert.ok(unknownVersion.issues.some(issue => issue.code === 'tracks-version'))
  assert.equal(plugin.__validateTrackSetMessage({ v: 2, items: [] }).ok, false)

  const perTrack = Array.from({ length: K + 1 }, (_, index) => key(index / 30, [index, 0, 0]))
  const perTrackResult = normalize(set(track('s:long', 'position', perTrack)))
  assert.equal(perTrackResult.tracks.items[0].keys.length, K)
  assert.ok(perTrackResult.issues.some(issue => issue.code === 'key-limit'))

  const manyTracks = Array.from({ length: M + 1 }, (_, index) => track(`s:t${String(index)}`, 'position', [key(0, [0, 0, 0])]))
  const manyResult = normalize(set(...manyTracks))
  assert.equal(manyResult.tracks.items.length, M)
  assert.ok(manyResult.issues.some(issue => issue.code === 'track-limit'))

  const budgetTracks = Array.from({ length: 101 }, (_, index) => track(`s:k${String(index)}`, 'position',
    Array.from({ length: 100 }, (_, keyIndex) => key(keyIndex / 30, [keyIndex, 0, 0]))))
  const budget = normalize(set(...budgetTracks))
  assert.equal(budget.tracks.items.reduce((total, item) => total + item.keys.length, 0), 10000)
  assert.ok(budget.issues.some(issue => issue.code === 'key-limit'))

  const emptyRecord = plugin.__emptyEditorRecord(0)
  assert.deepEqual(emptyRecord.tracks, set())
  const withTracks = plugin.__recordWithTracks(emptyRecord, manyResult.tracks, { now: 7, duration: 5 })
  assert.equal(withTracks.ok, true)
  assert.equal(withTracks.record.v, 2)
  assert.equal(withTracks.record.timeline.duration, 5)
  assert.equal(plugin.__trackSetForRecord(withTracks.record).items.length, M)
  assert.equal(plugin.__recordWithTracks(emptyRecord, { v: 2, items: [] }, { now: 8 }).ok, false)

  const recordIssues = []
  const stored = plugin.__normalizeEditorRecord({
    ...emptyRecord,
    tracks: { v: 2, items: [] },
  }, 0, recordIssues)
  assert.deepEqual(stored.tracks, set(), 'record normalization fails closed for bad tracks')
  assert.ok(recordIssues.some(issue => issue.kind === 'track-issue' && issue.code === 'tracks-version'))
  assert.equal(plugin.__clearTracks(manyResult.tracks).tracks.items.length, 0)
})

test('P2-1 Add-track candidates list every material slot present', () => {
  const materials = [
    { id: 0, type: 'MeshStandardMaterial', color: '#ff0000', roughness: 0.5, textures: ['map'] },
    { id: 1, type: 'MeshStandardMaterial', emissive: '#00ff00', metalness: 0.2, textures: ['normalMap', 'aoMap'] },
    { id: 2, type: 'ShaderMaterial', readonly: true, color: '#0000ff' },
  ]
  const single = plugin.__trackCandidatePaths({ material: 1 }, materials)
  for (const candidate of ['position', 'rotation', 'scale', 'visible', 'material.0.emissive',
    'material.0.metalness', 'material.0.normalMap', 'material.0.aoMap']) {
    assert.ok(single.includes(candidate), `single material offers ${candidate}`)
  }
  assert.ok(!single.some(item => item.startsWith('material.1.')), 'single material only uses slot 0')

  const multi = plugin.__trackCandidatePaths({ material: [0, 1, 2, 0] }, materials)
  for (const candidate of ['material.0.color', 'material.0.roughness', 'material.0.map',
    'material.1.emissive', 'material.1.metalness', 'material.1.normalMap', 'material.1.aoMap',
    'material.3.color', 'material.3.roughness', 'material.3.map']) {
    assert.ok(multi.includes(candidate), `multi material offers ${candidate}`)
  }
  assert.ok(!multi.some(item => item.startsWith('material.2.')), 'readonly slot exposes no channels')
  assert.ok(!multi.some(item => item.startsWith('material.4.')), 'absent slot exposes no channels')

  const wide = plugin.__trackCandidatePaths({ material: new Array(17).fill(0) }, materials)
  assert.ok(wide.includes('material.15.map'), 'slot 15 is offered')
  assert.ok(!wide.some(item => item.startsWith('material.16.')), 'slots above 15 are not offered')
  assert.deepEqual(plugin.__trackCandidatePaths({ material: [0, 1] }, null),
    ['position', 'rotation', 'scale', 'visible'], 'missing material registry degrades to transform paths')
})

test('P2-1 interpolation: easing, step, clamps, exact keys, slerp and colors', () => {
  const position = path => normalizedItems(set(track('s:interp', path, [
    key(0, [0, 0, 0]), key(2, [10, 10, 10], 'linear'),
  ])))[0]
  assert.deepEqual(plugin.__sampleTrack(position('position'), 1), [5, 5, 5])
  assert.deepEqual(plugin.__sampleTrack(position('position'), -1), [0, 0, 0])
  assert.deepEqual(plugin.__sampleTrack(position('position'), 9), [10, 10, 10])

  const easingValue = easing => {
    const sampled = normalizedItems(set(track('s:ease', 'position', [
      key(0, [0, 0, 0], easing), key(2, [1, 1, 1], 'linear'),
    ])))[0]
    return plugin.__sampleTrack(sampled, 0.5)[0]
  }
  close(easingValue('linear'), 0.25)
  close(easingValue('easeIn'), 0.0625)
  close(easingValue('easeOut'), 0.4375)
  close(easingValue('easeInOut'), 0.125)

  const stepped = normalizedItems(set(track('s:step', 'position', [
    key(0, [0, 0, 0], 'step'), key(1, [10, 0, 0], 'linear'),
  ])))[0]
  assert.deepEqual(plugin.__sampleTrack(stepped, 0.999), [0, 0, 0])
  assert.deepEqual(plugin.__sampleTrack(stepped, 1), [10, 0, 0], 'the exact next key wins')
  assert.deepEqual(plugin.__sampleTrack(stepped, 0.5), [0, 0, 0], 'step holds the outgoing key')

  const half = Math.PI / 4
  const quarter = Math.PI / 8
  const rotationTrack = normalizedItems(set(track('s:q', 'rotation', [
    key(0, [0, 0, 0, 1], 'linear'),
    key(1, [0, 0, Math.sin(half), Math.cos(half)], 'linear'),
  ])))[0]
  const midpoint = plugin.__sampleTrack(rotationTrack, 0.5)
  close(midpoint[0], 0)
  close(midpoint[2], Math.sin(quarter))
  close(midpoint[3], Math.cos(quarter))
  close(Math.hypot(...midpoint), 1)

  const easedRotation = normalizedItems(set(track('s:qe', 'rotation', [
    key(0, [0, 0, 0, 1], 'easeInOut'),
    key(1, [0, 0, Math.sin(half), Math.cos(half)], 'linear'),
  ])))[0]
  close(Math.hypot(...plugin.__sampleTrack(easedRotation, 0.25)), 1)

  const colorTrack = normalizedItems(set(track('s:c', 'material.0.color', [
    key(0, '#000000', 'linear'), key(2, '#ffffff', 'linear'),
  ])))[0]
  assert.equal(plugin.__sampleTrack(colorTrack, 1), '#808080')

  close(plugin.__trackEaseAlpha(0.25, 'easeIn'), 0.0625)
  close(plugin.__trackEaseAlpha(0.25, 'easeOut'), 0.4375)
  close(plugin.__trackEaseAlpha(0.25, 'easeInOut'), 0.125)
  assert.equal(plugin.__trackEaseAlpha(0.25, 'step'), 0)
})

test('P2-1 operations and keys history remain atomic and reversible', () => {
  const base = normalize(set(
    track('s:op', 'position', [key(0, [0, 0, 0]), key(1, [1, 1, 1])]),
    track('s:op', 'rotation', [key(0, [0, 0, 0, 1]), key(1, [0, 0, 0, 1])]),
  )).tracks
  const original = JSON.parse(JSON.stringify(base))

  const inserted = plugin.__upsertKey(base, {
    uid: 's:op', path: 'position', time: 0.5, value: [0.5, 0.5, 0.5], snapFps: 30,
  })
  assert.equal(inserted.ok, true)
  assert.equal(inserted.created, false)
  assert.equal(inserted.replaced, false)
  assert.deepEqual(inserted.tracks.items[0].keys.map(item => item.t), [0, 0.5, 1])
  assert.equal(inserted.item.before.keys.length, 2)
  assert.equal(inserted.item.after.keys.length, 3)

  const replaced = plugin.__upsertKey(base, {
    uid: 's:op', path: 'position', time: 1, value: [9, 9, 9], snapFps: 30,
  })
  assert.equal(replaced.replaced, true)
  assert.deepEqual(replaced.tracks.items[0].keys[1].v, [9, 9, 9])

  const collision = plugin.__moveKeys(base, [{ uid: 's:op', path: 'position', times: [0] }], 1, {
    stepFps: 30, duration: 1,
  })
  assert.equal(collision.ok, true)
  assert.equal(collision.collisions, 1, 'moving onto an existing key replaces it')
  assert.deepEqual(collision.tracks.items[0].keys.map(item => item.t), [1])
  assert.deepEqual(collision.tracks.items[0].keys[0].v, [0, 0, 0], 'the moved key wins')
  const undone = plugin.__applyTrackHistoryEntry(base, {
    kind: 'keys', action: 'move', items: collision.items,
  }, 'undo')
  assert.equal(undone.ok, true)
  assert.deepEqual(undone.tracks, original, 'undo restores the replaced key too')

  const moved = plugin.__moveKeys(base, [{ uid: 's:op', path: 'position', times: [0] }], 2, {
    stepFps: 30, duration: 1,
  })
  assert.equal(moved.durationAfter, 2, 'moving beyond duration extends it')
  const easing = plugin.__setKeyEasing(base, [{ uid: 's:op', path: 'position', times: [0] }], 'easeIn')
  assert.equal(easing.ok, true)
  assert.equal(easing.tracks.items[0].keys[0].e, 'easeIn')
  assert.equal(plugin.__setKeyEasing(base, [{ uid: 's:op', path: 'position', times: [0] }], 'bogus').ok, false)

  const muted = plugin.__setTrackEnabled(base, ['s:op'], 'position', false)
  assert.equal(muted.ok, true)
  assert.equal(muted.tracks.items[0].enabled, false)
  assert.equal(plugin.__setTrackEnabled(muted.tracks, ['s:op'], 'position', false).changed, false)
  const removed = plugin.__replaceTrack(base, 's:op', 'position', null)
  assert.equal(removed.changed, true)
  assert.equal(removed.tracks.items.length, 1)
  assert.equal(plugin.__clearTracks(base).tracks.items.length, 0)
  assert.equal(plugin.__clearTracks(set()).changed, false)

  const deleteEntry = { kind: 'keys', action: 'delete', items: [removed.item] }
  assert.equal(plugin.__preflightTrackEntry(deleteEntry, 'redo', [], new Set(), base).ok, true,
    'data-only cleanup survives a missing UID')
  assert.deepEqual(plugin.__applyTrackHistoryEntry(base, deleteEntry, 'redo').tracks,
    set(track('s:op', 'rotation', [key(0, [0, 0, 0, 1]), key(1, [0, 0, 0, 1])])))

  const insertEntry = { kind: 'keys', action: 'insert', items: [inserted.item] }
  assert.deepEqual(plugin.__preflightTrackEntry(insertEntry, 'redo', [{ uid: 's:op' }], new Set(), base),
    { ok: true, blocked: [], lockedCount: 0, staleCount: 0, collisionCount: 0, invalidCount: 0 })
  assert.equal(plugin.__preflightTrackEntry(insertEntry, 'redo', [], new Set(), base).ok, true,
    'undo/redo restores stay inert when the UID is gone')
  assert.equal(plugin.__preflightTrackGesture('insert', insertEntry.items, [], new Set(), base).staleCount, 1,
    'a freshly authored key gesture requires the live object')
  assert.equal(plugin.__preflightTrackGesture('track-delete', deleteEntry.items, [], new Set(), base).ok, true,
    'authored data-only cleanup survives a missing UID')
  assert.equal(plugin.__preflightTrackEntry(insertEntry, 'redo', [{ uid: 's:op' }], new Set(['s:op']), base).lockedCount, 1)
  assert.equal(plugin.__preflightTrackEntry({ kind: 'keys', action: 'bogus', items: [] }, 'redo', [], new Set(), base).invalidCount, 1)

  const full = normalize(set(...Array.from({ length: M }, (_, index) => track(`s:full${String(index)}`, 'position', [key(0, [0, 0, 0])])))).tracks
  const fullSnapshot = JSON.stringify(full)
  assert.equal(plugin.__upsertKey(full, { uid: 's:new', path: 'position', time: 0, value: [0, 0, 0] }).error, 'track-limit')
  assert.equal(JSON.stringify(full), fullSnapshot, 'refusal does not mutate the input set')
  const fullTrack = normalize(set(track('s:keys', 'position', Array.from({ length: K }, (_, index) => key(index / 30, [0, 0, 0]))))).tracks
  assert.equal(plugin.__upsertKey(fullTrack, {
    uid: 's:keys', path: 'position', time: (K + 1) / 30, value: [0, 0, 0],
  }).error, 'key-limit')

  const historyKeyTrack = track('s:h', 'position', Array.from({ length: 30 }, (_, index) => key(index / 30, [0, 0, 0])))
  const historyEntry = kind => ({
    kind, action: 'insert', items: [{ uid: 's:h', path: 'position', before: null, after: historyKeyTrack }],
  })
  const trimmed = plugin.__trimTrackHistory([historyEntry('keys'), { kind: 'override' }, historyEntry('keys')], 100, 50)
  assert.equal(trimmed.history.length, 2)
  assert.equal(trimmed.history[0].kind, 'override', 'the key budget drops oldest key entries only')
  assert.equal(trimmed.dropped, 1)
  const capped = plugin.__trimTrackHistory(Array.from({ length: 105 }, (_, index) => ({ kind: 'override', index })), 100, 100000)
  assert.equal(capped.history.length, 100)
  assert.equal(capped.history[0].index, 5)
})

test('P2-1 protocol validates atomically and only replace-all changes runtime tracks', () => {
  const valid = set(track('s:p', 'position', [key(0, [0, 0, 0])]))
  const first = plugin.__validateTrackSetMessage(valid)
  assert.equal(first.ok, true)
  assert.deepEqual(plugin.__validateTrackSetMessage(valid).tracks, first.tracks, 'replace-all is idempotent')
  const invalidPath = plugin.__validateTrackSetMessage(set(
    track('s:p', 'position', [key(0, [0, 0, 0])]),
    track('s:q', 'material.16.color', [key(0, '#ffffff')]),
  ))
  assert.equal(invalidPath.ok, false)
  assert.deepEqual(invalidPath.tracks.items, [], 'a bad member rejects the whole message')
  assert.equal(plugin.__validateTrackSetMessage(set(track('s:p', 'position', [key(0, [0, 'x', 0])]))).ok, false)
  assert.equal(plugin.__validateTrackSetMessage(set(track('s:p', 'visible', [key(0, true, 'linear')]))).ok, true)
  assert.equal(plugin.__validateTrackSetMessage(set(track('s:p', 'visible', [key(0, true, 'linear')]))).tracks.items[0].keys[0].e, 'step')
  assert.equal(plugin.__validateTrackSetMessage(set(track('s:ghost', 'position', [key(0, [0, 0, 0])]))).ok, true,
    'unresolved UIDs are a compile-time concern, not a protocol error')
  assert.equal(plugin.__validateTrackSetMessage({ v: 3, items: [] }).error, 'tracks-version')

  const commandStart = clientSource.indexOf('const handleTracksCommand = data => {')
  const commandEnd = clientSource.indexOf('const clearGestureHold', commandStart)
  const commandBody = clientSource.slice(commandStart, commandEnd)
  assert.ok(commandBody.includes("if (data.tracksVersion !== 1)"))
  assert.ok(commandBody.includes('const validated = validateTrackSetMessage(data.tracks)'))
  assert.ok(commandBody.includes("if (data.reason === 'edit')"))
  assert.ok(commandBody.includes('trackLockDiff'))
  assert.ok(commandBody.includes("error: 'locked'"))
  assert.ok(commandBody.indexOf('trackLockDiff') < commandBody.indexOf('compileTrackSet'))
  assert.equal(/postMessage|parent\.send/.test(commandBody), false, 'replace-all never echoes tracks back')

  assert.ok(clientSource.includes("if (data.command === 'query' && data.action === 'key-values')"))
  const queryStart = clientSource.indexOf('const queryKeyValues = async (uid, paths) => {')
  const queryEnd = clientSource.indexOf('const trackPathsForNode', queryStart)
  const queryBody = clientSource.slice(queryStart, queryEnd)
  assert.ok(queryBody.includes("command('query'"))
  assert.ok(queryBody.includes("action: 'key-values'"))
  assert.ok(queryBody.includes('ack.values'))
  assert.ok(queryBody.includes("ack.action !== 'key-values'"))
  assert.ok(clientSource.includes("resolve({ ok: false, error: 'timeout' })"))

  const sendStart = clientSource.indexOf('const sendTimeline = () => {')
  const sendEnd = clientSource.indexOf('const ', sendStart + 10)
  const sendTimelineBody = clientSource.slice(sendStart, sendEnd)
  assert.equal(/tracks/i.test(sendTimelineBody), false, 'the high-frequency clock report carries no tracks')
  assert.equal(/localStorage|onApplyEditorTransform|commitTracks/.test(commandBody), false,
    'the runtime never writes the parent record')
})

test('P2-1 preview, standalone and ZIP embed tracks and compile before frame one', () => {
  const state = {
    ...plugin.__emptyEditorRecord(0),
    timeline: { duration: 5 },
    tracks: normalize(set(
      track('s:a', 'position', [key(0, [0, 0, 0]), key(2, [2, 0, 0])]),
      track('s:a', 'rotation', [key(0, [0, 0, 0, 1])]),
    )).tracks,
  }
  const scene = { title: 'Tracks', revision: 3, code: 'const a = 1' }
  const document_ = plugin.__previewDocument(scene, null, state)
  assert.ok(document_.includes('"tracks":{"v":1,"items":'))
  assert.ok(document_.includes('"uid":"s:a"'))
  assert.ok(document_.includes('"duration":5'))
  for (const token of ['sampleTrack', 'buildAnimatedTrackPlan', 'INITIAL_EDITOR_STATE', 'initializeTracks(INITIAL_EDITOR_STATE)']) {
    assert.ok(document_.includes(token), `runtime includes ${token}`)
  }
  const order = ['resolveIdentity()', 'buildManualLayer(INITIAL_EDITOR_STATE)',
    'applyInitialStructure(INITIAL_EDITOR_STATE)', 'applyEditorState(INITIAL_EDITOR_STATE)',
    'initializeTracks(INITIAL_EDITOR_STATE)', 'renderer.setAnimationLoop', 'sendTree(\'ready\')']
    .map(token => document_.indexOf(token))
  assert.ok(order.every(index => index >= 0), 'all initialization stages are present')
  assert.deepEqual(order, [...order].sort((a, b) => a - b),
    'identity/manual/structure/pins compile before the first frame and ready report')
  assert.ok(document_.includes('timeline.duration = timelineValue.duration'))

  const standalone = plugin.__standaloneHtml(scene, state)
  assert.ok(standalone.includes('"tracks":{"v":1,"items":'))
  assert.equal(standalone.includes('three-workbench:editor:v2'), false)
  assert.equal(standalone.includes('sessionId'), false)
  assert.equal(/token=/i.test(standalone), false)

  assert.ok(plugin.__TRACK_RUNTIME_SOURCE.includes('buildAnimatedTrackPlan'))
  assert.equal(/\beval\s*\(|new Function|innerHTML|document\.write/.test(plugin.__TRACK_RUNTIME_SOURCE), false)
})

test('P2-1 animated sampler: exact grid, TRS-only, xyzw and name restore', () => {
  const tracks = normalize(set(
    track('s:a', 'position', [key(0, [0, 0, 0], 'linear'), key(4, [4, 2, 0], 'linear')]),
    track('s:a', 'rotation', [key(0, [0, 0, 0, 1], 'linear'), key(4, [0, 0, 1, 0], 'linear')]),
    track('s:b', 'scale', [key(0, [1, 1, 1], 'step'), key(4, [2, 2, 2], 'linear')]),
    track('s:b', 'visible', [key(0, true)]),
    track('s:b', 'material.0.opacity', [key(0, 1)]),
    track('s:c', 'position', [key(0, [0, 0, 0])], false),
    track('s:unresolved', 'position', [key(0, [0, 0, 0])]),
  )).tracks
  const live = new Set(['s:a', 's:b', 's:c'])
  const plan = plugin.__buildAnimatedTrackPlan(tracks, live, 5, 30)
  assert.equal(plan.fps, 30)
  assert.equal(plan.duration, 5)
  assert.equal(plan.frameCount, 150)
  assert.equal(plan.times.length, 150)
  assert.equal(plan.tracks.length, 3, 'disabled, non-TRS and unresolved tracks are excluded')
  close(plan.times[0], 0)
  close(plan.times[1], 1 / 30, 1e-8)
  close(plan.times[2], 2 / 30, 1e-8)
  close(plan.times[149], 149 / 30, 1e-7)
  for (const sampled of plan.tracks) {
    assert.ok(sampled.path === 'position' || sampled.path === 'scale' || sampled.path === 'quaternion')
    assert.equal(sampled.components, sampled.path === 'quaternion' ? 4 : 3)
    assert.equal(sampled.values.length, plan.frameCount * sampled.components)
  }
  const rotation = plan.tracks.find(sampled => sampled.path === 'quaternion')
  for (let index = 0; index < plan.frameCount; index += 1) {
    const length = Math.hypot(
      rotation.values[index * 4], rotation.values[index * 4 + 1],
      rotation.values[index * 4 + 2], rotation.values[index * 4 + 3],
    )
    close(length, 1, 1e-6)
  }
  assert.deepEqual([...rotation.values.slice(0, 4)], [0, 0, 0, 1], 'rotation persists xyzw')
  close(rotation.values[4 * 75 + 2], Math.sin(Math.PI * 5 / 16), 1e-6)

  // THREE.PropertyBinding reserves [].:/ in track names, so export node names
  // must be sanitized while keeping the UID suffix unique.
  assert.equal(plugin.__trackExportNodeName('Alpha', 's:a1b2'), 'Alpha__s_a1b2')
  assert.equal(plugin.__trackExportNodeName('A.b/c[d]:e', 'm:1:2'), 'A_b_c_d__e__m_1_2')
  assert.equal(plugin.__trackExportNodeName('', ''), 'Object__uid')
  assert.equal(/[\[\].:\/]/.test(plugin.__trackExportNodeName('x.y', 's:z')), false)
  assert.ok(plugin.__TRACK_RUNTIME_SOURCE.includes('function trackExportNodeName('))

  const fallback = plugin.__buildAnimatedTrackPlan(tracks, live, 0, 30)
  assert.equal(fallback.duration, 4 + 1 / 30)
  assert.equal(fallback.frameCount, 121)
  assert.equal(plugin.__buildAnimatedTrackPlan(tracks, new Set(), 5, 30), null)
  assert.equal(plugin.__buildAnimatedTrackPlan(set(), live, 5, 30), null)
  assert.equal(plugin.__buildAnimatedTrackPlan(tracks, live, 5, 0).fps, 30, 'zero falls back to the documented 30 fps')
  assert.equal(plugin.__buildAnimatedTrackPlan(tracks, live, 5, 1).fps, 1)
  assert.equal(plugin.__buildAnimatedTrackPlan(tracks, live, 5, 999).fps, 120)

  const samplerStart = clientSource.indexOf('const buildAnimatedTransformClip = (fpsValue, durationValue) => {')
  const samplerEnd = clientSource.indexOf('const applyExportNames', samplerStart)
  const samplerBody = clientSource.slice(samplerStart, samplerEnd)
  assert.ok(samplerBody.includes('buildAnimatedTrackPlan(trackState, liveUids, duration, fpsValue)'))
  assert.ok(samplerBody.includes('trackExportNodeName(base, sampled.uid)'),
    'animated export node names avoid PropertyBinding reserved characters')
  assert.ok(samplerBody.includes('const duration = typeof durationValue === \'number\''))
  assert.ok(samplerBody.includes('new THREE.AnimationClip(\'Animation\', plan.duration'))
  assert.ok(samplerBody.includes('new THREE.QuaternionKeyframeTrack'))
  assert.ok(samplerBody.includes('new THREE.VectorKeyframeTrack'))
  assert.ok(samplerBody.includes('new THREE.AnimationClip'))
  assert.ok(samplerBody.includes('restoreNames'))
  assert.equal(samplerBody.includes('object.position'), false, 'sampling never reads the live scene pose')
  assert.equal(samplerBody.includes('onFrame'), false)
  const glbStart = clientSource.indexOf("if (data.command === 'export-gltf')")
  const glbEnd = clientSource.indexOf("if (data.command === 'export-stl')", glbStart)
  const glbBody = clientSource.slice(glbStart, glbEnd)
  assert.ok(glbBody.indexOf('finish()') < glbBody.indexOf("type: 'three-workbench:glb'"),
    'names, helpers and the export hold restore before delivery')
  // F8: the playhead pose is forced for both static and animated paths,
  // before sampling/parse. Sampled TRS values still come from the pure
  // evaluator, never the live pose.
  assert.ok(glbBody.includes('forceTrackPoseAt(timeline.time)'),
    'glTF forces the playhead pose for both static and animated exports')
  assert.equal(glbBody.includes('data.animated !== true'), false,
    'the forced playhead pose is not conditional on the static path')
})

test('P2-1 performance budgets are generous but guard gross regressions', () => {
  const items = []
  for (let trackIndex = 0; trackIndex < 200; trackIndex += 1) {
    const rotation = trackIndex % 3 === 1
    const path = rotation ? 'rotation' : (trackIndex % 3 === 2 ? 'scale' : 'position')
    const keys = []
    for (let keyIndex = 0; keyIndex < 50; keyIndex += 1) {
      const t = keyIndex / 20
      keys.push(rotation
        ? key(t, [0, 0, Math.sin(t / 2), Math.cos(t / 2)], keyIndex % 2 === 0 ? 'easeInOut' : 'linear')
        : key(t, [t, t + 1, t + 2], 'linear'))
    }
    items.push(track(`s:perf${String(trackIndex)}`, path, keys))
  }
  const raw = set(...items)
  const normalizeStart = performance.now()
  const normalized = normalize(raw)
  const normalizeMs = performance.now() - normalizeStart
  assert.equal(normalized.tracks.items.length, 200)
  assert.equal(normalized.tracks.items.reduce((total, item) => total + item.keys.length, 0), 10000)
  assert.ok(normalizeMs < 500, `normalize 200 tracks/10000 keys took ${normalizeMs.toFixed(1)}ms`)

  const samples = []
  const sampleStart = performance.now()
  for (let frame = 0; frame < 100; frame += 1) {
    const time = (frame % 50) / 20
    let sum = 0
    for (const item of normalized.tracks.items) {
      const value = plugin.__sampleTrack(item, time)
      sum += Array.isArray(value) ? value[0] : value
    }
    samples.push(sum)
  }
  const sampleMs = performance.now() - sampleStart
  assert.equal(samples.length, 100)
  const perFrame = sampleMs / 100
  assert.ok(perFrame < 20, `evaluating 200 tracks/10000 keys took ${perFrame.toFixed(2)}ms/frame`)

  const live = new Set(normalized.tracks.items.map(item => item.uid))
  const planStart = performance.now()
  const plan = plugin.__buildAnimatedTrackPlan(normalized.tracks, live, 5, 30)
  const planMs = performance.now() - planStart
  assert.equal(plan.frameCount, 150)
  assert.ok(planMs < 5000, `sampling 150 animated frames took ${planMs.toFixed(1)}ms`)

  const runtimeCompileStart = clientSource.indexOf('const compileTrackSet = (tracks, reason) => {')
  const runtimeCompileEnd = clientSource.indexOf('const initializeTracks', runtimeCompileStart)
  const compileBody = clientSource.slice(runtimeCompileStart, runtimeCompileEnd)
  assert.ok(compileBody.includes('Float64Array'), 'compiled times use typed arrays')
  assert.ok(compileBody.includes('Float32Array') || compileBody.includes('Uint8Array') || compileBody.includes('Uint32Array'))
  assert.ok(compileBody.includes('trackCompileMs'))
  const resendStart = clientSource.indexOf("command: 'tracks',", clientSource.indexOf('postMessage({', 13500))
  assert.ok(resendStart > 0)
  assert.ok(clientSource.slice(resendStart, resendStart + 220).includes("action: 'replace-all'"),
    'the only whole-track message is the explicit ready/edit replace-all')
  assert.equal((clientSource.match(/sendTrackAck\(requestId, \{[^}]*tracks:/g) || []).length, 0,
    'acks never echo track state')
})

test('P2-1 dope sheet is parent DOM, localized, accessible and outside captures', () => {
  const dopeStart = clientSource.indexOf('function DopeSheet(props) {')
  const dopeEnd = clientSource.indexOf('/** Toolbar plus the sandboxed frame', dopeStart)
  const dope = clientSource.slice(dopeStart, dopeEnd)
  assert.ok(dope.includes("'data-three-sheet': '1'"))
  assert.ok(dope.includes("role: 'region'"))
  assert.ok(dope.includes("'aria-label': t('editor.keys.title')"))
  assert.ok(dope.includes("t('editor.keys.auto')"))
  assert.ok(dope.includes("t('editor.keys.fit')"))
  assert.ok(dope.includes("event.key === 'Delete'"))
  assert.ok(dope.includes("event.key === 'Escape'"))
  assert.ok(dope.includes("String(event.key).toLowerCase() === 'k'"))
  assert.ok(dope.includes('items.length === 0 ? [] : selectedUids'),
    'an empty sheet shows its empty state instead of duplicating selected outliner names')
  assert.ok(clientSource.includes("top: editorOpen && !isWide ? 8 : undefined")
    && clientSource.includes("bottom: editorOpen && !isWide ? 'auto' : 8"),
  'the narrow-editor stats HUD stays off the viewport picking centre')
  assert.equal(/<iframe|srcDoc|postMessage\([^)]*token/i.test(dope), false)

  const previewStart = clientSource.indexOf('editorOpen ? h(TimelineBar,')
  const previewDope = clientSource.indexOf('editorOpen\n          ? h(DopeSheet,', previewStart)
  const building = clientSource.indexOf('        building\n          ? h(\'div\'', previewDope)
  assert.ok(previewStart > 0 && previewDope > previewStart && building > previewDope,
    'timeline and dope sheet are full-width siblings below the header and above notices')
  const panelStart = clientSource.indexOf("return h('div', { ref: panelRef")
  const headerClose = clientSource.indexOf("'×')),", panelStart)
  assert.ok(panelStart > 0 && headerClose > panelStart && headerClose < previewStart,
    'the preview header closes before the timeline and sheet siblings')
  assert.ok(clientSource.slice(headerClose, previewDope).includes('h(TimelineBar'),
    'the timeline starts outside the header row')
  for (const name of ['editor.keys.title', 'editor.keys.auto', 'editor.keys.addTrack', 'editor.keys.clear',
    'editor.keys.zoomIn', 'editor.keys.fit', 'editor.keys.expand', 'editor.keys.collapse',
    'editor.keys.textureUnbound', 'editor.keys.ruler', 'editor.keys.resize']) {
    assert.ok(clientSource.includes(`'${name}':`), `zh dictionary has ${name}`)
  }
  assert.ok((clientSource.match(/'editor\.keys\.title': /g) || []).length >= 2, 'both zh and en define the sheet strings')
  for (const name of ['editor.keys.textureUnbound', 'editor.keys.ruler', 'editor.keys.resize']) {
    assert.ok((clientSource.match(new RegExp(`'${name.replaceAll('.', '\\.')}': `, 'g')) || []).length >= 2,
      `both dictionaries define ${name}`)
  }
  assert.ok(dope.includes('width: 8, height: 8, marginLeft: -4, marginTop: -4'),
    'key diamonds are the designed 8 px')
  assert.ok(dope.includes("role: 'slider'") && dope.includes('tabIndex: 0')
    && dope.includes('onKeyDown: rulerKeyDown') && dope.includes("'aria-valuenow': trackRound6(timeline.time)"),
  'the ruler is a real, keyboard-operable control')
  assert.ok(dope.includes("role: 'separator'") && dope.includes('onKeyDown: resizeKeyDown')
    && dope.includes("'aria-valuenow': height") && dope.includes("t('editor.keys.resize')"),
  'the resize handle is a real, keyboard-operable control')
  assert.ok(readmeSource.includes('presets 0.25×/0.5×/1×/2×; the runtime accepts 0.1–4×'),
    'detailed docs speed range matches the runtime clamp and UI presets')
  assert.ok(clientSource.includes("if (data.action === 'set-speed' && typeof data.speed === 'number' && Number.isFinite(data.speed)) timeline.speed = Math.min(4, Math.max(0.1, data.speed))"))
  assert.ok(clientSource.includes('}, [0.25, 0.5, 1, 2].map(value => h(\'option\''))
  assert.ok(clientSource.includes('data-three-sheet'))
  assert.ok(clientSource.includes('candidatePaths'))
  assert.ok(clientSource.includes("props.onKeyCommit(node.uid, patch"))
  assert.ok(clientSource.includes("command('fragment', { uid, fragment: stored || {}, replace: true"))
  assert.ok(clientSource.includes('hasAnimatedTracks'))
  assert.ok(clientSource.includes("'export-gltf', { animated: true, fps: stepFps, duration: timeline.duration }"))
  assert.ok(clientSource.includes('animatedExport'))
})

test('P2-1 texture exact values, discrete needsUpdate and allocation-free hot paths', () => {
  const textureStart = clientSource.indexOf('const trackTextureExactValue = (object, uid, slot, textureSlot) => {')
  const textureEnd = clientSource.indexOf('const trackExactValue = (object, uid, descriptor) => {', textureStart)
  assert.ok(textureStart > 0 && textureEnd > textureStart)
  const textureBody = clientSource.slice(textureStart, textureEnd)
  assert.ok(textureBody.includes('if (compiled !== null) return compiled.lastAsset'),
    'an active track, including an explicit null key, owns the slot and shadows pins')
  assert.ok(textureBody.includes('texture.userData.wbAssetId'),
    'asset-backed script textures carry their catalogue id')
  assert.ok(textureBody.includes('if (texture === null || texture === undefined) return null'),
    'only a genuinely empty slot keys as explicit null')
  assert.equal((textureBody.match(/return null/g) || []).length, 1,
    'a non-asset texture is reported unavailable, never as a null key')
  assert.ok(textureBody.includes('return undefined'), 'unbound live textures are unavailable')
  const addStart = clientSource.indexOf('const addTrackAtSelection = async (uid, path) => {')
  const addEnd = clientSource.indexOf('const addTrackRef', addStart)
  const addBody = clientSource.slice(addStart, addEnd)
  assert.ok(addBody.includes("descriptor.kind === 'asset'") && addBody.includes('editor.keys.textureUnbound'),
    'Add-track explains an unbound texture instead of writing a null key')

  const applyStart = clientSource.indexOf('const applyTrackEntry = (entry, time) => {')
  const applyEnd = clientSource.indexOf('const trackMayApply = entry => {', applyStart)
  const applyBody = clientSource.slice(applyStart, applyEnd)
  const materialStart = applyBody.indexOf("if (entry.group === 'material') {")
  assert.ok(materialStart > 0)
  const materialBody = applyBody.slice(materialStart)
  assert.equal((materialBody.match(/target\.needsUpdate = true/g) || []).length, 2,
    'only the boolean and side branches rebuild the material program')
  const colorBranch = materialBody.slice(materialBody.indexOf("if (entry.kind === 'color') {"),
    materialBody.indexOf("if (entry.kind === 'asset') {"))
  assert.equal(/target\.needsUpdate\s*=/.test(colorBranch), false,
    'continuous color tracks never set needsUpdate')
  const numberBranch = materialBody.slice(materialBody.indexOf("if (entry.kind === 'number') {"),
    materialBody.indexOf("if (entry.kind === 'boolean') {"))
  assert.equal(/target\.needsUpdate\s*=/.test(numberBranch), false,
    'continuous numeric tracks never set needsUpdate')
  const lightStart = applyBody.indexOf("if (entry.group === 'light') {")
  const lightBody = applyBody.slice(lightStart, materialStart)
  assert.equal(lightBody.includes('trackBytesToHex'), false, 'the light hot path allocates no hex string')
  assert.equal(/\[red, green, blue\]/.test(lightBody), false, 'the light hot path allocates no array')
  assert.ok(lightBody.includes('srgbByteToLinear') && lightBody.includes('setRGB(red / 255, green / 255, blue / 255, THREE.SRGBColorSpace)'))

  const propsStart = clientSource.indexOf('const applyMaterialProps = (object, slot, props, pin) => {')
  const propsEnd = clientSource.indexOf('const LIGHT_PROPS =', propsStart)
  const propsBody = clientSource.slice(propsStart, propsEnd)
  assert.ok(propsBody.includes('if (discrete) target.needsUpdate = true'),
    'static pins rebuild the program only for discrete changes')
  assert.equal((propsBody.match(/needsUpdate/g) || []).length, 1,
    'numeric/color static pins do not rebuild the program')
})

test('P2-1 runtime precedence, key preview, inspector semantics and shared sheet mapping stay wired', () => {
  // The pure model is injected by .toString(), not duplicated by hand.
  assert.ok(plugin.__TRACK_RUNTIME_SOURCE.includes('function normalizeTrackSet('))
  assert.ok(plugin.__TRACK_RUNTIME_SOURCE.includes('function validateTrackSetMessage('))
  assert.ok(plugin.__TRACK_RUNTIME_SOURCE.includes('function sampleTrack('))
  assert.ok(plugin.__TRACK_RUNTIME_SOURCE.includes('function buildAnimatedTrackPlan('))
  assert.ok(plugin.__TRACK_RUNTIME_SOURCE.includes('const TRACK_MAX_TRACKS = ' + String(M)))
  assert.ok(plugin.__TRACK_RUNTIME_SOURCE.includes('const TRACK_MAX_KEYS_PER_TRACK = ' + String(K)))
  assert.ok(plugin.__TRACK_RUNTIME_SOURCE.includes('const TRACK_MAX_KEYS = 10000'))
  assert.equal(/\beval\s*\(|new Function|innerHTML|document\.write/.test(plugin.__TRACK_RUNTIME_SOURCE), false)

  // Frame order: script callbacks, static pins, tracks, transient preview,
  // deletion guard, controls, render. The evaluator owns no per-frame I/O.
  const loopStart = clientSource.indexOf('renderer.setAnimationLoop(() => {')
  const loopEnd = clientSource.indexOf('renderer.render(scene, camera)', loopStart)
  const loop = clientSource.slice(loopStart, loopEnd)
  const ordered = ['for (const callback of frameCallbacks)', 'applyPins()', 'applyTracks(time)',
    'applyKeyPreview()', 'for (const entry of removed.values())', 'controls.update()']
    .map(token => loop.indexOf(token))
  assert.ok(ordered.every(index => index >= 0), 'every frame stage is present')
  assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b), 'frame stages run in precedence order')
  assert.equal(/postMessage|localStorage|setEditor|commitTracks/.test(loop), false,
    'the hot frame loop sends no track/store messages')

  // Compiled evaluator: typed arrays, monotonic cursor and binary search,
  // reused segment state, and no per-frame value allocation on the hot path.
  const findStart = clientSource.indexOf('const findSegment = (entry, time) => {')
  const findEnd = clientSource.indexOf('const applyTrackEntry = (entry, time) => {', findStart)
  const findBody = clientSource.slice(findStart, findEnd)
  assert.ok(findBody.includes('trackSegmentState.index'))
  assert.ok(findBody.includes('entry.lastIndex'))
  assert.ok(findBody.includes('while (low <= high)'), 'out-of-order seeks fall back to binary search')
  assert.equal(findBody.includes('reduce('), false)
  const applyTracksStart = clientSource.indexOf('const applyTracks = time => {')
  const applyTracksEnd = clientSource.indexOf('// ---- Transient key preview', applyTracksStart)
  const applyTracksBody = clientSource.slice(applyTracksStart, applyTracksEnd)
  assert.equal(applyTracksBody.includes('sampleTrack('), false, 'the runtime evaluator never allocates sampled arrays')
  assert.ok(applyTracksBody.includes('applyTrackEntry(entry, time)'))
  const compileStart = clientSource.indexOf('const compileTrackSet = (tracks, reason) => {')
  const compileEnd = clientSource.indexOf('const initializeTracks', compileStart)
  const compileBody = clientSource.slice(compileStart, compileEnd)
  assert.ok(compileBody.includes('new Float64Array') || compileBody.includes('Float64Array.from'))
  assert.ok(compileBody.includes('new Int8Array') || compileBody.includes('Int8Array.from') || compileBody.includes('Uint8Array'))

  // Inspector treats preview > active track > stored pin, and any keyed path
  // upserts even with auto-key OFF; muted paths still belong to the track.
  const inspectorStart = clientSource.indexOf('function Inspector(props) {')
  const inspectorEnd = clientSource.indexOf('function TimelineBar(props) ', inspectorStart)
  const inspector = clientSource.slice(inspectorStart, inspectorEnd)
  assert.ok(inspector.includes('const activeTrackPath = path => keyedPaths.has(path) && !mutedPaths.has(path)'))
  assert.ok(inspector.indexOf('hasOwnProperty.call(previewValues, path)')
    < inspector.indexOf('activeTrackPath(path) && Object.prototype.hasOwnProperty.call(trackValues, path)'),
  'a transient preview wins over the evaluated track value')
  assert.ok(inspector.includes('const keyedPatchPaths = changedPaths => changedPaths.filter(path => keyedPaths.has(path)'))
  assert.ok(inspector.includes('if (applyKeyPatch(patch, commit, dirty)) return'))
  assert.ok(inspector.includes("if (props.onDeleteKeyAt !== undefined) void props.onDeleteKeyAt("))
  assert.ok(inspector.includes('trackQuaternionToEuler(rotationTrackValue, node.rotationOrder)'))

  // Parent key authoring: query exact values first, preview transiently, then
  // make exactly one replace-all commit and clear the preview.
  const previewStart = clientSource.indexOf('const beginKeyPreview = (uid, patch, mode) => {')
  const previewEnd = clientSource.indexOf('const applyKeysHistory', previewStart)
  const previewBody = clientSource.slice(previewStart, previewEnd)
  assert.ok(previewBody.includes('queryKeyValues(uid, gesture.paths)'))
  assert.ok(previewBody.includes("command('key-preview', { gestureId: gesture.id, ops })"))
  assert.ok(clientSource.includes("command('key-preview', { gestureId, ops: [], clear: true })"))
  assert.ok(previewBody.includes('clearKeyPreviewCommand(gesture.id)'))
  assert.ok(previewBody.includes("commitTracks({ action: 'insert', nextTracks: next, items, durationAfter, entry })"))
  assert.ok(previewBody.indexOf('clearKeyPreviewCommand(gesture.id)')
    < previewBody.indexOf("commitTracks({ action: 'insert'"), 'preview clears before the authoritative pose commits')
  assert.equal(/localStorage|setItem\(/.test(previewBody), false, 'preview gestures never write storage directly')
  assert.ok(previewBody.includes('const values = ack.values'))
  assert.ok(previewBody.includes('const exact = normalizeTrackValue(descriptor, values[path])'),
    'position/scale keep the exact unedited axes from the runtime ack')

  // Gizmo releases carry exact untruncated TRS, quaternion rotation and the
  // frozen time; the parent prefers them over the display-rounded fields.
  const exactStart = clientSource.indexOf('const exactTransformOf = object => ({')
  const exactEnd = clientSource.indexOf('const sendTransform = ', exactStart)
  const exactBody = clientSource.slice(exactStart, exactEnd)
  for (const field of ['exactPosition:', 'exactRotation:', 'exactScale:', 'time: timeline.time']) {
    assert.ok(exactBody.includes(field), 'gizmo payload includes ' + field)
  }
  assert.ok(clientSource.includes("send(Object.assign({ type: 'three-workbench:gizmo-commit', uid }, changed, exactTransformOf(object)))"))
  const gizmoStart = clientSource.indexOf('const commitGizmo = data => {')
  const gizmoEnd = clientSource.indexOf('gizmoCommitRef.current = commitGizmo', gizmoStart)
  const gizmoBody = clientSource.slice(gizmoStart, gizmoEnd)
  assert.ok(gizmoBody.includes('Array.isArray(data.exactPosition) ? data.exactPosition : data.position'))
  assert.ok(gizmoBody.includes("rotation: Array.isArray(data.exactRotation) ? data.exactRotation : data.rotation"))
  assert.ok(gizmoBody.includes("scale: Array.isArray(data.exactScale) ? data.exactScale : data.scale"))
  assert.ok(gizmoBody.includes('trackFinite(data.time) ? data.time : null'))

  // TimelineBar and the dope sheet share one viewMax computed from the
  // duration and the last key, so far keys stay visible and aligned.
  const sharedStart = clientSource.indexOf('const renderTracks = authoritativeTracksRef.current()')
  const sharedEnd = clientSource.indexOf('const sampledTrackValues', sharedStart)
  const shared = clientSource.slice(sharedStart, sharedEnd)
  assert.ok(shared.includes('sharedLastKey = Math.max(sharedLastKey, key.t)'))
  assert.ok(shared.includes('const sharedViewMax = Math.max(timeline.duration > 0 ? timeline.duration : 0, sharedLastKey, 0.5)'))
  assert.ok((clientSource.match(/viewMax: sharedViewMax/g) || []).length >= 2)
  assert.ok(clientSource.includes("const max = props.viewMax !== undefined && props.viewMax !== null && Number.isFinite(props.viewMax)"))
  assert.ok(clientSource.includes('labelWidth + (Math.max(0, Math.min(time, viewMax)) / viewMax) * trackWidth'))

  // Every still export and capture forces pins+tracks at the playhead; the
  // animated glTF alone samples the clip from the pure evaluator.
  const branchBody = command => {
    const start = clientSource.indexOf(`if (data.command === '${command}'`)
    assert.ok(start > 0, `missing ${command}`)
    return clientSource.slice(start, start + 2500)
  }
  for (const command of ['capture', 'export-stl', 'export-obj', 'record']) {
    assert.ok(branchBody(command).includes('forceTrackPoseAt(timeline.time)'),
      `${command} forces the authoritative playhead pose`)
  }
  assert.ok(branchBody('export-gltf').includes('forceTrackPoseAt(timeline.time)'),
    'glTF forces the playhead pose before sampling/parse for both paths')
  assert.equal(branchBody('export-gltf').includes('data.animated !== true'), false,
    'glTF export no longer gates the forced pose on the static path')
  const forceStart = clientSource.indexOf('const forceTrackPoseAt = time => {')
  const forceBody = clientSource.slice(forceStart, clientSource.indexOf('/**', forceStart))
  assert.deepEqual(['clearKeyPreview()', 'applyPins()', 'applyTracks(time)'].map(token => forceBody.indexOf(token)),
    [...['clearKeyPreview()', 'applyPins()', 'applyTracks(time)'].map(token => forceBody.indexOf(token))]
      .sort((a, b) => a - b), 'exports clear preview, assert pins, then evaluate tracks')
  assert.ok(forceBody.indexOf('clearKeyPreview()') < forceBody.indexOf('applyPins()'),
    'exports never bake a transient preview')
})

test('P2-1 tracks persist D1 identity across reload/Reset and pin resets refresh the release baseline', () => {
  const alphaNode = { uid: 's:alpha', type: 'Mesh', name: 'Alpha', anchor: 'Alpha', namedPath: 'Alpha', ordinalPath: '0', parentUid: null, wbId: null }
  const rigNode = { uid: 's:rig', type: 'Group', name: 'Rig', anchor: 'Rig', namedPath: 'Rig', ordinalPath: '1', parentUid: null, wbId: null }
  const childNode = { uid: 's:child', type: 'Mesh', name: '', anchor: '', namedPath: '', ordinalPath: '1/0', parentUid: 's:rig', wbId: null }
  const lightNode = { uid: 's:light', type: 'DirectionalLight', name: 'ProbeLight', anchor: 'ProbeLight', namedPath: 'ProbeLight', ordinalPath: '2', parentUid: null, wbId: null }
  const nodes = [alphaNode, rigNode, childNode, lightNode]
  const tracks = set(
    track('s:alpha', 'position', [key(0, [1, 0, 0])]),
    track('s:child', 'scale', [key(0, [1, 1, 1])]),
    track('s:light', 'light.intensity', [key(0, 1)]),
  )
  const committed = plugin.__recordWithTracks(plugin.__emptyEditorRecord(0), tracks, { now: 9, nodes })
  assert.equal(committed.ok, true)
  const committedObjects = committed.record.objects
  assert.equal(committedObjects['s:alpha'].uid, 's:alpha')
  assert.equal(committedObjects['s:alpha'].namedPath, 'Alpha')
  assert.equal(committedObjects['s:light'].uid, 's:light', 'track-only lights get an identity stub')
  assert.equal(committedObjects['s:rig'].uid, 's:rig', 'the parent stub is persisted before the ordinal child')
  assert.equal(committedObjects['s:child'].parentUid, 's:rig', 'the ordinal child points at the stored parent')
  assert.equal(committedObjects['s:alpha'].overrides !== undefined, true)

  const cleared = plugin.__clearEditorOverrides(committed.record, 10)
  assert.equal(cleared.objects['s:alpha'].uid, 's:alpha', 'Reset all keeps the tracked UID identity')
  assert.equal(cleared.objects['s:light'].uid, 's:light', 'Reset all keeps a track-only identity stub')
  assert.equal(cleared.objects['s:rig'].uid, 's:rig', 'Reset all keeps tracked ancestor stubs')
  assert.deepEqual(cleared.objects['s:alpha'].overrides, {})
  assert.deepEqual(cleared.tracks, plugin.__normalizeTrackSet(tracks, { strict: false }).tracks)

  const withoutNodes = plugin.__recordWithTracks(plugin.__emptyEditorRecord(0), tracks, { now: 11 })
  assert.equal(withoutNodes.ok, true)
  assert.equal(withoutNodes.record.objects['s:alpha'], undefined, 'identity is never guessed without a live node')

  const unpinStart = clientSource.indexOf('const unpinObject = uid => {')
  const unpinEnd = clientSource.indexOf('/**', unpinStart)
  assert.ok(clientSource.slice(unpinStart, unpinEnd).includes('refreshTrackBaselinesFromStatic(uid, before)'),
    'a static reset refreshes the release baseline used by mute/delete/clear')
  const refreshStart = clientSource.indexOf('const refreshTrackBaselinesFromStatic = (uid, before) => {')
  const refreshEnd = clientSource.indexOf('const srgbByteToLinear', refreshStart)
  const refresh = clientSource.slice(refreshStart, refreshEnd)
  for (const path of ['position', 'rotation', 'scale', 'visible', 'before.light']) {
    assert.ok(refresh.includes(path), `baseline refresh covers ${path}`)
  }
  assert.ok(refresh.includes('baseline.object !== entry.object'))
  assert.ok(clientSource.includes('nodes: treeLiveRef.current === null ? [] : treeLiveRef.current.nodes'),
    'the live tree supplies proven identities for track commits')
  assert.ok(clientSource.includes('trackedUids.has(uid)'))
})

test('P2-3 animated plan excludes keyless tracks and refuses the cap before allocation', () => {
  const live = new Set(['s:main', 's:keyless'])
  const tracks = set(
    track('s:keyless', 'position', []),
    track('s:main', 'position', [key(0, [0, 0, 0]), key(4, [4, 0, 0])]),
    track('s:main', 'rotation', [key(0, [0, 0, 0, 1]), key(4, [0, 0, 1, 0])]),
    track('s:main', 'visible', [key(0, true), key(4, false)]),
  )
  const plan = plugin.__buildAnimatedTrackPlan(tracks, live, 5, 30)
  assert.equal(plan.frameCount, 150)
  assert.equal(plan.tracks.length, 2, 'keyless and non-TRS tracks never fabricate a channel')
  assert.equal(plan.tracks.some(sampled => sampled.uid === 's:keyless'), false)
  assert.equal(plugin.__buildAnimatedTrackPlan(tracks, live, 5, NaN).fps, 30,
    'NaN keeps the documented 30 fps fallback')
  assert.equal(plugin.__buildAnimatedTrackPlan(tracks, live, 5, -5).fps, 1,
    'negative fps still clamps to 1')

  assert.equal(plugin.__MAX_ANIMATED_GLTF_FRAMES, 7200)
  assert.ok(plugin.__TRACK_RUNTIME_SOURCE.includes('const MAX_ANIMATED_GLTF_FRAMES = 7200'))
  const runtimeSourceStart = plugin.__TRACK_RUNTIME_SOURCE.indexOf('const MAX_ANIMATED_GLTF_FRAMES = 7200')
  const runtimePlanStart = plugin.__TRACK_RUNTIME_SOURCE.indexOf('buildAnimatedTrackPlan')
  assert.ok(runtimeSourceStart >= 0 && runtimeSourceStart < runtimePlanStart,
    'the injected runtime defines the cap before the plan function')

  const planStart = clientSource.indexOf('function buildAnimatedTrackPlan(')
  const planEnd = clientSource.indexOf('function trackEnabledTrsTracks(', planStart)
  assert.ok(planStart > 0 && planEnd > planStart)
  const planBody = clientSource.slice(planStart, planEnd)
  assert.ok(planBody.includes("if (!Array.isArray(track.keys) || track.keys.length === 0) continue"),
    'the keyless guard is inside the plan')
  const guardAt = planBody.indexOf('if (frameCount > MAX_ANIMATED_GLTF_FRAMES) {')
  const allocationAt = planBody.indexOf('new Float32Array(')
  assert.ok(guardAt > 0 && allocationAt > guardAt,
    'the typed cap refusal precedes every time/value allocation')
  const guard = planBody.slice(guardAt, allocationAt)
  assert.ok(guard.includes("const error = new Error('animated-frame-cap')"))
  assert.ok(guard.includes("error.code = 'animated-frame-cap'"))
  assert.ok(guard.includes('error.max = MAX_ANIMATED_GLTF_FRAMES'))
  assert.ok(guard.includes('error.count = frameCount'))
  assert.ok(guard.includes('throw error'))
  assert.equal(guard.includes('return null'), false,
    'the cap is a refusal, never the defensive static fallback')

  // Behavioral no-allocation proof: the cap throw must happen before the
  // first Float32Array construction, not merely before the returned plan.
  const RealFloat32Array = globalThis.Float32Array
  let allocations = 0
  function CountingFloat32Array(...args) {
    allocations += 1
    return new RealFloat32Array(...args)
  }
  CountingFloat32Array.prototype = RealFloat32Array.prototype
  let capError = null
  const capTracks = set(track('s:main', 'position', [key(0, [0, 0, 0]), key(120, [1, 2, 3])]))
  try {
    globalThis.Float32Array = CountingFloat32Array
    assert.throws(
      () => plugin.__buildAnimatedTrackPlan(capTracks, live, 120, 120),
      error => {
        capError = error
        return error instanceof Error && error.code === 'animated-frame-cap'
      },
    )
    assert.equal(allocations, 0, 'the cap throw allocates no times/values arrays')
    const small = plugin.__buildAnimatedTrackPlan(tracks, live, 5, 30)
    assert.equal(small.frameCount, 150)
    assert.ok(allocations >= 3, 'the allocation counter observes the normal path')
  } finally {
    globalThis.Float32Array = RealFloat32Array
  }
  assert.equal(capError.message, 'animated-frame-cap')
  assert.equal(capError.code, 'animated-frame-cap')
  assert.equal(capError.max, 7200)
  assert.equal(capError.count, 14400, '120 s at 120 fps computes the exact refused count')
})

test('P2-3 animated sampler reaches hidden scene nodes, forces visibility after sampling and cleans up once', () => {
  const samplerStart = clientSource.indexOf('const buildAnimatedTransformClip = (fpsValue, durationValue) => {')
  const samplerEnd = clientSource.indexOf('const applyExportNames', samplerStart)
  assert.ok(samplerStart > 0 && samplerEnd > samplerStart)
  const samplerBody = clientSource.slice(samplerStart, samplerEnd)

  // Scene-graph eligibility: live, non-deleted, reachable through .parent.
  // Visibility is deliberately not consulted, so hidden nodes stay eligible.
  assert.ok(samplerBody.includes('const isSceneReachable = object => {'))
  assert.ok(samplerBody.includes('if (current === scene) return true'))
  assert.ok(samplerBody.includes('current = current.parent'))
  const liveStart = samplerBody.indexOf('const liveUids = {')
  const liveEnd = samplerBody.indexOf('// The export command carries', liveStart)
  const liveBody = samplerBody.slice(liveStart, liveEnd)
  assert.ok(liveBody.includes('const object = uidObjects.get(uid)'))
  assert.ok(liveBody.includes('!deletedUids.has(uid)'))
  assert.ok(liveBody.includes('&& isSceneReachable(object)'))
  assert.equal(liveBody.includes('visible'), false,
    'hidden nodes are eligible; only detached/deleted objects are excluded')

  // Metadata travels with the clip (GLTFExporter writes it as extras).
  assert.ok(samplerBody.includes("const clip = new THREE.AnimationClip('Animation', plan.duration, animationTracks)"))
  assert.ok(samplerBody.includes('clip.userData = {'))
  for (const field of ['timelineDuration: plan.duration', 'fps: plan.fps', 'frameCount: plan.frameCount']) {
    assert.ok(samplerBody.includes(field), `clip.userData carries ${field}`)
  }

  // Sampling finishes before any visibility write. The force saves only
  // currently-hidden objects and walks up to, not including, the scene.
  const samplingAt = samplerBody.indexOf('const animationTracks = []')
  const forceDeclAt = samplerBody.indexOf('const forceVisible = object => {')
  const forceCallAt = samplerBody.indexOf('for (const object of sampledObjects) forceVisible(object)')
  const emptyAt = samplerBody.indexOf('if (animationTracks.length === 0) {')
  const clipAt = samplerBody.indexOf('const clip = new THREE.AnimationClip')
  assert.ok(samplingAt > 0 && forceDeclAt > samplingAt && forceCallAt > forceDeclAt
    && emptyAt > forceCallAt && clipAt > emptyAt,
  'plan/sample → visibility forcing → empty guard → clip construction is the only order')
  assert.ok(samplerBody.includes('if (!forcedVisibility.has(current) && current.visible === false) {'))
  assert.ok(samplerBody.includes('forcedVisibility.set(current, false)'))
  assert.ok(samplerBody.includes('current.visible = true'))
  assert.ok(samplerBody.includes('while (current !== null && current !== undefined && current !== scene)'))
  const afterForce = samplerBody.slice(forceDeclAt)
  assert.equal(/forceTrackPoseAt\s*\(|applyPins\s*\(|applyTracks\s*\(|applyKeyPreview\s*\(|clearKeyPreview\s*\(/.test(afterForce),
    false, 'no pose/pin/track/key-preview pass runs after visibility forcing')

  // One idempotent cleanup restores visibility and then names. The defensive
  // empty-channel path returns null so the caller exports the static scene.
  const cleanupStart = samplerBody.indexOf('const cleanup = () => {')
  const cleanupEnd = samplerBody.indexOf('\n    try {', cleanupStart)
  const cleanupBody = samplerBody.slice(cleanupStart, cleanupEnd)
  assert.ok(samplerBody.includes('let cleanedUp = false'))
  assert.ok(cleanupBody.includes('if (cleanedUp) return'))
  assert.ok(cleanupBody.includes('cleanedUp = true'))
  assert.ok(cleanupBody.includes('restoreVisibility()'))
  assert.ok(cleanupBody.includes('restoreNames()'))
  assert.ok(cleanupBody.indexOf('restoreVisibility()') < cleanupBody.indexOf('restoreNames()'),
    'visibility is restored before the temporary names')
  assert.ok(samplerBody.includes('restoreNames: cleanup'))
  assert.ok(samplerBody.includes('restoreVisibility,'))
  const emptyBody = samplerBody.slice(emptyAt, clipAt)
  assert.ok(emptyBody.includes('cleanup()') && emptyBody.includes('return null'),
    'the defensive empty-channel path cleans names/visibility and exports static')
  const samplerCatch = samplerBody.slice(samplerBody.lastIndexOf('} catch (error) {'))
  assert.ok(samplerCatch.includes('cleanup()'))
  assert.ok(samplerCatch.includes('throw error'),
    'planning/sampling throws, including the typed cap, propagate after cleanup')

  const glbStart = clientSource.indexOf("if (data.command === 'export-gltf')")
  const glbEnd = clientSource.indexOf("if (data.command === 'export-stl')", glbStart)
  const glbBody = clientSource.slice(glbStart, glbEnd)
  const forceAt = glbBody.indexOf('forceTrackPoseAt(timeline.time)')
  const animatedCallAt = glbBody.indexOf('animated = buildAnimatedTransformClip(')
  const parseAt = glbBody.indexOf('new GLTFExporter().parse(scene')
  assert.ok(forceAt > 0 && animatedCallAt > forceAt && parseAt > animatedCallAt,
    'source order is force → plan/sample → forced visibility → parse')
  assert.equal(/forceTrackPoseAt\s*\(|applyPins\s*\(|applyTracks\s*\(|applyKeyPreview\s*\(|clearKeyPreview\s*\(/.test(glbBody.slice(parseAt)),
    false, 'nothing re-poses the scene after visibility forcing and parse begins')

  // One finish path covers success, parse failure and planning/sampling throw.
  assert.ok(glbBody.includes('let finished = false'))
  const finishStart = glbBody.indexOf('const finish = () => {')
  const finishEnd = glbBody.indexOf('try {', finishStart)
  const finishBody = glbBody.slice(finishStart, finishEnd)
  assert.ok(finishBody.includes('if (finished) return'))
  assert.ok(finishBody.includes('animated.restoreNames()'))
  assert.ok(finishBody.includes('restoreAliases()'))
  assert.ok(finishBody.includes('restoreHelpers()'))
  assert.ok(finishBody.includes('releaseHold()'))
  assert.ok(glbBody.indexOf('restoreHelpers = detachHelpers()') < animatedCallAt)
  assert.ok(glbBody.indexOf('restoreAliases = applyExportNames()') < animatedCallAt)
  assert.ok(/result => \{\s*finish\(\)/.test(glbBody), 'success restores before delivery')
  assert.ok(/\}, error => \{\s*finish\(\)/.test(glbBody), 'a parse failure uses the same finish')
  assert.ok(/\} catch \(error\) \{\s*finish\(\)/.test(glbBody), 'a planning/sampling throw uses the same finish')
  assert.ok(glbBody.includes("error.code === 'animated-frame-cap'"))
  assert.ok(glbBody.includes("code: 'animated-frame-cap'"))
  assert.ok(glbBody.includes('max: error.max'))
  assert.ok(glbBody.includes('count: error.count'))
  assert.ok(glbBody.includes("command: 'export-gltf'"))
  assert.ok(glbBody.includes('const options = { binary: true }'))
  assert.ok(glbBody.includes('if (animated !== null) options.animations = [animated.clip]'),
    'a null animated clip leaves the static scene animation-free')
})

test('P2-3 animated menu, notices, parent mapping and detailed docs state the live-track contract', () => {
  const menuStart = clientSource.indexOf('const liveTreeUids = () => {')
  const menuEnd = clientSource.indexOf('// Tier 3 needs a bound parent UID', menuStart)
  assert.ok(menuStart > 0 && menuEnd > menuStart)
  const menuBody = clientSource.slice(menuStart, menuEnd)
  assert.ok(menuBody.includes('const current = treeLiveRef.current'))
  assert.ok(menuBody.includes('new Set(current.nodes.map(node => node.uid))'))
  assert.ok(menuBody.includes('trackEnabledTrsTracks(authoritativeTracksRef.current())'))
  assert.ok(menuBody.includes('.filter(track => live.has(track.uid))'),
    'only tracks bound to a live runtime UID count')
  assert.ok(menuBody.includes('const hasAnimatedTracks = liveAnimatedTracks().length > 0'))
  assert.ok(menuBody.includes('const fps = Math.min(120, Math.max(1, Math.floor(Number(stepFps) || 30)))'),
    'preflight uses the same FPS fallback as the plan')
  assert.ok(menuBody.includes('lastTRSKey + 1 / fps'))
  assert.ok(menuBody.includes('const requested = Number(timeline.duration)'))
  assert.ok(menuBody.includes('Number.isFinite(requested) && requested > 0'))
  assert.ok(menuBody.includes('Math.max(1, Math.round(duration * fps))'))
  assert.ok(menuBody.includes('if (count > MAX_ANIMATED_GLTF_FRAMES) {'))
  assert.ok(menuBody.includes("setProtocolNotice(t('editor.keys.animatedCap', { max: MAX_ANIMATED_GLTF_FRAMES, count }))"))
  assert.ok(menuBody.includes('return false') && menuBody.includes('return true'))

  const actionAt = clientSource.indexOf("menuItem(t('action.exportGlbAnimated')")
  assert.ok(actionAt > 0)
  assert.ok(clientSource.slice(actionAt - 200, actionAt).includes('hasAnimatedTracks'),
    'the animated action is gated on the live keyed-track check')
  const actionBody = clientSource.slice(actionAt, actionAt + 700)
  const preflightAt = actionBody.indexOf('if (!preflightAnimatedExport()) return')
  const dispatchAt = actionBody.indexOf("commandAfterAssets('export-gltf', { animated: true, fps: stepFps, duration: timeline.duration })")
  const noticeAt = actionBody.indexOf("setProtocolNotice(t('editor.keys.animatedExport'))")
  assert.ok(preflightAt > 0 && dispatchAt > preflightAt && noticeAt > dispatchAt,
    'the cap preflight refuses before dispatch and the notice follows delivery dispatch')

  const parentStart = clientSource.indexOf("if (data.type === 'three-workbench:error') {")
  const parentEnd = clientSource.indexOf("if (data.type === 'three-workbench:console')", parentStart)
  assert.ok(parentStart > 0 && parentEnd > parentStart)
  const parentBody = clientSource.slice(parentStart, parentEnd)
  assert.ok(parentBody.includes("if (data.code === 'animated-frame-cap') {"))
  assert.ok(parentBody.includes('typeof data.max === \'number\' && Number.isFinite(data.max)'))
  assert.ok(parentBody.includes('? data.max : MAX_ANIMATED_GLTF_FRAMES'))
  assert.ok(parentBody.includes('typeof data.count === \'number\' && Number.isFinite(data.count) ? data.count : 0'))
  assert.ok(parentBody.includes("setProtocolNotice(t('editor.keys.animatedCap', { max, count }))"),
    'a direct protocol refusal gets the same localized cap notice')
  assert.ok(parentBody.includes("setErrorText(typeof data.message === 'string' ? data.message : '')"))
  assert.ok(parentBody.includes("if (data.command === 'export-gltf') setProtocolNotice(t('assets.exportFailed'))"),
    'uncoded export failures surface the existing localized export-failure notice')

  const zhAnimated = '动画 glTF 导出中：仅位置/旋转/缩放；可见性、材质、灯光与脚本动画不包含'
  const enAnimated = 'Exporting animated glTF: transforms only; visibility, material, light and script motion are excluded'
  const zhCap = '动画 glTF 帧数过多：最多 {max} 帧（当前 {count} 帧）'
  const enCap = 'Animated glTF is too large: at most {max} frames (this plan has {count})'
  for (const text of [zhAnimated, enAnimated, zhCap, enCap]) {
    assert.ok(clientSource.includes(text), `notice wording is exact: ${text}`)
  }
  assert.equal(clientSource.includes('已导出动画'), false, 'the animated dispatch never claims success')
  assert.equal(clientSource.includes('Animated glTF exported'), false, 'the animated dispatch never claims success')
  assert.ok((clientSource.match(/'editor\.keys\.animatedExport': /g) || []).length >= 2,
    'both dictionaries define the exporting notice')
  assert.ok((clientSource.match(/'editor\.keys\.animatedCap': /g) || []).length >= 2,
    'both dictionaries define the cap notice')

  assert.ok(readmeSource.includes('extras.timelineDuration'),
    'detailed docs document the metadata contract')
  assert.ok(readmeSource.includes('4.9667'),
    'detailed docs state the loaded last-key duration')
  assert.ok(readmeSource.includes('7200'),
    'detailed docs state the animated frame cap')
  assert.ok(readmeSource.includes('hidden ancestor'),
    'detailed docs state forced hidden-ancestor serialization')
  assert.ok(readmeSource.includes('isolated hidden'),
    'README states that isolated hidden non-tracked nodes stay omitted')
  assert.ok(readmeSource.includes('detached'),
    'README states that detached nodes are excluded')
  assert.ok(readmeSource.includes('AnimationMixer'),
    'README states the playback acceptance check')
})
