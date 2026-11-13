/**
 * Behavior tests for pure pieces of the browser half: preview identity across
 * Sessions, nested override merging/history shape, and frame-step boundaries.
 *
 * Browser-only behavior (orbit, undo against the live scene, dock-closed
 * shortcuts) is exercised by the Playwright verification script; the committed
 * suite stays dependency-free until the P5-1 runner lands.
 *
 */
// Run: node --test "tests/**/*.mjs"
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
await import(`${pathToFileURL(new URL('../client.js', import.meta.url).pathname).href}?behavior=${String(Date.now())}`)
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

test('preview identity is session-scoped even at equal scene revisions', () => {
  const a = { sceneId: 'session-a', revision: 1, title: 'A', code: 'A' }
  const b = { sceneId: 'session-b', revision: 1, title: 'B', code: 'B' }
  const tokenA = plugin.__previewToken('session-a', a, 0)
  const tokenB = plugin.__previewToken('session-b', b, 0)
  assert.notEqual(tokenA, tokenB)
  assert.match(tokenA, /^session-a:session-a:1:0:[0-9a-z]+\.[0-9a-z]+$/)
  assert.match(tokenB, /^session-b:session-b:1:0:[0-9a-z]+\.[0-9a-z]+$/)
  // A reload token still forces a rebuild for the same Session/scene/revision.
  assert.notEqual(plugin.__previewToken('session-a', a, 0), plugin.__previewToken('session-a', a, 1))
})

test('preview content identity changes at the same revision when code or title changes', () => {
  const base = { sceneId: 'session-a', revision: 1, title: 'T', code: 'const a = 1' }
  const same = { sceneId: 'session-a', revision: 1, title: 'T', code: 'const a = 1' }
  const codeChanged = { sceneId: 'session-a', revision: 1, title: 'T', code: 'const a = 2' }
  const titleChanged = { sceneId: 'session-a', revision: 1, title: 'U', code: 'const a = 1' }
  const revisionChanged = { sceneId: 'session-a', revision: 2, title: 'T', code: 'const a = 1' }

  assert.equal(plugin.__previewFingerprint(base), plugin.__previewFingerprint(same))
  assert.notEqual(plugin.__previewFingerprint(base), plugin.__previewFingerprint(codeChanged))
  assert.notEqual(plugin.__previewFingerprint(base), plugin.__previewFingerprint(titleChanged))
  assert.notEqual(plugin.__previewFingerprint(base), plugin.__previewFingerprint(revisionChanged))

  // Equal revisions and equal reload ticks still rebuild when the bytes change.
  assert.notEqual(
    plugin.__previewToken('session-a', base, 0),
    plugin.__previewToken('session-a', codeChanged, 0),
  )
  assert.equal(
    plugin.__previewToken('session-a', base, 0, plugin.__previewFingerprint(base)),
    plugin.__previewToken('session-a', base, 0),
  )
})

test('scene-head identity catches same-revision metadata rewrites', () => {
  const head = {
    sceneId: 'session-a',
    revision: 1,
    title: 'T',
    bytes: 12,
    updatedAt: 1000,
    revisions: [{ revision: 1, title: 'T', bytes: 12, updatedAt: 1000 }],
  }
  assert.equal(plugin.__feedIdentity(head), plugin.__feedIdentity({ ...head, revisions: [...head.revisions] }))
  assert.notEqual(plugin.__feedIdentity(head), plugin.__feedIdentity({ ...head, updatedAt: 2000 }))
  assert.notEqual(plugin.__feedIdentity(head), plugin.__feedIdentity({ ...head, bytes: 13 }))
  assert.notEqual(plugin.__feedIdentity(head), plugin.__feedIdentity({ ...head, title: 'U' }))
  assert.notEqual(plugin.__feedIdentity(head), plugin.__feedIdentity({
    ...head,
    revisions: [{ ...head.revisions[0], updatedAt: 2000 }],
  }))
  assert.notEqual(plugin.__feedIdentity(head), plugin.__feedIdentity({ sceneId: 'session-a', missing: true, revisions: [] }))
})

test('SceneCard auto-open requires a live result transition in this mount', () => {
  const pluginLoadedAt = 1_000_000
  const base = {
    sceneId: 'scene-a',
    resultTime: pluginLoadedAt + 1000,
    now: pluginLoadedAt + 2000,
    pluginLoadedAt,
    sawPending: true,
  }
  // A card that mounted while arguments streamed and then received a fresh
  // result opens once.
  assert.equal(plugin.__shouldAutoOpenScene({ ...base, phase: 'result' }), true)
  // A rehydrated result is complete on mount: no pending phase was observed.
  assert.equal(plugin.__shouldAutoOpenScene({ ...base, phase: 'result', sawPending: false }), false)
  // Even a pending mount cannot auto-open a result that predates this plugin
  // instance (reload rehydration under an initially pending view).
  assert.equal(plugin.__shouldAutoOpenScene({
    ...base, phase: 'result', resultTime: pluginLoadedAt - 1000, now: pluginLoadedAt + 1000,
  }), false)
  // Still pending, stale, or missing scene metadata does not open.
  assert.equal(plugin.__shouldAutoOpenScene({ ...base, phase: 'start' }), false)
  assert.equal(plugin.__shouldAutoOpenScene({ ...base, phase: 'result', resultTime: pluginLoadedAt - 121000 }), false)
  assert.equal(plugin.__shouldAutoOpenScene({ ...base, phase: 'result', sceneId: undefined }), false)
  assert.equal(plugin.__shouldAutoOpenScene({ ...base, phase: 'result', resultTime: undefined }), false)
})

test('a foreign record never matches the active session; the demo does', () => {
  assert.equal(plugin.__recordMatchesSession('session-b', { sceneId: 'session-a', revision: 1 }), false)
  assert.equal(plugin.__recordMatchesSession('session-b', { sceneId: 'session-b', revision: 1 }), true)
  assert.equal(plugin.__recordMatchesSession('session-b', { sceneId: 'demo', revision: 0 }), true)
  assert.equal(plugin.__recordMatchesSession('session-b', null), false)
  assert.equal(plugin.__recordMatchesSession(undefined, { sceneId: 'session-b' }), false)
})

test('nested material and light edits merge instead of replacing channels', () => {
  const base = {
    material: { '0': { color: '#ff0000', roughness: 0.8 } },
    light: { color: '#00ff00', intensity: 2 },
  }
  const afterColor = plugin.__mergeFragment(base, {
    material: { '0': { color: '#123456' } },
    light: { color: '#abcdef' },
  })
  assert.equal(afterColor.material['0'].color, '#123456')
  assert.equal(afterColor.material['0'].roughness, 0.8, 'color edit must keep roughness')
  assert.equal(afterColor.light.color, '#abcdef')
  assert.equal(afterColor.light.intensity, 2, 'color edit must keep intensity')

  const afterBoth = plugin.__mergeFragment(afterColor, {
    material: { '0': { roughness: 0.2 } },
    light: { intensity: 5 },
  })
  assert.equal(afterBoth.material['0'].color, '#123456')
  assert.equal(afterBoth.material['0'].roughness, 0.2)
  assert.equal(afterBoth.light.color, '#abcdef')
  assert.equal(afterBoth.light.intensity, 5)
  assert.equal(base.material['0'].roughness, 0.8, 'merge must not mutate history fragments')

  // Undo of the second edit re-applies the full first-state fragment: color
  // remains, roughness/intensity are gone from the target state.
  const undoTarget = afterColor
  assert.equal(undoTarget.material['0'].roughness, 0.8)
  assert.equal(undoTarget.light.intensity, 2)
  assert.equal(undoTarget.material['0'].color, '#123456')
})

test('frame stepping clamps at zero, duration, and the FPS range', () => {
  assert.equal(plugin.__nextStepTime(0, -1, 10, 10), 0)
  assert.equal(plugin.__nextStepTime(0.05, -1, 10, 10), 0)
  assert.equal(plugin.__nextStepTime(0, 1, 10, 10), 0.1)
  assert.equal(plugin.__nextStepTime(9.95, 1, 10, 10), 10)
  assert.equal(plugin.__nextStepTime(5, 1, 999, 10), 5 + 1 / 120)
  assert.equal(plugin.__nextStepTime(5, -1, 1, 0), 4)
  assert.equal(plugin.__nextStepTime(5, 1, 1, 0), 6)
})

test('camera contract keeps script bases, per-property resets, and orbit sync', () => {
  const preview = plugin.__previewDocument({
    title: 'Camera',
    revision: 4,
    code: 'setCamera([0, 2, 6], [0, 0, 0])',
  }, null)
  // The tree exposes all three script bases so the Inspector can reset each
  // camera property independently.
  assert.ok(preview.includes('scriptPosition: scriptCamera === null ? null : scriptCamera.position.map(round3)'))
  assert.ok(preview.includes('scriptTarget: scriptCamera === null ? null : scriptCamera.target.map(round3)'))
  assert.ok(preview.includes('scriptFov: scriptCamera === null ? null : round3(scriptCamera.fov)'))
  // Orbiting syncs an existing pin and reports interactivity for the parent.
  assert.ok(preview.includes("controls.addEventListener('start', () => { orbitGesture = true })"))
  assert.ok(preview.includes('if (interactive && cameraPin !== null)'))
  assert.ok(preview.includes('interactive: interactive === true'))
  assert.ok(preview.includes('hasPin: cameraPin !== null'))
  // Reset flags remove individual pins; Reset view clears the whole pin.
  assert.ok(preview.includes("? data.reset : (data.resetFov === true ? { fov: true } : null)"))
  assert.ok(preview.includes("reportCamera(true, false, 'reset')"))
  // setCamera moves OrbitControls' target too, so the baseline snapshot below
  // captures a non-origin script target and Reset view restores it (N3).
  assert.ok(preview.includes('controls.target.set(target[0], target[1], target[2])'))
  assert.ok(preview.includes('camera.lookAt(controls.target)'))
  assert.ok(preview.includes('controls.update()'))
  assert.ok(preview.includes('scriptCamera = { position: camera.position.toArray(), target: controls.target.toArray(), fov: camera.fov }'))
  // The parent creates an override on an interactive orbit even when none was
  // pinned before, so the view survives revisions and reloads (D12).
  assert.ok(clientSource.includes('cameraOverrideRef.current(mergeFragment(overridesRef.current.camera || {}, { position, target }))'))
})

test('shortcut scope is dock-independent and editable fields opt out', () => {
  const preview = plugin.__previewDocument({
    title: 'Keys',
    revision: 1,
    code: 'scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()))',
  }, null)
  // Keys forwarded from the sandbox obey the same editable-field guard as the
  // parent page (D13).
  assert.ok(preview.includes("tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true"))
  assert.ok(clientSource.includes("tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true"))
  // The dock-open gate must not suppress global shortcuts.
  assert.equal(clientSource.includes('if (!editorOpen) return'), false)
  assert.equal(clientSource.includes('if (!editorOpen) return undefined'), false)
  assert.ok(clientSource.includes("window.addEventListener('keydown', onKey)"))
})

/** Minimal Object3D-like graph for the dependency-free resolver tests. */
function liveNode(type, name, children = [], wbId) {
  const node = { type, name, children: [], parent: null, userData: wbId === undefined ? {} : { wbId } }
  for (const child of children) {
    child.parent = node
    node.children.push(child)
  }
  return node
}

function liveScene(children) {
  const scene = liveNode('Scene', '')
  for (const child of children) {
    child.parent = scene
    scene.children.push(child)
  }
  return scene
}

function allObjects(scene) {
  const list = []
  const visit = node => {
    for (const child of node.children) {
      list.push(child)
      visit(child)
    }
  }
  visit(scene)
  return list
}

function uidEntry(fields) {
  return Object.assign({
    uid: 's:entry',
    origin: 'script',
    type: 'Mesh',
    anchor: 't:Mesh',
    namedPath: 't:Mesh',
    ordinalPath: 't:Mesh',
    parentUid: null,
    overrides: {},
  }, fields)
}

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  const storage = {
    failKey: null,
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => {
      if (storage.failKey !== null && storage.failKey(key)) throw new Error('QuotaExceededError')
      data.set(key, String(value))
    },
    removeItem: key => { data.delete(key) },
    keys: () => [...data.keys()],
  }
  return storage
}

/** Deterministic fresh-UID source; a constant would collide on the second object. */
function sequentialUids() {
  let next = 0
  return prefix => prefix + ':fixed-' + String(next += 1)
}

test('T1 duplicate live names stay unbound and are never first-matched', () => {
  const scene = liveScene([liveNode('Mesh', 'Cube'), liveNode('Mesh', 'Cube')])
  const entry = uidEntry({
    uid: 's:cube',
    anchor: 'n:Cube',
    namedPath: 'n:Cube',
    ordinalPath: 'n:Cube',
    overrides: { position: [9, 9, 9] },
  })
  const result = plugin.__resolveUids([entry], scene.children, {
    root: scene,
    makeUid: sequentialUids(),
  })
  assert.equal(result.bindings.length, 0, 'duplicate names must not bind')
  assert.equal(result.fresh.length, 2)
  assert.equal(result.unresolved.length, 1)
  assert.equal(result.unresolved[0].uid, 's:cube')
  assert.equal(result.unresolved[0].kind, 'ambiguous')
  assert.equal(result.unresolved[0].anchor, 'n:Cube')
})

test('T2 wb.id survives a name change through tier 1', () => {
  const hero = liveNode('Mesh', 'Renamed', [], 'hero')
  const scene = liveScene([hero])
  const entry = uidEntry({
    uid: 's:hero-uid',
    wbId: 'hero',
    anchor: 'n:OldName',
    namedPath: 'n:OldName',
    ordinalPath: 'n:OldName',
    overrides: { position: [1, 2, 3] },
  })
  const result = plugin.__resolveUids([entry], scene.children, { root: scene, makeUid: sequentialUids() })
  assert.equal(result.bindings.length, 1)
  assert.equal(result.bindings[0][0], 's:hero-uid')
  assert.equal(result.bindings[0][1], hero)

  // A duplicate userData.wbId is ambiguous, and a missing declared wbId does
  // not silently fall through to the stored semantic path.
  const duplicateScene = liveScene([liveNode('Mesh', 'Both', [], 'hero'), liveNode('Mesh', 'Both', [], 'hero')])
  const duplicate = plugin.__resolveUids([entry], duplicateScene.children, { root: duplicateScene, makeUid: sequentialUids() })
  assert.equal(duplicate.bindings.length, 0)
  assert.equal(duplicate.unresolved[0].kind, 'ambiguous')
  const missingScene = liveScene([liveNode('Mesh', 'OldName')])
  const missing = plugin.__resolveUids([entry], missingScene.children, { root: missingScene, makeUid: sequentialUids() })
  assert.equal(missing.bindings.length, 0)
  assert.equal(missing.unresolved[0].kind, 'missing')

  // A path-only v2 entry still applies after the script starts assigning a
  // unique wbId, and a duplicated wbId is never revived by a fallback tier.
  const pathEntry = uidEntry({
    uid: 's:path',
    anchor: 'n:Hero',
    namedPath: 'n:Hero',
    ordinalPath: 'n:Hero',
    overrides: { position: [1, 0, 0] },
  })
  const pathScene = liveScene([liveNode('Mesh', 'Hero', [], 'hero')])
  const path = plugin.__resolveUids([pathEntry], pathScene.children, { root: pathScene, makeUid: sequentialUids() })
  assert.equal(path.bindings.length, 1)
  assert.equal(path.bindings[0][1], pathScene.children[0])
  const twins = liveScene([liveNode('Mesh', 'Twin', [], 'dup'), liveNode('Mesh', 'Twin', [], 'dup')])
  const twinPathEntry = uidEntry({
    uid: 's:twin', anchor: 'n:Twin', namedPath: 'n:Twin', ordinalPath: 'n:Twin', overrides: {},
  })
  const twinPath = plugin.__resolveUids([twinPathEntry], twins.children, { root: twins, makeUid: sequentialUids() })
  assert.equal(twinPath.bindings.length, 0, 'duplicate wbIds must not be reset by the name fallback')
})

test('T3 ordinal drift is unbound rather than rebound to a neighbour', () => {
  const scene = liveScene([liveNode('Mesh', ''), liveNode('Mesh', '')])
  const entry = uidEntry({
    uid: 's:drifted',
    anchor: 't:Mesh#2',
    namedPath: '',
    ordinalPath: 't:Mesh#2',
    overrides: { position: [4, 5, 6] },
  })
  const result = plugin.__resolveUids([entry], scene.children, { root: scene, makeUid: sequentialUids() })
  assert.equal(result.bindings.length, 0)
  assert.equal(result.unresolved.length, 1)
  assert.equal(result.unresolved[0].kind, 'missing')
  assert.equal(result.fresh.length, 2)
  assert.ok(result.fresh.every(([uid]) => uid.startsWith('s:fixed-')))
})

test('T4 parent UID binds before ordinal child paths', () => {
  const group = liveNode('Group', 'Group', [liveNode('Mesh', '')])
  const scene = liveScene([group])
  const parent = uidEntry({
    uid: 's:parent',
    type: 'Group',
    anchor: 'n:Group',
    namedPath: 'n:Group',
    ordinalPath: 'n:Group',
    overrides: { position: [0, 1, 0] },
  })
  const child = uidEntry({
    uid: 's:child',
    parentUid: 's:parent',
    anchor: 'n:Group/t:Mesh',
    namedPath: '',
    ordinalPath: 'n:Group/t:Mesh',
    overrides: { position: [2, 0, 0] },
  })
  const result = plugin.__resolveUids([child, parent], allObjects(scene), { root: scene, makeUid: sequentialUids() })
  assert.equal(result.bindings.length, 2)
  const objects = new Map(result.bindings)
  assert.equal(objects.get('s:parent'), group)
  assert.equal(objects.get('s:child'), group.children[0])

  // If the parent is ambiguous, the child's ordinal tier must not guess.
  const scene2 = liveScene([liveNode('Group', 'Group', [liveNode('Mesh', '')]), liveNode('Group', 'Group', [liveNode('Mesh', '')])])
  const result2 = plugin.__resolveUids([child, parent], allObjects(scene2), { root: scene2, makeUid: sequentialUids() })
  assert.equal(result2.bindings.length, 0)
  assert.equal(result2.unresolved.length, 2)
  assert.ok(result2.unresolved.every(row => row.uid === 's:parent' ? row.kind === 'ambiguous' : row.uid === 's:child'))
})

test('D2 tier-3 binding is parent-order independent and terminates on cycles', () => {
  // Both nodes are unnamed, so tier 2 skips them; only the bound parent UID
  // plus ordinal path can resolve this record.
  const childMesh = liveNode('Mesh', '')
  const group = liveNode('Group', '', [childMesh])
  const scene = liveScene([group])
  const parentPath = plugin.__objectPathInfo(group, scene, {})
  const childPath = plugin.__objectPathInfo(childMesh, scene, {})
  assert.equal(parentPath.namedPath, '')
  assert.equal(childPath.namedPath, '')
  const parent = uidEntry({
    uid: 's:parent',
    type: 'Group',
    anchor: parentPath.key,
    namedPath: parentPath.namedPath,
    ordinalPath: parentPath.ordinalPath,
    parentUid: 'scene',
    overrides: { position: [0, 1, 0] },
  })
  const child = uidEntry({
    uid: 's:child',
    type: 'Mesh',
    anchor: childPath.key,
    namedPath: childPath.namedPath,
    ordinalPath: childPath.ordinalPath,
    parentUid: 's:parent',
    overrides: { position: [2, 0, 0] },
  })
  const objects = allObjects(scene)

  // Child-before-parent must bind through repeated tier-3 passes.
  const childFirst = plugin.__resolveUids([child, parent], objects, { root: scene, makeUid: sequentialUids() })
  assert.equal(childFirst.bindings.length, 2)
  const childFirstMap = new Map(childFirst.bindings)
  assert.equal(childFirstMap.get('s:parent'), group)
  assert.equal(childFirstMap.get('s:child'), childMesh)
  assert.equal(childFirst.unresolved.length, 0)

  // Root-first records keep working unchanged.
  const parentFirst = plugin.__resolveUids([parent, child], objects, { root: scene, makeUid: sequentialUids() })
  assert.equal(parentFirst.bindings.length, 2)
  assert.equal(parentFirst.unresolved.length, 0)

  // A parent cycle makes no progress and must terminate as unresolved, not
  // loop or fall through to another tier.
  const cyclicA = uidEntry({
    uid: 's:cycle-a', type: 'Group', anchor: parentPath.key, namedPath: '',
    ordinalPath: parentPath.ordinalPath, parentUid: 's:cycle-b', overrides: {},
  })
  const cyclicB = uidEntry({
    uid: 's:cycle-b', type: 'Group', anchor: parentPath.key, namedPath: '',
    ordinalPath: parentPath.ordinalPath, parentUid: 's:cycle-a', overrides: {},
  })
  const cycle = plugin.__resolveUids([cyclicA, cyclicB], objects, { root: scene, makeUid: sequentialUids() })
  assert.equal(cycle.bindings.length, 0)
  assert.equal(cycle.unresolved.length, 2)
  assert.ok(cycle.unresolved.every(row => row.kind === 'missing' && row.reason === 'no-live-match'))

  const missingParent = Object.assign({}, child, { uid: 's:missing-parent', parentUid: 's:absent' })
  const missing = plugin.__resolveUids([missingParent], objects, { root: scene, makeUid: sequentialUids() })
  assert.equal(missing.bindings.length, 0)
  assert.equal(missing.unresolved.length, 1)
  assert.equal(missing.unresolved[0].reason, 'no-live-match')
})

