/**
 * Manual / film presentation records — pure contracts.
 *
 * The editor record is additive: old v2 records without `presentation` still
 * normalize, and a saved presentation survives localStorage reload. These
 * checks pin caps, defaults and the proposal bridge without a browser.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')

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
await import(`${pathToFileURL(new URL('../client.js', import.meta.url).pathname).href}?presentation=${String(Date.now())}`)
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

const camera = (x = 0, y = 2, z = 6) => ({ position: [x, y, z], target: [0, 1, 0], fov: 45 })
const step = (index = 1) => ({
  id: `step-${index}`,
  title: `Step ${index}`,
  body: 'Body',
  camera: camera(index, 2, 6),
  time: 0.5,
  hidden: ['s:hidden'],
  highlight: 's:hero',
  parts: [{ name: 'Bolt', number: 'B-01' }],
  hotspots: [{ id: 'hotspot-1', uid: 's:hero', label: 'Hero' }],
  duration: 2,
})
const manual = (steps = [step()]) => ({
  v: 1, title: 'Lamp', product: 'LUMEN', version: '1.0', language: 'zh',
  parts: [{ id: 'part-1', number: 'B-01', name: 'Bolt', qty: 4, uid: 's:hero' }],
  steps,
})
const film = (shots = []) => ({
  v: 1, title: 'Launch', aspect: '9:16', resolution: '1080p', fps: 60, shots,
  captions: [{ start: 0, end: 1.5, text: 'Hello' }],
  music: { id: 'music-1', name: 'Bed', mime: 'audio/mpeg', bytes: 1024, duration: 10, gain: 1, offset: 0, fadeIn: 0.5, fadeOut: 1 },
})

test('manual steps normalize cameras, UIDs, parts and caps', () => {
  const normalized = plugin.__normalizePresentationManual(manual(), null)
  assert.equal(normalized.v, 1)
  assert.equal(normalized.language, 'zh')
  assert.equal(normalized.steps.length, 1)
  assert.deepEqual(normalized.steps[0].camera, { position: [1, 2, 6], target: [0, 1, 0], fov: 45 })
  assert.deepEqual(normalized.steps[0].hidden, ['s:hidden'])
  assert.equal(normalized.steps[0].highlight, 's:hero')
  assert.deepEqual(normalized.steps[0].parts, [{ name: 'Bolt', number: 'B-01' }])
  assert.deepEqual(normalized.steps[0].hotspots, [{ id: 'hotspot-1', uid: 's:hero', label: 'Hero' }])
  assert.deepEqual(normalized.parts, [{ id: 'part-1', number: 'B-01', name: 'Bolt', qty: 4, uid: 's:hero' }])

  const many = plugin.__normalizePresentationManual(manual(
    Array.from({ length: 80 }, (_, index) => step(index + 1)),
  ), null)
  assert.equal(many.steps.length, plugin.__PRESENTATION_MANUAL_STEPS_MAX)

  const invalidCamera = plugin.__normalizePresentationManual(manual([
    { ...step(), camera: { position: [0, 0, Number.NaN], target: [0, 0, 0], fov: 45 } },
  ]), [])
  assert.equal(invalidCamera.steps.length, 0)

  const oversizedParts = plugin.__normalizePresentationManual(manual([
    { ...step(), parts: Array.from({ length: 30 }, (_, index) => ({ name: `P${index}`, number: '' })) },
  ]), null)
  assert.equal(oversizedParts.steps[0].parts.length, plugin.__PRESENTATION_MANUAL_PARTS_MAX)

  const invalidUids = plugin.__normalizePresentationManual(manual([
    { ...step(), hidden: ['not-a-uid', 's:ok', 4], highlight: 'not-a-uid' },
  ]), null)
  assert.deepEqual(invalidUids.steps[0].hidden, ['s:ok'])
  assert.equal(invalidUids.steps[0].highlight, null)

  const cappedBom = plugin.__normalizePresentationManual(Object.assign(manual(), {
    parts: Array.from({ length: 80 }, (_, index) => ({ id: `p-${index}`, name: `Part ${index}`, number: '', qty: 1, uid: null })),
  }), null)
  assert.equal(cappedBom.parts.length, plugin.__PRESENTATION_BOM_MAX)

  const cappedHotspots = plugin.__normalizePresentationManual(manual([
    { ...step(), hotspots: Array.from({ length: 30 }, (_, index) => ({ id: `h-${index}`, uid: 's:hero', label: `H${index}` })) },
  ]), null)
  assert.equal(cappedHotspots.steps[0].hotspots.length, plugin.__PRESENTATION_HOTSPOTS_MAX)
})

test('film settings normalize aspect, fps and bounded shots', () => {
  const normalized = plugin.__normalizePresentationFilm(film([
    { id: 'shot-1', name: 'Wide', position: [1, 2, 3], target: [0, 0, 0], fov: 40, time: 1 },
  ]), null)
  assert.equal(normalized.aspect, '9:16')
  assert.equal(normalized.fps, 60)
  assert.equal(normalized.shots.length, 1)
  assert.equal(normalized.shots[0].from.fov, 40)
  assert.equal(normalized.shots[0].to.fov, 40)
  assert.equal(normalized.shots[0].duration, 2)
  assert.equal(normalized.captions.length, 1)
  assert.equal(normalized.music.name, 'Bed')

  const fallback = plugin.__normalizePresentationFilm({
    v: 1, aspect: 'nope', fps: 99, shots: [],
  }, null)
  assert.equal(fallback.aspect, '16:9')
  assert.equal(fallback.fps, 30)
  assert.deepEqual(fallback.captions, [])
  assert.equal(fallback.music, null)

  const many = plugin.__normalizePresentationFilm(film(
    Array.from({ length: 40 }, (_, index) => ({
      id: `shot-${index}`, name: `Shot ${index}`, position: [0, 1, 2], target: [0, 0, 0], fov: 40, time: 0,
    })),
  ), null)
  assert.equal(many.shots.length, plugin.__PRESENTATION_FILM_SHOTS_MAX)
})

test('film sequence interpolates camera keys and round-trips SRT', () => {
  const shots = [{
    id: 'shot-1', name: 'Move', duration: 2,
    from: { position: [0, 0, 10], target: [0, 0, 0], fov: 50 },
    to: { position: [10, 0, 10], target: [0, 0, 0], fov: 30 },
  }]
  assert.equal(plugin.__filmShotsDuration(shots), 2)
  const start = plugin.__filmCameraAt(shots, 0)
  const mid = plugin.__filmCameraAt(shots, 1)
  const end = plugin.__filmCameraAt(shots, 2)
  assert.deepEqual(start.position, [0, 0, 10])
  assert.deepEqual(mid.position, [5, 0, 10])
  assert.equal(mid.fov, 40)
  assert.deepEqual(end.position, [10, 0, 10])

  const srt = plugin.__captionsToSrt([{ start: 0, end: 1.5, text: 'Hello' }])
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,500\nHello\n')
  assert.deepEqual(plugin.__parseSrt(srt), [{ start: 0, end: 1.5, text: 'Hello' }])
  assert.deepEqual(plugin.__parseSrt('not srt'), [])
  assert.equal(plugin.__exportSrtFilename(3, 30, 1920, 1080), 'three-scene-3-30fps-1080p.srt')

  const sequence = [
    { duration: 2, from: { position: [0, 0, 10], target: [0, 0, 0], fov: 50 }, to: { position: [2, 0, 10], target: [0, 0, 0], fov: 50 } },
    { duration: 3, from: { position: [10, 0, 10], target: [0, 0, 0], fov: 40 }, to: { position: [20, 0, 10], target: [0, 0, 0], fov: 40 } },
  ]
  assert.equal(plugin.__filmShotsDuration(sequence), 5)
  const cut = plugin.__filmCameraAt(sequence, 2.3)
  assert.ok(cut.position[0] > 10 && cut.position[0] < 11)
})

test('BOM CSV imports headers, quotes and caps and round-trips', () => {
  const parts = plugin.__parseBomCsv('number,name,qty\nB-01,"Bolt, steel",4\nB-02,Washer,2\n')
  assert.deepEqual(parts, [
    { number: 'B-01', name: 'Bolt, steel', qty: 4 },
    { number: 'B-02', name: 'Washer', qty: 2 },
  ])
  assert.deepEqual(plugin.__parseBomCsv('P-1,Plate,1\n'), [{ number: 'P-1', name: 'Plate', qty: 1 }])
  assert.deepEqual(plugin.__parseBomCsv('\uFEFF零件号,名称,数量\nA-1,螺栓,3\n'),
    [{ number: 'A-1', name: '螺栓', qty: 3 }])
  assert.equal(plugin.__parseBomCsv('number,name,qty\n"B-1","He said ""hi""",1.5\n')[0].name, 'He said "hi"')
  assert.deepEqual(plugin.__parseBomCsv(''), [])

  const capped = plugin.__parseBomCsv('number,name,qty\n'
    + Array.from({ length: 80 }, (_, index) => `P-${index},Part ${index},1`).join('\n'))
  assert.equal(capped.length, plugin.__PRESENTATION_BOM_MAX)

  const csv = plugin.__bomToCsv(parts)
  assert.ok(csv.startsWith('\uFEFFnumber,name,qty\n'))
  assert.match(csv, /"Bolt, steel"/)
  assert.deepEqual(plugin.__parseBomCsv(csv), parts)
})

test('editor record round-trips presentation through save/load', () => {
  const record = plugin.__emptyEditorRecord(1)
  const withPresentation = plugin.__updateEditorPresentation(record, {
    v: 1, manual: manual(), film: film(),
  }, 2)
  assert.equal(withPresentation.presentation.manual.steps.length, 1)
  assert.equal(withPresentation.presentation.film.fps, 60)

  const saved = new Map()
  const storage = {
    getItem: key => saved.has(key) ? saved.get(key) : null,
    setItem: (key, value) => saved.set(key, String(value)),
    removeItem: key => saved.delete(key),
  }
  assert.equal(plugin.__saveEditorSession(storage, 'session-a', withPresentation, { now: 3 }).ok, true)
  const loaded = plugin.__loadEditorSession(storage, 'session-a', { now: 4 })
  assert.equal(loaded.source, 'v2')
  assert.equal(loaded.record.presentation.manual.title, 'Lamp')
  assert.equal(loaded.record.presentation.film.aspect, '9:16')

  const cleared = plugin.__updateEditorPresentation(loaded.record, null, 5)
  assert.equal(cleared.presentation, undefined)
})

test('manual proposal bridge accepts wrapper and bare payloads', () => {
  assert.ok(plugin.__STUDIO_PROPOSAL_KINDS.includes('manual'))
  const wrapped = plugin.__normalizeStudioProposal({
    kind: 'manual', payload: { manual: manual() }, baseRevision: 4,
  }, null)
  assert.equal(wrapped.kind, 'manual')
  assert.equal(wrapped.baseRevision, 4)
  assert.equal(wrapped.payload.manual.steps.length, 1)

  const bare = plugin.__normalizeStudioProposal({
    kind: 'manual', payload: manual(), baseRevision: 5,
  }, null)
  assert.equal(bare.payload.manual.steps.length, 1)

  assert.equal(plugin.__normalizeStudioProposal({ kind: 'manual', payload: { manual: { v: 2 } } }, null), null)
  assert.equal(plugin.__normalizeStudioProposal({ kind: 'manual', payload: { manual: manual([]) } }, null), null)
})

test('film export stays deterministic and taps only render safe-area guides', () => {
  assert.match(clientSource, /film: true,\n\s+filmShots: shots/)
  assert.match(clientSource, /if \(job\.film === true\) \{\n\s+await abortExportJob\(job, t\('studio\.film\.exportUnsupported'\)\)/)
  assert.match(clientSource, /data-three-workbench-film-safe/)
  assert.match(clientSource, /preserveAspectRatio: 'xMidYMid meet'/)
  for (const key of ["'studio.film.safeArea'", "'studio.film.safeAreaHint'", "'studio.film.exportUnsupported'"]) {
    assert.ok((clientSource.match(new RegExp(key, 'g')) || []).length >= 2, key)
  }
})

test('film batch export runs every aspect sequentially', () => {
  assert.match(clientSource, /const studioExportFilmBatch = async settings => \{/)
  assert.match(clientSource, /for \(const aspect of PRESENTATION_ASPECTS\) \{/)
  assert.match(clientSource, /await studioExportFilmVariant\(settings, aspect\)/)
  assert.match(clientSource, /exportCompletedRef\.current > before/)
  assert.match(clientSource, /onExportAll: studioExportFilmBatch/)
  assert.match(clientSource, /studioFilmBatchRef\.current = true/)
  for (const key of ["'studio.film.exportAll'", "'studio.film.exportAllProgress'", "'studio.film.exportAllDone'", "'studio.film.exportAllPartial'"]) {
    assert.ok((clientSource.match(new RegExp(key, 'g')) || []).length >= 2, key)
  }
})

test('Manual and Film panels are wired with bilingual copy', () => {
  assert.match(clientSource, /data-three-workbench-drawer': 'manual'/)
  assert.match(clientSource, /data-three-workbench-drawer': 'film'/)
  assert.match(clientSource, /studioDockTabButton\('film'/)
  assert.match(clientSource, /\['manual', 'panel', t\('studio\.rail\.manual'\)\]/)
  assert.match(clientSource, /setPresentation,/)
  assert.match(clientSource, /onImportBom: studioImportManualBomCsv/)
  assert.match(clientSource, /onExportBom: studioDownloadManualBomCsv/)
  for (const key of ["'studio.manual.take'", "'studio.film.export'", "'studio.drawer.film'"]) {
    assert.ok((clientSource.match(new RegExp(key, 'g')) || []).length >= 2, key)
  }
  assert.match(clientSource, /startExport\('mp4', \{[\s\S]*?filmShots: shots[\s\S]*?srt: captionsToSrt\(captions\)/)
})
