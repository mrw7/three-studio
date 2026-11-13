/**
 * Programmatic smoke test for both plugin halves.
 *
 * Runs the Host plugin against a recording context and evaluates the browser
 * bundle against a stub React/module loader, so registration mistakes surface
 * without building or launching the Harness.
 *
 */
// Run: node --test "tests/**/*.mjs"
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { apply as applyHost, inject as hostInject, name as hostName, __assetInternal as assetInternal } from '../index.js'

/** Minimal recording Cordis context for the Host half. */
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
        // Compatibility for existing assertions: keep the original scene
        // prefix and thumbnail exact handler in their historical slots while
        // retaining every P1-9 route in `routes`.
        if (route.kind === 'prefix' && route.path === '/three-workbench') records.route = route
        if (route.kind === 'exact' && route.path === '/three-workbench/thumbnail') records.upload = route
        return () => {}
      },
    },
  }
  return ctx
}

test('host plugin registers the tool, prompt, and route', () => {
  const ctx = recordingHostContext()
  applyHost(ctx)
  assert.equal(hostName, 'three-workbench')
  assert.deepEqual(hostInject, ['tools', 'systemPrompt'])
  assert.equal(ctx.records.tool.name, 'three_scene')
  assert.equal(ctx.records.tool.parameters.required[0], 'code')
  assert.equal(ctx.records.section.name, 'tool:three-scene')
  assert.match(ctx.records.section.text, /three_scene/)
  assert.match(ctx.records.section.text, /wb\.id\(object, name\)/)
  assert.match(ctx.records.section.text, /userData\.wbId/)
  // The model must be able to discover the name-only asset helpers now that
  // the runtime supports user-uploaded images, models and HDRIs.
  for (const helper of ['assets.url', 'assets.texture', 'assets.model', 'assets.hdri']) {
    assert.ok(ctx.records.section.text.includes(helper), `prompt documents ${helper}`)
  }
  assert.match(ctx.records.section.text, /Assets\*\* panel/)
  // assets.model returns a holder the script must add itself; only the loaded
  // glTF scene is attached under it.
  assert.match(ctx.records.section.text, /scene\.add\(holder\)/)
  assert.match(ctx.records.tool.description, /assets\.model/)
  assert.equal(ctx.records.route.path, '/three-workbench')
  assert.equal(ctx.records.route.kind, 'prefix')
})

test('host plugin registers the P1-9 asset routes with exact handlers/resources', () => {
  const ctx = recordingHostContext()
  applyHost(ctx)
  const routeFor = (kind, path) => {
    const matches = ctx.records.routes.filter(route => route.kind === kind && route.path === path)
    assert.equal(matches.length, 1, `${kind} ${path} is registered exactly once`)
    return matches[0]
  }

  const uploadRoute = routeFor('exact', '/three-workbench/assets/upload')
  assert.equal(uploadRoute.handler, assetInternal.uploadHandler)
  assert.equal(uploadRoute.resource, undefined)
  const deleteRoute = routeFor('exact', '/three-workbench/assets/delete')
  assert.equal(deleteRoute.handler, assetInternal.deleteHandler)
  assert.equal(deleteRoute.resource, undefined)
  const listRoute = routeFor('exact', '/three-workbench/assets')
  assert.equal(listRoute.resource, assetInternal.listResponse)
  assert.equal(listRoute.handler, undefined)
  const contentRoute = routeFor('prefix', '/three-workbench/assets')
  assert.equal(contentRoute.resource, assetInternal.contentResponse)
  assert.equal(contentRoute.handler, undefined)
})