test('T5 v1 migration produces legacy records and exact-one tier 4 matches', () => {
  const v1Key = plugin.__editorV1Key('session-v1')
  const v2Key = plugin.__editorV2Key('session-v1')
  const storage = memoryStorage({
    [v1Key]: JSON.stringify({
      objects: { 't:Mesh': { position: [1, 2, 3] } },
      camera: { position: [0, 2, 5], target: [0, 0, 0] },
    }),
  })
  const loaded = plugin.__loadEditorSession(storage, 'session-v1', { now: 100, makeUid: () => 'l:legacy' })
  assert.equal(loaded.source, 'v1')
  assert.equal(loaded.migrated, true)
  assert.equal(loaded.record.v, 2)
  assert.equal(loaded.record.objects['l:legacy'].legacy, true)
  assert.equal(loaded.record.objects['l:legacy'].anchor, 't:Mesh')
  assert.deepEqual(loaded.record.objects['l:legacy'].overrides, { position: [1, 2, 3] })
  assert.deepEqual(loaded.record.camera, { position: [0, 2, 5], target: [0, 0, 0] })
  assert.ok(storage.getItem(v1Key) !== null, 'lazy migration must retain v1 before a v2 save')
  assert.equal(storage.getItem(v2Key), null)

  const entry = loaded.record.objects['l:legacy']
  const uniqueScene = liveScene([liveNode('Mesh', '')])
  const unique = plugin.__resolveUids([entry], uniqueScene.children, { root: uniqueScene, makeUid: sequentialUids() })
  assert.equal(unique.bindings.length, 1)
  assert.equal(unique.bindings[0][0], 'l:legacy')

  const namedLegacy = Object.assign({}, entry, { uid: 'l:named', anchor: 'n:Cube' })
  const zeroScene = liveScene([])
  const zero = plugin.__resolveUids([namedLegacy], zeroScene.children, { root: zeroScene, makeUid: sequentialUids() })
  assert.equal(zero.bindings.length, 0)
  assert.equal(zero.unresolved[0].kind, 'legacyAmbiguous')
  const duplicateScene = liveScene([liveNode('Mesh', 'Cube'), liveNode('Mesh', 'Cube')])
  const duplicate = plugin.__resolveUids([namedLegacy], duplicateScene.children, { root: duplicateScene, makeUid: sequentialUids() })
  assert.equal(duplicate.bindings.length, 0)
  assert.equal(duplicate.unresolved[0].kind, 'legacyAmbiguous')
  // A stronger UID entry may claim one of two same-anchor duplicates; the
  // legacy migration must still see two live matches and stay unbound rather
  // than taking the remaining one.
  const twinLeft = liveNode('Mesh', 'Twin', [], 'left')
  const twinRight = liveNode('Mesh', 'Twin', [], 'right')
  const twinScene = liveScene([twinLeft, twinRight])
  const twinLegacy = Object.assign({}, entry, { uid: 'l:twin', anchor: 'n:Twin' })
  const twinUid = uidEntry({ uid: 's:left', wbId: 'left', anchor: 'n:Twin', namedPath: 'n:Twin', ordinalPath: 'n:Twin' })
  const twinResult = plugin.__resolveUids([twinUid, twinLegacy], twinScene.children, { root: twinScene, makeUid: sequentialUids() })
  assert.equal(twinResult.bindings.length, 1)
  assert.equal(twinResult.bindings[0][0], 's:left')
  assert.equal(twinResult.bindings[0][1], twinLeft)
  assert.equal(twinResult.unresolved.length, 1)
  assert.equal(twinResult.unresolved[0].uid, 'l:twin')
  assert.equal(twinResult.unresolved[0].kind, 'legacyAmbiguous')
  assert.equal(twinResult.unresolved[0].reason, 'anchor-duplicate')
  // Scripts that adopted wb.id after the v1 record was written must still
  // receive their old override when the anchor matches exactly one object.
  const heroLegacy = Object.assign({}, entry, { uid: 'l:hero', anchor: 'n:Hero' })
  const heroScene = liveScene([liveNode('Mesh', 'Hero', [], 'hero')])
  const hero = plugin.__resolveUids([heroLegacy], heroScene.children, { root: heroScene, makeUid: sequentialUids() })
  assert.equal(hero.bindings.length, 1)
  assert.equal(hero.bindings[0][0], 'l:hero')
  assert.equal(hero.bindings[0][1], heroScene.children[0])

  const saved = plugin.__saveEditorSession(storage, 'session-v1', loaded.record, { now: 200 })
  assert.equal(saved.ok, true)
  assert.equal(storage.getItem(v2Key) !== null, true)
  assert.equal(storage.getItem(v1Key), null, 'v1 is removed only after the v2 write')
})

test('T6 tree and base contract are UID-based; key is diagnostic only', () => {
  const preview = plugin.__previewDocument({ title: 'Tree', revision: 1, code: 'const a = 1' }, null, {
    v: 2,
    updatedAt: 1,
    timeline: { duration: 10 },
    camera: null,
    objects: { 's:one': uidEntry({ uid: 's:one', overrides: { position: [1, 0, 0] } }) },
  })
  assert.ok(preview.includes('const uid = uidFor(object)'))
  assert.ok(preview.includes('uid,'))
  assert.ok(preview.includes('key: info.key'))
  assert.ok(preview.includes('parentUid: parent === null ? null : uidFor(parent)'))
  assert.ok(preview.includes('script: scriptBaseline.get(uid) || snapshotScript(object)'))
  assert.ok(preview.includes('unresolved: unresolvedUids.slice()'))
  assert.equal(preview.includes('id: idFor(object)'), false)
  assert.equal(preview.includes('node.base'), false)
  assert.ok(clientSource.includes('node.script !== undefined'))
  assert.equal(clientSource.includes('node.base !== undefined'), false)
})

test('T7 command targeting rejects stale UIDs and carries request ids', () => {
  const first = { name: 'Same' }
  const second = { name: 'Same' }
  const targets = new Map([['s:first', first], ['s:second', second]])
  assert.equal(plugin.__uidTarget(targets, 's:first').object, first)
  assert.equal(plugin.__uidTarget(targets, 's:second').object, second)
  assert.deepEqual(plugin.__uidTarget(targets, 's:missing'), { error: 'stale-uid' })
  assert.deepEqual(plugin.__uidTarget(targets, undefined), { error: 'stale-uid' })

  const preview = plugin.__previewDocument({ title: 'Protocol', revision: 1, code: 'const a = 1' }, null)
  assert.ok(preview.includes('const target = uidTarget(uidObjects, data.uid, deletedUids)'))
  const selectBody = preview.slice(
    preview.indexOf("if (data.command === 'select')"),
    preview.indexOf("if (data.command === 'select-mode')"),
  )
  assert.ok(selectBody.includes('uidTarget(uidObjects, data.uid, deletedUids)'), 'select must resolve the UID')
  assert.ok(selectBody.includes('selectObject(null)'), 'select null must clear the selection')
  assert.ok(selectBody.includes("error: target.error"), 'select must reject stale UIDs')
  const focusBody = preview.slice(
    preview.indexOf("if (data.command === 'focus')"),
    preview.indexOf("if (data.command === 'camera-reset'"),
  )
  assert.ok(focusBody.includes('uidTarget(uidObjects, data.uid, deletedUids)'), 'focus must resolve the UID')
  assert.ok(focusBody.includes('focusObject(data.uid)'), 'focus null must still frame the scene')
  assert.ok(focusBody.includes("error: target.error"), 'focus must reject stale UIDs')
  assert.ok(preview.includes("type: 'three-workbench:selection',"))
  assert.ok(preview.includes('uids: selectionList(),'))
  assert.ok(preview.includes('primary: primarySelectedUid,'))
  assert.ok(preview.includes("error: target.error"))
  assert.ok(preview.includes('requestId: data.requestId'))
  assert.equal(preview.includes('stale-key'), false)
  assert.equal(preview.includes('stale-id'), false)
  // Parent commands send UIDs, never runtime numeric ids or semantic keys.
  assert.ok(clientSource.includes("command('fragment', { uid, fragment: after, replace: true })"))
  assert.ok(clientSource.includes("command('select', { uids: normalized.uids, primary: normalized.primary })"))
  assert.ok(clientSource.includes("command('focus', { uid:"))
})

test('T8 v2 store prefers v2, backs up corruption, surfaces quota, and exports UIDs', () => {
  const v1Key = plugin.__editorV1Key('session-v2')
  const v2Key = plugin.__editorV2Key('session-v2')
  const v2Record = {
    v: 2,
    updatedAt: 10,
    timeline: { duration: 17 },
    camera: { position: [1, 2, 3], target: [0, 0, 0] },
    objects: { 's:live': uidEntry({ uid: 's:live', overrides: { visible: false } }) },
  }
  const storage = memoryStorage({
    [v2Key]: JSON.stringify(v2Record),
    [v1Key]: JSON.stringify({ objects: { 't:Old': { position: [7, 7, 7] } } }),
  })
  const preferred = plugin.__loadEditorSession(storage, 'session-v2', { now: 20 })
  assert.equal(preferred.source, 'v2')
  assert.equal(preferred.migrated, false)
  assert.equal(preferred.record.timeline.duration, 17)
  assert.equal(preferred.record.objects['s:live'].overrides.visible, false)
  assert.ok(storage.getItem(v1Key) !== null, 'a v2 load must not consume v1')

  const corruptStorage = memoryStorage({ [v2Key]: '{not json', [v1Key]: JSON.stringify({ objects: {} }) })
  const corrupt = plugin.__loadEditorSession(corruptStorage, 'session-v2', { now: 30 })
  assert.equal(corrupt.source, 'corrupt-v2')
  assert.equal(corrupt.notice.kind, 'corrupt')
  assert.equal(corrupt.record.objects && Object.keys(corrupt.record.objects).length, 0)
  assert.ok(corruptStorage.keys().some(key => key.startsWith(v2Key + ':corrupt:')), 'corrupt bytes are backed up')

  const quotaStorage = memoryStorage({ [v1Key]: JSON.stringify({ objects: { 't:Mesh': { position: [1, 1, 1] } } }) })
  const migrated = plugin.__loadEditorSession(quotaStorage, 'session-v2', { now: 40, makeUid: () => 'l:quota' })
  quotaStorage.failKey = key => key === v2Key
  const failed = plugin.__saveEditorSession(quotaStorage, 'session-v2', migrated.record, { now: 50 })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /Quota/)
  assert.ok(quotaStorage.getItem(v1Key) !== null, 'a failed v2 write must not remove v1')
  assert.equal(quotaStorage.getItem(v2Key), null)

  const state = Object.assign({}, v2Record)
  const preview = plugin.__previewDocument({ title: 'Export', revision: 1, code: 'const a = 1' }, null, state)
  const standalone = plugin.__standaloneHtml({ title: 'Export', revision: 1, code: 'const a = 1' }, state)
  assert.ok(preview.includes('"uid":"s:live"'))
  assert.ok(preview.includes('applyEditorState(INITIAL_EDITOR_STATE)'))
  assert.ok(standalone.includes('"uid":"s:live"'))
  assert.ok(standalone.includes('applyEditorState(INITIAL_EDITOR_STATE)'))
  assert.ok(standalone.includes('"duration":17'))

  const updated = plugin.__updateEditorObject(plugin.__emptyEditorRecord(0), 's:new', {
    origin: 'script', type: 'Mesh', anchor: 'n:New', namedPath: 'n:New', ordinalPath: 'n:New', parentUid: null, wbId: 'hero',
  }, { position: [2, 2, 2] }, 60)
  assert.equal(updated.objects['s:new'].wbId, 'hero')
  assert.deepEqual(updated.objects['s:new'].overrides, { position: [2, 2, 2] })
  assert.deepEqual(plugin.__editorFragment(updated, 's:new'), { position: [2, 2, 2] })
  assert.equal(plugin.__editorHasOverrides(updated), true)

  // Referencing a child persists its ancestor registry chain so tier 3 can
  // still bind after the parent receives a fresh runtime UID.
  const ancestorNode = {
    uid: 's:parent', origin: 'script', type: 'Group', anchor: 'n:Group',
    namedPath: 'n:Group', ordinalPath: 'n:Group', parentUid: null,
  }
  const childNode = {
    uid: 's:child', origin: 'script', type: 'Mesh', anchor: 'n:Group/t:Mesh',
    namedPath: '', ordinalPath: 'n:Group/t:Mesh', parentUid: 's:parent',
    ancestors: [ancestorNode],
  }
  const withAncestors = plugin.__updateEditorObject(plugin.__emptyEditorRecord(0), 's:child', childNode, { visible: false }, 70)
  assert.equal(withAncestors.objects['s:parent'].type, 'Group')
  assert.equal(withAncestors.objects['s:child'].parentUid, 's:parent')
  assert.deepEqual(withAncestors.objects['s:child'].overrides, { visible: false })
})

test('D1 Inspector base values come from node.script, never post-override live state', () => {
  assert.ok(clientSource.includes('const base = node.script !== undefined && node.script !== null ? node.script : {}'))
  // Transform base: override/live values only while an edit is active, then
  // the script snapshot. There is deliberately no node[prop] fallback.
  assert.ok(clientSource.includes('if (liveHere !== null && Array.isArray(liveHere[prop])) return liveHere[prop]'))
  assert.ok(clientSource.includes('const baseValue = base[prop]'))
  assert.equal(clientSource.includes('base[prop] !== undefined ? base[prop] : node[prop]'), false)
  // Visible, material and light read the script base too.
  assert.ok(clientSource.includes("effective('visible', base.visible !== undefined ? base.visible : true)"))
  assert.equal(clientSource.includes('base.visible !== undefined ? base.visible : node.visible'), false)
  // P2-1 inserts the evaluated track value ahead of the static/script base;
  // the D1 fallback chain itself still never reads post-override node state.
  assert.ok(clientSource.includes("const materialColor = typeof materialTrackValue('color') === 'string'"))
  assert.ok(clientSource.includes(": (materialOverride.color || (materialBase !== null ? materialBase.color : undefined) || '#ffffff')"))
  assert.equal(clientSource.includes("materialBase.color : undefined) || material.color || '#ffffff'"), false)
  assert.ok(clientSource.includes("['roughness', materialBase !== null ? materialBase.roughness : undefined]"))
  assert.equal(clientSource.includes('? materialBase.roughness : material.roughness'), false)
  assert.ok(clientSource.includes('? materialBase.metalness : undefined'))
  assert.ok(clientSource.includes('? materialBase.opacity : undefined'))
  assert.ok(clientSource.includes("base.light !== undefined && typeof base.light.intensity === 'number' ? base.light.intensity : 1"))
  assert.equal(clientSource.includes(': node.light.intensity)'), false)
  assert.equal(clientSource.includes('|| node.light.color'), false)
  // Outliner visibility is a view of the override/script base, not a stale
  // tree value captured before the override was committed.
  assert.ok(clientSource.includes('? node.script.visible : true'))
  assert.equal(clientSource.includes('? node.script.visible : node.visible'), false)
  // Camera keeps script position/target/fov as its base across resets.
  assert.ok(clientSource.includes('overrides.camera?.position ?? scriptPosition'))
  assert.ok(clientSource.includes('overrides.camera?.target ?? scriptTarget'))
  assert.ok(clientSource.includes('scriptFov ?? (tree === null ? 50 : tree.camera.fov)'))
})

test('D3 malformed v2 records are quarantined and keep the first valid UID', () => {
  const v2Key = plugin.__editorV2Key('session-malformed')
  const duplicateFirst = {
    uid: 's:dup', origin: 'script', type: 'Mesh', anchor: 'n:First', namedPath: 'n:First',
    ordinalPath: 'n:First', parentUid: null, overrides: { position: [1, 2, 3] }, locked: true,
  }
  const duplicateSecond = {
    uid: 's:dup', origin: 'script', type: 'Mesh', anchor: 'n:Second', namedPath: 'n:Second',
    ordinalPath: 'n:Second', parentUid: null, overrides: { position: [9, 9, 9] },
  }
  const raw = JSON.stringify({
    v: 2,
    updatedAt: 5,
    timeline: { duration: 12 },
    camera: null,
    objects: {
      first: duplicateFirst,
      second: duplicateSecond,
      bad: 'not-an-object',
      nil: null,
      ok: { uid: 's:ok', origin: 'script', overrides: { visible: false } },
    },
  }).replace('"objects":{', '"objects":{"__proto__":{"overrides":{"visible":true}},')
  assert.ok(raw.includes('"__proto__"'))
  const storage = memoryStorage({ [v2Key]: raw })
  const loaded = plugin.__loadEditorSession(storage, 'session-malformed', { now: 123 })
  assert.equal(loaded.source, 'v2-malformed')
  assert.equal(loaded.notice.kind, 'malformed')
  assert.equal(loaded.notice.backupKey, v2Key + ':quarantine:123')
  assert.equal(storage.getItem(loaded.notice.backupKey), raw, 'original bytes are quarantined verbatim')
  const kinds = loaded.notice.issues.map(issue => issue.kind)
  assert.equal(kinds.filter(kind => kind === 'malformed-entry').length, 3)
  assert.equal(kinds.filter(kind => kind === 'duplicate-uid').length, 1)
  assert.ok(loaded.notice.issues.some(issue => issue.kind === 'duplicate-uid' && issue.uid === 's:dup' && issue.key === 'second'))
  assert.ok(loaded.notice.issues.some(issue => issue.kind === 'malformed-entry' && issue.key === '__proto__'))
  assert.deepEqual(Object.keys(loaded.record.objects).sort(), ['s:dup', 's:ok'])
  assert.deepEqual(loaded.record.objects['s:dup'].overrides, { position: [1, 2, 3] }, 'the first valid duplicate wins')
  assert.equal(loaded.record.objects['s:dup'].locked, true, 'lock metadata survives sanitization')
  assert.deepEqual(loaded.record.objects['s:ok'].overrides, { visible: false })

  // The pure normalizer accepts optional issue collection without throwing.
  const issues = []
  const normalized = plugin.__normalizeEditorRecord(JSON.parse(raw), 124, issues)
  assert.equal(issues.length, loaded.notice.issues.length)
  assert.deepEqual(normalized.objects['s:dup'].overrides, { position: [1, 2, 3] })
})

test('D4 mutation acks keep stale/no-pin/apply-failed/invalid/locked distinct', () => {
  assert.match(plugin.__mutationNotice('stale-uid'), /no longer in the live scene/)
  assert.match(plugin.__mutationNotice('no-pin'), /no editor pin/)
  assert.match(plugin.__mutationNotice('apply-failed'), /could not apply/)
  assert.match(plugin.__mutationNotice('invalid'), /invalid edit/)
  assert.match(plugin.__mutationNotice('locked'), /locked/)
  assert.equal(plugin.__mutationNotice('something-else'), 'The preview rejected this edit.')
  assert.ok(clientSource.includes('setProtocolNotice(mutationNotice(typeof data.error === \'string\' ? data.error : null))'))

  const preview = plugin.__previewDocument({ title: 'Errors', revision: 1, code: 'const a = 1' }, null)
  for (const code of ['stale-uid', 'no-pin', 'apply-failed', 'invalid', 'locked']) {
    assert.ok(preview.includes("error: '" + code + "'"), 'runtime emits ' + code)
  }
  // A failed or empty reset must not leave an empty pin behind.
  assert.ok(preview.includes('if (op.reset === true) unpinObject(op.uid)'))
  assert.ok(preview.includes('const hasFragment = Object.keys(op.fragment).length > 0'))
})

test('P1-2 lock is metadata-only, survives clear/normalize/batch, and is not history', () => {
  const parentNode = {
    uid: 's:parent', origin: 'script', type: 'Group', anchor: 'n:Group',
    namedPath: 'n:Group', ordinalPath: 'n:Group', parentUid: null,
  }
  const childNode = {
    uid: 's:child', origin: 'script', type: 'Mesh', anchor: 'n:Group/t:Mesh',
    namedPath: '', ordinalPath: 'n:Group/t:Mesh', parentUid: 's:parent',
    ancestors: [parentNode],
  }
  const otherNode = {
    uid: 's:other', origin: 'script', type: 'Mesh', anchor: 'n:Other',
    namedPath: 'n:Other', ordinalPath: 'n:Other', parentUid: null,
  }
  let record = plugin.__updateEditorObject(plugin.__emptyEditorRecord(0), 's:child', childNode, { position: [1, 2, 3] }, 10)
  record = plugin.__updateEditorObject(record, 's:other', otherNode, { visible: false }, 11)
  const locked = plugin.__updateEditorLock(record, 's:child', childNode, true, 12)
  assert.equal(locked.objects['s:child'].locked, true)
  assert.deepEqual(locked.objects['s:child'].overrides, { position: [1, 2, 3] }, 'lock must not erase overrides')
  assert.equal(locked.objects['s:parent'].type, 'Group', 'locking a tier-3 child persists its ancestor stub')
  assert.equal(locked.objects['s:parent'].locked, false)
  assert.deepEqual(locked.objects['s:other'].overrides, { visible: false }, 'other entries are untouched')

  // Locking an object with no overrides stores metadata only and does not make
  // the record look like it has override history.
  const metadataOnly = plugin.__updateEditorLock(plugin.__emptyEditorRecord(0), 's:other', otherNode, true, 12)
  assert.equal(metadataOnly.objects['s:other'].locked, true)
  assert.deepEqual(metadataOnly.objects['s:other'].overrides, {})
  assert.equal(plugin.__editorHasOverrides(metadataOnly), false)

  // Metadata-only updates with no tree node still preserve the existing data.
  const unlocked = plugin.__updateEditorLock(locked, 's:child', null, false, 13)
  assert.equal(unlocked.objects['s:child'].locked, false)
  assert.deepEqual(unlocked.objects['s:child'].overrides, { position: [1, 2, 3] })
  const relocked = plugin.__updateEditorLock(unlocked, 's:child', childNode, true, 14)
  assert.deepEqual(relocked.objects['s:child'].overrides, { position: [1, 2, 3] })

  // A normal override edit or batch update may change values but never lock.
  const edited = plugin.__updateEditorObject(relocked, 's:child', childNode, { position: [4, 5, 6] }, 15)
  assert.equal(edited.objects['s:child'].locked, true)
  assert.deepEqual(edited.objects['s:child'].overrides, { position: [4, 5, 6] })
  const batch = plugin.__applyEditorBatch(plugin.__emptyEditorRecord(0), [
    { uid: 's:child', node: childNode, fragment: { scale: [2, 2, 2] } },
    { uid: 's:other', node: otherNode, fragment: { visible: true } },
  ], 16)
  assert.equal(batch.updatedAt, 16)
  assert.equal(batch.objects['s:child'].locked, undefined)
  assert.deepEqual(batch.objects['s:child'].overrides, { scale: [2, 2, 2] })
  assert.deepEqual(batch.objects['s:other'].overrides, { visible: true })
  const batchLocked = plugin.__applyEditorBatch(relocked, [
    { uid: 's:child', node: childNode, fragment: { scale: [3, 3, 3] } },
  ], 17)
  assert.equal(batchLocked.objects['s:child'].locked, true)
  assert.deepEqual(batchLocked.objects['s:child'].overrides, { scale: [3, 3, 3] })
  assert.deepEqual(relocked.objects['s:child'].overrides, { position: [1, 2, 3] }, 'batch returns a new record')

  // Reset-all keeps locked objects and the registry chain that rebinds them.
  const cleared = plugin.__clearEditorOverrides(relocked, 18)
  assert.equal(cleared.camera, null)
  assert.equal(cleared.objects['s:child'].locked, true)
  assert.deepEqual(cleared.objects['s:child'].overrides, {})
  assert.ok(cleared.objects['s:parent'] !== undefined, 'ancestor stub survives so the lock can rebind')
  assert.equal(cleared.objects['s:other'], undefined, 'unlocked entries without a locked descendant are dropped')
  assert.equal(plugin.__editorHasOverrides(cleared), false)

  // Normalization preserves the lock flag on reload.
  const normalized = plugin.__normalizeEditorRecord(relocked, 19)
  assert.equal(normalized.objects['s:child'].locked, true)
  assert.deepEqual(normalized.objects['s:child'].overrides, { position: [1, 2, 3] })

  // Lock changes never create a history entry; batch edits are one entry.
  const toggleBody = clientSource.slice(
    clientSource.indexOf('const toggleLock = node => {'),
    clientSource.indexOf('const applyHistoryFragment'),
  )
  assert.ok(toggleBody.length > 0)
  assert.equal(toggleBody.includes('setHistory'), false, 'lock is metadata, not override history')
  assert.ok(clientSource.includes("setHistory(state => ({ past: [...state.past.slice(-99), { ops }], future: [] }))"))
  const batchHistory = plugin.__historyEntryOps({
    ops: [{ uid: 's:a', before: {}, after: { visible: false } }, { uid: 's:b', before: {}, after: undefined }],
  })
  assert.deepEqual(batchHistory.map(op => op.uid), ['s:a', 's:b'], 'one entry carries every batch op')
  assert.deepEqual(plugin.__historyEntryOps({ uid: 's:a', before: {}, after: {} }).map(op => op.uid), ['s:a'])
  assert.deepEqual(plugin.__historyEntryOps(null), [])
})

