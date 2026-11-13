/**
 * Standalone Studio shell.
 *
 * Provides the small host contract client.js expects from DeepSeek Harness:
 * a snapshot-store require, locale, session catalog and bindings, slots, and
 * the layout/ui-workspace stubs. The workbench slot component is then mounted
 * as the whole page.
 */
(function () {
  'use strict'

  var React = window.React
  var ReactDOM = window.ReactDOM
  if (React === undefined || ReactDOM === undefined) {
    throw new Error('React UMD bundles are missing')
  }

  function createSnapshotStore(initial) {
    var state = initial
    var listeners = new Set()
    function notify() {
      for (var listener of Array.from(listeners)) {
        try { listener() } catch (error) { void error }
      }
    }
    return {
      getSnapshot: function () { return state },
      subscribe: function (listener) {
        listeners.add(listener)
        return function () { listeners.delete(listener) }
      },
      set: function (next) { state = next; notify() },
      update: function (mutate) {
        var draft = Object.assign({}, state)
        mutate(draft)
        state = draft
        notify()
      },
    }
  }

  function useStore(store, selector) {
    var get = function () { return selector(store.getSnapshot()) }
    return React.useSyncExternalStore(store.subscribe, get, get)
  }

  var definition = null
  window.__ModuleLoader__ = {
    load: function (value) { definition = value },
  }

  var NS = 'threeWorkbench'
  var dictionaries = { zh: {}, en: {} }
  var localeListeners = new Set()
  var activeLocale = (function () {
    try {
      var saved = localStorage.getItem('three-studio:locale')
      return saved === 'en' ? 'en' : 'zh'
    } catch (error) { return 'zh' }
  })()
  var localeStore = createSnapshotStore({ active: activeLocale, revision: 0 })
  function notifyLocale() {
    localeStore.set({ active: activeLocale, revision: localeStore.getSnapshot().revision + 1 })
    for (var listener of Array.from(localeListeners)) {
      try { listener() } catch (error) { void error }
    }
    document.documentElement.lang = activeLocale === 'zh' ? 'zh-CN' : 'en'
  }
  function format(text, params) {
    if (params === null || params === undefined) return text
    return String(text).replace(/\{([A-Za-z0-9_]+)\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
    })
  }
  function translate(key, params) {
    var table = dictionaries[activeLocale] || {}
    var fallback = dictionaries.en || {}
    var text = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : fallback[key]
    if (typeof text !== 'string') return key
    return format(text, params)
  }
  var locale = {
    register: function (namespace, tables) {
      dictionaries = {
        zh: Object.assign({}, dictionaries.zh, tables.zh || {}),
        en: Object.assign({}, dictionaries.en, tables.en || {}),
      }
      notifyLocale()
      return function () {}
    },
    bind: function () { return translate },
    getLocale: function () { return localeStore.getSnapshot() },
    setLocale: function (id) {
      if (id !== 'zh' && id !== 'en') return
      activeLocale = id
      try { localStorage.setItem('three-studio:locale', id) } catch (error) { void error }
      notifyLocale()
    },
    subscribe: function (listener) {
      localeListeners.add(listener)
      return function () { localeListeners.delete(listener) }
    },
    getSnapshot: function () { return localeStore.getSnapshot() },
    resolveText: function (value) { return typeof value === 'string' ? value : String(value) },
  }

  var sessionsStore = createSnapshotStore({ ids: [], byId: {}, phase: 'loading', projectionsBySession: {} })
  var activeSessionId = null
  var sessionBindings = new Map()

  function sessionRow(row, active) {
    return {
      id: row.id,
      displayTitle: row.displayTitle || row.title || row.id,
      title: row.title,
      updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : Date.now(),
      running: false,
      blank: true,
      retainedBy: { mainView: active ? 1 : 0 },
    }
  }

  async function refreshSessions() {
    try {
      var response = await fetch('/api/sessions')
      var data = await response.json()
      var ids = []
      var byId = {}
      var rows = Array.isArray(data.sessions) ? data.sessions : []
      for (var row of rows) ids.push(row.id)
      if (activeSessionId === null || !ids.includes(activeSessionId)) {
        activeSessionId = ids.length > 0 ? ids[0] : null
      }
      for (var item of rows) {
        byId[item.id] = sessionRow(item, item.id === activeSessionId)
      }
      sessionsStore.set({ ids: ids, byId: byId, phase: 'ready', projectionsBySession: {} })
    } catch (error) {
      sessionsStore.set({ ids: [], byId: {}, phase: 'error', projectionsBySession: {} })
    }
  }

  function openSession(id) {
    if (typeof id !== 'string' || id === '') return
    activeSessionId = id
    try { localStorage.setItem('three-studio:session', id) } catch (error) { void error }
    var current = sessionsStore.getSnapshot()
    var byId = {}
    for (var key of Object.keys(current.byId)) {
      byId[key] = Object.assign({}, current.byId[key], {
        retainedBy: { mainView: key === id ? 1 : 0 },
      })
    }
    sessionsStore.set(Object.assign({}, current, { byId: byId }))
  }

  function emptySessionSnapshot() {
    return {
      running: false,
      pendingSubmissions: [],
      promptError: null,
      lastAgentError: '',
      loadingOlder: false,
    }
  }

  var modelsStore = createSnapshotStore({ status: 'loading', providers: [], groups: [], default: null })
  async function refreshModels() {
    try {
      var response = await fetch('/api/models')
      var data = await response.json()
      modelsStore.set({
        status: 'ready',
        providers: Array.isArray(data.providers) ? data.providers : [],
        groups: Array.isArray(data.groups) ? data.groups : [],
        default: data.default === undefined ? null : data.default,
      })
    } catch (error) {
      modelsStore.set({ status: 'error', providers: [], groups: [], default: null })
    }
    return modelsStore.getSnapshot()
  }

  function bindingFor(sessionId) {
    var existing = sessionBindings.get(sessionId)
    if (existing !== undefined) return existing
    var sessionStore = createSnapshotStore(emptySessionSnapshot())
    var eventStore = createSnapshotStore({ entries: [], hasMore: false })
    var modelStore = createSnapshotStore({ next: null })
    var events = []
    var stream = new EventSource('/api/sessions/' + encodeURIComponent(sessionId) + '/stream')
    function publishEvents() {
      eventStore.set({ entries: events.slice(), hasMore: false })
    }
    stream.onmessage = function (message) {
      var payload
      try { payload = JSON.parse(message.data) } catch (error) { return }
      if (payload === null || typeof payload !== 'object') return
      if (payload.kind === 'snapshot') {
        if (payload.state !== null && typeof payload.state === 'object') sessionStore.set(payload.state)
        if (Array.isArray(payload.events)) {
          events = payload.events.map(function (event) { return { type: 'committed', event: event } })
          publishEvents()
        }
        if (payload.selection !== null && payload.selection !== undefined) {
          modelStore.set({ next: payload.selection })
        }
      } else if (payload.kind === 'event' && payload.event !== null && typeof payload.event === 'object') {
        events.push({ type: 'committed', event: payload.event })
        publishEvents()
        if (payload.event.type === 'assistant/message') refreshSessions()
      } else if (payload.kind === 'chunk' && typeof payload.text === 'string') {
        events.push({
          type: 'transient',
          event: {
            type: 'assistant/live-chunk',
            data: {
              attemptId: payload.attemptId,
              chunk: { type: 'text-delta', text: payload.text },
            },
          },
        })
        publishEvents()
      } else if (payload.kind === 'selection') {
        modelStore.set({ next: payload.selection === undefined ? null : payload.selection })
      } else if (payload.kind === 'state' && payload.state !== null && typeof payload.state === 'object') {
        sessionStore.set(payload.state)
      }
    }
    stream.onerror = function () {
      sessionStore.update(function (draft) {
        if (draft.running === true) draft.lastAgentError = 'Connection to the Studio server was interrupted.'
      })
    }
    var session = {
      getSnapshot: sessionStore.getSnapshot,
      subscribe: sessionStore.subscribe,
      prompt: async function (parts, mode, signal, requestId) {
        void mode
        void signal
        void requestId
        sessionStore.update(function (draft) { draft.promptError = null })
        try {
          var response = await fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/prompt', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ parts: parts }),
          })
          var data = await response.json()
          if (response.ok && data.ok === true) {
            await refreshSessions()
            return { ok: true, value: { accepted: true } }
          }
          var error = { message: data && data.error && data.error.message ? data.error.message : 'Prompt failed.' }
          sessionStore.update(function (draft) { draft.promptError = { error: error } })
          return { ok: false, error: error }
        } catch (error) {
          var failure = { message: error && error.message ? error.message : 'Prompt failed.' }
          sessionStore.update(function (draft) { draft.promptError = { error: failure } })
          return { ok: false, error: failure }
        }
      },
      cancel: async function () {
        try {
          await fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/cancel', { method: 'POST' })
        } catch (error) { void error }
      },
      loadOlder: async function () {},
      clearPromptError: function () {
        sessionStore.update(function (draft) { draft.promptError = null })
      },
      projections: {
        faceOf: function (name) {
          return name === 'modelSelection' ? modelStore : createSnapshotStore({})
        },
      },
    }
    var eventSource = {
      getSnapshot: eventStore.getSnapshot,
      subscribe: eventStore.subscribe,
    }
    var binding = {
      sessionId: sessionId,
      session: session,
      eventSource: eventSource,
      modelStore: modelStore,
    }
    sessionBindings.set(sessionId, binding)
    return binding
  }

  var workspaceStore = createSnapshotStore({
    items: [{
      workspaceId: 'studio',
      path: '/',
      title: 'Three Studio',
      createdAt: '',
      updatedAt: '',
      sessionIds: [],
    }],
  })

  async function refreshWorkspaces() {
    try {
      var response = await fetch('/api/workspaces')
      var data = await response.json()
      if (Array.isArray(data.items)) workspaceStore.set({ items: data.items })
    } catch (error) { void error }
  }

  async function modelCatalog() {
    try {
      var response = await fetch('/api/models')
      var data = await response.json()
      return {
        providers: Array.isArray(data.providers) ? data.providers : [],
        groups: Array.isArray(data.groups) ? data.groups : [],
        default: data.default === undefined ? null : data.default,
      }
    } catch (error) {
      return { providers: [], groups: [], default: null }
    }
  }
  var remote = {
    llm: {
      listProviders: async function () {
        var data = await modelCatalog()
        return { ok: true, value: data.providers.map(function (provider) {
          return { id: provider.id, name: provider.name }
        }) }
      },
      listConfigurableProviders: async function () {
        var data = await modelCatalog()
        return { ok: true, value: data.providers.map(function (provider) {
          return {
            provider: provider.id,
            displayName: provider.name,
            settingsNs: 'studio-models',
            settingsPath: ['providers', provider.id],
            active: true,
            declared: true,
            defaultBaseURL: provider.baseURL,
          }
        }) }
      },
      discoverModels: async function () {
        return { ok: false, error: { code: 'not-supported', message: 'Model discovery is not implemented.' } }
      },
    },
    credentials: {
      describe: async function (refs) {
        var data = await modelCatalog()
        var value = {}
        for (var ref of Array.isArray(refs) ? refs : []) {
          var provider = data.providers.find(function (row) { return row.keyRef === ref })
          value[ref] = { configured: provider !== undefined && provider.keyConfigured === true }
        }
        return { ok: true, value: value }
      },
      set: async function (ref, value) {
        var data = await modelCatalog()
        var provider = data.providers.find(function (row) { return row.keyRef === ref })
        if (provider === undefined) return { ok: false, error: { code: 'unknown-provider', message: 'Unknown credential reference.' } }
        var response = await fetch('/api/providers/' + encodeURIComponent(provider.id) + '/key', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: value }),
        })
        var result = await response.json()
        await refreshModels()
        return result.ok === true ? { ok: true, value: undefined }
          : { ok: false, error: { code: 'credential-failed', message: result.message || 'Could not store the API key.' } }
      },
      unset: async function (ref) {
        var data = await modelCatalog()
        var provider = data.providers.find(function (row) { return row.keyRef === ref })
        if (provider === undefined) return { ok: false, error: { code: 'unknown-provider', message: 'Unknown credential reference.' } }
        var response = await fetch('/api/providers/' + encodeURIComponent(provider.id) + '/key', { method: 'DELETE' })
        var result = await response.json()
        await refreshModels()
        return result.ok === true ? { ok: true, value: undefined }
          : { ok: false, error: { code: 'credential-failed', message: result.message || 'Could not clear the API key.' } }
      },
    },
    settings: {
      describe: async function () {
        var data = await modelCatalog()
        var providers = {}
        for (var provider of data.providers) {
          providers[provider.id] = {
            displayName: provider.name,
            api: provider.api,
            baseURL: provider.baseURL,
            apiKeyEnv: provider.keyRef,
            models: provider.models.map(function (model) { return { id: model.id, name: model.name } }),
          }
        }
        return {
          ok: true,
          value: {
            writable: true,
            hasDocument: true,
            namespaces: [{
              autoGenerate: false,
              ns: 'studio-models',
              schema: {},
              value: { providers: providers },
              base: {},
              user: { providers: providers },
              applies: 'live',
              secrets: [],
              revision: Date.now(),
            }],
          },
        }
      },
      mutate: async function (ns, ops) {
        var list = Array.isArray(ops) ? ops : []
        var unset = list.find(function (entry) {
          return entry !== null && typeof entry === 'object' && entry.op === 'unset'
            && Array.isArray(entry.path) && entry.path[0] === 'providers' && typeof entry.path[1] === 'string'
        })
        if (unset !== undefined) {
          var removed = await fetch('/api/providers/' + encodeURIComponent(unset.path[1]), { method: 'DELETE' })
          var removal = await removed.json()
          await refreshModels()
          if (removal.ok !== true) {
            return { ok: false, error: { code: 'settings-refused', message: removal.message || 'Could not delete the provider.' } }
          }
          return { ok: true, value: { ns: ns, value: { providers: {} }, revision: Date.now() } }
        }
        var operation = list.find(function (entry) {
          return entry !== null && typeof entry === 'object' && entry.op === 'set'
            && Array.isArray(entry.path) && entry.path[0] === 'providers' && typeof entry.path[1] === 'string'
        })
        if (operation === undefined) {
          return { ok: false, error: { code: 'invalid-operation', message: 'Unsupported settings operation.' } }
        }
        var route = operation.path[1]
        var profile = operation.value !== null && typeof operation.value === 'object' ? operation.value : {}
        var models = Array.isArray(profile.models)
          ? profile.models.map(function (model) { return typeof model === 'string' ? model : model.id })
          : []
        var catalog = await modelCatalog()
        var exists = catalog.providers.some(function (provider) { return provider.id === route })
        var response = await fetch(exists
          ? '/api/providers/' + encodeURIComponent(route)
          : '/api/providers', {
          method: exists ? 'PUT' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: route,
            name: profile.displayName,
            baseURL: profile.baseURL,
            api: profile.api,
            models: models,
            apiKey: '',
          }),
        })
        var result = await response.json()
        await refreshModels()
        if (result.ok !== true) {
          return { ok: false, error: { code: 'settings-refused', message: result.message || 'Could not save the provider.' } }
        }
        return {
          ok: true,
          value: {
            ns: ns,
            value: { providers: {} },
            revision: Date.now(),
          },
        }
      },
    },
  }

  var directoryCache = new Map()
  var modelDirectories = {
    directoryFor: function (sessionId) {
      var existing = directoryCache.get(sessionId)
      if (existing !== undefined) return existing
      var binding = bindingFor(sessionId)
      var store = createSnapshotStore({
        current: null, routable: null, groups: [], failures: [], status: 'loading', pending: null, error: null,
      })
      function syncFromCatalog() {
        var catalog = modelsStore.getSnapshot()
        var selection = binding.modelStore.getSnapshot().next
        store.update(function (draft) {
          draft.groups = catalog.groups
          draft.current = selection
          draft.routable = selection === null ? null : catalog.groups.some(function (group) {
            return group.id === selection.provider && group.models.some(function (model) { return model.id === selection.model })
          })
          draft.status = catalog.status === 'error' ? 'error' : 'ready'
          draft.error = catalog.status === 'error' ? 'Could not load models.' : null
        })
      }
      var offModels = modelsStore.subscribe(syncFromCatalog)
      var offSelection = binding.modelStore.subscribe(syncFromCatalog)
      syncFromCatalog()
      var directory = {
        store: store,
        load: async function () { await refreshModels(); syncFromCatalog(); return store.getSnapshot() },
        select: async function (selection) {
          store.update(function (draft) { draft.status = 'selecting'; draft.pending = selection; draft.error = null })
          try {
            var response = await fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/selection', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(selection),
            })
            var result = await response.json()
            if (result.ok !== true) {
              store.update(function (draft) {
                draft.status = 'error'
                draft.pending = null
                draft.error = result.message || 'Could not select the model.'
              })
              return { ok: false, error: { message: result.message || 'Could not select the model.' } }
            }
            binding.modelStore.set({ next: result.selection })
            store.update(function (draft) {
              draft.current = result.selection
              draft.status = 'ready'
              draft.pending = null
              draft.error = null
            })
            return { ok: true, value: undefined }
          } catch (error) {
            var message = error && error.message ? error.message : 'Could not select the model.'
            store.update(function (draft) {
              draft.status = 'error'
              draft.pending = null
              draft.error = message
            })
            return { ok: false, error: { message: message } }
          }
        },
        dispose: function () {
          offModels()
          offSelection()
        },
      }
      directoryCache.set(sessionId, directory)
      return directory
    },
  }
  void refreshModels()

  var slots = {
    register: function (options, component) {
      registrations.push({ options: options, component: component })
      return function () {}
    },
    inject: function (key, callback) {
      callback()
      return function () {}
    },
    getVersion: function () { return 1 },
    entries: function () { return [] },
    subscribe: function () { return function () {} },
  }
  var registrations = []

  var ctx = {
    effect: function (fn) {
      var dispose = fn()
      return typeof dispose === 'function' ? dispose : function () {}
    },
    slots: slots,
    locale: locale,
    sessions: {
      list: sessionsStore,
      binding: bindingFor,
      create: async function () {
        var response = await fetch('/api/sessions', { method: 'POST' })
        var data = await response.json()
        await refreshSessions()
        return data.id
      },
    },
    workspaces: { list: workspaceStore },
    uiWorkspace: {
      openSession: openSession,
      startSession: async function () { return null },
      openWorkspace: async function () { return null },
    },
    layout: {
      openWorkbench: function () {},
      closeWorkbench: function () {},
      setWorkbenchPlacement: function () {},
      workbenchPlacement: function () { return 'left' },
      selectPanel: function () {},
    },
    sidebarRightTabs: { register: function () { return function () {} } },
    sidebarRight: { openTab: function () {}, openResource: function () {}, openTabs: createSnapshotStore({}) },
    remote: remote,
    remoteAccess: { whenAccess: function (name, callback) { return callback() } },
    get: function (name) {
      if (name === 'modelDirectories') return modelDirectories
      return undefined
    },
  }

  function App() {
    var [viewportWidth, setViewportWidth] = React.useState(window.innerWidth)
    var [viewportHeight, setViewportHeight] = React.useState(window.innerHeight)
    React.useEffect(function () {
      var onResize = function () {
        setViewportWidth(window.innerWidth)
        setViewportHeight(window.innerHeight)
      }
      window.addEventListener('resize', onResize)
      return function () { window.removeEventListener('resize', onResize) }
    }, [])
    var registration = registrations.find(function (row) {
      return row.options !== null && row.options !== undefined && row.options.name === 'workbench'
    })
    var injected = registration === undefined || typeof registration.options.inject !== 'function'
      ? {} : registration.options.inject()
    var hooks = injected.hooks || {}
    var openWorkbench = function () {
      if (hooks.workbench === undefined || typeof hooks.workbench.update !== 'function') return
      hooks.workbench.update(function (draft) {
        draft.open = true
        if (draft.overlayOpen !== true) {
          draft.overlayOpen = true
          draft.overlayOpenGeneration = (draft.overlayOpenGeneration || 0) + 1
        }
      })
    }
    React.useEffect(function () { openWorkbench() }, [])
    if (registration === undefined) {
      return React.createElement('div', { style: { color: '#fff', padding: 24 } }, 'Workbench slot was not registered.')
    }
    var props = Object.assign({}, injected, {
      t: translate,
      useWorkbench: function (selector) { return useStore(hooks.workbench, selector) },
      useEditor: function (selector) { return useStore(hooks.editor, selector) },
      useSessions: function (selector) { return useStore(sessionsStore, selector) },
      usePanelInfo: function (selector) { return selector({ activePanelId: null }) },
      viewportWidth: viewportWidth,
      viewportHeight: viewportHeight,
      width: viewportWidth,
      canShow: true,
      // Embedded Studio has no exit gesture; the Workbench overlay stays up.
      close: undefined,
      report: function () {},
      openWorkbench: openWorkbench,
    })
    return React.createElement(registration.component, props)
  }

  async function start() {
    document.documentElement.lang = activeLocale === 'zh' ? 'zh-CN' : 'en'
    var savedTheme = 'dark'
    try { savedTheme = localStorage.getItem('three-studio:theme') === 'light' ? 'light' : 'dark' } catch (error) { void error }
    var dark = savedTheme !== 'light'
    document.documentElement.dataset.studioTheme = savedTheme
    document.documentElement.style.colorScheme = savedTheme
    document.body.toggleAttribute('data-ds-dark-theme', dark)
    document.body.setAttribute('data-ds-theme-source', savedTheme)
    if (definition === null) {
      document.getElementById('root').textContent = 'client.js did not register.'
      return
    }
    var plugin = definition.factory(function (name) {
      if (name === 'react') return React
      if (name === '@deepseek-ai/dsh-client-store') return { createSnapshotStore: createSnapshotStore }
      throw new Error('Unexpected module: ' + name)
    })
    try {
      var saved = localStorage.getItem('three-studio:session')
      if (saved !== null && saved !== '') activeSessionId = saved
    } catch (error) { void error }
    await refreshSessions()
    await refreshWorkspaces()
    await refreshModels()
    plugin.apply(ctx)
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App))
  }

  window.ThreeStudioStandalone = { start: start }
})()