test('three_scene stores revisions and serves the scene record', async () => {
  const ctx = recordingHostContext()
  applyHost(ctx)
  const exec = { agent: { session: { id: 'sess-smoke' } } }

  const first = await ctx.records.tool.execute({ title: 'Sphere', code: 'const x = 1' }, exec)
  assert.deepEqual(first, { sceneId: 'sess-smoke', revision: 1, bytes: 11, title: 'Sphere' })

  const meta = ctx.records.tool.output.presentationMeta({ code: 'x' }, first)
  assert.deepEqual(meta, { sceneId: 'sess-smoke', revision: 1, title: 'Sphere' })

  const second = await ctx.records.tool.execute({ code: 'const x = 2' }, exec)
  assert.equal(second.revision, 2)
  assert.equal(second.title, 'Three.js scene')

  const response = await ctx.records.route.resource(new Request('http://localhost/three-workbench/scene/sess-smoke'))
  assert.equal(response.status, 200)
  const record = await response.json()
  assert.equal(record.revision, 2)
  assert.equal(record.code, 'const x = 2')
  assert.equal(response.headers.get('access-control-allow-origin'), null)
})

test('three_scene keeps revisions and serves an older one on request', async () => {
  const ctx = recordingHostContext()
  applyHost(ctx)
  const exec = { agent: { session: { id: 'sess-history' } } }
  await ctx.records.tool.execute({ title: 'One', code: 'const a = 1' }, exec)
  await ctx.records.tool.execute({ title: 'Two', code: 'const a = 2' }, exec)

  const state = await (await ctx.records.route.resource(new Request('http://localhost/three-workbench/state/sess-history'))).json()
  assert.equal(state.revision, 2)
  assert.deepEqual(state.revisions.map(row => row.revision), [1, 2])

  const first = await (await ctx.records.route.resource(new Request('http://localhost/three-workbench/scene/sess-history?rev=1'))).json()
  assert.equal(first.code, 'const a = 1')
  assert.equal(first.title, 'One')
  const missing = await ctx.records.route.resource(new Request('http://localhost/three-workbench/scene/sess-history?rev=99'))
  assert.equal(missing.status, 404)
})

/** Drive the upload handler with a JSON body and capture its response. */
function upload(ctx, payload, method = 'POST') {
  return new Promise(resolve => {
    const req = Readable.from([Buffer.from(JSON.stringify(payload))])
    req.method = method
    const res = {
      status: 0,
      body: '',
      writeHead (code) { this.status = code },
      end (text) { this.body = text ?? ''; resolve(this) },
    }
    ctx.records.upload.handler(req, res)
  })
}

test('thumbnails require a stored session/revision and round-trip as PNG bytes', async () => {
  const ctx = recordingHostContext()
  applyHost(ctx)
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const exec = { agent: { session: { id: 'sess-thumb' } } }
  for (let index = 1; index <= 3; index += 1) {
    await ctx.records.tool.execute({ code: `const rev = ${String(index)}` }, exec)
  }

  const posted = await upload(ctx, { sessionId: 'sess-thumb', revision: 3, dataUrl: `data:image/png;base64,${png}` })
  assert.equal(posted.status, 200)
  assert.equal(posted.body, '{"ok":true}')

  const fetched = await ctx.records.route.resource(new Request('http://localhost/three-workbench/thumbnail/sess-thumb/3'))
  assert.equal(fetched.status, 200)
  assert.equal(fetched.headers.get('content-type'), 'image/png')
  const bytes = Buffer.from(await fetched.arrayBuffer())
  assert.equal(bytes.subarray(0, 4).toString('hex'), '89504e47')

  const rejected = await upload(ctx, { sessionId: 'sess-thumb', revision: 3, dataUrl: 'data:image/png;base64,bm90IGEgcG5n' })
  assert.equal(rejected.status, 415)
  const unknownSession = await upload(ctx, { sessionId: 'sess-nobody', revision: 1, dataUrl: `data:image/png;base64,${png}` })
  assert.equal(unknownSession.status, 404)
  const unknownRevision = await upload(ctx, { sessionId: 'sess-thumb', revision: 4, dataUrl: `data:image/png;base64,${png}` })
  assert.equal(unknownRevision.status, 404)
  const wrongMethod = await upload(ctx, {}, 'GET')
  assert.equal(wrongMethod.status, 405)
  const badBody = await upload(ctx, { sessionId: 'sess-thumb' })
  assert.equal(badBody.status, 400)
})