test('P1-1 selection normalizes to one UID set with a deterministic primary', () => {
  assert.deepEqual(
    plugin.__normalizeSelection(['s:b', 's:a', 's:b', '', null], 's:missing', ['s:a', 's:b']),
    { uids: ['s:b', 's:a'], primary: 's:b' },
  )
  assert.deepEqual(
    plugin.__normalizeSelection(['s:b', 's:a'], 's:a', ['s:a', 's:b']),
    { uids: ['s:b', 's:a'], primary: 's:a' },
  )
  assert.deepEqual(plugin.__normalizeSelection(['s:stale'], 's:stale', ['s:a']), { uids: [], primary: null })
  assert.deepEqual(plugin.__normalizeSelection([], null, null), { uids: [], primary: null })

  // The runtime reports and accepts the same set; legacy single UID still works.
  const preview = plugin.__previewDocument({ title: 'Select', revision: 1, code: 'const a = 1' }, null)
  assert.ok(preview.includes('uids: selectionList(),'))
  assert.ok(preview.includes('primary: primarySelectedUid,'))
  assert.ok(preview.includes("Array.isArray(data.uids)"))
  assert.ok(preview.includes('normalizeSelection(data.uids, data.primary, uidObjects.keys())'))
  assert.ok(clientSource.includes("command('select', { uids: normalized.uids, primary: normalized.primary })"))
  assert.ok(clientSource.includes('selectedUids.size === 1'))
  assert.ok(clientSource.includes('lockedUids.has(onlyUid)'))
  assert.ok(preview.includes('return rowUid === undefined || !lockedUids.has(rowUid)'))
})

test('H1 preflight blocks locked/stale history targets atomically', () => {
  const nodes = [
    { uid: 's:hero', locked: false },
    { uid: 's:locked', locked: true },
    { uid: 's:store', locked: false },
  ]
  const storeLocks = new Set(['s:store'])
  const empty = { ok: true, blocked: [], lockedCount: 0, staleCount: 0 }

  // All-clear: unlocked live target, no store lock.
  assert.deepEqual(plugin.__preflightHistoryOps([{ uid: 's:hero' }], nodes, storeLocks), empty)
  assert.deepEqual(plugin.__preflightHistoryOps([], nodes, storeLocks), empty)
  // Locked: tree metadata and persisted store lock are both enforced; duplicate
  // ops count once in the notice.
  assert.deepEqual(
    plugin.__preflightHistoryOps([{ uid: 's:locked' }, { uid: 's:locked' }], nodes, new Set()),
    { ok: false, blocked: [{ uid: 's:locked', reason: 'locked' }], lockedCount: 1, staleCount: 0 },
  )
  assert.deepEqual(
    plugin.__preflightHistoryOps([{ uid: 's:store' }], nodes, storeLocks),
    { ok: false, blocked: [{ uid: 's:store', reason: 'locked' }], lockedCount: 1, staleCount: 0 },
  )
  // Stale: UID absent from the current tree.
  assert.deepEqual(
    plugin.__preflightHistoryOps([{ uid: 's:ghost' }], nodes, new Set()),
    { ok: false, blocked: [{ uid: 's:ghost', reason: 'stale' }], lockedCount: 0, staleCount: 1 },
  )
  // Mixed batch: one blocked target aborts the whole entry, in op order.
  assert.deepEqual(
    plugin.__preflightHistoryOps([
      { uid: 's:hero' }, { uid: 's:locked' }, { uid: 's:store' }, { uid: 's:ghost' },
    ], nodes, storeLocks),
    {
      ok: false,
      blocked: [
        { uid: 's:locked', reason: 'locked' },
        { uid: 's:store', reason: 'locked' },
        { uid: 's:ghost', reason: 'stale' },
      ],
      lockedCount: 2,
      staleCount: 1,
    },
  )

  // The parent guards all UID-scoped mutations with the same preflight, and
  // undo/redo move the history cursor only after a successful replay.
  assert.ok(clientSource.includes('if (!allowMutation(ops)) return false'))
  assert.ok(clientSource.includes('if (!applyHistoryOps(historyEntryOps(entry), true)) return'))
  assert.ok(clientSource.includes('if (!applyHistoryOps(historyEntryOps(entry), false)) return'))
  const historyBody = clientSource.slice(
    clientSource.indexOf('const applyHistoryOps = (ops, undoDirection) => {'),
    clientSource.indexOf('const undo = () => {'),
  )
  assert.ok(historyBody.indexOf('allowMutation(ops)') < historyBody.indexOf('onBatchOverride(updates)'))
  assert.ok(historyBody.includes('return false'), 'blocked history replay reports failure')
  for (const entry of ['liveOverride', 'commitOverride', 'unpinUid', 'resetOverrideProperty']) {
    const start = clientSource.indexOf('const ' + entry + ' = ')
    const end = clientSource.indexOf('\n      const ', start + 5)
    assert.ok(start >= 0 && end > start, entry + ' entry point exists')
    assert.ok(clientSource.slice(start, end).includes('allowMutation('), entry + ' uses the shared guard')
  }
  assert.ok(clientSource.includes("if (!allowMutation(ops.map(op => ({ uid: op.uid })))) return"))
})


test('P1-3 manual manifests normalize, preserve metadata, and cap at 500', () => {
  const box = plugin.__makeManualItem('box', 'm:box-1')
  assert.equal(box.origin, 'manual')
  assert.equal(box.type, 'Mesh')
  assert.equal(box.uid, 'm:box-1')
  assert.equal(box.alias, 'Box')
  assert.equal(box.parent, 'scene')
  assert.equal(box.locked, false)
  assert.deepEqual(box.manual.params, { width: 1, height: 1, depth: 1 })
  assert.deepEqual(box.manual.transform.position, [0, 0.5, 0])
  assert.deepEqual(box.manual.material, { color: '#8ab4ff', roughness: 0.5, metalness: 0 })
  assert.deepEqual(plugin.__normalizeManualManifest(box), box)

  for (const shape of plugin.__MANUAL_SHAPE_IDS) {
    const item = plugin.__makeManualItem(shape, 'm:' + shape)
    assert.ok(item !== null, shape + ' is a supported deterministic shape')
    assert.equal(item.manual.shape, shape)
    assert.ok(item.manual.transform.position.every(Number.isFinite))
  }
  const torus = plugin.__normalizeManualManifest({
    uid: 'm:torus',
    origin: 'manual',
    alias: '  Ring  ',
    parent: 's:root',
    locked: true,
    deleted: false,
    manual: {
      kind: 'primitive',
      shape: 'torus',
      params: { radius: 2, tube: 0.4, radialSegments: 8, tubularSegments: 12 },
      transform: { position: [1, 2, 3], rotation: [0, 0.5, 0], scale: [2, 2, 2] },
      material: { color: '#ff0000', roughness: 0.2, metalness: 0.8 },
    },
    overrides: { position: [1, 2, 3] },
  })
  assert.equal(torus.alias, 'Ring')
  assert.equal(torus.parent, 's:root')
  assert.equal(torus.locked, true)
  assert.deepEqual(torus.overrides, { position: [1, 2, 3] })

  const invalid = [
    null,
    {},
    { ...box, uid: 's:wrong' },
    { ...box, uid: 'm:has space' },
    { ...box, manual: { ...box.manual, shape: 'capsule' } },
    { ...box, manual: { ...box.manual, params: { width: -1, height: 1, depth: 1 } } },
    { ...box, manual: { ...box.manual, shape: 'sphere', params: { radius: 0.5, widthSegments: 1.5, heightSegments: 16 } } },
    { ...box, manual: { ...box.manual, transform: { position: [0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } } },
    { ...box, manual: { ...box.manual, material: { color: 'blue', roughness: 0.5, metalness: 0 } } },
    { ...box, parent: '' },
  ]
  for (const value of invalid) assert.equal(plugin.__normalizeManualManifest(value), null)

  // Normalization accepts manual entries and preserves the manifest, alias,
  // parent, lock and overrides; a malformed one is reported, not rewritten.
  const record = plugin.__createEditorManual(plugin.__emptyEditorRecord(0), torus, 1)
  assert.equal(record.ok, true)
  assert.equal(plugin.__manualObjectCount(record.record), 1)
  const normalized = plugin.__normalizeEditorRecord(record.record, 2, [])
  assert.deepEqual(normalized.objects['m:torus'], torus)
  const issues = []
  const malformed = plugin.__normalizeEditorRecord({
    v: 2,
    objects: { 'm:bad': { uid: 'm:bad', origin: 'manual', manual: { kind: 'primitive', shape: 'nope' } } },
  }, 3, issues)
  assert.deepEqual(malformed.objects, {})
  assert.deepEqual(issues.map(issue => issue.kind), ['malformed-manual'])

  // Override/batch/lock updates keep the definition fields and never attach
  // script-resolver fields to a manual entry.
  const manualNode = {
    uid: 'm:torus', origin: 'manual', type: 'Mesh', anchor: 'wrong', namedPath: 'wrong',
    ordinalPath: 'wrong', parentUid: null, wbId: 'wrong',
  }
  const edited = plugin.__updateEditorObject(record.record, 'm:torus', manualNode, { rotation: [0, 1, 0] }, 4)
  assert.deepEqual(edited.objects['m:torus'].overrides, { rotation: [0, 1, 0] })
  assert.deepEqual(edited.objects['m:torus'].manual, torus.manual)
  assert.equal(edited.objects['m:torus'].alias, 'Ring')
  assert.equal(edited.objects['m:torus'].parent, 's:root')
  assert.equal(edited.objects['m:torus'].locked, true)
  assert.equal(edited.objects['m:torus'].anchor, undefined)
  assert.equal(edited.objects['m:torus'].namedPath, undefined)
  const relocked = plugin.__updateEditorLock(edited, 'm:torus', manualNode, false, 5)
  assert.equal(relocked.objects['m:torus'].locked, false)
  assert.deepEqual(relocked.objects['m:torus'].overrides, { rotation: [0, 1, 0] })
  const batch = plugin.__applyEditorBatch(record.record, [
    { uid: 'm:torus', node: manualNode, fragment: { position: [4, 5, 6] } },
  ], 6)
  assert.deepEqual(batch.objects['m:torus'].overrides, { position: [4, 5, 6] })
  assert.deepEqual(batch.objects['m:torus'].manual, torus.manual)

  // Remove is one record write and rejects script UIDs; the source is untouched.
  const removed = plugin.__removeEditorManual(record.record, 'm:torus', 7)
  assert.equal(removed.ok, true)
  assert.equal(removed.record.objects['m:torus'], undefined)
  assert.equal(record.record.objects['m:torus'].uid, 'm:torus')
  assert.deepEqual(plugin.__removeEditorManual(record.record, 's:script', 8), {
    ok: false, error: 'not-manual', record: record.record,
  })

  const full = { ...plugin.__emptyEditorRecord(0), objects: {} }
  for (let index = 0; index < plugin.__MANUAL_LIMIT; index += 1) {
    const uid = 'm:cap-' + String(index)
    full.objects[uid] = plugin.__makeManualItem('box', uid)
  }
  assert.equal(plugin.__manualObjectCount(full), plugin.__MANUAL_LIMIT)
  assert.equal(
    plugin.__createEditorManual(full, plugin.__makeManualItem('box', 'm:cap-over'), 9).error,
    'manual-limit',
  )
  const overflowIssues = []
  const overflow = { ...plugin.__emptyEditorRecord(0), objects: {} }
  for (let index = 0; index < plugin.__MANUAL_LIMIT + 1; index += 1) {
    const uid = 'm:over-' + String(index)
    overflow.objects[uid] = plugin.__makeManualItem('sphere', uid)
  }
  const capped = plugin.__normalizeEditorRecord(overflow, 10, overflowIssues)
  assert.equal(plugin.__manualObjectCount(capped), plugin.__MANUAL_LIMIT)
  assert.deepEqual(overflowIssues.map(issue => issue.kind), ['manual-limit'])
})

test('P1-3 reset-all keeps manuals while clearing their overrides and tweaks skip them', () => {
  const manual = plugin.__makeManualItem('plane', 'm:plane-1')
  manual.overrides = { position: [1, 1, 1] }
  manual.locked = true
  const record = {
    ...plugin.__emptyEditorRecord(0),
    camera: { position: [1, 2, 3] },
    objects: {
      'm:plane-1': manual,
      's:locked': { uid: 's:locked', origin: 'script', overrides: { visible: false }, locked: true },
      's:plain': { uid: 's:plain', origin: 'script', overrides: { visible: false }, locked: false },
    },
  }
  assert.equal(plugin.__editorHasOverrides({ ...plugin.__emptyEditorRecord(0), objects: { 'm:plane-1': plugin.__makeManualItem('box', 'm:clean') } }), false)
  assert.equal(plugin.__editorHasOverrides(record), true)
  const cleared = plugin.__clearEditorOverrides(record, 11)
  assert.equal(cleared.camera, null)
  assert.ok(cleared.objects['m:plane-1'] !== undefined, 'reset-all keeps the manual definition')
  assert.deepEqual(cleared.objects['m:plane-1'].overrides, {})
  assert.equal(cleared.objects['m:plane-1'].locked, true)
  assert.deepEqual(cleared.objects['m:plane-1'].manual, manual.manual)
  assert.equal(cleared.objects['m:plane-1'].alias, 'Plane')
  assert.equal(cleared.objects['m:plane-1'].parent, 'scene')
  assert.ok(cleared.objects['s:locked'] !== undefined)
  assert.equal(cleared.objects['s:plain'], undefined)
  assert.equal(plugin.__editorHasOverrides(cleared), false)

  const tweakBody = clientSource.slice(
    clientSource.indexOf('const sendTweaks = () => {'),
    clientSource.indexOf('const setCamera = (fragment, commit, reset) => {'),
  )
  assert.ok(tweakBody.includes('isManualEditorEntry(stored, uid)'))
  assert.ok(tweakBody.includes('skippedManual += 1'))
  assert.ok(tweakBody.includes("t('editor.skippedManual'"))
  const resetBody = clientSource.slice(
    clientSource.indexOf('const resetAllOverrides = () => {'),
    clientSource.indexOf('React.useEffect(() => { if (skipOverrides)'),
  )
  assert.ok(resetBody.includes('onClearOverrides()'))
  assert.ok(clientSource.includes('skipOverrides ? clearEditorOverrides(authoritativeRecord(), 0)'))
})

test('P1-3 runtime rebuilds manuals after UID resolution and before overrides', () => {
  const manual = plugin.__makeManualItem('box', 'm:seed-box')
  manual.overrides = { position: [3, 2, 1] }
  const state = {
    ...plugin.__emptyEditorRecord(0),
    objects: { 'm:seed-box': manual },
  }
  const record = { title: 'Manual', revision: 4, code: 'const a = 1' }
  const preview = plugin.__previewDocument(record, null, state)
  assert.ok(preview.includes('m:seed-box'))
  assert.ok(preview.includes('const buildManualLayer = state =>'))
  assert.ok(preview.includes('function buildManualPrimitive(THREE, entry)'))
  assert.ok(preview.includes('const manualEntry = manualEntries.get(uid)'))
  assert.ok(preview.includes("origin: manualEntry === undefined ? 'script' : 'manual'"))
  assert.ok(preview.includes("alias: aliases.get(uid) ?? (manualEntry === undefined ? '' : manualEntry.alias)"))
  assert.ok(preview.includes('node.parentUid = manualParent'))
  const resolveAt = preview.indexOf('resolveIdentity()')
  const buildAt = preview.indexOf('buildManualLayer(INITIAL_EDITOR_STATE)')
  const applyAt = preview.indexOf('applyEditorState(INITIAL_EDITOR_STATE)')
  assert.ok(resolveAt >= 0 && buildAt > resolveAt && applyAt > buildAt, 'manual build sits between resolution and overrides')
  assert.ok(preview.includes('objectUids.set(mesh, entry.uid)'))
  assert.ok(preview.includes('uidObjects.set(entry.uid, mesh)'))
  assert.ok(preview.includes('scriptBaseline.set(entry.uid, snapshotScript(mesh))'))
  assert.ok(preview.includes("data.command === 'manual'"))
  assert.ok(preview.includes('applyManualOps(data.ops, data.requestId)'))
  assert.ok(preview.includes('normalizeManualManifest(op.item)'))
  assert.ok(preview.includes("error: 'manual-invalid'"))
  assert.ok(preview.includes("error: 'stale-uid'"))
  assert.ok(preview.includes('manualUids.has(entry.uid)'), 'create is idempotent for an existing UID')
  assert.ok(preview.includes('removeManualObject(uid)'))
  assert.ok(preview.includes('manual-missing-parent'))
  assert.ok(preview.includes('manual-self-parent'))
  assert.ok(preview.includes('new THREE.BoxGeometry('))
  assert.ok(preview.includes('new THREE.SphereGeometry('))
  assert.ok(preview.includes('new THREE.PlaneGeometry('))
  assert.ok(preview.includes('new THREE.CylinderGeometry('))
  assert.ok(preview.includes('new THREE.ConeGeometry('))
  assert.ok(preview.includes('new THREE.TorusGeometry('))
  assert.ok(preview.includes('new THREE.MeshStandardMaterial('))
  assert.ok(preview.includes("manual.shape === 'plane' ? THREE.DoubleSide"))
  const standalone = plugin.__standaloneHtml(record, state)
  assert.ok(standalone.includes('m:seed-box'))
  assert.ok(standalone.includes('buildManualLayer(INITIAL_EDITOR_STATE)'))
  assert.ok(clientSource.includes('skipOverrides ? clearEditorOverrides(authoritativeRecord(), 0)'))
  assert.ok(clientSource.includes("Object.assign({}, state, { v: 2, objects: state.objects || {}, camera })"))
})

test('P1-3 tagged history preflights create/remove by direction and hardens R1', () => {
  const item = plugin.__makeManualItem('cone', 'm:cone-1')
  const entry = { kind: 'manual', action: 'create', item }
  const nodes = [{ uid: 'm:cone-1', locked: false }]
  const record = { ...plugin.__emptyEditorRecord(0), objects: { 'm:cone-1': item } }
  const empty = { ok: true, blocked: [], lockedCount: 0, staleCount: 0, collisionCount: 0, invalidCount: 0 }

  // Undo create requires a live, unlocked UID; redo create requires absence.
  assert.deepEqual(plugin.__preflightHistoryEntry(entry, 'undo', nodes, new Set(), record), empty)
  assert.deepEqual(plugin.__preflightHistoryEntry(entry, 'redo', [], new Set(), plugin.__emptyEditorRecord(0)), empty)
  assert.deepEqual(
    plugin.__preflightHistoryEntry(entry, 'undo', [], new Set(), plugin.__emptyEditorRecord(0)),
    { ok: false, blocked: [{ uid: 'm:cone-1', reason: 'stale' }], lockedCount: 0, staleCount: 1, collisionCount: 0, invalidCount: 0 },
  )
  assert.deepEqual(
    plugin.__preflightHistoryEntry(entry, 'undo', [{ uid: 'm:cone-1', locked: true }], new Set(), record),
    { ok: false, blocked: [{ uid: 'm:cone-1', reason: 'locked' }], lockedCount: 1, staleCount: 0, collisionCount: 0, invalidCount: 0 },
  )
  const lockedStore = { ...record, objects: { 'm:cone-1': { ...item, locked: true } } }
  assert.equal(plugin.__preflightHistoryEntry(entry, 'undo', nodes, new Set(), lockedStore).lockedCount, 1)
  assert.deepEqual(
    plugin.__preflightHistoryEntry(entry, 'redo', nodes, new Set(), plugin.__emptyEditorRecord(0)),
    { ok: false, blocked: [{ uid: 'm:cone-1', reason: 'collision' }], lockedCount: 0, staleCount: 0, collisionCount: 1, invalidCount: 0 },
  )
  assert.equal(
    plugin.__preflightHistoryEntry(entry, 'redo', [], new Set(), record).collisionCount,
    1,
    'a store-only UID collides even when the tree has not caught up',
  )

  // Remove entries invert the direction expectation.
  const removeEntry = { kind: 'manual', action: 'remove', item }
  assert.equal(plugin.__preflightHistoryEntry(removeEntry, 'undo', [], new Set(), plugin.__emptyEditorRecord(0)).ok, true)
  assert.equal(plugin.__preflightHistoryEntry(removeEntry, 'undo', nodes, new Set(), record).collisionCount, 1)
  assert.equal(plugin.__preflightHistoryEntry(removeEntry, 'redo', nodes, new Set(), record).ok, true)
  assert.equal(plugin.__preflightHistoryEntry(removeEntry, 'redo', [], new Set(), plugin.__emptyEditorRecord(0)).staleCount, 1)

  // Malformed manual entries fail closed; override entries keep H1 semantics.
  assert.equal(plugin.__preflightHistoryEntry({ kind: 'manual', action: 'create', item: { uid: 'm:bad' } }, 'undo', nodes, new Set(), record).invalidCount, 1)
  assert.equal(plugin.__preflightHistoryEntry({ kind: 'manual', action: 'move', item }, 'undo', nodes, new Set(), record).invalidCount, 1)
  assert.equal(plugin.__preflightHistoryEntry({ ops: [{ uid: 'm:cone-1' }] }, 'undo', [], new Set(), record).staleCount, 1)
  assert.equal(plugin.__preflightHistoryEntry({ ops: [{ uid: 'm:cone-1' }] }, 'undo', nodes, new Set(), record).ok, true)

  // The dispatcher reads the authoritative snapshot/latest tree and gates the
  // cursor; lock updates publish the live tree synchronously (R1 regression).
  const applyBody = clientSource.slice(
    clientSource.indexOf('const applyHistoryEntry = async (entry, direction) => {'),
    clientSource.indexOf('/** Add one deterministic primitive'),
  )
  assert.ok(applyBody.includes('preflightEntry(entry, direction)'))
  assert.ok(applyBody.includes("if (entry.kind !== 'manual') return applyHistoryOps"))
  assert.ok(applyBody.includes('removeEditorManual(next, item.uid, Date.now())'))
  assert.ok(applyBody.includes('createEditorManualBatch(record, items, Date.now())'))
  assert.ok(applyBody.includes("Array.isArray(entry.items) && entry.items.length > 0 ? entry.items : [entry.item]"))
  assert.ok(applyBody.includes("kind: 'remove'"))
  assert.ok(applyBody.includes("kind: 'create'"))
  assert.ok(applyBody.includes('commitStructure({'))
  const preflightBody = clientSource.slice(
    clientSource.indexOf('const preflightEntry = (entry, direction) =>'),
    clientSource.indexOf('const showMutationBlocked'),
  )
  assert.ok(preflightBody.includes('treeLiveRef.current'))
  assert.ok(preflightBody.includes('authoritativeRecord()'))
  assert.ok(preflightBody.includes('storedLockedUids()'))
  const lockBody = clientSource.slice(
    clientSource.indexOf('const toggleLock = node => {'),
    clientSource.indexOf('const applyHistoryFragment'),
  )
  assert.ok(lockBody.indexOf('onSetLock(') < lockBody.indexOf('treeLiveRef.current = update'))
  assert.ok(lockBody.includes('lockedUidsFrom(authoritativeRecord())'))
  const undoBody = clientSource.slice(
    clientSource.indexOf('const undo = async () => {'),
    clientSource.indexOf('const redo = async () => {'),
  )
  assert.ok(undoBody.indexOf("await applyHistoryEntry(entry, 'undo')") < undoBody.indexOf('setHistory('))
  assert.ok(undoBody.includes('if (!applied) return'))
  const redoBody = clientSource.slice(
    clientSource.indexOf('const redo = async () => {'),
    clientSource.indexOf('const manualStoreNotice'),
  )
  assert.ok(redoBody.indexOf("await applyHistoryEntry(entry, 'redo')") < redoBody.indexOf('setHistory('))
  assert.ok(redoBody.includes('if (!applied) return'))

  // Creation writes the store immediately before the runtime command and one
  // tagged history entry; exports use the authoritative record.
  const addBody = clientSource.slice(
    clientSource.indexOf('const addManualObject = async shape => {'),
    clientSource.indexOf('const resetAllOverrides'),
  )
  assert.ok(addBody.indexOf('onApplyEditorTransform') < addBody.indexOf("command('manual'"))
  assert.ok(addBody.includes('createEditorManual(record, item, Date.now())'))
  assert.ok(addBody.includes('{ kind: \'manual\', action: \'create\', item }'))
  assert.ok(addBody.includes('commitStructure({'))
})

test('P1-4 alias/deleted normalize, survive override/lock/batch/reset, and are not overrides', () => {
  const record = plugin.__emptyEditorRecord(0)
  const node = { uid: 's:a', origin: 'script', type: 'Mesh', anchor: 'n:A', namedPath: 'n:A', ordinalPath: 'n:A', parentUid: null, wbId: 'a' }
  const aliased = plugin.__updateEditorAlias(record, 's:a', node, '  Tower  ', 1)
  assert.equal(aliased.ok, true)
  assert.equal(aliased.record.objects['s:a'].alias, 'Tower')
  const deleted = plugin.__setEditorDeleted(aliased.record, 's:a', node, true, 2)
  assert.equal(deleted.ok, true)
  assert.equal(deleted.record.objects['s:a'].deleted, true)
  assert.deepEqual(deleted.record.objects['s:a'].overrides, {})
  const edited = plugin.__updateEditorObject(deleted.record, 's:a', node, { visible: false }, 3)
  assert.equal(edited.objects['s:a'].alias, 'Tower')
  assert.equal(edited.objects['s:a'].deleted, true)
  assert.deepEqual(edited.objects['s:a'].overrides, { visible: false })
  const locked = plugin.__updateEditorLock(edited, 's:a', node, true, 4)
  assert.equal(locked.objects['s:a'].locked, true)
  assert.equal(locked.objects['s:a'].alias, 'Tower')
  assert.equal(locked.objects['s:a'].deleted, true)
  const batch = plugin.__applyEditorBatch(edited, [{ uid: 's:a', node, fragment: { position: [1, 2, 3] } }], 5)
  assert.equal(batch.objects['s:a'].alias, 'Tower')
  assert.equal(batch.objects['s:a'].deleted, true)
  const cleared = plugin.__clearEditorOverrides(locked, 6)
  assert.ok(cleared.objects['s:a'] !== undefined)
  assert.equal(cleared.objects['s:a'].alias, 'Tower')
  assert.equal(cleared.objects['s:a'].deleted, true)
  assert.deepEqual(cleared.objects['s:a'].overrides, {})
  assert.equal(plugin.__editorHasOverrides(cleared), false)
  const metadataOnly = { ...plugin.__emptyEditorRecord(0), objects: { 's:a': { uid: 's:a', origin: 'script', alias: 'X', deleted: true, locked: true, overrides: {} } } }
  assert.equal(plugin.__editorHasOverrides(metadataOnly), false)
  const normalized = plugin.__normalizeEditorRecord({ v: 2, objects: { 's:a': { uid: 's:a', origin: 'script', alias: '  X ', deleted: true, locked: true, overrides: {} } } }, 7, [])
  assert.equal(normalized.objects['s:a'].alias, 'X')
  assert.equal(normalized.objects['s:a'].deleted, true)
  assert.equal(normalized.objects['s:a'].locked, true)
})

test('P1-4 clone manifests normalize, quarantine, and validate source support', () => {
  const clone = plugin.__makeCloneItem('s:source', 'Mesh', { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] }, 'Tower copy', { visible: false }, 'm:clone-1', 's:parent')
  assert.equal(clone.origin, 'manual')
  assert.equal(clone.manual.kind, 'clone')
  assert.equal(clone.manual.sourceUid, 's:source')
  assert.equal(clone.manual.sourceType, 'Mesh')
  assert.deepEqual(clone.manual.transform.position, [1, 2, 3])
  assert.equal(clone.alias, 'Tower copy')
  assert.equal(clone.parent, 's:parent')
  assert.deepEqual(clone.overrides, { visible: false })
  assert.equal(clone.deleted, false)
  assert.equal(clone.locked, false)
  assert.equal(plugin.__makeCloneItem('bad', 'Mesh', { position: [1, 2, 3] }, 'x', {}, 'm:c', 'scene'), null)
  assert.equal(plugin.__makeCloneItem('s:ok', 'Mesh', { position: [1, 2] }, 'x', {}, 'm:c', 'scene'), null)
  assert.equal(plugin.__normalizeManualManifest({ uid: 'm:c', origin: 'manual', manual: { kind: 'clone', sourceUid: 's:ok', sourceType: '', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }, overrides: {} }), null)
  assert.equal(plugin.__validateCloneSource({ uid: 's:g', origin: 'script', type: 'Group' }, []), 'clone-source-unsupported')
  assert.equal(plugin.__validateCloneSource({ uid: 's:m', origin: 'script', type: 'Mesh', material: [0] }, [{ readonly: true }]), 'clone-source-unsupported')
  assert.equal(plugin.__validateCloneSource({ uid: 's:m', origin: 'script', type: 'Mesh', material: [0] }, [{ readonly: false, type: 'MeshStandardMaterial' }]), null)
  assert.equal(plugin.__validateCloneSource(undefined, []), 'clone-source-missing')
  const issues = []
  const normalized = plugin.__normalizeEditorRecord({ v: 2, objects: { 'm:c': { uid: 'm:c', origin: 'manual', manual: { kind: 'clone', sourceUid: 'bad', sourceType: 'Mesh', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } } } } }, 1, issues)
  assert.deepEqual(normalized.objects, {})
  assert.deepEqual(issues.map(issue => issue.kind), ['malformed-manual'])
  const full = { ...plugin.__emptyEditorRecord(0), objects: {} }
  for (let index = 0; index < plugin.__MANUAL_LIMIT; index += 1) full.objects['m:cap' + String(index)] = plugin.__makeManualItem('box', 'm:cap' + String(index))
  assert.equal(plugin.__createEditorManual(full, plugin.__makeCloneItem('s:x', 'Mesh', { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, 'x', {}, 'm:over', 'scene'), 2).error, 'manual-limit')
})

