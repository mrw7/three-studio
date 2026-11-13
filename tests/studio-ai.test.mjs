/**
 * AI-native Studio contract: proposals are data until applied, the Context
 * Shelf is normalized per Session, and manual geometry edits stay validated.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { apply as applyHost } from '../index.js'

function recordingHostContext() {
  const records = { tool: undefined, tools: {}, section: undefined, sections: {}, routes: [], inject: undefined }
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
    on(event, callback) {
      assert.equal(event, 'webserver/index-inject')
      records.inject = callback
      return () => {}
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
    webServer: { register(route) { records.routes.push(route); return () => {} } },
  }
  return ctx
}

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
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
}
await import(`${pathToFileURL(new URL('../client.js', import.meta.url).pathname).href}?studio-ai=${String(Date.now())}`)
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

test('Context Shelf defaults every reference on and accepts only booleans', () => {
  assert.deepEqual(client.__defaultStudioContextRefs(), {
    scene: true, selection: true, camera: true, timeline: true,
    assets: true, params: true, shots: true, review: true, measure: true,
    library: true, links: true, case: true,
  })
  assert.deepEqual(client.__studioContextRefIds, [
    'scene', 'selection', 'camera', 'timeline', 'assets', 'params',
    'shots', 'review', 'measure', 'library', 'links', 'case',
  ])
  const refs = client.__normalizeStudioContextRefs({
    scene: false, camera: 'no', timeline: true, injected: false,
  })
  assert.equal(refs.scene, false)
  assert.equal(refs.camera, true)
  assert.equal(refs.timeline, true)
  assert.equal(Object.hasOwn(refs, 'injected'), false)
  assert.deepEqual(client.__STUDIO_AI_MODES, ['ask', 'edit', 'review', 'direct'])
})

test('studio meta normalizes bounds, caps and stable generated ids', () => {
  const once = client.__normalizeStudioMeta({
    contextRefs: { scene: false },
    shots: [{ name: '  A  ', position: [1, 2, 3], target: [0, 0, 0], fov: 999 }],
    pins: [{ uid: 's:abc', message: '  fix  ', severity: 'nope' }],
    measures: [{ from: [0, 0, 0], to: [3, 4, 0], label: 'gap' }],
    advice: undefined,
    decisions: [{ kind: 'view', status: 'applied', summary: 'Frame front', rationale: 'Wide', revision: 2 }],
    links: [
      { fromUid: 's:a', toUid: 's:b', kind: 'nope', label: '  binds  ' },
      { fromUid: 's:a', toUid: 's:a', label: 'self' },
    ],
    recipes: [
      { name: '  Arch  ', description: ' door ', parts: [{ shape: 'box', params: { width: 2 } }] },
      { name: '', parts: [] },
    ],
    explode: 9,
    extra: 'dropped',
  }, 'session-a')
  assert.equal(once.v, 4)
  assert.equal(client.__studioMetaVersion, 4)
  assert.equal(once.decisions.length, 1)
  assert.equal(once.decisions[0].status, 'applied')
  assert.equal(once.decisions[0].revision, 2)
  assert.equal(once.sessionId, 'session-a')
  assert.equal(once.contextRefs.scene, false)
  assert.equal(once.shots[0].name, 'A')
  assert.equal(once.shots[0].fov, 120)
  assert.ok(once.shots[0].id.startsWith('shot:'))
  assert.equal(once.pins[0].severity, 'info')
  assert.equal(once.pins[0].resolved, false)
  assert.equal(once.measures[0].label, 'gap')
  assert.equal(once.links.length, 1)
  assert.equal(once.links[0].kind, 'relation')
  assert.equal(once.links[0].label, 'binds')
  assert.ok(once.links[0].id.startsWith('link:'))
  assert.equal(once.recipes.length, 1)
  assert.equal(once.recipes[0].name, 'Arch')
  assert.equal(once.recipes[0].parts[0].shape, 'box')
  assert.equal(once.recipes[0].parts[0].params.width, 2)
  assert.equal(once.recipes[0].parts[0].params.height, 1)
  assert.ok(once.recipes[0].id.startsWith('recipe:'))
  assert.equal(once.explode, 2)
  assert.equal(Object.hasOwn(once, 'extra'), false)
  assert.equal(Object.hasOwn(once, 'advice'), false)
  const twice = client.__normalizeStudioMeta(once, 'session-a')
  assert.deepEqual(twice.shots.map(shot => shot.id), once.shots.map(shot => shot.id))
  assert.deepEqual(twice.pins.map(pin => pin.id), once.pins.map(pin => pin.id))
  assert.deepEqual(twice.measures.map(measure => measure.id), once.measures.map(measure => measure.id))
  assert.deepEqual(twice.links.map(link => link.id), once.links.map(link => link.id))
  assert.deepEqual(twice.recipes.map(recipe => recipe.id), once.recipes.map(recipe => recipe.id))
  assert.deepEqual(twice.decisions.map(entry => entry.id), once.decisions.map(entry => entry.id))
  assert.equal(client.__studioMeasureLength(once.measures[0]), 5)
})

test('studio meta drops malformed shot anchors and enforces caps', () => {
  const meta = client.__normalizeStudioMeta({
    shots: [{ position: [0, 'x', 0], target: [0, 0, 0] }],
    pins: [{ message: 'no anchor' }],
    measures: [{ from: [0, 0, 0] }],
    links: [{ fromUid: '', toUid: 's:b' }],
    recipes: [{ name: 'Bad part', parts: [{ shape: 'nope' }] }],
    explode: 'loud',
  }, 'session-b')
  assert.deepEqual(meta.shots, [])
  assert.deepEqual(meta.pins, [])
  assert.deepEqual(meta.measures, [])
  assert.deepEqual(meta.links, [])
  assert.deepEqual(meta.recipes, [])
  assert.equal(meta.explode, 0)
})

test('case library is an original localized multi-stage registry', () => {
  const cases = client.__STUDIO_CASES
  assert.ok(cases.length >= 12, 'at least twelve curated cases')
  assert.deepEqual(client.__STUDIO_CASE_CATEGORIES, ['model', 'animation', 'camera', 'look', 'review'])
  assert.equal(client.__STUDIO_CASES_VERSION, 1)
  const ids = new Set()
  const serialized = JSON.stringify(cases)
  for (const entry of cases) {
    assert.match(entry.id, /^case_[a-z0-9_]+$/)
    assert.equal(ids.has(entry.id), false, 'unique case id: ' + entry.id)
    ids.add(entry.id)
    assert.ok(client.__STUDIO_CASE_CATEGORIES.includes(entry.category), 'known category: ' + entry.id)
    assert.ok(['cube', 'layers', 'cone', 'play', 'refresh', 'bolt', 'camera', 'focus', 'eye', 'sparkles', 'grid']
      .includes(entry.glyph), 'known glyph: ' + entry.id)
    const stages = client.__studioCaseStages(entry)
    assert.ok(stages.length >= 3, 'multi-stage case: ' + entry.id)
    const stageIds = new Set()
    for (const stage of stages) {
      assert.equal(stageIds.has(stage.id), false, 'unique stage id: ' + entry.id + '/' + stage.id)
      stageIds.add(stage.id)
      assert.ok(client.__STUDIO_AI_MODES.includes(stage.mode), 'known mode: ' + entry.id + '/' + stage.id)
      for (const locale of ['zh', 'en']) {
        assert.ok(client.__studioCaseText(stage.title, locale).length > 0, 'localized stage title: ' + entry.id)
        assert.ok(client.__studioCaseText(stage.prompt, locale).length > 80, 'localized stage prompt: ' + entry.id)
      }
    }
    for (const locale of ['zh', 'en']) {
      assert.ok(client.__studioCaseTitle(entry, locale).length > 0, 'localized title: ' + entry.id)
      assert.ok(client.__studioCaseText(entry.summary, locale).length > 20, 'localized summary: ' + entry.id)
      assert.ok(client.__studioCaseChecks(entry, locale).length >= 1, 'checks: ' + entry.id)
    }
  }
  // A brief is prompt text, not a component or a demo payload.
  assert.equal(/https?:\/\//.test(serialized), false, 'no external URLs in case briefs')
  assert.equal(serialized.includes('```'), false, 'no code fences in case briefs')
  const stage = client.__studioCaseStages(cases[0])[0]
  const prompt = client.__studioCasePrompt(cases[0], stage, 'en')
  assert.ok(prompt.includes(stage.prompt.en))
  assert.ok(prompt.includes('workbench_proposal'))
  assert.ok(prompt.includes('three_scene'))
  assert.equal(client.__studioCasePrompt(cases[0], stage, 'zh').includes('工作台约定'), true)
})

test('custom cases and the active case stay bounded and inert', () => {
  const custom = client.__normalizeStudioCustomCase({
    id: 'case:user', title: '  My brief  ', category: 'animation',
    brief: '  Make a loop  ', mode: 'review', at: 5, extra: 'dropped',
  }, 0)
  assert.deepEqual(custom, {
    id: 'case:user', title: 'My brief', category: 'animation',
    mode: 'review', brief: 'Make a loop', at: 5,
  })
  assert.equal(client.__normalizeStudioCustomCase({ title: '', brief: 'x' }), null)
  assert.equal(client.__normalizeStudioCustomCase({ title: 'x', brief: '   ' }), null)
  const long = client.__normalizeStudioCustomCase({ title: 'x', brief: 'y'.repeat(5000) })
  assert.equal(long.brief.length, 4000)
  assert.ok(long.id.startsWith('case:'))
  assert.equal(long.category, 'model')
  assert.equal(client.__normalizeStudioActiveCase(null), null)
  const active = client.__normalizeStudioActiveCase({ caseId: 'case:user', stageIndex: 3, at: 7 })
  assert.equal(active.caseId, 'case:user')
  assert.equal(active.stageIndex, 3)
  assert.equal(active.at, 7)
  assert.equal(client.__normalizeStudioActiveCase({ caseId: '../escape', stageIndex: 1 }), null)
  assert.equal(client.__normalizeStudioActiveCase({ caseId: '', stageIndex: 1 }), null)
  const meta = client.__normalizeStudioMeta({
    customCases: [custom, { title: 'bad', brief: '' }],
    activeCase: { caseId: 'case:user', stageIndex: 2 },
  }, 'session-c')
  assert.equal(meta.customCases.length, 1)
  assert.equal(meta.customCases[0].title, 'My brief')
  assert.equal(meta.activeCase.caseId, 'case:user')
  assert.equal(meta.activeCase.stageIndex, 2)
  assert.equal(client.__studioFindCase('case_task_lamp', []).id, 'case_task_lamp')
  assert.equal(client.__studioFindCase(custom.id, [custom]).title, 'My brief')
  assert.equal(client.__studioFindCase('case_missing', [custom]), null)
})

test('proposal normalization preserves base revision and kind payloads', () => {
  const shots = client.__normalizeStudioProposal({
    id: 'proposal_abc',
    kind: 'shots',
    baseRevision: 7,
    rationale: '  Three beats  ',
    payload: { shots: [{ name: 'Wide', position: [0, 2, 6], target: [0, 0, 0], fov: 40 }] },
  }, 1)
  assert.equal(shots.id, 'proposal_abc')
  assert.equal(shots.baseRevision, 7)
  assert.equal(shots.rationale, 'Three beats')
  assert.equal(shots.payload.shots.length, 1)

  const fallback = client.__normalizeStudioProposal({
    kind: 'view', payload: { preset: 'front' },
  }, 4)
  assert.equal(fallback.baseRevision, 4)
  assert.ok(fallback.id.startsWith('proposal:'))

  const custom = client.__normalizeStudioProposal({
    kind: 'view', payload: { position: [1, 2, 3], target: [0, 0, 0] },
  }, 2)
  assert.equal(custom.payload.preset, null)
  assert.deepEqual(custom.payload.position, [1, 2, 3])

  const geometry = client.__normalizeStudioProposal({
    kind: 'geometry', payload: { uid: 'm:abc', params: { width: 2 } },
  }, 3)
  assert.deepEqual(geometry.payload.params, { width: 2 })

  const plan = client.__normalizeStudioProposal({
    kind: 'view', payload: { preset: 'plan' },
  }, 3)
  assert.equal(plan.payload.preset, 'top')
  assert.equal(plan.payload.projection, 'orthographic')

  const insert = client.__normalizeStudioProposal({
    kind: 'insert',
    payload: { shape: 'box', params: { width: 2 }, origin: [1, 0, 2] },
  }, 5)
  assert.deepEqual(insert.payload.origin, [1, 0, 2])
  assert.equal(insert.payload.parts.length, 1)
  assert.equal(insert.payload.parts[0].shape, 'box')
  assert.equal(insert.payload.parts[0].params.width, 2)

  const insertRecipe = client.__normalizeStudioProposal({
    kind: 'insert', payload: { recipeId: 'recipe_abc', origin: [0, 0, 1] },
  }, 5)
  assert.equal(insertRecipe.payload.recipeId, 'recipe_abc')
  assert.deepEqual(insertRecipe.payload.parts, [])

  const recipe = client.__normalizeStudioProposal({
    kind: 'recipe', payload: { name: 'Arch', parts: [{ shape: 'box' }] },
  }, 6)
  assert.equal(recipe.payload.name, 'Arch')
  assert.equal(recipe.payload.parts.length, 1)
  assert.equal(Object.hasOwn(recipe.payload, 'id'), false)

  const link = client.__normalizeStudioProposal({
    kind: 'link', payload: { fromUid: 's:a', toUid: 's:b' },
  }, 7)
  assert.equal(link.payload.kind, 'relation')
  assert.equal(link.payload.fromUid, 's:a')

  assert.equal(client.__normalizeStudioProposal({ kind: 'nope', payload: {} }, 1), null)
  assert.equal(client.__normalizeStudioProposal({ kind: 'shots', payload: { shots: [] } }, 1), null)
  assert.equal(client.__normalizeStudioProposal({ kind: 'geometry', payload: { uid: '', params: {} } }, 1), null)
  assert.equal(client.__normalizeStudioProposal({ kind: 'insert', payload: {} }, 1), null)
  assert.equal(client.__normalizeStudioProposal({ kind: 'recipe', payload: { name: 'Empty', parts: [] } }, 1), null)
  assert.equal(client.__normalizeStudioProposal({
    kind: 'link', payload: { fromUid: 's:a', toUid: 's:a' },
  }, 1), null)
})

test('manual geometry updates merge only known primitive keys', () => {
  const item = client.__makeManualItem('box', 'm:one')
  const created = client.__createEditorManual(null, item, 100)
  assert.equal(created.ok, true)
  const updated = client.__updateEditorManual(created.record, 'm:one', {
    width: 2, bogus: 3, height: 'x',
  }, 200)
  assert.equal(updated.ok, true)
  assert.equal(updated.record.objects['m:one'].manual.params.width, 2)
  assert.equal(updated.record.objects['m:one'].manual.params.height, 1)
  assert.equal(Object.hasOwn(updated.record.objects['m:one'].manual.params, 'bogus'), false)
  const missing = client.__updateEditorManual(updated.record, 'm:missing', { width: 3 }, 300)
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'not-manual')
})

test('insert parts normalize once and commit as one manual batch', () => {
  const part = client.__normalizeStudioPart({
    shape: 'cylinder',
    name: '  Column  ',
    position: [1, 2, 3],
    rotation: [0, 90, 0],
    scale: [1, 2, 1],
    params: { radiusTop: 2, bogus: 9 },
    material: { color: '#ff0000', roughness: 0.2 },
  }, 0)
  assert.equal(part.name, 'Column')
  assert.equal(part.params.radiusTop, 2)
  assert.equal(part.params.radiusBottom, 0.5)
  assert.equal(Object.hasOwn(part.params, 'bogus'), false)
  assert.deepEqual(part.scale, [1, 2, 1])
  assert.equal(client.__normalizeStudioPart({ shape: 'box', scale: [0, 1, 1] }, 0), null)
  assert.equal(client.__normalizeStudioPart({ shape: 'box', params: { width: -1 } }, 0), null)
  assert.equal(client.__normalizeStudioPart({ shape: 'box', material: { color: 'red' } }, 0), null)

  const item = client.__studioPartToManualItem(part, 'm:two', [10, 0, 10])
  assert.equal(item.uid, 'm:two')
  assert.deepEqual(item.manual.transform.position, [11, 2, 13])
  assert.equal(item.manual.transform.rotation[1], 1.5708)
  assert.deepEqual(item.manual.transform.scale, [1, 2, 1])
  assert.equal(item.manual.params.radiusTop, 2)

  const batch = client.__createEditorManualBatch(null, [
    client.__makeManualItem('box', 'm:one'),
    item,
  ], 100)
  assert.equal(batch.ok, true)
  assert.equal(client.__manualObjectCount(batch.record), 2)
  assert.deepEqual(
    client.__normalizeManualManifest(batch.record.objects['m:two']).manual.transform.position,
    [11, 2, 13])

  const duplicate = client.__createEditorManualBatch(null, [
    client.__makeManualItem('box', 'm:dupe'),
    client.__makeManualItem('sphere', 'm:dupe'),
  ], 100)
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.error, 'manual-invalid')
  const conflict = client.__createEditorManualBatch(batch.record, [
    client.__makeManualItem('sphere', 'm:one'),
  ], 100)
  assert.equal(conflict.ok, false)
  assert.equal(conflict.error, 'uid-conflict')
})

test('host registers workbench_proposal and defaults baseRevision to the head', async () => {
  const ctx = recordingHostContext()
  applyHost(ctx)
  const tool = ctx.records.tools.workbench_proposal
  assert.ok(tool, 'proposal tool is registered')
  assert.equal(tool.name, 'workbench_proposal')
  assert.deepEqual(tool.parameters.required, ['kind', 'payload'])
  assert.match(ctx.records.sections['tool:workbench-proposal'].text, /A proposal is data/)
  const exec = { agent: { session: { id: 'sess-proposal' } } }
  await ctx.records.tools.three_scene.execute({ code: 'const a = 1' }, exec)
  await ctx.records.tools.three_scene.execute({ code: 'const a = 2' }, exec)
  const value = await tool.execute({
    kind: 'view',
    rationale: '  Frame the front  ',
    payload: { preset: 'front' },
  }, exec)
  assert.equal(value.kind, 'view')
  assert.equal(value.baseRevision, 2)
  assert.equal(value.rationale, 'Frame the front')
  assert.match(value.id, /^proposal_[a-f0-9]{24}$/)
  assert.deepEqual(tool.output.presentationMeta({}, value), { proposal: value })

  const pinned = await tool.execute({
    kind: 'explode', baseRevision: 1, payload: { amount: 0.4 },
  }, exec)
  assert.equal(pinned.baseRevision, 1)

  const inserted = await tool.execute({
    kind: 'insert',
    payload: { shape: 'box', params: { width: 2 }, origin: [0, 0, 0] },
  }, exec)
  assert.equal(inserted.payload.shape, 'box')
  const recipe = await tool.execute({
    kind: 'recipe', payload: { name: 'Arch', parts: [{ shape: 'box' }] },
  }, exec)
  assert.equal(recipe.payload.name, 'Arch')
  const linked = await tool.execute({
    kind: 'link', payload: { fromUid: 's:a', toUid: 's:b', kind: 'flow' },
  }, exec)
  assert.equal(linked.payload.fromUid, 's:a')
  const plan = await tool.execute({
    kind: 'view', payload: { preset: 'plan', projection: 'orthographic' },
  }, exec)
  assert.equal(plan.payload.projection, 'orthographic')

  await assert.rejects(tool.execute({ kind: 'nope', payload: {} }, exec), /kind must be one of/)
  await assert.rejects(tool.execute({ kind: 'measure', payload: { from: [0, 0, 0] } }, exec), /from and to/)
  await assert.rejects(tool.execute({ kind: 'geometry', payload: { uid: 'm:x', params: {} } }, exec), /non-empty params/)
  await assert.rejects(tool.execute({ kind: 'scene', payload: { prompt: '  ' } }, exec), /needs a prompt/)
  await assert.rejects(tool.execute({ kind: 'insert', payload: {} }, exec), /validated parts/)
  await assert.rejects(tool.execute({
    kind: 'recipe', payload: { name: 'Empty', parts: [] },
  }, exec), /name and validated parts/)
  await assert.rejects(tool.execute({
    kind: 'link', payload: { fromUid: 's:a', toUid: 's:a' },
  }, exec), /two different object uids/)
})

test('host brands the boot page before any client plugin can run', () => {
  const ctx = recordingHostContext()
  applyHost(ctx)
  assert.equal(typeof ctx.records.inject, 'function', 'webServer injection listener is registered')
  const table = []
  ctx.records.inject(table)
  assert.equal(table.length, 5)
  assert.equal(table[0].kind, 'html')
  assert.match(table[0].html, /<title>Three Studio<\/title>/)
  assert.match(table[0].html, /theme-color/)
  assert.equal(table[1].kind, 'style')
  assert.match(table[1].text, /data-three-workbench-boot/)
  assert.match(table[1].text, /--three-wb-boot-accent/)
  assert.match(table[1].text, /data-three-workbench-splash/)
  assert.match(table[1].text, /three-wb-splash-spin/)
  assert.match(table[1].text, /max-width:775px/)
  assert.equal(table[2].kind, 'script')
  assert.equal(table[2].placement, 'head')
  assert.match(table[2].text, /THREE STUDIO/)
  assert.match(table[2].text, /HARNESS/)
  assert.match(table[2].text, /Loading plugins/)
  assert.match(table[2].text, /正在加载工作台/)
  assert.equal(table[2].text.includes('</script'), false)
  // The body cover paints before the Host shell and is removed as soon as the
  // Studio overlay mounts, with a bounded wait and a loader-failure escape.
  assert.equal(table[3].kind, 'html')
  assert.equal(table[3].placement, 'body')
  assert.match(table[3].html, /data-three-workbench-splash/)
  assert.match(table[3].html, /THREE STUDIO/)
  assert.match(table[3].html, /role="status"/)
  assert.equal(table[4].kind, 'script')
  assert.equal(table[4].placement, 'body')
  assert.match(table[4].text, /data-three-workbench-studio="root"/)
  assert.match(table[4].text, /Failed to load plugins/)
  assert.match(table[4].text, /setTimeout\(done, 8000\)/)
  assert.equal(table[4].text.includes('</script'), false)
  const again = []
  ctx.records.inject(again)
  assert.equal(again.length, 5)
  assert.notEqual(again, table)
})