test('per-session thumbnail storage is bounded while new revisions keep working', async () => {
  const ctx = recordingHostContext()
  applyHost(ctx)
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const exec = { agent: { session: { id: 'sess-thumb-cap' } } }
  for (let revision = 1; revision <= 13; revision += 1) {
    await ctx.records.tool.execute({ code: `const rev = ${String(revision)}` }, exec)
    const posted = await upload(ctx, { sessionId: 'sess-thumb-cap', revision, dataUrl: `data:image/png;base64,${png}` })
    assert.equal(posted.status, 200, `revision ${String(revision)} upload`)
  }
  // 13 valid revisions were uploaded; the per-session cap must have evicted
  // the oldest thumbnail, while the newest remains addressable.
  const oldest = await ctx.records.route.resource(new Request('http://localhost/three-workbench/thumbnail/sess-thumb-cap/1'))
  assert.equal(oldest.status, 404)
  const newest = await ctx.records.route.resource(new Request('http://localhost/three-workbench/thumbnail/sess-thumb-cap/13'))
  assert.equal(newest.status, 200)
})

test('three_scene rejects oversized code and unknown scenes', async () => {
  const ctx = recordingHostContext()
  applyHost(ctx)
  const exec = { agent: { session: { id: 'sess-big' } } }
  await assert.rejects(
    ctx.records.tool.execute({ code: 'x'.repeat(256 * 1024 + 1) }, exec),
    /limit is 262144 bytes/,
  )
  const missingState = await (await ctx.records.route.resource(new Request('http://localhost/three-workbench/state/nobody'))).json()
  assert.deepEqual(missingState, { missing: true, sceneId: 'nobody', revision: null, revisions: [] })
  const missing = await ctx.records.route.resource(new Request('http://localhost/three-workbench/scene/nobody'))
  assert.equal(missing.status, 404)
})