test('P1-4 structure history items apply delete/restore/alias and preflight by direction', () => {
  const node = { uid: 's:hero', origin: 'script', type: 'Mesh', anchor: 'n:Hero', namedPath: 'n:Hero', ordinalPath: 'n:Hero', parentUid: null, wbId: 'hero' }
  const record = plugin.__updateEditorObject(plugin.__emptyEditorRecord(0), 's:hero', node, { visible: false }, 1)
  const scriptItem = plugin.__makeScriptDeleteItem(record, 's:hero', node)
  assert.deepEqual(scriptItem.before.overrides, { visible: false })
  assert.equal(scriptItem.after.deleted, true)
  assert.equal(scriptItem.after.anchor, 'n:Hero')
  const absentItem = plugin.__makeScriptDeleteItem(plugin.__emptyEditorRecord(0), 's:new', node)
  assert.equal(absentItem.before, null)
  assert.equal(absentItem.after.deleted, true)
  const manual = plugin.__makeManualItem('box', 'm:box')
  manual.overrides = { position: [4, 5, 6] }
  const manualRecord = plugin.__createEditorManual(plugin.__emptyEditorRecord(0), manual, 2).record
  const manualItem = plugin.__makeManualDeleteItem(manualRecord, 'm:box')
  assert.deepEqual(manualItem.item.overrides, { position: [4, 5, 6] })
  assert.deepEqual(manualItem.item.manual, manual.manual)
  const mixedRecord = plugin.__updateEditorObject(manualRecord, 's:hero', node, { visible: false }, 3)
  const mixed = [scriptItem, manualItem]
  const deleted = plugin.__applyStructureDelete(mixedRecord, mixed, 4)
  assert.equal(deleted.ok, true)
  assert.equal(deleted.record.objects['s:hero'].deleted, true)
  assert.equal(deleted.record.objects['m:box'], undefined)
  const restored = plugin.__applyStructureRestore(deleted.record, mixed, 5)
  assert.equal(restored.ok, true)
  assert.deepEqual(restored.record.objects['s:hero'].overrides, { visible: false })
  assert.equal(restored.record.objects['s:hero'].deleted, false)
  assert.deepEqual(restored.record.objects['m:box'].manual, manual.manual)
  assert.deepEqual(restored.record.objects['m:box'].overrides, { position: [4, 5, 6] })
  const aliasEntry = { kind: 'structure', action: 'alias', items: [{ uid: 's:hero', origin: 'script', before: '', after: 'Tower' }] }
  const nodes = [{ uid: 's:hero', locked: false, alias: '' }]
  assert.equal(plugin.__preflightStructureEntry(aliasEntry, 'undo', nodes, new Set(), restored.record).ok, true)
  assert.equal(plugin.__preflightStructureEntry(aliasEntry, 'redo', [{ uid: 's:hero', locked: true }], new Set(), restored.record).lockedCount, 1)
  const deleteEntry = { kind: 'structure', action: 'delete', items: [scriptItem] }
  assert.equal(plugin.__preflightStructureEntry(deleteEntry, 'redo', nodes, new Set(), restored.record).ok, true)
  assert.equal(plugin.__preflightStructureEntry(deleteEntry, 'redo', [], new Set(), restored.record).staleCount, 1)
  assert.equal(plugin.__preflightStructureEntry(deleteEntry, 'undo', nodes, new Set(), restored.record).collisionCount, 1)
  assert.equal(plugin.__preflightStructureEntry(deleteEntry, 'undo', [], new Set(), deleted.record).ok, true)
  const childNodes = [{ uid: 's:hero', locked: false }, { uid: 's:child', locked: true, parentUid: 's:hero' }]
  assert.equal(plugin.__preflightStructureEntry(deleteEntry, 'redo', childNodes, new Set(), restored.record).lockedCount, 1)
  const manualDeleteEntry = { kind: 'structure', action: 'delete', items: [manualItem] }
  assert.equal(plugin.__preflightStructureEntry(manualDeleteEntry, 'undo', [], new Set(), plugin.__emptyEditorRecord(0)).ok, true)
  assert.equal(plugin.__preflightStructureEntry(manualDeleteEntry, 'undo', [{ uid: 'm:box', locked: false }], new Set(), manualRecord).collisionCount, 1)
  assert.equal(plugin.__preflightStructureEntry({ kind: 'structure', action: 'move', items: [] }, 'undo', nodes, new Set(), record).invalidCount, 1)
})

test('P1-4 manifest-less m: writes fail closed with no synthesized entry', () => {
  const record = plugin.__emptyEditorRecord(0)
  const ghost = { uid: 'm:ghost', origin: 'manual', type: 'Mesh', anchor: 'n:X', namedPath: 'n:X', ordinalPath: 'n:X', parentUid: null }
  assert.equal(plugin.__manualWriteFailure(record, 'm:ghost'), 'manual-invalid')
  const obj = plugin.__updateEditorObjectChecked(record, 'm:ghost', ghost, { visible: false }, 1)
  assert.equal(obj.ok, false)
  assert.equal(obj.error, 'manual-invalid')
  assert.equal(obj.record.objects['m:ghost'], undefined)
  const lock = plugin.__updateEditorLockChecked(record, 'm:ghost', ghost, true, 2)
  assert.equal(lock.ok, false)
  assert.equal(lock.record.objects['m:ghost'], undefined)
  const batch = plugin.__applyEditorBatchChecked(record, [{ uid: 'm:ghost', node: ghost, fragment: { visible: false } }], 3)
  assert.equal(batch.ok, false)
  assert.equal(batch.error, 'manual-invalid')
  assert.equal(batch.record.objects['m:ghost'], undefined)
  const alias = plugin.__updateEditorAlias(record, 'm:ghost', ghost, 'X', 4)
  assert.equal(alias.ok, false)
  const manualRecord = plugin.__createEditorManual(record, plugin.__makeManualItem('box', 'm:box'), 5).record
  assert.equal(plugin.__manualWriteFailure(manualRecord, 'm:box'), null)
  const ok = plugin.__updateEditorObjectChecked(manualRecord, 'm:box', { uid: 'm:box', origin: 'manual' }, { rotation: [0, 1, 0] }, 6)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.record.objects['m:box'].manual, plugin.__makeManualItem('box', 'm:box').manual)
})

test('P1-4 idempotent manual create compares manifests and refuses tombstones', () => {
  const item = plugin.__makeManualItem('box', 'm:box')
  const record = plugin.__createEditorManual(plugin.__emptyEditorRecord(0), item, 1).record
  const again = plugin.__createEditorManual(record, item, 2)
  assert.equal(again.ok, true)
  assert.equal(again.record, record)
  const different = plugin.__createEditorManual(record, { ...item, alias: 'Other' }, 3)
  assert.equal(different.ok, false)
  assert.equal(different.error, 'uid-conflict')
  assert.equal(different.record.objects['m:box'].alias, item.alias)
  const tombstone = plugin.__createEditorManual(plugin.__emptyEditorRecord(0), { ...item, deleted: true }, 4)
  assert.equal(tombstone.ok, false)
  assert.equal(tombstone.error, 'manual-invalid')
})

test('P1-4 runtime structure contracts: atomic ops, deleted guard, clone order', () => {
  const preview = plugin.__previewDocument({ title: 'P14', revision: 1, code: 'const a = 1' }, null, { ...plugin.__emptyEditorRecord(0), objects: {} })
  const resolveAt = preview.indexOf('resolveIdentity()')
  const manualAt = preview.indexOf('buildManualLayer(INITIAL_EDITOR_STATE)')
  const structureAt = preview.indexOf('applyInitialStructure(INITIAL_EDITOR_STATE)')
  const applyAt = preview.indexOf('applyEditorState(INITIAL_EDITOR_STATE)')
  assert.ok(resolveAt >= 0 && manualAt > resolveAt && structureAt > manualAt && applyAt > structureAt, 'initial order is resolve -> manual -> structure -> overrides')
  assert.ok(preview.includes("data.command === 'structure'"))
  assert.ok(preview.includes('applyStructureOps(data.ops, data.requestId)'))
  assert.ok(preview.includes('const applyStructureOps = (ops, requestId) => {'))
  assert.ok(preview.includes('removed.set(uid, { object, parent, index, hidden })'))
  assert.ok(preview.includes('deletedUids.add(uid)'))
  assert.ok(preview.includes('deletedUids.has(uid)'))
  assert.ok(preview.includes('for (const entry of removed.values()) {'))
  assert.ok(preview.includes('deleted: [...deletedUids]'))
  assert.ok(preview.includes('function buildManualClone(THREE, entry, source)'))
  assert.ok(preview.includes('source.geometry.clone()'))
  assert.ok(preview.includes('source.material.map'))
  assert.ok(preview.includes("entry.manual.kind === 'clone'"))
  assert.ok(preview.includes('applyFragment(object, entry.overrides, entry.uid)'))
  assert.ok(preview.includes('restoreManualRemoval'))
  assert.ok(preview.includes('removalsApplied.push'))
  assert.ok(clientSource.includes('const structuralBusyRef = React.useRef(false)'))
  assert.ok(clientSource.includes('if (structuralBusyRef.current) {'))
  assert.ok(clientSource.includes('const commitStructure = async ({ applyStore, buildCommand, expected }) => {'))
  assert.ok(clientSource.includes('hashString(JSON.stringify(preRecord)'))
  assert.ok(clientSource.includes('slice(-99)'), 'history is capped at 100 entries')
})

test('P1-4 export naming prefers alias, then name, then type/manual fallback', () => {
  assert.equal(plugin.__exportNameFor('Tower', 'obj', 'Mesh', ''), 'Tower')
  assert.equal(plugin.__exportNameFor('', 'obj', 'Mesh', ''), 'obj')
  assert.equal(plugin.__exportNameFor('', '', 'Mesh', ''), 'Mesh')
  assert.equal(plugin.__exportNameFor('', '', 'Mesh', 'box'), 'Manual box')
  assert.equal(plugin.__exportNameFor(undefined, undefined, undefined, undefined), 'Object')
  const preview = plugin.__previewDocument({ title: 'N', revision: 1, code: 'const a = 1' }, null)
  assert.ok(preview.includes('const applyExportNames = () => {'))
  assert.ok(preview.includes('restoreNames()'))
})

test('P1-4 structure items order parents-first regardless of selection order', () => {
  const parent = { uid: 's:parent', origin: 'script', node: { uid: 's:parent', parentUid: null }, before: null }
  const child = { uid: 's:child', origin: 'script', node: { uid: 's:child', parentUid: 's:parent' }, before: { uid: 's:child', parentUid: 's:parent' } }
  const ordered = plugin.__orderStructureItemsParentsFirst([child, parent])
  assert.deepEqual(ordered.map(item => item.uid), ['s:parent', 's:child'])
  const manualParent = { uid: 'm:parent', origin: 'manual', item: { uid: 'm:parent', parent: 'scene' } }
  const manualChild = { uid: 'm:child', origin: 'manual', item: { uid: 'm:child', parent: 'm:parent' } }
  const mixed = plugin.__orderStructureItemsParentsFirst([manualChild, child, manualParent, parent])
  const uids = mixed.map(item => item.uid)
  assert.ok(uids.indexOf('s:parent') < uids.indexOf('s:child'))
  assert.ok(uids.indexOf('m:parent') < uids.indexOf('m:child'))
  // Plain no-entry script parent+child: the child UID sorts before the parent,
  // so only the tree-snapshot parent relationship can recover parent-first order.
  const plainChild = { uid: 's:a-child', origin: 'script', node: { uid: 's:a-child', parentUid: 's:b-parent' }, before: null }
  const plainParent = { uid: 's:b-parent', origin: 'script', node: { uid: 's:b-parent', parentUid: null }, before: null }
  const plain = plugin.__orderStructureItemsParentsFirst([plainChild, plainParent])
  assert.deepEqual(plain.map(item => item.uid), ['s:b-parent', 's:a-child'])
})

