/**
 * Init script installed in every E2E page before the Host app loads.
 *
 * Top frame: records metadata-only summaries of `three-workbench:*` messages
 * arriving from the runtime. Runtime frame: records summaries of commands sent
 * by the parent so the ready handshake order and command payloads can be
 * asserted. Frame buffers, HTML, state blobs and data URLs are never copied.
 *
 * This function is serialized by Playwright; it must be self-contained.
 */
export function collectorInit() {
  const MAX_MESSAGES = 2500
  const MAX_STRING = 300

  const text = value => (typeof value === 'string' ? value.slice(0, MAX_STRING) : value)

  const small = (value, depth) => {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
    if (typeof value === 'string') return text(value)
    if (typeof value === 'undefined') return undefined
    if (depth <= 0) return '<value>'
    if (Array.isArray(value)) {
      return value.slice(0, 24).map(entry => {
        const next = small(entry, depth - 1)
        return next === undefined ? null : next
      })
    }
    if (typeof value === 'object') {
      const out = {}
      let count = 0
      for (const key of Object.keys(value)) {
        if (count >= 30) break
        const lowered = key.toLowerCase()
        if (lowered === 'pixels' || lowered === 'dataurl' || lowered === 'blob' ||
            lowered === 'buffer' || lowered === 'srcdoc' || lowered === 'html' ||
            lowered === 'code' || lowered === 'token' || lowered === 'url') continue
        const next = small(value[key], depth - 1)
        if (next === undefined) continue
        out[text(key)] = next
        count += 1
      }
      return out
    }
    return undefined
  }

  const valueBytes = value => {
    if (value && typeof value.byteLength === 'number') return value.byteLength
    if (value && ArrayBuffer.isView(value)) return value.byteLength
    return null
  }

  const treeNode = node => {
    if (!node || typeof node !== 'object') return null
    return {
      uid: text(node.uid),
      name: text(node.name),
      type: text(node.type),
      depth: typeof node.depth === 'number' ? node.depth : null,
      parentUid: text(node.parentUid),
      alias: text(node.alias),
      locked: node.locked === true,
      pinned: node.pinned === true,
      wbId: text(node.wbId),
      visible: node.visible,
    }
  }

  const summarizeParamDescriptor = (key, descriptor) => {
    if (!descriptor || typeof descriptor !== 'object') {
      return { key: text(key), value: small(descriptor, 2) }
    }
    return {
      key: text(key === undefined ? descriptor.key : key),
      type: text(descriptor.type),
      label: small(descriptor.label, 2),
      default: small(descriptor.default, 2),
      min: typeof descriptor.min === 'number' ? descriptor.min : undefined,
      max: typeof descriptor.max === 'number' ? descriptor.max : undefined,
      step: typeof descriptor.step === 'number' ? descriptor.step : undefined,
      options: Array.isArray(descriptor.options)
        ? descriptor.options.slice(0, 12).map(option => ({
          value: small(option && option.value, 1),
          label: small(option && option.label, 2),
        }))
        : undefined,
    }
  }

  // The runtime sends an ordered descriptor array (each descriptor carries its
  // own key); older fixtures may send an object keyed by parameter name.
  const summarizeParamSchema = schema => {
    if (!schema || typeof schema !== 'object') return null
    if (Array.isArray(schema)) {
      return schema.slice(0, 24).map(descriptor => summarizeParamDescriptor(
        descriptor && typeof descriptor === 'object' ? descriptor.key : undefined,
        descriptor,
      ))
    }
    const out = {}
    let count = 0
    for (const key of Object.keys(schema)) {
      if (count >= 24) break
      out[text(key)] = summarizeParamDescriptor(key, schema[key])
      count += 1
    }
    return out
  }

  const summarize = data => {
    const base = { type: text(data.type) }
    switch (data.type) {
      case 'three-workbench:ready':
        base.revision = data.revision
        base.editorVersion = data.editorVersion
        return base
      case 'three-workbench:scene-tree': {
        base.requestId = text(data.requestId)
        base.reason = text(data.reason)
        base.revision = data.revision
        base.nodes = Array.isArray(data.nodes) ? data.nodes.slice(0, 80).map(treeNode) : null
        base.camera = data.camera ? {
          position: small(data.camera.position, 2),
          target: small(data.camera.target, 2),
          fov: data.camera.fov,
          scriptFov: data.camera.scriptFov,
        } : null
        base.count = typeof data.count === 'number' ? data.count : (Array.isArray(data.nodes) ? data.nodes.length : null)
        return base
      }
      case 'three-workbench:selection':
        base.uid = text(data.uid)
        base.uids = Array.isArray(data.uids) ? data.uids.slice(0, 40).map(text) : null
        base.primary = text(data.primary)
        return base
      case 'three-workbench:mutation':
        base.requestId = text(data.requestId)
        base.ok = data.ok
        base.error = text(data.error)
        base.command = text(data.command)
        base.action = text(data.action)
        base.uid = text(data.uid)
        base.uids = Array.isArray(data.uids) ? data.uids.slice(0, 40).map(text) : null
        base.key = text(data.key)
        base.trackCount = data.trackCount
        base.keyCount = data.keyCount
        base.unresolved = small(data.unresolved, 3)
        base.values = small(data.values, 3)
        base.locals = small(data.locals, 3)
        base.beforeLocals = small(data.beforeLocals, 3)
        base.channels = small(data.channels, 2)
        base.message = text(data.message)
        return base
      case 'three-workbench:params':
        base.action = text(data.action)
        base.ok = data.ok
        base.requestId = text(data.requestId)
        base.declared = data.declared
        base.schema = summarizeParamSchema(data.schema)
        base.values = small(data.values, 3)
        base.issues = small(data.issues, 3)
        base.applyError = text(data.applyError)
        base.error = text(data.error)
        return base
      case 'three-workbench:timeline':
        base.playing = data.playing
        base.time = data.time
        base.speed = data.speed
        base.loop = data.loop
        base.duration = data.duration
        return base
      case 'three-workbench:pick':
        base.uid = text(data.uid)
        base.uids = Array.isArray(data.uids) ? data.uids.slice(0, 40).map(text) : null
        base.primary = text(data.primary)
        base.object = data.object ? {
          name: text(data.object.name),
          type: text(data.object.type),
          position: small(data.object.position, 2),
          material: small(data.object.material, 2),
        } : null
        return base
      case 'three-workbench:stats':
        base.objects = data.objects
        base.triangles = data.triangles
        base.fps = data.fps
        base.calls = data.calls
        return base
      case 'three-workbench:transform-live':
        base.uid = text(data.uid)
        base.position = small(data.position, 2)
        base.rotation = small(data.rotation, 2)
        base.scale = small(data.scale, 2)
        return base
      case 'three-workbench:gizmo-commit':
        base.uid = text(data.uid)
        base.cancelled = data.cancelled === true
        base.channels = small(data.channels, 2)
        base.position = small(data.position, 2)
        base.rotation = small(data.rotation, 2)
        base.scale = small(data.scale, 2)
        return base
      case 'three-workbench:frame':
        base.requestId = text(data.requestId)
        base.index = data.index
        base.width = data.width
        base.height = data.height
        base.pixelsBytes = valueBytes(data.pixels)
        return base
      case 'three-workbench:frame-error':
        base.requestId = text(data.requestId)
        base.index = data.index
        base.message = text(data.message)
        return base
      case 'three-workbench:capture-session':
        base.requestId = text(data.requestId)
        base.ended = data.ended === true
        base.cancelled = data.cancelled === true
        return base
      case 'three-workbench:recording':
        base.started = data.started === true
        return base
      case 'three-workbench:webm':
      case 'three-workbench:glb':
      case 'three-workbench:stl':
      case 'three-workbench:obj': {
        base.mimeType = text(data.mimeType)
        const blob = data.blob || data.data
        base.blobBytes = blob && typeof blob.size === 'number' ? blob.size : null
        return base
      }
      case 'three-workbench:camera':
        base.position = small(data.position, 2)
        base.target = small(data.target, 2)
        base.fov = data.fov
        base.interactive = data.interactive
        base.source = text(data.source)
        return base
      case 'three-workbench:error':
        base.message = text(data.message)
        base.code = text(data.code)
        return base
      case 'three-workbench:console':
        base.level = text(data.level)
        base.message = text(data.message)
        return base
      case 'three-workbench:asset-state':
      case 'three-workbench:assets':
        base.assets = Array.isArray(data.assets)
          ? data.assets.slice(0, 20).map(asset => ({
            id: text(asset && asset.id),
            name: text(asset && asset.name),
            bytes: asset && asset.bytes,
            kind: text(asset && asset.kind),
          }))
          : null
        base.usage = small(data.usage, 2)
        return base
      case 'three-workbench:asset-error':
        base.message = text(data.message)
        base.error = text(data.error)
        return base
      case 'three-workbench:shortcut':
        base.key = text(data.key)
        base.command = text(data.command)
        return base
      default:
        base.keys = Object.keys(data).slice(0, 24).map(text)
        return base
    }
  }

  const summarizeCommand = data => {
    const base = { type: text(data.type), command: text(data.command) }
    for (const key of [
      'action', 'requestId', 'uid', 'primary', 'mode', 'space', 'snap', 'enabled',
      'aspect', 'scale', 'duration', 'speed', 'loop', 'time', 'direction', 'fps',
      'tracksVersion', 'reason', 'autoKey', 'stepFps', 'revision', 'timeoutMs',
      'interactive', 'source', 'cancelled',
    ]) {
      if (data[key] === undefined) continue
      base[key] = typeof data[key] === 'string' ? text(data[key]) : data[key]
    }
    if (Array.isArray(data.uids)) base.uids = data.uids.slice(0, 40).map(text)
    if (Array.isArray(data.ops)) base.ops = data.ops.slice(0, 8).map(op => ({
      kind: text(op && op.kind),
      uid: text(op && op.uid),
    }))
    if (Array.isArray(data.keys)) base.keys = data.keys.slice(0, 12).map(text)
    if (Array.isArray(data.declared)) base.declared = data.declared.slice(0, 20).map(text)
    if (data.tracks !== undefined) {
      if (data.tracks && typeof data.tracks === 'object') {
        base.tracksVersionField = data.tracks.v
        base.trackItems = Array.isArray(data.tracks.items) ? data.tracks.items.length : null
        if (Array.isArray(data.tracks.items)) {
          let keys = 0
          for (const track of data.tracks.items) {
            if (track && Array.isArray(track.keys)) keys += track.keys.length
          }
          base.trackKeys = keys
          base.trackUids = data.tracks.items.slice(0, 12).map(track => text(track && track.uid))
          base.trackPaths = data.tracks.items.slice(0, 12).map(track => text(track && track.path))
        }
      } else {
        base.tracks = small(data.tracks, 2)
      }
    }
    if (data.values !== undefined) base.values = small(data.values, 3)
    if (data.locals !== undefined) base.locals = small(data.locals, 2)
    return base
  }

  if (window.top === window) {
    if (window.__e2e) return
    const state = {
      messages: [],
      types: Object.create(null),
      readies: 0,
      errors: [],
      startedAt: Date.now(),
    }
    window.__e2e = state
    window.addEventListener('error', event => {
      if (state.errors.length < 20) state.errors.push(String(event.message || 'error').slice(0, MAX_STRING))
    })
    window.addEventListener('unhandledrejection', event => {
      if (state.errors.length < 20) {
        const reason = event.reason
        state.errors.push(String(reason && reason.message ? reason.message : reason).slice(0, MAX_STRING))
      }
    })
    window.addEventListener('message', event => {
      const data = event.data
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return
      if (data.type.indexOf('three-workbench:') !== 0) return
      let summary
      try {
        summary = summarize(data)
      } catch {
        summary = { type: text(data.type), unsummarized: true }
      }
      summary.at = Date.now()
      state.messages.push(summary)
      state.types[summary.type] = (state.types[summary.type] || 0) + 1
      if (summary.type === 'three-workbench:ready') state.readies += 1
      if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES)
    })
  } else {
    if (window.__e2eInbound) return
    const inbound = []
    window.__e2eInbound = inbound
    window.addEventListener('message', event => {
      const data = event.data
      if (!data || typeof data !== 'object' || data.type !== 'three-workbench:command') return
      let summary
      try {
        summary = summarizeCommand(data)
      } catch {
        summary = { type: text(data.type), unsummarized: true }
      }
      summary.at = Date.now()
      inbound.push(summary)
      if (inbound.length > 600) inbound.splice(0, inbound.length - 600)
    })
  }
}