test('runtime files are served with a permissive CORS header', async () => {
  const ctx = recordingHostContext()
  applyHost(ctx)
  const response = await ctx.records.route.resource(new Request('http://localhost/three-workbench/runtime/three.module.js'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.match(response.headers.get('content-type') ?? '', /javascript/)
  const controls = await ctx.records.route.resource(new Request('http://localhost/three-workbench/runtime/TransformControls.js'))
  assert.equal(controls.status, 200)
  assert.equal(controls.headers.get('access-control-allow-origin'), '*')
  assert.match(await controls.text(), /class TransformControls/)
  const unknown = await ctx.records.route.resource(new Request('http://localhost/three-workbench/runtime/../../package.json'))
  assert.equal(unknown.status, 404)
})

/** Minimal React stand-in: hooks keep state in a module slot per call order. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: current => ({ current }),
  useCallback: fn => fn,
}

/** Minimal recording Cordis context for the browser half. */
function recordingClientContext() {
  const records = {
    tabs: [], slots: [], dictionaries: [], localeSet: [],
    createdSessions: [], openedSessions: [], prompts: [], modelDirectories: [],
  }
  let activeLocale = 'en'
  return {
    records,
    sessions: {
      list: { getSnapshot: () => ({ ids: [], byId: {} }) },
      create: async opts => {
        records.createdSessions.push(opts)
        return 'sess-new'
      },
      binding: id => id === 'sess-new'
        ? {
          session: {
            prompt: async (parts, mode) => {
              records.prompts.push({ id, parts, mode })
              return { ok: true, value: { accepted: true } }
            },
          },
        }
        : undefined,
    },
    uiWorkspace: {
      openSession: id => { records.openedSessions.push(id) },
    },
    workspaces: {
      list: {
        getSnapshot: () => ({
          items: [{ workspaceId: 'ws-1', path: '/tmp/work', title: 'Work', createdAt: '', updatedAt: '',
            sessionIds: ['sess-current'] }],
        }),
      },
    },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: {
      register(namespace, dictionaries) {
        records.dictionaries.push({ namespace, dictionaries })
        return () => {}
      },
      bind() {
        return (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key)
      },
      getLocale() {
        return { active: activeLocale }
      },
      setLocale(id) {
        records.localeSet.push(id)
        activeLocale = id
      },
      subscribe() {
        return () => {}
      },
    },
    sidebarRightTabs: {
      register(definition) {
        records.tabs.push(definition)
        return () => {}
      },
    },
    get(name) {
      if (name !== 'modelDirectories') return undefined
      return {
        directoryFor(sessionId) {
          records.modelDirectories.push(sessionId)
          return { sessionId, store: { getSnapshot: () => null, subscribe: () => () => {} } }
        },
      }
    },
    sidebarRight: { openTab() {} },
    layout: {
      openWorkbench() {},
      closeWorkbench() {},
    },
    slots: {
      inject(key, callback) {
        records.slots.push({ key, disposer: callback() })
        return () => {}
      },
      register(options) {
        records.slots.push({ options })
        return () => {}
      },
    },
  }
}

test('browser bundle registers a tab type, its body, and a tool card', async () => {
  let definition
  globalThis.window = { __ModuleLoader__: { load: value => { definition = value } } }
  globalThis.document = {
    createElement: () => ({ textContent: '', remove () {} }),
    head: { append () {} },
  }
  await import(`${pathToFileURL(new URL('../client.js', import.meta.url).pathname).href}?smoke=${String(Date.now())}`)
  assert.equal(definition.id, 'three-workbench')

  const storeInitials = []
  const plugin = definition.factory(name => {
    if (name === 'react') return reactStub
    if (name === '@deepseek-ai/dsh-client-store') {
      return {
        createSnapshotStore: initial => {
          storeInitials.push(initial)
          let state = initial
          return {
            getSnapshot: () => state,
            subscribe: () => () => {},
            set: next => { state = next },
            update: mutator => { const draft = { ...state }; mutator(draft); state = draft },
          }
        },
      }
    }
    throw new Error(`unexpected require: ${name}`)
  })
  assert.deepEqual(plugin.inject, [
    'slots', 'locale', 'layout', 'sessions', 'workspaces', 'uiWorkspace', 'sidebarRightTabs',
    'remote', 'remote.llm', 'remote.credentials', 'remote.settings',
  ])

  const ctx = recordingClientContext()
  plugin.apply(ctx)

  assert.equal(ctx.records.tabs.length, 1)
  assert.equal(ctx.records.tabs[0].kind, 'three-preview')
  assert.equal(ctx.records.tabs[0].guide.length, 1)
  assert.equal(ctx.records.dictionaries.length, 1)
  const registered = ctx.records.slots.filter(row => row.options).map(row => row.options)
  assert.deepEqual(registered.map(row => row.name), [
    'workbench',
    'conversation.session.header.actions',
    'tool.call.toolview',
    'sidebar.right.pane.tab',
  ])
  assert.equal(registered[0].key, undefined)
  assert.equal(registered[2].key, 'three_scene')
  assert.equal(registered[3].key, 'three-workbench')

  // Fresh installs open the preview and step frames at 30 fps.
  assert.equal(storeInitials[0].open, true)
  assert.equal(storeInitials[0].stepFps, 30)

  const dictionaries = ctx.records.dictionaries[0].dictionaries
  assert.equal(dictionaries.en['stats.title'], 'Scene stats')
  assert.equal(dictionaries.en['timeline.stepBack'], 'Step back one frame')
  assert.equal(dictionaries.en['timeline.stepForward'], 'Step forward one frame')
  assert.equal(dictionaries.en['editor.fov'], 'FOV')
  assert.equal(dictionaries.en['studio.language'], 'Language')
  assert.equal(dictionaries.en['studio.sessions.title'], 'Sessions')
  assert.equal(dictionaries.zh['studio.sessions.title'], '会话')
  assert.equal(dictionaries.en['studio.model.label'], 'Model')
  assert.equal(dictionaries.zh['studio.model.configure'], '模型设置')
  assert.equal(dictionaries.en['studio.settings.title'], 'Settings')
  assert.equal(dictionaries.zh['studio.settings.title'], '设置')
  assert.equal(dictionaries.zh['stats.calls'], '绘制调用')
  assert.equal(dictionaries.zh['timeline.stepForward'], '下一帧')
  assert.equal(dictionaries.zh['studio.language'], '语言')

  // The header writes through the Host locale service, so switching one
  // workbench surface switches every slot and persists the preference.
  const workbenchInject = registered[0].inject()
  assert.equal(workbenchInject.language.getActive(), 'en')
  workbenchInject.language.setActive('zh')
  assert.deepEqual(ctx.records.localeSet, ['zh'])
  assert.equal(workbenchInject.language.getActive(), 'zh')
  assert.equal(registered[3].inject().language, workbenchInject.language)

  // A Studio new task creates a Session in the origin's Workspace and opens
  // it. A draft is sent as the first message; an empty draft opens the Session
  // without prompting so the user can type there.
  assert.deepEqual(await workbenchInject.createTask('sess-current', '   '), { ok: true })
  assert.deepEqual(ctx.records.createdSessions, [{ workspaceId: 'ws-1' }])
  assert.deepEqual(ctx.records.openedSessions, ['sess-new'])
  assert.deepEqual(ctx.records.prompts, [])
  assert.deepEqual(await workbenchInject.createTask('sess-current', 'build a watch'), { ok: true })
  assert.deepEqual(ctx.records.createdSessions, [{ workspaceId: 'ws-1' }, { workspaceId: 'ws-1' }])
  assert.deepEqual(ctx.records.openedSessions, ['sess-new', 'sess-new'])
  assert.deepEqual(ctx.records.prompts, [{
    id: 'sess-new', parts: [{ type: 'text', text: 'build a watch' }], mode: 'queue',
  }])
  assert.equal(registered[3].inject().createTask, workbenchInject.createTask)
  ctx.sessions.create = async () => { throw new Error('session/create denied') }
  assert.deepEqual(await workbenchInject.createTask('sess-current', 'retry'),
    { ok: false, message: 'session/create denied' })
  assert.deepEqual(ctx.records.openedSessions, ['sess-new', 'sess-new'])

  // The Studio session switcher reopens an existing Host Session through the
  // main view. Studio stays mounted and follows the switch.
  assert.equal(registered[3].inject().openSession, workbenchInject.openSession)
  assert.deepEqual(workbenchInject.openSession('sess-past'), { ok: true })
  assert.deepEqual(ctx.records.openedSessions, ['sess-new', 'sess-new', 'sess-past'])
  assert.deepEqual(workbenchInject.openSession(''), { ok: false, message: '' })
  ctx.uiWorkspace.openSession = () => { throw new Error('workspace/open denied') }
  assert.deepEqual(workbenchInject.openSession('sess-past'),
    { ok: false, message: 'workspace/open denied' })

  // The model picker reuses the Host's per-Session model directory and stays
  // optional when that service is absent.
  assert.equal(registered[3].inject().model, workbenchInject.model)
  assert.equal(workbenchInject.model('sess-1').sessionId, 'sess-1')
  assert.deepEqual(ctx.records.modelDirectories, ['sess-1'])
  assert.equal(workbenchInject.model(''), null)
  ctx.get = () => undefined
  assert.equal(workbenchInject.model('sess-1'), null)

  // Persisted prefs seed the store: frame-step FPS is restored, but a stale
  // `open:false` (from the pre-Studio column) never hides the desktop Studio.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: key => key === 'three-workbench:prefs' ? JSON.stringify({ open: false, stepFps: 24 }) : null,
      setItem: () => {},
    },
  })
  const reloadContext = recordingClientContext()
  plugin.apply(reloadContext)
  assert.equal(storeInitials[2].open, true)
  assert.equal(storeInitials[2].stepFps, 24)
  delete globalThis.localStorage

  const document = plugin.__previewDocument({
    title: 'Escape </script> test',
    revision: 3,
    code: 'const closing = "</script>"\nonFrame(() => {})',
  }, { position: [1, 2, 3], target: [0, 0, 0] })
  assert.match(document, /"three":"\/three-workbench\/runtime\/three\.module\.js"/)
  assert.match(document, /new Function\('ctx'/)
  assert.match(document, /const INITIAL_CAMERA = \{"position":\[1,2,3\],"target":\[0,0,0\]\}/)
  assert.ok(document.includes('\\u003c/script>'), 'payload must escape script terminators')
  assert.equal((document.match(/<\/script>/g) ?? []).length, 2, 'only the two real script tags may close')

  assert.ok(document.includes('three-workbench:scene-tree'))
  assert.ok(document.includes("from 'three/addons/TransformControls.js'"))
  assert.ok(document.includes('three-workbench:transform-live'))
  assert.ok(document.includes('three-workbench:gizmo-commit'))
  assert.ok(document.includes("data.command === 'gizmo'"))
  assert.ok(document.includes('data.reset === true'))
  assert.ok(document.includes('pin.before'))
  assert.ok(document.includes('script: scriptBaseline.get(uid) || snapshotScript(object)'))
  assert.ok(document.includes('unresolved: unresolvedUids.slice()'))
  assert.equal(document.includes('node.base = base'), false)
  assert.ok(document.includes("key: 'palette'"))
  assert.ok(document.includes('const INITIAL_EDITOR_STATE = null'))
  assert.ok(document.includes('resolveIdentity()'))
  assert.ok(document.includes('applyEditorState(INITIAL_EDITOR_STATE)'))
  assert.ok(document.includes('api.applyOverrides'))
  // Identity protocol is UID-only; semantic keys are diagnostic anchors.
  assert.ok(document.includes('const target = uidTarget(uidObjects, data.uid, deletedUids)'))
  assert.ok(document.includes("error: target.error"))
  assert.equal(document.includes('findObjectByKey'), false)
  assert.equal(document.includes("data.command === 'select') selectObject(data.id)"), false)

  // Stats protocol: aggregated at most twice per second, not per frame.
  assert.ok(document.includes("type: 'three-workbench:stats'"))
  assert.ok(document.includes('const STATS_INTERVAL = 500'))
  assert.ok(document.includes('objects: countObjects()'))
  assert.ok(document.includes('fps: Math.round((statsFrames / seconds) * 10) / 10'))
  assert.ok(document.includes('triangles: renderInfo.triangles'))
  assert.ok(document.includes('calls: renderInfo.calls'))
  assert.match(document, /stamp - lastStatsReport >= STATS_INTERVAL/)

  // Frame stepping pauses, validates fps, and clamps to both clock bounds.
  assert.ok(document.includes("data.action === 'step'"))
  assert.ok(document.includes('data.fps > 0'))
  assert.ok(document.includes('const upperBound = timeline.duration > 0 ? timeline.duration : Infinity'))
  assert.ok(document.includes('timeline.time = Math.min(upperBound, Math.max(0, stepTime))'))

  // Camera: tree reports per-property script bases, OrbitControls syncs an
  // existing pin, and resets drop individual pins.
  assert.ok(document.includes('scriptFov: scriptCamera === null ? null : round3(scriptCamera.fov)'))
  assert.ok(document.includes('scriptPosition: scriptCamera === null ? null : scriptCamera.position.map(round3)'))
  assert.ok(document.includes('scriptTarget: scriptCamera === null ? null : scriptCamera.target.map(round3)'))
  assert.ok(document.includes("? data.reset : (data.resetFov === true ? { fov: true } : null)"))
  assert.ok(document.includes('camera.fov = scriptCamera.fov'))
  assert.ok(document.includes('if (next.fov !== undefined) { camera.fov = next.fov; camera.updateProjectionMatrix() }'))
  assert.ok(document.includes('const syncCameraPin = () =>'))
  assert.ok(document.includes("controls.addEventListener('start', () => { orbitGesture = true })"))
  assert.ok(document.includes('interactive: interactive === true'))
  assert.ok(document.includes('hasPin: cameraPin !== null'))
  assert.ok(document.includes('reportCamera(true, false, \'reset\')'))
  // setCamera synchronizes the OrbitControls target before the script camera
  // baseline is captured, so non-origin targets survive Reset view (N3).
  assert.ok(document.includes('controls.target.set(target[0], target[1], target[2])'))
  assert.ok(document.includes('camera.lookAt(controls.target)'))
  assert.ok(document.includes('scriptCamera = { position: camera.position.toArray(), target: controls.target.toArray(), fov: camera.fov }'))

  // Nested overrides restore individual material/light channels on undo.
  assert.ok(document.includes('delete pin.props.light[prop]'))
  assert.ok(document.includes('const original = pin.originalMaterials === undefined ? undefined : pin.originalMaterials.get(slot)'))
  assert.ok(document.includes("restore[prop] = '#' + original[prop].getHexString()"))

  // Selection outlines follow animation and gizmo drags; one pooled helper per
  // selected mesh is refreshed every frame.
  assert.ok(document.includes('for (const helper of selectionHelpers.values()) {'))
  assert.ok(document.includes('if (helper.visible) helper.update()'))

  // Error reports are throttled by identical text, while the box shows newest.
  assert.ok(document.includes('errText.textContent = text'))
  assert.ok(document.includes('if (text === lastErrorText && now - lastErrorAt < 1000) return'))

  const editorState = {
    v: 2,
    updatedAt: 1,
    timeline: { duration: 12 },
    camera: null,
    objects: {
      's:mesh': {
        uid: 's:mesh', origin: 'script', type: 'Mesh', anchor: 't:Mesh',
        namedPath: 'n:Cube', ordinalPath: 'n:Cube', parentUid: null, wbId: 'cube',
        overrides: { position: [1, 2, 3] },
      },
    },
  }
  const withOverrides = plugin.__previewDocument(
    { title: 'O', revision: 2, code: 'const a = 2' },
    null,
    editorState,
  )
  assert.ok(withOverrides.includes('const INITIAL_EDITOR_STATE = {"v":2'))
  assert.ok(withOverrides.includes('"uid":"s:mesh"'))
  assert.ok(withOverrides.includes('"overrides":{"position":[1,2,3]}'))
  assert.ok(withOverrides.includes('applyEditorState(INITIAL_EDITOR_STATE)'))

  const standalone = plugin.__standaloneHtml({ title: 'S', revision: 1, code: 'const a = 1' }, editorState)
  assert.ok(standalone.includes('const INITIAL_EDITOR_STATE = {"v":2'))
  assert.ok(standalone.includes('"uid":"s:mesh"'))
  assert.ok(standalone.includes('applyEditorState(INITIAL_EDITOR_STATE)'))
  assert.match(standalone, /cdn\.jsdelivr\.net\/npm\/three@0\.186\.1\/build\/three\.module\.js/)
  assert.match(standalone, /cdn\.jsdelivr\.net\/npm\/three@0\.186\.1\/examples\/jsm\/controls\/OrbitControls\.js/)
  assert.match(standalone, /cdn\.jsdelivr\.net\/npm\/three@0\.186\.1\/examples\/jsm\/controls\/TransformControls\.js/)
  assert.equal(standalone.includes('/three-workbench/runtime'), false)

  const zip = plugin.__createZip([
    { name: 'index.html', bytes: new TextEncoder().encode('<html></html>') },
    { name: 'runtime/three.module.js', bytes: new Uint8Array([1, 2, 3]) },
  ])
  const zipBytes = new Uint8Array(await zip.arrayBuffer())
  assert.equal(Buffer.from(zipBytes.subarray(0, 4)).toString('hex'), '504b0304')
  const text = Buffer.from(zipBytes).toString('latin1')
  assert.ok(text.includes('index.html'))
  assert.ok(text.includes('runtime/three.module.js'))
  assert.ok(text.includes('PK\x05\x06'))
})