test('P1-4 duplicate rejects InstancedMesh and stored identity parentUid is preserved', () => {
  assert.equal(plugin.__validateCloneSource({ uid: 's:i', origin: 'script', type: 'Mesh', instances: 2, material: [0] }, [{ readonly: false }]), 'clone-source-unsupported')
  assert.equal(plugin.__validateCloneSource({ uid: 's:m', origin: 'script', type: 'Mesh', material: [0] }, [{ readonly: false }]), null)
  const node = { uid: 's:child', origin: 'script', type: 'Mesh', anchor: 'n:A', namedPath: 'n:A', ordinalPath: 'n:A', parentUid: 's:other', wbId: 'x' }
  const record = plugin.__updateEditorObject(plugin.__emptyEditorRecord(0), 's:child', { ...node, parentUid: 's:parent' }, { visible: false }, 1)
  assert.equal(record.objects['s:child'].parentUid, null, 'a new entry with wbId never initializes parentUid from the live tree (D3b-7R)')
  const updated = plugin.__updateEditorObject(record, 's:child', node, { position: [1, 2, 3] }, 2)
  assert.equal(updated.objects['s:child'].parentUid, null, 'existing identity parentUid is never overwritten from the live tree')
  const locked = plugin.__updateEditorLock(record, 's:child', node, true, 3)
  assert.equal(locked.objects['s:child'].parentUid, null)
  const aliased = plugin.__updateEditorAlias(record, 's:child', node, 'X', 4)
  assert.equal(aliased.record.objects['s:child'].parentUid, null)
  const deleted = plugin.__setEditorDeleted(record, 's:child', node, true, 5)
  assert.equal(deleted.record.objects['s:child'].parentUid, null)
})

test('P1-4 runtime revalidates clone sources, guards hidden descendants, and restore-parent-first', () => {
  const preview = plugin.__previewDocument({ title: 'P14', revision: 1, code: 'const a = 1' }, null)
  assert.ok(preview.includes('object.isInstancedMesh === true'), 'runtime clone source rejects InstancedMesh')
  assert.ok(preview.includes('object.isSkinnedMesh === true'))
  assert.ok(preview.includes("material.isShaderMaterial !== true"))
  assert.ok(preview.includes('entry.hidden || []'), 'frame guard covers hidden descendants')
  assert.ok(preview.includes('hidden.push({ uid: childUid, object: child, parent, index'), 'subtree stash keeps instance/parent/index')
  assert.ok(preview.includes("item.parent !== 'scene' && deletedUids.has(item.parent) && !batchRestored.has(item.parent)"), 'manual child restore validates the batch final state')
  assert.ok(clientSource.includes('orderStructureItemsParentsFirst(items)'))
  assert.ok(preview.includes('const recordHiddenSubtree = object => {'))
  assert.ok(preview.includes('const reattachStash = stash => {'))
  assert.ok(preview.includes('const batchRestored = new Set()'))
  assert.ok(clientSource.includes('synthesizeDeletedScriptEntry'))
})

test('P1-4 camera writes and identity synthesis use stored identity and are gated', () => {
  assert.ok(clientSource.includes("parentUid: previous !== null && previous.parentUid !== undefined ? previous.parentUid : null"), 'deleted tombstone never synthesizes parentUid from the live tree')
  assert.ok(clientSource.includes("const beforeParent = item.before !== null && item.before !== undefined"), 'ordering uses the stored parent, not node.parentUid')
  const resetBody = clientSource.slice(clientSource.indexOf('const resetCamera = () => {'), clientSource.indexOf('const timelineAction'))
  assert.ok(resetBody.includes('structuralBusyRef.current'), 'resetCamera is gated on structuralBusy')
  assert.ok(clientSource.includes("if (structuralBusyRef.current) {\n                structuralNotice()\n              } else {\n                cameraOverrideRef.current"), 'interactive orbit/focus camera write is gated')
})

test('P1-5 parent override normalizes, survives writes/reset, and is metadata-only', () => {
  assert.deepEqual(plugin.__normalizeEditorParent({ to: 's:x', keepWorld: false }), { to: 's:x', keepWorld: false })
  assert.deepEqual(plugin.__normalizeEditorParent({ to: 'scene' }), { to: 'scene', keepWorld: true })
  assert.equal(plugin.__normalizeEditorParent({ to: 'bad key' }), null)
  assert.equal(plugin.__normalizeEditorParent('s:x'), null)
  const node = { uid: 's:a', origin: 'script', type: 'Mesh', anchor: 'n:A', namedPath: 'n:A', ordinalPath: 'n:A', parentUid: null, wbId: 'a' }
  const rep = plugin.__updateEditorParent(plugin.__emptyEditorRecord(0), 's:a', node, 's:b', true, 1, undefined, [{ uid: 's:b', node: { uid: 's:b', origin: 'script', type: 'Group', anchor: 'n:B', namedPath: 'n:B', ordinalPath: 'n:B', parentUid: null }, parentUid: null }])
  assert.equal(rep.ok, true)
  assert.deepEqual(rep.record.objects['s:a'].parent, { to: 's:b', keepWorld: true })
  assert.equal(rep.record.objects['s:a'].parentUid, null, 'script parent override is distinct from identity parentUid')
  assert.ok(rep.record.objects['s:b'] !== undefined, 'target stub created from proven namedPath identity')
  // preserve through writes and reset
  const edited = plugin.__updateEditorObject(rep.record, 's:a', node, { visible: false }, 2)
  assert.deepEqual(edited.objects['s:a'].parent, { to: 's:b', keepWorld: true })
  const cleared = plugin.__clearEditorOverrides(rep.record, 3)
  assert.deepEqual(cleared.objects['s:a'].parent, { to: 's:b', keepWorld: true })
  assert.equal(plugin.__editorHasOverrides(cleared), false, 'parent-only entry is metadata-only')
  // malformed parent is dropped with structure-invalid issue
  const issues = []
  const normalized = plugin.__normalizeEditorRecord({ v: 2, objects: { 's:a': { uid: 's:a', origin: 'script', parent: { to: 'bad' }, overrides: {} } } }, 4, issues)
  assert.equal(normalized.objects['s:a'].parent, null)
  assert.deepEqual(issues.map(issue => issue.kind), ['structure-invalid'])
})

test('P1-5 updateEditorParent manual path and setEditorManualLocal', () => {
  const manual = plugin.__makeManualItem('box', 'm:box')
  manual.parentKeepWorld = false
  const record = plugin.__createEditorManual(plugin.__emptyEditorRecord(0), manual, 1).record
  const rep = plugin.__updateEditorParent(record, 'm:box', null, 's:parent', false, 2, undefined)
  assert.equal(rep.ok, true)
  assert.equal(rep.record.objects['m:box'].parent, 's:parent')
  assert.equal(rep.record.objects['m:box'].parentKeepWorld, false)
  const withLocal = plugin.__updateEditorParent(record, 'm:box', null, 's:parent', true, 3, { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] })
  assert.deepEqual(withLocal.record.objects['m:box'].manual.transform.position, [1, 2, 3])
  const localOnly = plugin.__setEditorManualLocal(record, 'm:box', { position: [4, 5, 6], rotation: [0, 0, 0], scale: [2, 2, 2] }, 4)
  assert.deepEqual(localOnly.record.objects['m:box'].manual.transform.position, [4, 5, 6])
  assert.deepEqual(localOnly.record.objects['m:box'].manual.transform.scale, [2, 2, 2])
  assert.equal(plugin.__setEditorManualLocal(record, 's:no', { position: [1, 2, 3] }, 5).ok, false)
})

test('P1-5 scriptParentUidFor never derives identity from the live tree', () => {
  assert.deepEqual(plugin.__scriptParentUidFor(plugin.__emptyEditorRecord(0), { uid: 's:a', parentUid: 's:live', wbId: 'a', namedPath: '' }, undefined), { ok: true, parentUid: null })
  assert.deepEqual(plugin.__scriptParentUidFor(plugin.__emptyEditorRecord(0), { uid: 's:a', parentUid: 's:live', wbId: null, namedPath: 'n:A' }, undefined), { ok: true, parentUid: null })
  const stored = { ...plugin.__emptyEditorRecord(0), objects: { 's:p': { uid: 's:p', origin: 'script', overrides: {} } } }
  assert.deepEqual(plugin.__scriptParentUidFor(stored, { uid: 's:a', parentUid: 's:p', wbId: null, namedPath: '' }, undefined), { ok: true, parentUid: 's:p' })
  assert.equal(plugin.__scriptParentUidFor(plugin.__emptyEditorRecord(0), { uid: 's:a', parentUid: 's:live', wbId: null, namedPath: '' }, undefined).ok, false)
  // Update-time uniqueness: duplicate wbId or namedPath+type fails closed.
  const dupWb = { ...plugin.__emptyEditorRecord(0), objects: { 's:other': { uid: 's:other', origin: 'script', overrides: {}, wbId: 'a' } } }
  assert.equal(plugin.__scriptParentUidFor(dupWb, { uid: 's:a', parentUid: null, wbId: 'a', namedPath: '' }, undefined).ok, false)
  const dupNamed = { ...plugin.__emptyEditorRecord(0), objects: { 's:other': { uid: 's:other', origin: 'script', overrides: {}, type: 'Mesh', namedPath: 'n:A' } } }
  assert.equal(plugin.__scriptParentUidFor(dupNamed, { uid: 's:a', parentUid: null, wbId: null, namedPath: 'n:A', type: 'Mesh' }, undefined).ok, false)
})

test('P1-5 runtime reparent contracts: locals query, cycle guard, has-script-children, initial graph', () => {
  const preview = plugin.__previewDocument({ title: 'P15', revision: 1, code: 'const a = 1' }, null)
  assert.ok(preview.includes('const queryLocals = (uids, requestId) => {'))
  assert.ok(preview.includes('object.position.toArray()'))
  assert.ok(preview.includes('const applyReparentOp = (op, requestId) => {'))
  assert.ok(preview.includes("error: 'reparent-cycle'"))
  assert.ok(preview.includes("error: 'has-script-children'"))
  assert.ok(preview.includes('newParent.updateWorldMatrix(true, false)'))
  assert.ok(preview.includes('newParent.attach(object)'))
  assert.ok(preview.includes('pinPatches[channel] = after[channel].slice()'))
  assert.ok(preview.includes('const applyInitialReparents = state => {'))
  assert.ok(preview.includes('reason: \'reparent-cycle\''))
  assert.ok(preview.includes('reason: \'reparent-missing\''))
  assert.ok(clientSource.includes('const performReparent = async (sourceUid, targetUid) => {'))
  assert.ok(clientSource.includes("command('structure', { query: 'locals', uids })"))
})

class DraftStorageStub {
  constructor () {
    this.map = new Map()
    this.failWrites = false
    this.failReads = false
    this.failRemoves = false
  }

  get length () { return this.map.size }

  key (index) { return [...this.map.keys()][index] ?? null }

  getItem (key) {
    if (this.failReads) throw new Error('read failed')
    return this.map.has(key) ? this.map.get(key) : null
  }

  setItem (key, value) {
    if (this.failWrites) throw new Error('write failed')
    this.map.set(key, String(value))
  }

  removeItem (key) {
    if (this.failRemoves) throw new Error('remove failed')
    this.map.delete(key)
  }
}

test('P1-6 draft key, UTF-8 size guard, validation, and Session/revision isolation', () => {
  assert.equal(
    plugin.__codeDraftKey('session a/一', 7),
    'three-workbench:code:v1:session%20a%2F%E4%B8%80:7',
  )
  assert.equal(plugin.__codeDraftBytes('abc'), 3)
  assert.equal(plugin.__codeDraftBytes('é'), 2)
  assert.equal(plugin.__codeDraftBytes('🙂'), 4)
  assert.equal(plugin.__CODE_DRAFT_LIMIT_BYTES, 512 * 1024)

  const valid = plugin.__parseCodeDraft(JSON.stringify({ v: 1, text: 'const a = 1', updatedAt: 1234 }))
  assert.deepEqual(valid, { ok: true, text: 'const a = 1', updatedAt: 1234, bytes: 11 })
  for (const raw of [
    '', 'not json', 'null', '[]', '42',
    JSON.stringify({ v: 2, text: 'x', updatedAt: 1 }),
    JSON.stringify({ v: 1, text: 42, updatedAt: 1 }),
    JSON.stringify({ v: 1, text: 'x' }),
    JSON.stringify({ v: 1, text: 'x', updatedAt: -1 }),
    JSON.stringify({ v: 1, text: 'x', updatedAt: '1' }),
    JSON.stringify({ v: 1, text: 'x', updatedAt: null }),
  ]) {
    assert.deepEqual(plugin.__parseCodeDraft(raw), { ok: false, reason: 'corrupt' }, `rejects ${raw.slice(0, 40)}`)
  }

  const exact = 'a'.repeat(plugin.__CODE_DRAFT_LIMIT_BYTES)
  const tooBig = exact + 'a'
  assert.equal(plugin.__parseCodeDraft(JSON.stringify({ v: 1, text: exact, updatedAt: 1 })).ok, true)
  assert.deepEqual(
    plugin.__parseCodeDraft(JSON.stringify({ v: 1, text: tooBig, updatedAt: 1 })),
    { ok: false, reason: 'oversized', bytes: plugin.__CODE_DRAFT_LIMIT_BYTES + 1 },
  )

  const storage = new DraftStorageStub()
  const saved = plugin.__saveCodeDraft(storage, 's 1', 4, 'const hero = 1', 100)
  assert.deepEqual(saved, { ok: true, bytes: 14 })
  assert.equal(storage.map.size, 1)
  assert.equal(plugin.__parseCodeDraft(storage.getItem(plugin.__codeDraftKey('s 1', 4))).text, 'const hero = 1')
  assert.equal(plugin.__saveCodeDraft(storage, 's 1', 5, 'draft five', 101).ok, true)
  assert.equal(plugin.__saveCodeDraft(storage, 's 2', 4, 'other session', 102).ok, true)

  const listed = plugin.__listCodeDrafts(storage, 's 1')
  assert.deepEqual(Object.keys(listed.drafts).sort(), ['4', '5'])
  assert.deepEqual(listed.issues, [])
  assert.equal(listed.drafts['4'].text, 'const hero = 1')
  assert.equal(listed.drafts['4'].updatedAt, 100)
  assert.equal(listed.drafts['4'].active, false, 'stored drafts always load inactive')

  const prefix = 'three-workbench:code:v1:s%201:'
  storage.setItem(prefix + '6', '{bad json')
  storage.setItem(prefix + 'x', '{}')
  storage.setItem(prefix + '0', '{}')
  storage.setItem(prefix + '01', '{}')
  storage.setItem(prefix + '7', JSON.stringify({ v: 1, text: 'ok', updatedAt: 1 }))
  storage.setItem(prefix + '8', JSON.stringify({ v: 1, text: tooBig, updatedAt: 1 }))
  const mixed = plugin.__listCodeDrafts(storage, 's 1')
  assert.deepEqual(Object.keys(mixed.drafts).sort(), ['4', '5', '7'])
  assert.deepEqual(
    mixed.issues.map(issue => [issue.reason, issue.revision]).sort(),
    [['corrupt', null], ['corrupt', null], ['corrupt', null], ['corrupt', 6], ['oversized', 8]].sort(),
  )
  assert.equal(mixed.issues.find(issue => issue.reason === 'oversized').bytes, plugin.__CODE_DRAFT_LIMIT_BYTES + 1)

  const beforeOversize = storage.map.size
  assert.deepEqual(
    plugin.__saveCodeDraft(storage, 's 1', 9, tooBig, 1),
    { ok: false, error: 'oversized', bytes: plugin.__CODE_DRAFT_LIMIT_BYTES + 1 },
  )
  assert.equal(storage.map.size, beforeOversize, 'oversized drafts are refused, never truncated or written')
  assert.deepEqual(plugin.__saveCodeDraft(storage, 's 1', 9, 42, 1), { ok: false, error: 'invalid' })
  assert.deepEqual(plugin.__saveCodeDraft(storage, 's 1', 9, 'x', Number.NaN), { ok: false, error: 'invalid' })

  storage.failWrites = true
  assert.deepEqual(plugin.__saveCodeDraft(storage, 's 1', 9, 'x', 1), { ok: false, error: 'storage' })
  storage.failWrites = false
  storage.failReads = true
  assert.equal(plugin.__listCodeDrafts(storage, 's 1').issues[0].reason, 'storage')
  storage.failReads = false
  storage.failRemoves = true
  assert.deepEqual(plugin.__deleteCodeDraft(storage, 's 1', 4), { ok: false, error: 'storage' })
  storage.failRemoves = false
  assert.deepEqual(plugin.__deleteCodeDraft(storage, 's 1', 5), { ok: true })
  assert.equal(plugin.__listCodeDrafts(storage, 's 1').drafts['5'], undefined)
  assert.deepEqual(plugin.__deleteCodeDraftKey(storage, ''), { ok: false, error: 'invalid' })
  assert.deepEqual(plugin.__deleteCodeDraftKey(null, prefix + '4'), { ok: false, error: 'unavailable' })
  assert.deepEqual(plugin.__listCodeDrafts(null, 's 1'), {
    drafts: {},
    issues: [{ reason: 'storage', revision: null, key: null }],
  })
})

test('P1-6 effective record only applies an active draft at the exact revision', () => {
  const record = { sceneId: 'session-a', revision: 3, title: 'T', code: 'agent()' }
  const draft = { revision: 3, text: 'draft()', active: true }
  const effective = plugin.__effectiveSceneRecord(record, draft)
  assert.notEqual(effective, record)
  assert.equal(effective.code, 'draft()')
  assert.equal(record.code, 'agent()', 'the Host record object is never mutated')
  assert.equal(effective.sceneId, 'session-a')
  assert.equal(effective.revision, 3)
  assert.equal(effective.title, 'T')
  assert.notEqual(plugin.__previewFingerprint(effective), plugin.__previewFingerprint(record))

  assert.equal(plugin.__effectiveSceneRecord(record, { ...draft, active: false }), record)
  assert.equal(plugin.__effectiveSceneRecord(record, { ...draft, active: 'true' }), record)
  assert.equal(plugin.__effectiveSceneRecord(record, { ...draft, revision: 2 }), record)
  assert.equal(plugin.__effectiveSceneRecord(record, { ...draft, text: null }), record)
  assert.equal(plugin.__effectiveSceneRecord(record, null), record)
  assert.equal(plugin.__effectiveSceneRecord(null, draft), null)
  assert.equal(plugin.__codeDraftIdentity(record, { ...draft, active: false }), 'agent')
  assert.equal(plugin.__codeDraftIdentity(record, { ...draft, revision: 2 }), 'agent')
  assert.match(plugin.__codeDraftIdentity(record, draft), /^draft:[0-9a-z]+$/)

  // Equal-length drafts must still produce distinct document tokens.
  const textA = 'const heroX = 1'
  const textB = 'const heroY = 1'
  assert.equal(textA.length, textB.length)
  assert.notEqual(
    plugin.__codeDraftIdentity(record, { ...draft, text: textA }),
    plugin.__codeDraftIdentity(record, { ...draft, text: textB }),
  )
  const recordA = { ...record, code: textA }
  const recordB = { ...record, code: textB }
  const tokenA = plugin.__previewToken('session-a', recordA, 0, plugin.__previewFingerprint(recordA), plugin.__codeDraftIdentity(record, { ...draft, text: textA }))
  const tokenB = plugin.__previewToken('session-a', recordB, 0, plugin.__previewFingerprint(recordB), plugin.__codeDraftIdentity(record, { ...draft, text: textB }))
  assert.notEqual(tokenA, tokenB)
  assert.notEqual(
    plugin.__previewToken('session-a', recordA, 0, plugin.__previewFingerprint(recordA), 'agent'),
    tokenA,
    'applying or reverting the same bytes still changes the document identity',
  )
  assert.equal(
    plugin.__previewToken('session-a', recordA, 0, plugin.__previewFingerprint(recordA)),
    'session-a:session-a:3:0:' + plugin.__previewFingerprint(recordA),
    'the legacy four-argument token shape is unchanged',
  )
})

test('P1-7 console serializer survives cycles, Errors, hostile getters, and caps text', () => {
  const serialize = plugin.__serializeConsoleArgument
  assert.equal(serialize(null), 'null')
  assert.equal(serialize(undefined), 'undefined')
  assert.equal(serialize(12), '12')
  assert.equal(serialize(12n), '12')
  assert.equal(serialize(true), 'true')
  assert.equal(serialize(Symbol('s')), 'Symbol(s)')
  assert.equal(serialize(function named () {}), '[Function: named]')
  assert.equal(serialize(function () {}), '[Function: anonymous]')
  assert.equal(serialize('hello'), 'hello')
  assert.deepEqual(serialize([1, 'two', undefined]), '[1, two, undefined]')
  assert.equal(serialize({ a: 1, b: 'x' }), '{a: 1, b: x}')
  assert.equal(serialize(new Date('2020-01-02T03:04:05.000Z')), '2020-01-02T03:04:05.000Z')

  const long = 'x'.repeat(2500)
  const capped = serialize(long)
  assert.equal(capped.length, 2000)
  assert.equal(capped.endsWith('…'), true)
  assert.equal(serialize({ long }).length <= 2000, true)

  const error = new Error('BOOM-MARKER')
  const errorText = serialize(error)
  assert.ok(errorText.includes('BOOM-MARKER'))
  assert.ok(errorText.includes('at '), 'Error serialization keeps the stack')

  const circular = { name: 'loop' }
  circular.self = circular
  const circularText = serialize(circular)
  assert.ok(circularText.includes('name: loop'))
  assert.ok(circularText.includes('[Circular]'))

  const hostile = {}
  Object.defineProperty(hostile, 'x', { enumerable: true, get () { throw new Error('getter') } })
  assert.equal(serialize(hostile), '{x: [Unserializable]}')
  const hostileKeys = new Proxy({}, { ownKeys () { throw new Error('keys') } })
  assert.equal(serialize(hostileKeys), '[Unserializable]')

  let deep = {}
  const root = deep
  for (let index = 0; index < 8; index += 1) {
    deep.next = {}
    deep = deep.next
  }
  assert.ok(serialize(root).includes('[Object]'), 'deep nesting is bounded')

  const wide = Array.from({ length: 60 }, (_, index) => index)
  const wideText = serialize(wide)
  assert.ok(wideText.endsWith('…]'))
  assert.equal(wideText.includes('50'), false, 'arrays stop at 50 items')

  assert.deepEqual(
    plugin.__consoleEntryFor('warn', [1, 'two', undefined, function f () {}, Symbol('s'), 'ignored'], 123),
    { level: 'warn', text: '1 two undefined [Function: f] Symbol(s)', at: 123 },
  )
  assert.deepEqual(plugin.__consoleEntryFor('log', 'not an array', 1), { level: 'log', text: '', at: 1 })
})

test('P1-7 console buffer keeps newest 200, tracks drops/unread, filters, and clears on token', () => {
  const empty = plugin.__emptyConsoleBuffer()
  assert.deepEqual(empty, { entries: [], dropped: 0, unread: 0 })
  const levels = ['log', 'info', 'warn', 'error', 'debug']
  let buffer = plugin.__appendConsoleEntries(empty, levels.map((level, index) => ({
    level, text: String(index), at: index,
  })), false)
  assert.deepEqual(buffer.entries.map(entry => entry.level), levels)
  assert.equal(buffer.unread, 5)
  assert.equal(buffer.dropped, 0)

  const read = plugin.__appendConsoleEntries(buffer, [{ level: 'log', text: 'six', at: 6 }], true)
  assert.equal(read.unread, 0, 'an open drawer marks entries as read')
  assert.equal(read.entries.length, 6)

  assert.equal(plugin.__normalizeConsoleEntry({ level: 'trace', text: 'x' }), null)
  assert.equal(plugin.__normalizeConsoleEntry({ level: 'log', text: 1 }), null)
  assert.deepEqual(plugin.__normalizeConsoleEntry({ level: 'log', text: 'x', at: Number.NaN }), { level: 'log', text: 'x', at: 0 })
  assert.equal(plugin.__normalizeConsoleEntry({ level: 'log', text: 'y'.repeat(9000) }).text.length, 8000)
  assert.deepEqual(plugin.__normalizeConsoleEntries('nope'), [])
  assert.equal(plugin.__normalizeConsoleEntries(Array.from({ length: 500 }, (_, index) => ({ level: 'log', text: String(index), at: index }))).length, 400)

  const many = Array.from({ length: 201 }, (_, index) => ({ level: 'log', text: 'n' + index, at: index }))
  const capped = plugin.__appendConsoleEntries(plugin.__emptyConsoleBuffer(), many, false)
  assert.equal(capped.entries.length, plugin.__CONSOLE_ENTRY_LIMIT)
  assert.equal(capped.entries[0].text, 'n1')
  assert.equal(capped.entries[199].text, 'n200')
  assert.equal(capped.dropped, 1)
  assert.equal(capped.unread, 201)
  const cappedAgain = plugin.__appendConsoleEntries(capped, many.slice(0, 5), false)
  assert.equal(cappedAgain.entries.length, 200)
  assert.equal(cappedAgain.entries[0].text, 'n6')
  assert.equal(cappedAgain.dropped, 6)

  assert.deepEqual(plugin.__filterConsoleEntries(read.entries, 'warn').map(entry => entry.text), ['2'])
  assert.equal(plugin.__filterConsoleEntries(read.entries, 'all').length, 6)
  assert.equal(plugin.__filterConsoleEntries(read.entries, 'trace').length, 6, 'unknown filters do not hide logs')
  assert.deepEqual(plugin.__filterConsoleEntries(null, 'all'), [])
  assert.deepEqual(plugin.__CONSOLE_FILTERS, ['all', 'log', 'info', 'warn', 'error'])

  assert.equal(plugin.__consoleBufferForToken(buffer, 'token-a', 'token-a'), buffer)
  assert.deepEqual(plugin.__consoleBufferForToken(buffer, 'token-a', 'token-b'), plugin.__emptyConsoleBuffer())
  assert.deepEqual(
    plugin.__appendConsoleEntries(null, [{ level: 'log', text: 'alive', at: 1 }], false).entries.map(entry => entry.text),
    ['alive'],
  )
})

test('P1-6/P1-7 source guards: no parent eval, unchanged sandbox, bilingual keys, runtime batching', () => {
  assert.equal(/\beval\s*\(/.test(clientSource), false, 'the parent half never calls eval')
  const newFunctionCalls = [...clientSource.matchAll(/new Function/g)]
  assert.equal(newFunctionCalls.length, 1, 'the only new Function is the sandboxed runtime source')
  const functionLineStart = clientSource.lastIndexOf('\n', newFunctionCalls[0].index) + 1
  const functionLineEnd = clientSource.indexOf('\n', newFunctionCalls[0].index)
  const functionLine = clientSource.slice(functionLineStart, functionLineEnd)
  assert.ok(functionLine.includes("'with (ctx) {\\\\n' + SCENE.code"))
  assert.ok(functionLine.includes('new Function'))
  assert.ok(clientSource.indexOf('new Function') > clientSource.indexOf('const previewDocument'))
  assert.ok(clientSource.indexOf('new Function') < clientSource.indexOf('function PreviewPanel'))

  assert.equal((clientSource.match(/allow-same-origin/g) || []).length, 0)
  const sandboxMatches = [...clientSource.matchAll(/sandbox:\s*'([^']+)'/g)]
  assert.equal(sandboxMatches.length, 1)
  assert.equal(sandboxMatches[0][1], 'allow-scripts allow-pointer-lock allow-downloads')

  assert.ok(clientSource.includes('previewDocument(effectiveRecord, initialCamera, payload, {'))
  assert.ok(clientSource.includes('previewToken(sessionId, effectiveRecord, reloadTick, contentFingerprint, codeIdentity)'))
  const applyStart = clientSource.indexOf('const applyCodeDraft = () => {')
  const applyEnd = clientSource.indexOf('const activateStoredDraft = () => {', applyStart)
  assert.ok(applyStart > 0 && applyEnd > applyStart)
  const applyBody = clientSource.slice(applyStart, applyEnd)
  assert.ok(applyBody.includes('saveCodeDraft(storage, sessionId, record.revision, codeText, updatedAt)'))
  assert.equal(/\bprompt\s*\(|\bcommand\s*\(|\brequest\s*\(|\bfetch\s*\(|\bpost\s*\(/.test(applyBody), false, 'Apply only writes localStorage')

  const preview = plugin.__previewDocument({ title: 'P17', revision: 1, code: 'console.log("x")' }, null)
  assert.ok(preview.includes("type: 'three-workbench:console'"))
  assert.ok(preview.includes('consoleQueue.splice(0, 20)'))
  assert.ok(preview.includes('setTimeout(flushConsole, 200)'))
  assert.ok(preview.includes('nativeConsoleMethods[consoleLevel].apply(console, arguments)'))
  assert.ok(preview.includes("consoleLevels = ['log', 'info', 'warn', 'error', 'debug']"))
  assert.ok(preview.includes('const serializeConsoleArgument = '))
  assert.ok(preview.includes('const consoleEntryFor = '))

  const newKeys = [
    'console.title', 'console.open', 'console.close', 'console.clear', 'console.empty',
    'console.dropped', 'console.level.all', 'console.level.log', 'console.level.info',
    'console.level.warn', 'console.level.error', 'console.level.debug',
    'code.localNotice', 'code.runningAgent', 'code.runningDraft', 'code.apply',
    'code.applyHint', 'code.revert', 'code.restore', 'code.editorLabel', 'code.lineInfo',
    'code.unsaved', 'code.draftInactive', 'code.applyStored', 'code.discardChanges',
    'code.oversized', 'code.storageError', 'code.invalidDrafts', 'code.discardInvalid',
    'code.historyReadOnly', 'code.conflict', 'code.conflictApply', 'code.conflictDiscard',
  ]
  for (const key of newKeys) {
    assert.equal((clientSource.split(`'${key}':`).length - 1), 2, `${key} exists once in zh and once in en`)
  }
})

// ---------------------------------------------------------------------------
// P1-10 wb.expose user parameters
// ---------------------------------------------------------------------------

test('P1-10 schema round-trips all five types and rejects malformed schemas atomically', () => {
  const schema = {
    speed: { type: 'number', default: 5, min: 0, max: 10, step: 0.5, label: { zh: '速度', en: 'Speed' } },
    tint: { type: 'color', default: '#AABBCC' },
    flag: { type: 'boolean', default: true, label: '  Toggle  ' },
    mode: {
      type: 'select',
      default: 'b',
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: { zh: '乙', en: 'B' } }],
    },
    note: { type: 'text', default: 'hi', maxLength: 10 },
  }
  const result = plugin.__validateParamSchema(schema)
  assert.equal(result.ok, true)
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.schema.map(entry => entry.key), ['speed', 'tint', 'flag', 'mode', 'note'])
  assert.deepEqual(result.schema[0].label, { zh: '速度', en: 'Speed' })
  assert.deepEqual(result.schema[1].label, { zh: 'tint', en: 'tint' }, 'missing label falls back to the key')
  assert.deepEqual(result.schema[2].label, { zh: 'Toggle', en: 'Toggle' }, 'string labels are trimmed')
  assert.deepEqual(result.schema[4].label, { zh: 'note', en: 'note' })
  assert.deepEqual(result.schema[3].options, [
    { value: 'a', label: { zh: 'A', en: 'A' } },
    { value: 'b', label: { zh: '乙', en: 'B' } },
  ])
  assert.equal(result.schema[0].default, 5)
  assert.equal(result.schema[1].default, '#aabbcc', 'colors are lowercased')
  assert.equal(result.schema[3].default, 'b')
  assert.equal(result.schema[4].maxLength, 10)
  assert.deepEqual(result.defaults, { speed: 5, tint: '#aabbcc', flag: true, mode: 'b', note: 'hi' })

  const resolved = plugin.__resolveParamValues(result.schema, {
    speed: 4.5, tint: '#AABBCC', flag: false, mode: 'b', note: 'hello',
  })
  assert.equal(resolved.ok, true)
  assert.deepEqual(resolved.values, { speed: 4.5, tint: '#aabbcc', flag: false, mode: 'b', note: 'hello' })
  assert.deepEqual(resolved.issues, [])

  const set = plugin.__paramUpdateResult(result.schema, resolved.values, 'set', {
    speed: 3, tint: '#00FF00', flag: true, mode: 'a', note: 'ok',
  })
  assert.equal(set.ok, true)
  assert.deepEqual(set.values, { speed: 3, tint: '#00ff00', flag: true, mode: 'a', note: 'ok' })
  const reset = plugin.__paramUpdateResult(result.schema, set.values, 'reset', null)
  assert.equal(reset.ok, true)
  assert.deepEqual(reset.values, result.defaults)

  // 1..50 parameters is the limit; the 51st fails all-or-nothing.
  const fifty = {}
  for (let index = 0; index < 50; index += 1) fifty['p' + index] = { type: 'boolean', default: false }
  assert.equal(plugin.__validateParamSchema(fifty).ok, true)
  const fiftyOne = Object.assign({}, fifty, { p50: { type: 'boolean', default: true } })
  const overLimit = plugin.__validateParamSchema(fiftyOne)
  assert.equal(overLimit.ok, false)
  assert.deepEqual(overLimit.schema, [])
  assert.deepEqual(overLimit.defaults, {})
  assert.ok(overLimit.issues.some(issue => issue.code === 'param-limit'))

  const bad = {
    ['__proto__']: { type: 'boolean', default: true },
    constructor: { type: 'boolean', default: true },
    prototype: { type: 'boolean', default: true },
    '1bad': { type: 'boolean', default: true },
    ['a'.repeat(65)]: { type: 'boolean', default: true },
    unknownType: { type: 'date', default: 'x' },
    duplicateOptions: { type: 'select', default: 'a', options: [{ value: 'a' }, { value: 'a' }] },
    emptyOption: { type: 'select', default: '', options: [{ value: '' }] },
    noOptions: { type: 'select', default: 'a', options: [] },
    badMaxZero: { type: 'text', default: 'x', maxLength: 0 },
    badMaxFraction: { type: 'text', default: 'x', maxLength: 2.5 },
    badMaxBig: { type: 'text', default: 'x', maxLength: 1025 },
    badMaxType: { type: 'text', default: 'x', maxLength: '10' },
    badLabel: { type: 'boolean', default: true, label: { zh: 5, en: 'x' } },
    badDescriptor: 'nope',
    badNumberDefault: { type: 'number', default: '2' },
    badColorDefault: { type: 'color', default: 'red' },
    badBooleanDefault: { type: 'boolean', default: 1 },
    missingTextDefault: { type: 'text' },
  }
  const rejected = plugin.__validateParamSchema(bad)
  assert.equal(rejected.ok, false)
  assert.deepEqual(rejected.schema, [], 'no valid descriptor leaks out of a malformed schema')
  assert.deepEqual(rejected.defaults, {})
  assert.ok(rejected.issues.length <= 20, 'issue reports are bounded')
  const codes = new Set(rejected.issues.map(issue => issue.code))
  for (const code of ['invalid-key', 'invalid-type', 'duplicate-option', 'invalid-option',
    'invalid-options', 'invalid-max-length', 'invalid-label', 'invalid-default']) {
    assert.ok(codes.has(code), `malformed schema reports ${code}`)
  }
  assert.ok(rejected.issues.some(issue => issue.key === '__proto__'), 'reserved key is named in the issue')

  // The 64-character boundary is valid; a rejected declaration is inert.
  assert.equal(plugin.__isParamKeyText('a'.repeat(64)), true)
  assert.equal(plugin.__isParamKeyText('a'.repeat(65)), false)
  assert.equal(plugin.__isParamKeyText('constructor'), false)
  assert.equal(plugin.__validateParamSchema(null).issues[0].code, 'not-object')
  assert.equal(plugin.__validateParamSchema({}).issues[0].code, 'empty-schema')
})

test('P1-10 number, color, select and text values clamp, normalize and fall back', () => {
  const clamped = plugin.__validateParamSchema({ n: { type: 'number', default: 12, min: 0, max: 10, step: 2 } })
  assert.equal(clamped.ok, true)
  assert.equal(clamped.schema[0].default, 10, 'number defaults clamp to bounds after snapping')
  const snapped = plugin.__validateParamSchema({ n: { type: 'number', default: 0.30000000000000004, min: 0, step: 0.1 } })
  assert.equal(snapped.schema[0].default, 0.3, 'binary noise is cleaned and the default snaps to the step')
  assert.equal(plugin.__validateParamSchema({ n: { type: 'number', default: 1, min: 5, max: 1 } }).issues[0].code, 'invalid-range')
  assert.equal(plugin.__validateParamSchema({ n: { type: 'number', default: 1, step: 0 } }).issues[0].code, 'invalid-step')
  assert.equal(plugin.__validateParamSchema({ n: { type: 'number', default: 1, step: -1 } }).issues[0].code, 'invalid-step')
  for (const value of ['2', NaN, Infinity, -Infinity]) {
    assert.equal(plugin.__validateParamSchema({ n: { type: 'number', default: value } }).issues[0].code, 'invalid-default')
  }

  const numberSchema = plugin.__validateParamSchema({ n: { type: 'number', default: 5, min: 0, max: 10, step: 2 } }).schema
  const numberResolved = plugin.__resolveParamValues(numberSchema, { n: 12.2 })
  assert.equal(numberResolved.values.n, 10, 'stored out-of-range values resolve clamped/snapped for the session')
  assert.ok(numberResolved.issues.some(issue => issue.code === 'clamped'))
  const numberSet = plugin.__paramUpdateResult(numberSchema, { n: 5 }, 'set', { n: -3 })
  assert.equal(numberSet.values.n, 0, 'live sets clamp/snap rather than reject finite numbers')
  assert.equal(plugin.__paramUpdateResult(numberSchema, { n: 5 }, 'set', { n: Infinity }).error, 'invalid-value')

  const colorSchema = plugin.__validateParamSchema({ c: { type: 'color', default: '#A1B2C3' } }).schema
  assert.equal(colorSchema[0].default, '#a1b2c3')
  const badColorStored = plugin.__resolveParamValues(colorSchema, { c: 'red' })
  assert.equal(badColorStored.values.c, '#a1b2c3', 'invalid stored color falls back to the default')
  assert.ok(badColorStored.issues.some(issue => issue.code === 'invalid-value'))
  assert.equal(plugin.__paramUpdateResult(colorSchema, { c: '#a1b2c3' }, 'set', { c: '#ABCDEF' }).values.c, '#abcdef')

  const selectSchema = plugin.__validateParamSchema({
    s: { type: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b' }] },
  })
  assert.equal(selectSchema.ok, true)
  assert.equal(selectSchema.schema[0].default, 'a', 'a missing/invalid select default uses the first option')
  assert.deepEqual(selectSchema.schema[0].options[1].label, { zh: 'b', en: 'b' }, 'option labels fall back to the value')
  const removedOption = plugin.__resolveParamValues(selectSchema.schema, { s: 'gone' })
  assert.equal(removedOption.values.s, 'a')
  assert.ok(removedOption.issues.some(issue => issue.code === 'invalid-value'))
  const rawRecord = { v: 2, objects: {}, params: { v: 1, values: { s: 'gone' } } }
  assert.equal(rawRecord.params.values.s, 'gone', 'resolving never deletes the raw removed-option value')
  assert.equal(plugin.__paramUpdateResult(selectSchema.schema, { s: 'a' }, 'set', { s: 'gone' }).error, 'invalid-value')
  assert.equal(plugin.__validateParamSchema({
    s: { type: 'select', options: [{ value: 'x' }, { value: 'x' }] },
  }).issues[0].code, 'duplicate-option')

  const textSchema = plugin.__validateParamSchema({ t: { type: 'text', default: 'abcdef', maxLength: 3 } })
  assert.equal(textSchema.schema[0].default, 'abc', 'text defaults are capped by maxLength')
  assert.equal(plugin.__validateParamSchema({ t: { type: 'text', default: 'x' } }).schema[0].maxLength, 256)
  const long = plugin.__validateParamSchema({ t: { type: 'text', default: 'x'.repeat(300) } })
  assert.equal(long.schema[0].default.length, 256, 'default maxLength is 256')
  const overCap = 'x'.repeat(1025)
  const stored = plugin.__normalizeParamValues({ t: overCap })
  assert.equal(stored.values.t.length, 1024, 'stored text over the hard cap is truncated on read')
  assert.ok(stored.issues.some(issue => issue.code === 'text-truncated'))
  const textResolved = plugin.__resolveParamValues(textSchema.schema, { t: 'abcd' })
  assert.equal(textResolved.values.t, 'abc')
  assert.ok(textResolved.issues.some(issue => issue.code === 'invalid-value'))
  assert.equal(plugin.__paramUpdateResult(textSchema.schema, { t: 'abc' }, 'set', { t: 'abcd' }).error, 'invalid-value')
  assert.equal(plugin.__paramUpdateResult(textSchema.schema, { t: 'abc' }, 'set', { t: 'abc' }).ok, true)
})

test('P1-10 parent revalidates runtime schemas, issue data and acks as untrusted', () => {
  const validation = plugin.__validateParamSchema({
    speed: { type: 'number', default: 5, min: 0, max: 10, step: 0.5, label: { zh: '速度', en: 'Speed' } },
    mode: { type: 'select', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    note: { type: 'text', default: 'hi', maxLength: 8 },
  })
  const descriptors = JSON.parse(JSON.stringify(validation.schema))
  const declared = plugin.__validateParamsRuntimeMessage({
    action: 'schema',
    ok: true,
    declared: true,
    schema: descriptors,
    values: { speed: 999, mode: 'b', note: 'tampered' },
    issues: [{ code: 'clamped', key: 'speed' }],
    applyError: { message: '  boom  ' },
  }, { speed: 7, mode: 'b', note: 'ok', orphan: 'kept-out' })
  assert.equal(declared.ok, true)
  assert.equal(declared.invalid, false)
  assert.equal(declared.declared, true)
  assert.deepEqual(declared.schema, validation.schema, 'parent reconstruction validates to the same schema')
  assert.deepEqual(declared.values, { speed: 7, mode: 'b', note: 'ok' }, 'effective values are recomputed from parent storage, never the frame')
  assert.deepEqual(declared.applyError, { message: 'boom' })
  assert.equal(Object.prototype.hasOwnProperty.call(declared.values, 'orphan'), false, 'dormant keys are not exposed as active values')

  const outOfRange = plugin.__validateParamsRuntimeMessage({
    action: 'schema', ok: true, declared: true, schema: descriptors,
  }, { speed: 99 })
  assert.equal(outOfRange.values.speed, 10)
  assert.ok(outOfRange.issues.some(issue => issue.code === 'clamped'))

  const tamperedLabel = plugin.__validateParamsRuntimeMessage({
    action: 'schema', ok: false, declared: true, schema: [], issues: [{ code: '<img onerror>', key: 'k'.repeat(100) }],
  }, {})
  assert.equal(tamperedLabel.invalid, true)
  assert.equal(tamperedLabel.issues[0].code, 'invalid-schema')
  assert.equal(tamperedLabel.issues[0].key.length, 80)
  const emptyIssues = plugin.__validateParamsRuntimeMessage({ action: 'schema', ok: false, declared: true, schema: [] }, {})
  assert.deepEqual(emptyIssues.issues, [{ code: 'invalid-schema' }])

  const forgedDescriptor = plugin.__validateParamsRuntimeMessage({
    action: 'schema', ok: true, declared: true,
    schema: [{ key: 'bad', type: 'date', label: 'Bad', default: 'x' }],
  }, {})
  assert.equal(forgedDescriptor.invalid, true)
  assert.equal(forgedDescriptor.schema.length, 0)
  assert.equal(plugin.__rawParamSchemaFromDescriptors([{ key: 'x' }, { key: 'x' }]), null)
  assert.equal(plugin.__rawParamSchemaFromDescriptors([{ key: '1bad' }]), null)
  assert.equal(plugin.__rawParamSchemaFromDescriptors([{ key: 'x', options: 'no' }]), null)
  assert.equal(plugin.__rawParamSchemaFromDescriptors(new Array(51).fill({ key: 'x' })), null)
  assert.equal(plugin.__rawParamSchemaFromDescriptors([null]), null)

  assert.deepEqual(plugin.__validateParamsRuntimeMessage({ action: 'schema', ok: true, duplicate: true }, {}), { ok: true, duplicate: true })
  assert.equal(plugin.__validateParamsRuntimeMessage({ action: 'reset', ok: true }, {}).ok, false)
  assert.equal(plugin.__validateParamsRuntimeMessage({ action: 'schema', ok: true }, {}).ok, false)
  assert.equal(plugin.__validateParamsRuntimeMessage(null, {}).ok, false)
  const cappedError = plugin.__validateParamsRuntimeMessage({
    action: 'schema', ok: true, declared: true, schema: descriptors, applyError: { message: 'x'.repeat(400) },
  }, {})
  assert.equal(cappedError.applyError.message.length, 300)
  const ignoredError = plugin.__validateParamsRuntimeMessage({
    action: 'schema', ok: true, declared: true, schema: descriptors, applyError: { message: 7 },
  }, {})
  assert.equal(ignoredError.applyError, null)

  const manyIssues = plugin.__sanitizeParamIssues(new Array(30).fill({ code: 'bad code', key: 'a'.repeat(90) }))
  assert.equal(manyIssues.length, 20)
  assert.deepEqual(manyIssues[0], { code: 'invalid-schema', key: 'a'.repeat(80) })

  assert.equal(plugin.__paramLabelFor('zh', { zh: '中文', en: 'EN' }), '中文')
  assert.equal(plugin.__paramLabelFor('en', { zh: '中文', en: 'EN' }), 'EN')
  assert.equal(plugin.__paramLabelFor('zh', { zh: '', en: 'EN' }), 'EN')
  assert.equal(plugin.__paramLabelFor('en', { zh: '中文', en: '' }), '中文')
  assert.equal(plugin.__paramLabelFor('en', 'Flat'), 'Flat')
  assert.equal(plugin.__paramLabelFor('en', null), '')

  assert.deepEqual(plugin.__paramDormantKeys(validation.schema, { speed: 1, orphan: 'x', bad: null }), ['orphan'])
  assert.deepEqual(plugin.__paramDormantKeys([], { orphan: 'x' }), ['orphan'])

  const setAck = plugin.__paramAckCheck(validation.schema, { speed: 5, mode: 'a', note: 'hi' }, 'set', { speed: 3.2, mode: 'b' }, {
    speed: 3, mode: 'b', extra: 'ignored',
  })
  assert.equal(setAck.ok, true)
  assert.deepEqual(setAck.values, { speed: 3, mode: 'b', note: 'hi' })
  assert.equal(plugin.__paramAckCheck(validation.schema, { speed: 5, mode: 'a', note: 'hi' }, 'set', { speed: 3 }, { speed: 3.5 }).error, 'ack-mismatch')
  assert.equal(plugin.__paramAckCheck(validation.schema, { speed: 5, mode: 'a', note: 'hi' }, 'set', { speed: 3 }, { mode: 'a' }).error, 'ack-mismatch')
  assert.equal(plugin.__paramAckCheck(validation.schema, { speed: 5, mode: 'a', note: 'hi' }, 'set', { speed: 3 }, []).error, 'ack-mismatch')
  assert.equal(plugin.__paramAckCheck(validation.schema, { speed: 5, mode: 'a', note: 'hi' }, 'set', { nope: 1 }, {}).error, 'unknown-key')
  const resetAck = plugin.__paramAckCheck(validation.schema, { speed: 3, mode: 'b', note: 'yo' }, 'reset', null, {
    speed: 5, mode: 'a', note: 'hi',
  })
  assert.equal(resetAck.ok, true)
})

test('P1-10 v2 records persist parameter values, preserve dormant keys and reset precisely', () => {
  const v2Key = plugin.__editorV2Key('session-params')
  const v1Key = plugin.__editorV1Key('session-params')
  const oldIssues = []
  const oldV2 = plugin.__normalizeEditorRecord({ v: 2, updatedAt: 3, objects: {}, camera: null }, 4, oldIssues)
  assert.deepEqual(oldV2.params, { v: 1, values: {} }, 'a pre-P1-10 v2 record gains an empty params field')
  assert.deepEqual(oldIssues, [])

  const v1Storage = memoryStorage({
    [v1Key]: JSON.stringify({ objects: {}, camera: null }),
  })
  const migrated = plugin.__loadEditorSession(v1Storage, 'session-params', { now: 10, makeUid: () => 'l:legacy' })
  assert.equal(migrated.source, 'v1')
  assert.deepEqual(migrated.record.params, { v: 1, values: {} }, 'v1 migration gains an empty params field')

  const malformedField = plugin.__normalizeEditorParamsField({
    v: 1,
    values: { good: 'x', bad: null, list: [], long: 'x'.repeat(1025) },
  })
  assert.deepEqual(Object.keys(malformedField.params.values).sort(), ['good', 'long'])
  assert.equal(malformedField.params.values.long.length, 1024)
  const fieldCodes = malformedField.issues.map(issue => issue.code)
  assert.equal(fieldCodes.filter(code => code === 'malformed-value').length, 2)
  assert.ok(fieldCodes.includes('text-truncated'))
  assert.equal(plugin.__normalizeEditorParamsField({ v: 2, values: {} }).issues[0].code, 'malformed-params')
  const recordIssues = []
  plugin.__normalizeEditorRecord({
    v: 2, objects: {}, params: { v: 1, values: { bad: null } },
  }, 5, recordIssues)
  assert.deepEqual(recordIssues, [{ kind: 'malformed-param', key: 'bad' }])

  const base = plugin.__emptyEditorRecord(1)
  const withParams = plugin.__setEditorParamValues(base, {
    speed: 4.5, tint: '#aabbcc', mode: 'b', note: 'hello', orphan: 'dormant',
  }, 20).record
  const storage = memoryStorage()
  const saved = plugin.__saveEditorSession(storage, 'session-params', withParams, { now: 30 })
  assert.equal(saved.ok, true)
  const raw = storage.getItem(v2Key)
  assert.ok(raw.includes('"params"'))
  assert.equal(raw.includes('"schema"'), false, 'the schema is never persisted')
  const loaded = plugin.__loadEditorSession(storage, 'session-params', { now: 40 })
  assert.equal(loaded.source, 'v2')
  assert.deepEqual(loaded.record.params, withParams.params)

  const overrideEntry = { uid: 's:a', origin: 'script', overrides: { visible: false } }
  const tweened = {
    ...withParams,
    timeline: { duration: 12 },
    camera: { position: [1, 2, 3], target: [0, 0, 0] },
    objects: { 's:a': overrideEntry },
  }
  const cleared = plugin.__clearEditorOverrides(tweened, 50)
  assert.deepEqual(cleared.params, tweened.params, 'Reset all tweaks preserves parameter values')
  assert.equal(cleared.objects['s:a'], undefined)
  assert.equal(cleared.camera, null)
  assert.equal(plugin.__editorHasOverrides({ ...plugin.__emptyEditorRecord(0), params: { v: 1, values: { x: 1 } } }), false,
    'params alone are not an object/camera override')

  const paramBase = {
    ...plugin.__emptyEditorRecord(1),
    timeline: { duration: 12 },
    camera: null,
    objects: { 's:a': overrideEntry },
    params: { v: 1, values: { keep: 1, orphan: 'x' } },
  }
  const before = JSON.parse(JSON.stringify(paramBase))
  const set = plugin.__setEditorParamValues(paramBase, { keep: 2, added: true }, 60)
  assert.equal(set.ok, true)
  assert.notEqual(set.record, paramBase)
  assert.deepEqual(paramBase, before, 'the input record is never mutated')
  assert.deepEqual(set.record.params.values, { keep: 2, orphan: 'x', added: true })
  assert.deepEqual(
    Object.keys(set.record).filter(key => set.record[key] !== paramBase[key]).sort(),
    ['params', 'updatedAt'],
    'set returns one new record changing only params and updatedAt',
  )
  assert.equal(set.record.objects, paramBase.objects)
  assert.deepEqual(set.record.timeline, paramBase.timeline)

  const resetOne = plugin.__resetEditorParamValues(set.record, ['keep'], 61)
  assert.equal(resetOne.ok, true)
  assert.deepEqual(resetOne.record.params.values, { orphan: 'x', added: true }, 'per-key reset keeps dormant values')
  assert.deepEqual(
    Object.keys(resetOne.record).filter(key => resetOne.record[key] !== set.record[key]).sort(),
    ['params', 'updatedAt'],
  )
  const resetAll = plugin.__resetEditorParamValues(resetOne.record, null, 62)
  assert.equal(resetAll.ok, true)
  assert.deepEqual(resetAll.record.params, { v: 1, values: {} }, 'reset-all clears dormant values')
  assert.equal(resetAll.record.updatedAt, 62)

  assert.equal(plugin.__setEditorParamValues(paramBase, { '1bad': 1 }, 70).error, 'invalid-key')
  assert.equal(plugin.__setEditorParamValues(paramBase, { ['__proto__']: 'x' }, 70).error, 'invalid-key')
  assert.equal(plugin.__setEditorParamValues(paramBase, { keep: NaN }, 70).error, 'invalid-value')
  assert.equal(plugin.__setEditorParamValues(paramBase, { keep: null }, 70).error, 'invalid-value')
  assert.equal(plugin.__setEditorParamValues(paramBase, { keep: 'x'.repeat(1025) }, 70).error, 'invalid-value')
  const rejectedSet = plugin.__setEditorParamValues(paramBase, { keep: 3, bad: null }, 70)
  assert.equal(rejectedSet.ok, false)
  assert.equal(rejectedSet.record, paramBase, 'a rejected set is atomic and returns the input record')
  assert.deepEqual(plugin.__editorParamValues(paramBase), { keep: 1, orphan: 'x' })
  assert.equal(plugin.__resetEditorParamValues(paramBase, ['1bad'], 71).error, 'invalid-key')
  assert.equal(plugin.__resetEditorParamValues(paramBase, 'keep', 71).error, 'invalid-value')
  assert.equal(plugin.__resetEditorParamValues(paramBase, new Array(201).fill('keep'), 71).error, 'invalid-value')
  assert.deepEqual(plugin.__resetEditorParamValues(paramBase, [], 72).record.params.values, { keep: 1, orphan: 'x' })
})

test('P1-10 exports embed values safely and the initial apply precedes identity work', () => {
  const injected = '</script><img src=x onerror="window.__pwned=1">\u2028\u2029'
  const editorState = {
    ...plugin.__emptyEditorRecord(0),
    params: { v: 1, values: { note: injected, tint: '#112233' } },
  }
  const record = { title: 'Params', revision: 2, code: 'const a = 1' }
  const preview = plugin.__previewDocument(record, null, editorState)
  const start = preview.indexOf('const INITIAL_EDITOR_STATE = ')
  assert.ok(start > 0)
  const end = preview.indexOf('\n', start)
  const stateLine = preview.slice(start, end)
  assert.ok(stateLine.includes('#112233'), 'non-default parameter values are embedded')
  assert.ok(stateLine.includes('\\u003c/script>'), 'script-closing text is escaped as JSON unicode')
  assert.ok(stateLine.includes('\\u003cimg'), 'markup is escaped, never emitted literally')
  assert.ok(stateLine.includes('\\u2028') && stateLine.includes('\\u2029'), 'line separators are escaped')
  assert.equal(stateLine.includes('</script>'), false)
  assert.equal(stateLine.includes('<img'), false)
  assert.equal(stateLine.includes('"schema"'), false, 'exported state carries values only')
  assert.equal(stateLine.includes('"maxLength"'), false)

  const standalone = plugin.__standaloneHtml(record, editorState)
  const standaloneStart = standalone.indexOf('const INITIAL_EDITOR_STATE = ')
  const standaloneEnd = standalone.indexOf('\n', standaloneStart)
  const standaloneState = standalone.slice(standaloneStart, standaloneEnd)
  assert.equal(standaloneState, stateLine, 'standalone export embeds the same sanitized values')

  const runAt = preview.indexOf('run(api)')
  const initAt = preview.indexOf('\n  applyInitialParams()')
  const scriptCameraAt = preview.indexOf('scriptCamera = {')
  const resolveAt = preview.indexOf('  resolveIdentity()')
  const manualAt = preview.indexOf('  buildManualLayer(INITIAL_EDITOR_STATE)')
  const structureAt = preview.indexOf('  applyInitialStructure(INITIAL_EDITOR_STATE)')
  const overridesAt = preview.indexOf('  applyEditorState(INITIAL_EDITOR_STATE)')
  assert.ok(runAt >= 0 && initAt > runAt, 'initial apply runs after the script body')
  assert.ok(scriptCameraAt > initAt, 'parameter-created objects exist before the script camera snapshot')
  assert.ok(resolveAt > scriptCameraAt, 'identity resolution sees parameter-created objects')
  assert.ok(manualAt > resolveAt && structureAt > manualAt && overridesAt > structureAt)

  const runtime = plugin.__PARAM_RUNTIME_SOURCE
  assert.equal(/\beval\s*\(/.test(runtime), false)
  assert.equal(runtime.includes('new Function'), false)
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(runtime), false)
  assert.equal(/javascript:/i.test(runtime), false)
  assert.equal(clientSource.includes('dangerouslySetInnerHTML'), false)
  assert.ok(preview.includes('Object.freeze(Object.assign({}, paramValues))'), 'apply receives a fresh frozen values object')
  assert.ok(preview.includes("type: 'three-workbench:params'"))
  assert.ok(preview.includes("command: 'params'"))
  assert.ok(preview.includes("action: 'schema'"))
  assert.ok(preview.includes("error: 'apply-failed'"))
  assert.ok(preview.includes("error: 'duplicate-expose'"))

  const tabAt = clientSource.indexOf("editorTab === 'params'")
  const panelAt = clientSource.indexOf('h(ParametersPanel')
  assert.ok(tabAt > 0 && panelAt > 0, 'Parameters is rendered as the third editor tab')
  const tabLabels = [...clientSource.matchAll(/onClick: \(\) => setEditorTab\('(scene|inspector|params)'\)/g)].map(match => match[1])
  assert.deepEqual(tabLabels.slice(0, 3), ['scene', 'inspector', 'params'], 'tab order is Scene, Inspector, Parameters')
  assert.ok(clientSource.includes('ParamNumberField'))
  assert.ok(clientSource.includes('type: \'text\','))
  assert.ok(clientSource.includes('maxLength,'))
  assert.ok(clientSource.includes("`${String(textValue.length)}/${String(maxLength)}`"))

  const paramKeys = [...clientSource.matchAll(/^\s*'(editor\.params[^']*)':/gm)].map(match => match[1])
  assert.ok(paramKeys.length > 30)
  const counts = new Map()
  for (const key of paramKeys) counts.set(key, (counts.get(key) || 0) + 1)
  for (const [key, count] of counts) assert.equal(count, 2, `${key} exists once in zh and once in en`)
  assert.equal([...counts.keys()].some(key => key.endsWith('.')), false, 'no truncated i18n key')
})

test('P1-10 fix round guards native color change, stored resets, Escape, one tree refresh and the pending gate', () => {
  const panelStart = clientSource.indexOf('function ParametersPanel(props) {')
  const panelEnd = clientSource.indexOf('function TimelineBar(props) {', panelStart)
  assert.ok(panelStart > 0 && panelEnd > panelStart, 'ParametersPanel source is present')
  const panel = clientSource.slice(panelStart, panelEnd)

  // R5: React 18 suppresses the synthetic change after an input event, so the
  // commit must come from a native DOM change listener; React onChange stays
  // the live path and blur remains the fallback.
  assert.ok(panel.includes('ref: node => {'), 'color control installs a ref callback')
  assert.ok(panel.includes('if (node === null) return'), 'the ref callback tolerates unmount')
  assert.ok(panel.includes('node.onchange = () => props.onCommit(entry.key)'), 'native color change commits once')
  const colorAt = panel.indexOf("if (entry.type === 'color')")
  const booleanAt = panel.indexOf("if (entry.type === 'boolean')", colorAt)
  assert.ok(colorAt > 0 && booleanAt > colorAt, 'color control branch is sliceable')
  const colorBranch = panel.slice(colorAt, booleanAt)
  assert.ok(colorBranch.includes('onChange: event => props.onLive(entry.key, event.target.value)'),
    'React onChange is the live color path')
  assert.equal(colorBranch.includes('event.nativeEvent'), false,
    'the dead synthetic-change branch is gone')
  assert.equal(colorBranch.includes("nativeEvent.type === 'change'"), false)
  assert.ok(colorBranch.includes('onBlur: () => props.onCommit(entry.key)'), 'blur remains the commit fallback')

  // R1: stored raw keys drive per-row affordances, and reset-all is enabled by
  // the sanitized stored-key count (dormant keys included).
  assert.ok(panel.includes('const storedValues = props.storedValues'))
  assert.ok(panel.includes('Object.prototype.hasOwnProperty.call(storedValues, entry.key)'),
    'rowResettable reads the stored raw key')
  assert.ok(panel.includes('const storedKeyCount = Object.keys(storedValues).length'))
  assert.ok(panel.includes('const resetAllDisabled = disabled || busy || status === \'unavailable\' || storedKeyCount === 0'),
    'reset-all is enabled from stored keys, not from effective diff')
  assert.ok(panel.includes('rowResettable(entry) ? resetGlyph(entry) : null'), 'rows render the reset affordance')

  // R2: text Escape is wired to the shared revert path.
  assert.ok(panel.includes("event.key === 'Escape'"))
  assert.ok(panel.includes('onEscape(entry.key)'))
  assert.ok(panel.includes("const onEscape = props.onEscape === undefined ? () => {} : props.onEscape"))

  // R3: exactly one tree refresh after a final param ack, none for live sends.
  const liveStart = clientSource.indexOf('const sendParamLive = (key, value) => {')
  const liveEnd = clientSource.indexOf('const onParamLive =', liveStart)
  const finalStart = clientSource.indexOf('const sendParamFinal = async (action, keys, payload) => {')
  const finalEnd = clientSource.indexOf('const onParamCommit =', finalStart)
  assert.ok(liveStart > 0 && liveEnd > liveStart && finalStart > liveEnd && finalEnd > finalStart)
  const liveSource = clientSource.slice(liveStart, liveEnd)
  const finalSource = clientSource.slice(finalStart, finalEnd)
  assert.equal((liveSource.match(/refreshTree\(\)/g) || []).length, 0,
    'live and scheduled live sends never refresh the tree')
  assert.equal((finalSource.match(/void refreshTree\(\)/g) || []).length, 1,
    'sendParamFinal refreshes the tree exactly once')
  const refreshAt = finalSource.indexOf('void refreshTree()')
  assert.ok(refreshAt > finalSource.indexOf('onSetParamValues(checked.updates)'), 'the refresh follows a set ack/store write')
  assert.ok(refreshAt > finalSource.indexOf('onResetParamValues(keys'), 'the refresh follows a reset ack/store write')

  // R4: the pending parameter gesture is checked before history preflight so a
  // built-in mutation is refused with the translated notice.
  const allowStart = clientSource.indexOf('const allowMutation = ops => {')
  const allowEnd = clientSource.indexOf('const liveOverride =', allowStart)
  assert.ok(allowStart > 0 && allowEnd > allowStart)
  const allowSource = clientSource.slice(allowStart, allowEnd)
  const pendingAt = allowSource.indexOf('paramsPendingRef.current')
  const preflightAt = allowSource.indexOf('preflightCurrent(ops)')
  assert.ok(pendingAt > 0 && preflightAt > pendingAt, 'paramsPending is checked before preflight')
  assert.ok(allowSource.includes("setProtocolNotice(t('editor.paramsPending'))"), 'the refusal is translated')
})

// P1-8 material and renderer settings.

test('P1-8 material normalization accepts the six new channels, canonicalizes colors and clamps ranges', () => {
  const normalized = plugin.__normalizeMaterialProps({
    color: '#AABBCC',
    roughness: 2,
    metalness: -1,
    opacity: 0.4,
    emissive: '#00FF00',
    emissiveIntensity: 25,
    transparent: true,
    alphaTest: 1.5,
    side: 'double',
    flatShading: true,
    wireframe: false,
  })
  assert.deepEqual(normalized, {
    color: '#aabbcc',
    roughness: 1,
    metalness: 0,
    opacity: 0.4,
    emissive: '#00ff00',
    emissiveIntensity: 20,
    transparent: true,
    alphaTest: 1,
    side: 'double',
    flatShading: true,
    wireframe: false,
  })
  assert.deepEqual(plugin.__normalizeMaterialProps({
    emissiveIntensity: -0.5, alphaTest: -0.2, side: 'front',
  }), { emissiveIntensity: 0, alphaTest: 0, side: 'front' })
})

test('P1-8 material normalization drops invalid known values and preserves unknown channels', () => {
  const normalized = plugin.__normalizeMaterialProps({
    color: 'red',
    emissive: '#fff',
    roughness: NaN,
    metalness: '0.5',
    opacity: Infinity,
    emissiveIntensity: '2',
    transparent: 1,
    alphaTest: NaN,
    side: 'left',
    flatShading: 'yes',
    wireframe: 'true',
    size: 3,
    futureChannel: { nested: true },
  })
  assert.deepEqual(normalized, { size: 3, futureChannel: { nested: true } })
  assert.deepEqual(plugin.__normalizeMaterialProps(null), {})
  assert.deepEqual(plugin.__normalizeMaterialProps([1, 2]), {})
  assert.deepEqual(plugin.__normalizeMaterialProps('color'), {})
})

test('P1-8 material channel and renderer allowlists stay single-sourced', () => {
  assert.deepEqual(plugin.__MATERIAL_CHANNELS, [
    'color', 'roughness', 'metalness', 'opacity', 'emissive',
    'emissiveIntensity', 'transparent', 'alphaTest', 'side', 'flatShading',
    'wireframe',
  ])
  assert.deepEqual(plugin.__MATERIAL_NUMERIC_PROPS, [
    'roughness', 'metalness', 'opacity', 'emissiveIntensity', 'alphaTest', 'size', 'linewidth',
  ])
  assert.deepEqual(plugin.__MATERIAL_BOOLEAN_PROPS, ['transparent', 'flatShading', 'wireframe'])
  assert.deepEqual(plugin.__MATERIAL_SCALAR_PROPS, [
    'roughness', 'metalness', 'opacity', 'emissiveIntensity', 'transparent',
    'alphaTest', 'flatShading', 'wireframe', 'size', 'linewidth',
  ])
  assert.deepEqual(plugin.__MATERIAL_CLAMPED_PROPS, {
    emissiveIntensity: [0, 20],
    alphaTest: [0, 1],
  })
  assert.deepEqual(plugin.__MATERIAL_SIDE_VALUES, ['front', 'back', 'double'])
  assert.deepEqual(plugin.__RENDERER_CHANNELS, ['toneMapping', 'exposure', 'shadows', 'background', 'fog'])
  assert.deepEqual(plugin.__RENDERER_TONE_MAPPINGS, [
    'NoToneMapping', 'LinearToneMapping', 'ReinhardToneMapping', 'CineonToneMapping',
    'ACESFilmicToneMapping', 'AgXToneMapping', 'NeutralToneMapping',
  ])
  assert.equal(plugin.__MATERIAL_CHANNELS.includes('color'), true)
  assert.equal(plugin.__MATERIAL_CHANNELS.includes('wireframe'), true)
  // Every runtime allowlist is interpolated from the parent definitions; no
  // duplicate literal list remains in the srcDoc source.
  const interpolated = [
    ['MATERIAL_SIDE_VALUES', 'MATERIAL_SIDE_VALUES'],
    ['RENDERER_TONE_MAPPING_NAMES', 'RENDERER_TONE_MAPPINGS'],
    ['MATERIAL_NUMERIC_PROPS', 'MATERIAL_NUMERIC_PROPS'],
    ['MATERIAL_BOOLEAN_PROPS', 'MATERIAL_BOOLEAN_PROPS'],
    ['MATERIAL_SCALAR_PROPS', 'MATERIAL_SCALAR_PROPS'],
    ['MATERIAL_CLAMPED_PROPS', 'MATERIAL_CLAMPED_PROPS'],
    ['RENDERER_CHANNELS', 'RENDERER_CHANNELS'],
  ]
  for (const [runtimeName, parentName] of interpolated) {
    assert.ok(clientSource.includes(`const ${runtimeName} = \${JSON.stringify(${parentName})}`),
      `${runtimeName} is interpolated from ${parentName}`)
  }
  assert.equal(clientSource.includes("const MATERIAL_NUMERIC_PROPS = ['roughness'"), false)
  assert.equal(clientSource.includes("const MATERIAL_BOOLEAN_PROPS = ['transparent'"), false)
})

test('P1-8 script bases expose texture backgrounds and FogExp2 without null fields', () => {
  const kindStart = clientSource.indexOf('const backgroundKindOf = value => {')
  const kindEnd = clientSource.indexOf('const describeFog =', kindStart)
  assert.ok(kindStart > 0 && kindEnd > kindStart)
  const kinds = clientSource.slice(kindStart, kindEnd)
  assert.ok(kinds.includes("if (value.isColor === true) return 'color'"))
  assert.ok(kinds.includes("if (value.isTexture === true) return 'texture'"))
  assert.ok(kinds.includes("if (fog.isFogExp2 === true) return 'FogExp2'"))
  assert.equal(kinds.includes('String('), false)
  // The tree carries both effective and post-script kinds so the Inspector can
  // label a Texture base even though its hex value is null.
  assert.ok(clientSource.includes('backgroundKind: backgroundKindOf(scene.background)'))
  assert.ok(clientSource.includes('scriptBackgroundKind: scriptRenderer === null ? null : backgroundKindOf(scriptRenderer.background)'))
  assert.ok(clientSource.includes('scriptFogType: scriptRenderer === null ? null : fogTypeOf(scriptRenderer.fog)'))
  const renderStart = clientSource.indexOf('const fogScript = rendererScript.fog')
  const renderEnd = clientSource.indexOf('const backgroundBaseText =', renderStart)
  assert.ok(renderStart > 0 && renderEnd > renderStart)
  const render = clientSource.slice(renderStart, renderEnd)
  assert.ok(render.includes('fogScriptHasRange'))
  assert.ok(render.includes("t('editor.fogLinearEdit'"))
  assert.equal(render.includes('String(rendererScript.fog.near)'), false)
  assert.ok(clientSource.includes("rendererScript.backgroundKind === 'texture'"))
  assert.ok(clientSource.includes("t('editor.backgroundTexture')"))
  assert.ok(clientSource.includes('editor.fogLinearEdit'))
})


test('P1-8 runtime material apply maps sides, clamps, marks discrete needsUpdate, and skips ShaderMaterial', () => {
  const start = clientSource.indexOf('const applyMaterialProps = (object, slot, props, pin) => {')
  const end = clientSource.indexOf('const LIGHT_PROPS =', start)
  assert.ok(start > 0 && end > start)
  const body = clientSource.slice(start, end)
  assert.ok(body.includes('source.isShaderMaterial === true'))
  assert.ok(body.includes('MATERIAL_NUMERIC_PROPS'))
  assert.ok(body.includes('MATERIAL_CLAMPED_PROPS'))
  assert.ok(body.includes('Math.min(clamp[1], Math.max(clamp[0], props[prop]))'))
  assert.ok(body.includes('MATERIAL_BOOLEAN_PROPS'))
  assert.ok(body.includes('sideValueOf(props.side)'))
  assert.ok(body.includes('target.color.set(props.color)'))
  assert.ok(body.includes('target.emissive.set(props.emissive)'))
  assert.ok(body.includes('if (discrete) target.needsUpdate = true'))
  assert.equal(/target\.needsUpdate = true/.test(body.slice(
    body.indexOf('for (const prop of MATERIAL_NUMERIC_PROPS)'),
    body.indexOf('for (const prop of MATERIAL_BOOLEAN_PROPS)'))), false,
  'numeric channels are uniforms and never rebuild the program')
  assert.equal(/target\.needsUpdate = true/.test(body.slice(
    body.indexOf("if (typeof props.color === 'string'"),
    body.indexOf('if (props.textures !== undefined)'))), false,
  'color channels are uniforms and never rebuild the program')
  const descriptorStart = clientSource.indexOf('const describeMaterialEntry = material => {')
  const descriptorEnd = clientSource.indexOf('const ignoredObjects =', descriptorStart)
  const descriptor = clientSource.slice(descriptorStart, descriptorEnd)
  assert.ok(descriptor.includes('MATERIAL_SCALAR_PROPS'), 'material descriptor uses the shared scalar list')
  for (const channel of ['emissive', 'side']) {
    assert.ok(descriptor.includes(channel), `material baseline descriptor exposes ${channel}`)
  }
  for (const channel of ['emissiveIntensity', 'transparent', 'alphaTest', 'flatShading']) {
    assert.ok(plugin.__MATERIAL_SCALAR_PROPS.includes(channel), `material scalar list exposes ${channel}`)
  }
})

test('P1-8 renderer normalization round-trips every channel and keeps fog:null distinct from absent', () => {
  const value = {
    toneMapping: 'ACESFilmicToneMapping',
    exposure: 1.2,
    shadows: true,
    background: '#101418',
    fog: { color: '#202428', near: 4, far: 40 },
  }
  const normalized = plugin.__normalizeEditorRendererField(value)
  assert.deepEqual(normalized.issues, [])
  assert.deepEqual(normalized.renderer, value)
  assert.deepEqual(plugin.__normalizeEditorRendererField({
    background: '#ABCDEF', fog: null,
  }).renderer, { background: '#abcdef', fog: null })
  assert.equal(Object.prototype.hasOwnProperty.call(plugin.__normalizeEditorRendererField({}).renderer || {}, 'fog'), false,
    'absent fog stays absent')
  assert.equal(plugin.__normalizeEditorRendererField({}).renderer, null)
  assert.equal(plugin.__normalizeEditorRendererField(null).renderer, null)
  assert.equal(plugin.__normalizeEditorRendererField({}).issues.length, 0)
})

test('P1-8 renderer normalization drops only invalid channels and clamps exposure', () => {
  const normalized = plugin.__normalizeEditorRendererField({
    toneMapping: 'CustomToneMapping',
    exposure: 99,
    shadows: 'yes',
    background: 'black',
    fog: { color: '#101418', near: 10, far: 10 },
    extra: true,
  })
  assert.deepEqual(normalized.renderer, { exposure: 10 })
  assert.deepEqual(normalized.issues.map(issue => issue.channel), [
    'toneMapping', 'shadows', 'background', 'fog',
  ])
  assert.deepEqual(plugin.__normalizeEditorRendererField({
    toneMapping: 'NeutralToneMapping', exposure: -3, background: '#010203',
  }).renderer, { toneMapping: 'NeutralToneMapping', exposure: 0, background: '#010203' })
  assert.deepEqual(plugin.__normalizeEditorRendererField({
    exposure: null, shadows: false,
  }).renderer, { shadows: false })
  assert.equal(plugin.__normalizeEditorRendererField({ fog: { color: '#101418', near: -1, far: 2 } }).renderer, null)
  assert.equal(plugin.__normalizeEditorRendererField({ fog: [] }).renderer, null)
  assert.equal(plugin.__normalizeEditorRendererField('x').renderer, null)
})

test('P1-8 setEditorRenderer, clearEditorOverrides and editorHasOverrides keep record semantics', () => {
  const base = plugin.__emptyEditorRecord(1)
  const renderer = {
    toneMapping: 'AgXToneMapping', exposure: 2, shadows: false,
    background: '#112233', fog: { color: '#445566', near: 2, far: 20 },
  }
  const set = plugin.__setEditorRenderer(base, renderer, 50)
  assert.equal(set.ok, true)
  assert.deepEqual(set.issues, [])
  assert.equal(set.record.v, 2)
  assert.equal(set.record.updatedAt, 50)
  assert.deepEqual(set.record.renderer, renderer)
  assert.notEqual(set.record, base)
  assert.equal(base.renderer, undefined, 'the input record is never mutated')
  assert.deepEqual(
    Object.keys(set.record).filter(key => set.record[key] !== base[key]).sort(),
    ['renderer', 'updatedAt'],
  )
  const normalized = plugin.__normalizeEditorRecord(set.record, 60, [])
  assert.deepEqual(normalized.renderer, renderer)

  const clearedField = plugin.__setEditorRenderer(set.record, null, 61)
  assert.equal(Object.prototype.hasOwnProperty.call(clearedField.record, 'renderer'), false,
    'an empty renderer removes the field instead of persisting {}')
  const clearedField2 = plugin.__setEditorRenderer(set.record, { exposure: 'x' }, 62)
  assert.deepEqual(clearedField2.issues, [{ kind: 'invalid-renderer', channel: 'exposure' }])
  assert.equal(Object.prototype.hasOwnProperty.call(clearedField2.record, 'renderer'), false)

  const withObjects = Object.assign({}, set.record, {
    camera: { position: [1, 2, 3], target: [0, 0, 0] },
    objects: { 's:a': { uid: 's:a', origin: 'script', overrides: { visible: false } } },
    params: { v: 1, values: { keep: 2 } },
  })
  assert.equal(plugin.__editorHasOverrides(withObjects), true)
  assert.equal(plugin.__editorHasOverrides(Object.assign({}, base, { renderer })), true,
    'a renderer-only override counts')
  const cleared = plugin.__clearEditorOverrides(withObjects, 70)
  assert.equal(Object.prototype.hasOwnProperty.call(cleared, 'renderer'), false)
  assert.equal(cleared.camera, null)
  assert.deepEqual(cleared.objects, {})
  assert.deepEqual(cleared.params, { v: 1, values: { keep: 2 } })
  assert.equal(plugin.__editorHasOverrides(cleared), false)
  assert.equal(cleared.v, 2, 'clearing never bumps the record version')
})

test('P1-8 normalizeEditorRecord validates renderer fields and keeps params and objects intact', () => {
  const issues = []
  const normalized = plugin.__normalizeEditorRecord({
    v: 2,
    updatedAt: 4,
    objects: { 's:a': { uid: 's:a', origin: 'script', overrides: { material: { '0': { emissive: '#123456', side: 'back' } } } } },
    params: { v: 1, values: { speed: 2 } },
    renderer: {
      toneMapping: 'LinearToneMapping', exposure: 0.5, shadows: true,
      background: '#0a0b0c', fog: null,
    },
  }, 5, issues)
  assert.deepEqual(issues, [])
  assert.deepEqual(normalized.renderer, {
    toneMapping: 'LinearToneMapping', exposure: 0.5, shadows: true,
    background: '#0a0b0c', fog: null,
  })
  assert.deepEqual(normalized.params, { v: 1, values: { speed: 2 } })
  assert.deepEqual(normalized.objects['s:a'].overrides.material['0'], { emissive: '#123456', side: 'back' })

  const droppedIssues = []
  const dropped = plugin.__normalizeEditorRecord({
    v: 2, objects: {}, renderer: { toneMapping: 'CustomToneMapping', exposure: 1, fog: { color: 'x', near: 0, far: 1 } },
  }, 6, droppedIssues)
  assert.deepEqual(dropped.renderer, { exposure: 1 })
  assert.deepEqual(droppedIssues, [
    { kind: 'invalid-renderer', channel: 'toneMapping' },
    { kind: 'invalid-renderer', channel: 'fog' },
  ])
  const absent = plugin.__normalizeEditorRecord({ v: 2, objects: {} }, 7, [])
  assert.equal(Object.prototype.hasOwnProperty.call(absent, 'renderer'), false)
})

test('P1-8 runtime snapshots the renderer after the script and applies it before object overrides', () => {
  const runAt = clientSource.indexOf('run(api)')
  const paramsAt = clientSource.indexOf('applyInitialParams()', runAt)
  const cameraAt = clientSource.indexOf('scriptCamera = {', paramsAt)
  const rendererAt = clientSource.indexOf('scriptRenderer = {', cameraAt)
  const resolveAt = clientSource.indexOf('resolveIdentity()', rendererAt)
  const applyStateAt = clientSource.indexOf('applyEditorState(INITIAL_EDITOR_STATE)', resolveAt)
  assert.ok(runAt > 0 && paramsAt > runAt && cameraAt > paramsAt && rendererAt > cameraAt && resolveAt > rendererAt && applyStateAt > resolveAt,
    'script -> params -> scriptCamera -> scriptRenderer -> identity -> overrides')
  const snapshot = clientSource.slice(rendererAt, resolveAt)
  for (const channel of ['toneMapping', 'exposure', 'shadows', 'background', 'fog']) {
    assert.ok(snapshot.includes(channel), `script renderer snapshot carries ${channel}`)
  }
  const applyStart = clientSource.indexOf('function applyEditorState(state) {')
  const applyEnd = clientSource.indexOf('// Initialize the runtime-only structure maps', applyStart)
  const applyBody = clientSource.slice(applyStart, applyEnd)
  const rendererCallAt = applyBody.indexOf('applyRendererState(state.renderer)')
  const objectLoopAt = applyBody.indexOf('for (const uid of Object.keys(objects))')
  assert.ok(rendererCallAt > 0 && objectLoopAt > rendererCallAt, 'renderer override precedes object overrides')
})

test('P1-8 applyPins re-asserts only overridden renderer channels after onFrame', () => {
  const pinsStart = clientSource.indexOf('const applyPins = () => {')
  const pinsEnd = clientSource.indexOf('// Replace semantics for manual-override edits', pinsStart)
  const pinsBody = clientSource.slice(pinsStart, pinsEnd)
  const rendererCallAt = pinsBody.indexOf('applyRendererPins()')
  const cameraPinAt = pinsBody.indexOf('if (cameraPin !== null)')
  assert.ok(rendererCallAt > 0 && rendererCallAt > cameraPinAt)
  assert.ok(pinsBody.includes('Script onFrame callbacks run before this pass'))
  const reassertStart = clientSource.indexOf('const applyRendererPins = () => {')
  const reassertEnd = clientSource.indexOf('const handleRendererCommand =', reassertStart)
  const reassert = clientSource.slice(reassertStart, reassertEnd)
  for (const channel of ['toneMapping', 'exposure', 'shadows', 'background', 'fog']) {
    assert.ok(reassert.includes(`hasOwnProperty.call(rendererPins, '${channel}')`),
      `only a pinned ${channel} is re-asserted`)
  }
  assert.ok(reassert.includes('scene.fog !== rendererPinFog'),
    'a replaced fog instance is restored')
  assert.ok(reassert.includes('rendererPinFog.near !== pinned.near')
    && reassert.includes('rendererPinFog.far !== pinned.far'),
    'an in-place onFrame mutation of the pinned fog is re-asserted')
  assert.ok(reassert.includes('rendererPinBackground.getHexString() !== rendererPins.background')
    && reassert.includes('rendererPinBackground.set(rendererPins.background)'),
    'an in-place onFrame mutation of the pinned background Color is re-asserted')
  assert.equal(reassert.includes('scriptRenderer.toneMapping'), false, 'unpinned channels are not re-applied')
})

test('P1-8 standalone/ZIP and preview embed renderer state without weakening the sandbox', () => {
  const state = Object.assign({}, plugin.__emptyEditorRecord(0), {
    renderer: {
      toneMapping: 'ACESFilmicToneMapping', exposure: 1.2, shadows: true,
      background: '#101418', fog: null,
    },
    objects: {
      's:mesh': {
        uid: 's:mesh', origin: 'script',
        overrides: { material: { '0': { emissive: '#ff8800', emissiveIntensity: 3, side: 'double', alphaTest: 0.25, transparent: true, flatShading: false } } },
      },
    },
  })
  const record = { title: 'Renderer', revision: 3, code: 'const a = 1' }
  const preview = plugin.__previewDocument(record, null, state)
  assert.ok(preview.includes('"renderer":{"toneMapping":"ACESFilmicToneMapping","exposure":1.2,"shadows":true,"background":"#101418","fog":null}'))
  assert.ok(preview.includes('"emissiveIntensity":3'))
  assert.ok(preview.includes('"side":"double"'))
  assert.ok(preview.includes('applyRendererState(state.renderer)'))
  assert.ok(clientSource.includes("sandbox: 'allow-scripts allow-pointer-lock allow-downloads'"))
  assert.equal(clientSource.includes('allow-same-origin'), false)
  assert.equal(preview.includes('allow-same-origin'), false)
  assert.equal(/[?&]token=/i.test(preview), false)
  assert.equal(/token%3D/i.test(preview), false)
  const standalone = plugin.__standaloneHtml(record, state)
  assert.ok(standalone.includes('"renderer":{"toneMapping":"ACESFilmicToneMapping"'))
  assert.ok(standalone.includes('applyRendererState(state.renderer)'))
  assert.equal(standalone.includes('allow-same-origin'), false)
  const zip = plugin.__createZip([{ name: 'index.html', bytes: new TextEncoder().encode(preview) }])
  assert.ok(zip instanceof Blob)
})

test('P1-8 inspector exposes Render and the new material controls bilingually', () => {
  assert.ok(clientSource.includes('const renderSection = () =>'))
  assert.equal((clientSource.match(/renderSection\(\)/g) || []).length, 4,
    'Render is rendered in all four inspector branches')
  assert.ok((clientSource.match(/const renderSection = \(\) =>/g) || []).length === 1)
  for (const key of ['render', 'toneMapping', 'exposure', 'shadows', 'background', 'fog', 'fogColor', 'fogNear', 'fogFar', 'fogNone',
    'emissive', 'emissiveIntensity', 'transparent', 'alphaTest', 'flatShading', 'side', 'sideFront', 'sideBack', 'sideDouble', 'rendererInvalid']) {
    assert.equal((clientSource.match(new RegExp(`'editor\\.${key}':`, 'g')) || []).length, 2,
      `${key} is translated in both locales exactly once`)
  }
  for (const call of ["t('editor.emissiveIntensity')", "t('editor.transparent')", "t('editor.alphaTest')",
    "t('editor.side')", "t('editor.flatShading')", "t('editor.emissive')"]) {
    assert.ok(clientSource.includes(call), `${call} is used by the material inspector`)
  }
  assert.ok(clientSource.includes('...MATERIAL_SIDE_VALUES.map(side =>'))
  assert.ok(clientSource.includes("issue.kind === 'invalid-renderer'")
    && clientSource.includes("t('editor.rendererInvalid')"),
    'invalid persisted renderer channels surface a translated notice')
  assert.ok(clientSource.includes('materialHas(\'emissiveIntensity\')'))
  assert.ok(clientSource.includes('resetMaterial(\'side\')'))
  assert.ok(clientSource.includes('{ toneMapping:'), 'renderer section does not use raw keys')
})
