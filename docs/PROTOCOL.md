# Three.js Workbench protocol and trust boundary

Status: implemented behavior, 2026-11-02. This document describes what the
shipped code does, not an aspirational design. Source anchors are line numbers
in the frozen files below; re-grep the named symbol if those files change.

| File | Size | SHA-256 |
|---|---|---|
| `client.js` | 24,187 lines | `fc3c39526b1fcae1f6b92a4a2df10dee10218377a2c9444c77826e8f2959c114` |
| `index.js` | 10,470 lines, 383,552 bytes | `fe28263777db63fadb4fb08ddede79bff7b28604560f743b7b638a556b1039b9` |

The browser half (`client.js`) owns the parent page and emits the sandboxed
runtime as `srcDoc`. The Host half (`index.js`) owns the scene, asset, share and
persistence routes. The runtime is generated inside the parent bundle, so its
"source" anchors are line ranges in `client.js`.

Conventions in this document: `<request-id>` is an opaque correlation string
whose parent-generated form is `${sessionKey}:${sequence}`; never log it or
put a real value in a document. `<session-key>`, `<share-id>`,
`<asset-id>` and `<host-url-with-token>` are placeholders. No real token,
Session identifier, share id or capability URL belongs in protocol examples.

## 1. Transport and trust boundary

- Parent → runtime: `frame.contentWindow.postMessage(message, '*')`. The main
  command helper is at `client.js:17482-17518`; command-free sends use
  `postRuntimeCommand` at `client.js:17612-17622`.
- Runtime → parent: `parent.postMessage(payload, '*')`, with an ArrayBuffer
  transfer variant for pixels at `client.js:6535-6541`.
- The preview iframe sandbox is exactly
  `allow-scripts allow-pointer-lock allow-downloads` at `client.js:22427`.
  There is no `allow-same-origin`, so the generated document has an opaque
  origin. The document is assigned as `srcDoc`; generated code never receives a
  navigable HTML URL.
- The share viewer uses the same sandbox triple in a constant shell:
  `index.js:7445`. The share document is fetched as a `text/plain` attachment
  and assigned to `srcdoc`; it is never served as navigable HTML
  (`index.js:9404-9434`).
- Parent source guard: the parent accepts a message only after
  `event.source === frame.contentWindow` (`client.js:17173-17177`). It does
  **not** check `event.origin`.
- Runtime source/origin guard: none. The runtime accepts any object whose
  `type` is `three-workbench:command` (`client.js:11301-11304`); it checks
  neither `event.source` nor `event.origin`.
- Trust model: the parent page is trusted; the sandboxed frame is untrusted
  code. The sandbox protects the editor origin, not the runtime from forged
  commands. Any script that can obtain the frame's `WindowProxy` can send a
  valid command, and the runtime will execute it. Conversely, the parent
  filters runtime messages by window identity, but not by origin, because an
  opaque origin is expected. Do not use this channel for secrets or
  authorization decisions. A same-origin script already in the parent can
  call the same UI actions.
- `targetOrigin: '*'` is deliberate: a sandboxed opaque-origin document cannot
  be addressed by a meaningful origin string. Confidentiality must come from
  not putting secrets in messages, not from target-origin filtering.
- Unknown message types and unknown command names are ignored. A malformed
  message that carries a recognized `type` is handled defensively, and a
  malformed command normally produces no ack. There is no protocol error
  channel beyond the messages in this document.

## 2. Envelope and request correlation

Every parent command has the envelope:

```js
{ type: 'three-workbench:command', command: '<name>', requestId?: '<opaque>', ...fields }
```

`requestId` is generated only by the parent command helper:
`${sessionKey}:${sequence}` with a monotonically increasing per-mount
sequence (`client.js:17482-17518`). It is opaque to the runtime and is echoed
unchanged in the reply. The parent resolves waiters by exact string equality.

Parent waiters and timeouts:

| Operation | Timeout | Source |
|---|---|---|
| generic mutation | 4 s, resolves `{ok:false,error:'timeout'}` | `client.js:17520-17530` |
| scene tree | 4 s, resolves `null` | `client.js:17531-17541` |
| asset status | 4 s, resolves `null` | `client.js:17542-17552` |
| deterministic export frame | 5 s, rejects `frame-timeout` | `client.js:17787-17820` |
| capture end/cancel ack | 2 s, resolves `false` | `client.js:17624-17630` |

The runtime only echoes `requestId` when one was supplied. It never invents an
id for a command that omitted it. The parent also accepts spontaneous messages
(`ready`, `timeline`, `stats`, `camera`, `selection`, `asset-state`,
`asset-error`, `console`, `error`, recording and export payloads) without a
waiter.

Asset manifest requests use a deterministic id,
`${sessionKey}:assets:${assetManifestRevision}` (`client.js:18151-18163`), not
the command-helper sequence. This is an idempotent refresh key, so a repeated
manifest at the same revision is acked with the same id; the runtime rejects a
manifest whose revision is not greater than the current one.

## 3. Handshake and startup order

1. Runtime posts `ready`: `{type:'three-workbench:ready', revision, editorVersion: 2}`
   (`client.js:11775`). There is no `requestId`.
2. Immediately after `ready`, on the next animation frame, the runtime sends
   the first scene tree with `reason:'ready'` and a timeline message
   (`client.js:11776`).
3. On `ready`, the parent clears late-capture state, marks the frame ready, and
   posts these commands without request ids (`client.js:17178-17231`):
   `resolution`, timeline `set-speed`/`set-loop`/`set-duration`, `locks`,
   `tracks`/`config`, `tracks`/`replace-all` with `tracksVersion:1` and
   `reason:'load'`, `scene-tree`, `select-mode`, `gizmo`, and `params`/`schema`.
4. Separately, when the parent is ready and the asset manifest revision changes,
   it posts `assets`/`manifest` with the deterministic request id described
   above (`client.js:18151-18163`).

A fresh document receives no old command queue. A command posted before the
frame exposes `contentWindow` is dropped by the parent helper, which returns
`undefined` rather than an id (`client.js:17505-17518`).

## 4. Runtime → parent messages

All shapes below are exact field sets except where marked optional. Array and
object contents may contain additional inspector fields that are not part of
the extension contract.

### 4.1 `ready`

```js
{ type: 'three-workbench:ready', revision: number, editorVersion: 2 }
```

### 4.2 `scene-tree`

Reply to `scene-tree`, and also emitted proactively with `reason:'ready'`
(`client.js:7770-7872`, `client.js:9709-9714`).

```js
{
  type: 'three-workbench:scene-tree',
  rev: number,
  nodes: Node[],
  materials: Material[],
  unresolved: string[],
  deleted: string[],
  camera: {
    position: number[3], target: number[3], fov: number,
    scriptFov: number|null, scriptPosition: number[3]|null,
    scriptTarget: number[3]|null
  },
  renderer: {
    toneMapping: string, exposure: number, shadows: boolean,
    background: string|null, backgroundKind: string,
    fog: object|null,
    scriptToneMapping: string|null, scriptExposure: number|null,
    scriptShadows: boolean|null, scriptBackground: string|null,
    scriptBackgroundKind: string|null, scriptFog: object|null,
    scriptFogType: string|null
  },
  environment: { scriptKind: 'none'|'texture'|'other', pinned: boolean, assetId: string|null },
  counts: { objects: number, triangles: number },
  reason: 'ready'|'request',
  requestId?: string
}
```

`Node` (`client.js:7793-7832`):

```js
{
  uid, key, anchor, origin: 'script'|'manual', alias,
  parentUid: string|null, pinned: string[], locked: boolean,
  wbId: string|null, namedPath, ordinalPath, depth,
  type, name, visible: boolean,
  position: number[3], rotation: number[3], rotationOrder: string, scale: number[3],
  script: object,
  manual?: object,
  material?: number|number[],
  light?: { intensity: number, color?: string, distance?, angle?, penumbra?, decay? },
  instances?: number,
  vertices?: number,
  triangles?: number,
  bounds?: number[3],
  worldPosition?: number[3]
}
```

`uid` is the stable identity. `key`/`anchor` is the resolution key, not an
identity substitute. `material` values index into the top-level `materials`
array. A material row is
`{id, uses, type, readonly, color?, emissive?, ...scalars, side?, textures?}`
(`client.js:7337-7348`); `readonly` is true for `ShaderMaterial`.

### 4.3 `mutation` (generic and overloaded)

The base ack type is reused by several command families. The parent dispatches
on `command` when present; readers must tolerate the absence of fields that
belong only to other variants.

Generic mutation ack (`client.js:9730-9759`, structure helpers
`client.js:10890`, `client.js:11175-11295`):

```js
{ type: 'three-workbench:mutation', requestId, ok: true }
{ type: 'three-workbench:mutation', requestId, ok: true, uid }        // lock, fragment, unpin
{ type: 'three-workbench:mutation', requestId, ok: true, uids }       // manual/structure batches
{ type: 'three-workbench:mutation', requestId, ok: true, uids, locals, beforeLocals, pinPatches } // reparent
{ type: 'three-workbench:mutation', requestId, ok: true, locals }     // structure/local query
{ type: 'three-workbench:mutation', requestId, ok: false, error, uid?, message? }
```

Common errors: `invalid`, `stale-uid`, `locked`, `apply-failed`, `no-pin`,
`manual-limit`, `reparent-cycle`, `manual-invalid`, `source.error` values from
the runtime target resolver. `message` is present only for `apply-failed`.
`mutate` itself acks success with no `uid`/`uids`; the caller already knows the
targets.

Overloaded variants:

#### `params`

Runtime `params` schema reply (`client.js:6552-6576`):

```js
{
  type: 'three-workbench:params', action: 'schema', revision,
  ok: boolean, declared: boolean, schema: Param[], values: object,
  issues: Issue[], applyError: {message}|null, requestId?
}
```

An invalid declaration uses `ok:false, declared:true, error:'invalid-schema'`
and no schema. A duplicate valid `wb.expose` adds
`{duplicate:true, error:'duplicate-expose', duplicateCount}` to the schema
message and leaves the first declaration authoritative
(`client.js:6653-6660`).

`set`/`reset` acks (`client.js:6577-6634`):

```js
{ type:'three-workbench:mutation', requestId, command:'params', action, ok:true,
  values: object }
{ type:'three-workbench:mutation', requestId, command:'params', action, ok:false,
  error, key? }
```

`reset` with no `keys` resets all declared values; `set` with no `values`
uses `{}`. Errors include `invalid-schema`, `invalid`, `apply-failed` and
per-value validation errors; `apply-failed.message` is capped at 300
characters. **A successful `live:true` set/reset sends no ack**; failures do
(`client.js:6626-6633`). The final non-live commit is the only ack the panel
uses for persistence.

#### `tracks`

Only `replace-all` is acknowledged (`client.js:8645-8725`):

```js
{ type:'three-workbench:mutation', requestId, command:'tracks',
  action:'replace-all', ok:true, trackCount, keyCount, unresolved }
{ type:'three-workbench:mutation', requestId, command:'tracks',
  action:'replace-all', ok:false, error, uid?, message? }
```

`tracks`/`config` is fire-and-forget. `replace-all` requires
`tracksVersion:1`, validates atomically, and with `reason:'edit'` rejects a
change to a locked UID as `{ok:false,error:'locked',uid}`. Failure codes are
`tracks-version`, `tracks-invalid`, `apply-failed`, and the strict set
(`key-limit`, `track-limit`, `tracks-version`). The ack is sent before
reasserting pins and evaluating the new tracks.

#### `key-values`

`query`/`key-values` success (`client.js:9225-9270`):

```js
{ type:'three-workbench:mutation', requestId, ok:true, action:'key-values',
  time, values: { [path]: value }, unavailable: string[] }
```

The command pauses playback, snaps `time` to the supplied `snapFps` (or the
track step FPS), clamps it to the duration, applies pins/tracks, and reads at
most 64 paths. Errors are `stale-uid`, `locked`, `invalid`. `values` is keyed
by the canonical path; unsupported paths appear in `unavailable`.

#### `renderer`

`client.js:8299-8325`:

```js
{ type:'three-workbench:mutation', requestId, command:'renderer', ok:true,
  live: boolean, renderer: RendererDescriptor }
{ type:'three-workbench:mutation', requestId, command:'renderer', ok:false,
  error:'invalid'|'apply-failed', message? }
```

`live` mirrors the request's `live === true`. The descriptor is the same shape
used under `scene-tree.renderer` (without the `script*` baseline fields).

### 4.4 `selection`

```js
{ type:'three-workbench:selection', uid: string|null, uids: string[], primary: string|null }
```

Sent after every deliberate selection change (`client.js:9676-9688`). It has no
`requestId`; it is both the ack to `select` and an unsolicited notification.
`uid` duplicates `primary` for old readers.

### 4.5 `timeline`

```js
{ type:'three-workbench:timeline', playing, time, speed, loop, duration }
```

`time` and `duration` are rounded to six decimals; `speed` is not rounded
(`client.js:9716-9728`). Sent at about 4 Hz during playback, on command, and
after a seek/step. It is suppressed while a capture session is active.

### 4.6 `stats`

```js
{ type:'three-workbench:stats', objects, triangles, fps, calls }
```

Emitted at 2 Hz, with `fps` rounded to one decimal (`client.js:10324-10343`).
Suppressed during capture sessions.

### 4.7 `camera`

```js
{
  type:'three-workbench:camera', position: number[3], target: number[3], fov: number,
  interactive: boolean, source: 'init'|'change'|'orbit'|'reset'|'programmatic'|'view',
  hasPin: boolean
}
```

`client.js:9871-9887`. Orbit reports are throttled to one per 200 ms; a
force-report is sent on init, reset, programmatic camera command and the end of
an orbit gesture. Suppressed during capture.

### 4.8 `transform-live` and `gizmo-commit`

`transform-live` is a throttled drag preview, at most once per 80 ms:

```js
{ type:'three-workbench:transform-live', uid, position: number[3],
  rotation: number[3], scale: number[3] }
```

`client.js:9416-9420`, `client.js:9485-9492`. `rotation` here is Euler radians.

`gizmo-commit` (`client.js:9493-9524`):

```js
{
  type:'three-workbench:gizmo-commit', uid,
  position?: number[3], rotation?: number[3], scale?: number[3], // changed channels only
  exactPosition: number[3], exactRotation: number[4],              // quaternion, unrounded
  exactScale: number[3], rotationOrder, time
}
```

A click that did not change the object sends
`{type:'three-workbench:gizmo-commit', uid, cancelled:true}`. The cancellation
routine also sends exactly one cancelled commit (`client.js:10053-10088`). The
`exact*` fields are the only values suitable for keyframe insertion; the scene
tree and live message are rounded for display.

### 4.9 `pick`

```js
{
  type:'three-workbench:pick', uid, uids, primary,
  object: {
    name, type, position: number[3],
    material: { type, color, roughness, metalness }|null
  }
}
```

Sent only when pick mode is enabled (`client.js:9970-9986`). `position` is the
world position rounded for display.

### 4.10 `shortcut`

```js
{ type:'three-workbench:shortcut', key, mode? }
```

Keys emitted by the runtime keyboard handler (`client.js:10225-10248`):
`undo`, `redo`, `palette`, `gizmo` (with `mode` `translate|rotate|scale|off`),
`focus`, `delete`, `escape`, `play`. The handler ignores events whose target
is an input, textarea, select or contenteditable element.

### 4.11 `error`

```js
{ type:'three-workbench:error', message }
{ type:'three-workbench:error', message, command?, code?, max?, count? }
```

`client.js:6483-6509`. The plain form covers thrown script errors and
unhandled rejections. Structured details are added only by callers that pass
them; the animated-glTF refusal uses
`{command:'export-gltf', code:'animated-frame-cap', max:7200, count}`.
Identical plain error text is deduplicated for 1000 ms; a structured error
bypasses the dedupe. The error box is always updated with the newest stack,
even when the parent message is suppressed.

### 4.12 `console`

```js
{ type:'three-workbench:console', entries: { level, text, at }[] }
```

`client.js:7211-7242`. The runtime batches at most 20 entries per message,
flushes a partial batch within 200 ms, and keeps at most 1,000 queued entries.
The parent keeps the newest 200 entries and never persists them. `at` is a
`Date.now()` millisecond timestamp.

### 4.13 `asset-state` and `asset-error`

```js
{ type:'three-workbench:asset-state', assetId, name, kind, state: 'loading'|'loaded'|'failed' }
{ type:'three-workbench:asset-error', error: { code, message }, assetId?, name? }
```

`client.js:6727-6742`, `client.js:7003-7021`. Error codes include
`asset-load-failed` and `asset-deleted`. These are asynchronous and carry no
request id.

### 4.14 Asset status and manifest ack (`assets`)

```js
{ type:'three-workbench:assets', action:'ack', requestId, revision, accepted: boolean }
{ type:'three-workbench:assets', action:'status', requestId, revision,
  generation, pending: string[], pendingNames: (string|null)[] }
```

`client.js:11304-11348`. The manifest ack means "the runtime applied or
rejected this manifest revision", not "all loads finished". `accepted` is
false for a non-object payload, a non-finite revision, a revision not greater
than the current one, or a non-array `assets`. Invalid individual rows are
skipped. A successful manifest increments the runtime generation. `status`
reports the current revision, generation, and the ids/names of pending loads.

### 4.15 Capture: `capture`, `capture-session`, `frame`, `frame-error`

Single-frame snapshot command `capture` (`client.js:11597-11638`) has no
request id. Its reply is:

```js
{ type:'three-workbench:capture', purpose:'download'|'thumbnail', dataUrl }
```

A download capture renders at the fixed export size; a thumbnail capture uses
the live drawing buffer. Both force the track pose at the current playhead,
hide helpers, and restore them. A thrown snapshot posts `error`, not a capture
reply.

Deterministic export session messages:

```js
{ type:'three-workbench:frame', requestId, index, width, height, pixels: ArrayBuffer }
{ type:'three-workbench:frame-error', requestId, index, message }
{ type:'three-workbench:capture-session', requestId, ended:true, cancelled:boolean }
```

`client.js:10396-10586`, `client.js:10468-10477`. Frame pixels are RGBA,
top-left row order, transferred rather than copied. The parent validates that
`pixels` is an `ArrayBuffer` of exactly `width * height * 4` bytes and discards
any frame whose id or index does not match the awaited job
(`client.js:17366-17393`). Frame errors use the codes `invalid-request`,
`recording-active`, `invalid-frame`, `capture-busy`, `unexpected-index`,
`dimension-mismatch`, or a thrown message. **A frame error does not end the
session**; the parent must send `capture-end` or `capture-cancel`, which is
idempotent, restores the canvas/timeline/helpers, and acks `capture-session`.
There is one capture session at a time per runtime, owned by the first
request id. `capture-end`/`capture-cancel` with a different or absent id still
restore the current session but echo the supplied id (or `''`).

Capture frame caps: index `0..3600` inclusive, `fps` 1..60, width/height
positive integers with `width * height <= 1920 * 1080`, time finite and
non-negative, fixed dimensions for the session, sequential indices
(`client.js:6410-6412`, `client.js:10499-10586`). Timeline and stats messages
are suppressed for the session's duration.

### 4.16 Export payloads

```js
{ type:'three-workbench:glb', buffer: ArrayBuffer }
{ type:'three-workbench:stl', buffer: ArrayBuffer }
{ type:'three-workbench:obj', text: string }
{ type:'three-workbench:recording', started:true }
{ type:'three-workbench:webm', blob: Blob, mimeType: string }
```

`client.js:11640-11767`. glTF/STL/OBJ are spontaneous replies to the matching
command and carry no request id. The animated-glTF frame-cap refusal is an
`error` message, not a `glb`. `record` sends `recording` when capture starts and
`webm` when `MediaRecorder` stops; the recorder duration is
`max(1000, durationMs || 5000)` ms. Recording is refused with a plain `error`
while a deterministic capture session is active, and a browser without a
secure context reports the translated MediaRecorder failure.

## 5. Parent → runtime commands

Every command is sent only when a frame `contentWindow` exists. The table lists
the acknowledgement (if any) and the correlation semantics. `none` means the
runtime deliberately sends no ack; `spontaneous` means a related message may be
sent without correlation. `used` means the runtime echoes a supplied
`requestId` and the parent may wait on it; it is optional unless the row says
`required in payload`. The startup commands in section 3 intentionally omit
request ids.

| Command | Key fields | Ack / reply | Request id |
|---|---|---|---|
| `resolution` | `aspect`, `scale` | none | ignored |
| `play` / `pause` | none | `timeline` | ignored |
| `timeline` | `action` is one of `play`, `pause`, `seek`, `set-speed`, `set-loop`, `set-duration`, `step`, plus `time`/`speed`/`loop`/`duration`/`fps`/`direction` | `timeline` | ignored |
| `params` | `action` is one of `schema`, `set`, `reset`, plus `values?`, `keys?`, `live?` | `params` schema or `mutation` `command:'params'` | used, except live-success no ack |
| `scene-tree` | none | `scene-tree` | used |
| `select` | `uid` or `uids`+`primary` | `selection`; stale single id also gets a mutation error | used for error only |
| `locks` | `uids` | none | ignored |
| `lock` | `uid`, `locked` | `mutation` | used |
| `select-mode` | `enabled` | none | ignored |
| `gizmo` | `mode` is one of `translate`, `rotate`, `scale`, `off`, plus `space`, `snap` | none | ignored |
| `focus` | `uid` | none on success; mutation error on stale | used for error only |
| `renderer` | `renderer?`, `reset?`, `live?` | `mutation` `command:'renderer'` | used |
| `camera-reset` | none | `camera` with `source:'reset'` | ignored |
| `camera` | `position?`, `target?`, `fov?`, `reset?`/`resetFov?` | `camera` with `source` set to `programmatic` or `reset` | ignored |
| `view` | `preset` is one of `perspective`, `front`, `back`, `left`, `right`, `top`, `bottom` | `camera` with `source:'view'`; `error` on an unknown preset | ignored |
| `shading` | `mode` is one of `rendered`, `wireframe`, `normals` | none | ignored |
| `grid` | `enabled` | none | ignored |
| `explode` | `amount` clamped to `0..2`; `0` restores saved positions | none | ignored |
| `manual` | `ops` | `mutation` with `uids` | used |
| `structure` | `query:'locals'` + `uids`, or one `kind:'reparent'` op, or `ops` | `mutation` with `locals`/`uids`/patches | used |
| `mutate` | `ops`, `transient?` | `mutation` | used |
| `fragment` | `uid`, `fragment`, `reset?`, `replace?` | `mutation` with `uid` | used |
| `fragments` | `ops` | `mutation` with `uids` | used |
| `unpin` | `uid` | `mutation` with `uid` | used |
| `tracks` | `action:'config'` or `'replace-all'`, `tracksVersion`, `tracks`, `reason`, `autoKey`, `stepFps` | config none; replace-all `mutation` `command:'tracks'` | used for replace-all |
| `key-preview` | `ops` (max 500) | none | ignored |
| `query` | `action:'key-values'`, `uid`, `paths`, `snapFps?` | `mutation` `action:'key-values'` | used |
| `pick` | `enabled` | none (later `pick` messages) | ignored |
| `assets` | `action:'manifest'`, `revision`, `assets` | `assets` `action:'ack'` | used |
| `assets-status` | none | `assets` `action:'status'` | used |
| `environment` | `value` (or absent/null to clear) | `mutation` | used |
| `capture` | `purpose` set to `download` or `thumbnail` | `capture` with the same `requestId` | echoed in the reply; used to route shot thumbnails |
| `capture-frame` | `requestId`, `index`, `time`, `fps`, `width`, `height` | `frame` or `frame-error` | required in payload |
| `capture-end` / `capture-cancel` | `requestId?` | `capture-session` | optional; echoed, absent becomes `''` |
| `export-gltf` | `animated?`, `fps?`, `duration?` | `glb` or `error` | ignored |
| `export-stl` | none | `stl` or `error` | ignored |
| `export-obj` | none | `obj` or `error` | ignored |
| `record` | `durationMs?` | `recording`, then `webm` or `error` | ignored |

Command details that are easy to get wrong:

- `play` and `pause` are simple aliases that set `playing` and send `timeline`
  (`client.js:11363-11364`). The current parent drives playback through the
  `timeline` command's `play`/`pause` actions, but both command names remain
  accepted.
- `timeline` actions are independent, not an enum error. Unknown actions still
  cause a timeline report. `seek` pauses and clamps to `[0,duration]`;
  `set-speed` clamps to 0.1..4; `set-duration` clamps to 0..86400 and ignores
  non-finite values; `step` pauses and moves one frame, with the upper bound
  `duration` when positive and **`Infinity` when duration is 0**
  (`client.js:11371-11391`). That asymmetry is intentional current behavior.
- `params` accepts only `schema`, `set`, `reset`; an invalid action returns
  `{ok:false,error:'invalid'}`. A live success is silent; a live failure is
  always acked. Schema results carry `revision` from the embedded scene.
- `select` with an array filters unknown ids through `normalizeSelection` and
  always emits `selection`, with no mutation ack. A single stale id sends
  `{ok:false,error:'stale-uid'}` and then clears selection, which emits a
  second `selection` message. A single valid id emits only `selection`.
- `gizmo` normalizes an unknown mode to `off`, a non-`local` space to `world`,
  and `snap` to strict `true`. `select-mode` and `pick` also require strict
  `true`; other truthy values do not enable them.
- `focus` on a null/absent uid frames the whole scene. It sends no success ack;
  only a stale target produces a mutation error.
- `camera-reset` does nothing when there is no script camera. `camera` reset
  flags restore only the named channels after dropping those pins; the reply
  is always `camera`.
- `mutate` accepts op kinds `transform`, `visibility`, `material`, `light` and
  validates the entire array before applying. `transient:true` is a preview
  path used for live edits.
- `structure` with one reparent op is atomic and returns unrounded
  `locals`/`beforeLocals`/`pinPatches` plus `uids: [uid]`.
- `tracks`/`config` accepts `autoKey` (strict `true`) and a finite
  `stepFps` in 1..120; values outside the range leave the old value.
  `replace-all` is strict and all-or-nothing.
- `key-preview` is transient and never persisted or exported. There is no ack.
- `environment` with `value` absent or `undefined` clears the pin, equivalent
  to null.
- `capture-frame` is not the `capture` snapshot command. It belongs to a
  deterministic export session and requires a session request id in the
  payload; the parent's command helper also adds one, but the runtime uses the
  payload value.
- `export-gltf` with `animated:true` samples only enabled
  `position`/`rotation`/`scale` tracks bound to live, scene-reachable,
  non-deleted UIDs. A plan above 7,200 frames is refused with the structured
  error above; it is never truncated. Sampling fps is clamped by the clip
  builder; the UI limits fps to 1..120.
- `record` does not run while a capture session is active. The runtime posts a
  plain `error` and leaves recording off.

## 6. Overlay history marker (P4)

The narrow-screen overlay is parent-page DOM, not a second iframe. Its marker
is a same-document History entry with exactly two plugin keys
(`client.js:22751-22755`, `client.js:22816-23032`):

```js
{
  __threeWorkbenchOverlay: true,
  __threeWorkbenchOverlayGeneration: <integer>
}
```

- `OVERLAY_BREAKPOINT = 776`, `TABLET_BAND_MAX = 1024`,
  `MARKER_SETTLE_TIMEOUT_MS = 1000`. The marker keys are exactly
  `'__threeWorkbenchOverlay'` and `'__threeWorkbenchOverlayGeneration'`.
- The marker is pushed with `history.pushState(state, '')`: no URL argument,
  so the URL and document do not change. It is not a router route.
- `generation` is the overlay-open generation, an integer. One marker is
  active per overlay lifetime. If the current projection already matches the
  generation, `pushMarker` records the existing marker instead of pushing a
  duplicate. If a close settlement is pending, `ensureMarker` defers the push
  until settlement.
- `previousMarkerState` is a structured clone of the pre-marker history state
  with both plugin keys deleted. It is the expected Back target.
- On overlay close, the effect cleanup removes the Back listener, calls
  `history.back()` once, and registers a pending marker pair. If the Back
  cannot be issued (no history object or a throw), no pair is registered.
- Settlement listens for `popstate` and also arms a 1000 ms fallback. A pending
  generation settles when the current projection matches the previous
  marker-free projection, or when the current projection carries a different
  marker generation. On settlement the pair is removed; a deferred marker may
  then be pushed once if the overlay is still active.
- The Back listener closes the overlay only when all of these hold: no pending
  close traversal; the `popstate` event was not generated by the plugin's own
  marker machinery; and the current projection exactly matches the captured
  marker-free previous projection. It then removes itself and calls the close
  callback.
- A consumed marker entry is reconciled with `replaceState` when possible, or
  at most one bounded `back()`; this prevents a stale marker from trapping the
  next Back.
- The marker carries no scene, token, Session, share, asset or capability
  data. `markerFreeState` clones arbitrary host state and removes only the two
  plugin keys, so unrelated host fields survive.
- History may be unavailable or `pushState` may throw. The overlay still
  renders; the Back marker is best-effort and its absence does not change the
  overlay's close button behavior.
- Presentation DOM: `data-three-workbench-presentation="overlay"`,
  `data-three-workbench-overlay=""`, fixed inset 0, z-index 18, isolation,
  `overflow:hidden`, `role="dialog"`, `aria-modal="true"`
  (`client.js:23179-23190`). The overlay closes only after an active export
  job is not blocking Escape; recording alone does not block it.

Safe-area behavior is CSS-only: the overlay uses `100vh` then `100dvh`, and
`env(safe-area-inset-*)` with `max()` fallbacks (`client.js:24066-24076`). The
preview Host viewport meta is `width=device-width,initial-scale=1` without
`viewport-fit=cover` (`client.js:6336`, `index.js:7432`). The current
Linux/WPE WebKit test host reports zero insets even with `viewport-fit=cover`;
nonzero safe-area behavior is therefore not verified here, and no iOS
safe-area result is claimed. This is a platform-coverage gap, not a
demonstration that the CSS is wrong.

## 7. Stable identity and object resolution

- `s:` UIDs are runtime-generated for script objects and cached on the object
  (`uidFor`, `client.js:7270`; the `newUid('s')` loop is at
  `client.js:2847`). A script UID remains stable for the life of that object.
  It is not derived from the display name, index or path.
- Manual objects use parent-generated `m:<uuid>` UIDs and an
  `origin:'manual'` manifest (`client.js:20210`, `client.js:20516`). A manual
  manifest is written once and is not replaced by a script `s:` UID.
- `wb.id(object, name)` sets `object.userData.wbId` to the trimmed name and
  returns the object (`client.js:7174-7184`). Writing `userData.wbId` directly
  is equivalent. IDs should be unique within a scene.
- Resolution prefers the script `wbId`; then a unique named path plus type;
  then a unique bound parent UID plus ordinal path plus type. Legacy v1 path
  anchors bind only on exactly one live match. Duplicates and missing matches
  remain unresolved rather than guessed. `scene-tree.nodes[].key`/`anchor`,
  `namedPath`, `ordinalPath`, `wbId`, `parentUid` and `uid` expose the inputs
  to this rule; only `uid` is identity.
- `scene-tree.unresolved` lists overrides that did not resolve;
  `scene-tree.deleted` lists current tombstones. Deleted script objects are
  absent from exports; deletes are undo-only and not a separate list.
- Aliases are display-only and need not be unique. Exports may therefore
  contain duplicate node names. UIDs remain the identity.

## 8. Keyframes, tracks and caps

Canonical track set (`client.js:3683-3699`):

```js
{
  v: 1,
  items: [
    { uid, path, enabled: boolean, keys: [ { t, v, e } ] }
  ]
}
```

`t` is seconds, `v` is the path-specific value, and `e` is one of `linear`,
`step`, `easeIn`, `easeOut`, `easeInOut`. The caps are 200 tracks, 1,000 keys
per track, 10,000 keys per session, path length 120, UID length 200, and time
0..86400 seconds. Track times are rounded to six decimals. Duplicate times keep
the last key. Keys are sorted by time. Unknown `tracks.v` fails closed.

Canonical paths (`client.js:3725-3778`):

| Path | Value |
|---|---|
| `position` | 3 numbers |
| `rotation` | 4 numbers, xyzw quaternion; normalized |
| `scale` | 3 numbers |
| `visible` | boolean, step-only |
| `material.<slot>.<channel>` | slot 0..15; see below |
| `light.<channel>` | `intensity`, `distance`, `decay`, `angle`, `penumbra`, `color` |

Material channels: `color`/`emissive` are `#rrggbb`; `emissiveIntensity` is
0..20; `roughness`, `metalness`, `opacity`, `alphaTest` are 0..1;
`transparent`, `wireframe`, `flatShading` are booleans and step-only; `side` is
`front|back|double` and step-only; texture slots are `map`, `normalMap`,
`roughnessMap`, `metalnessMap`, `emissiveMap`, `alphaMap`, `aoMap`, each a
22-character asset id or null and step-only. Light `intensity`, `distance` and
`decay` are 0..1,000,000; `angle` is 0..π; `penumbra` is 0..1; `color` is
`#rrggbb`.

Numbers must be finite and `|v| <= 1,000,000`, then clamp to the channel range.
Vectors are rounded to six decimals; quaternions are rounded and normalized;
colors are stored lowercase. A step-only path always stores `e:'step'`.

Normalization has two modes. The parent store normalization is non-strict and
drops malformed members with issue codes `track-invalid`, `track-uid`,
`track-path`, `duplicate-track`, `track-key`, `duplicate-key`,
`value-clamped`, `empty-track`, `key-limit`, `track-limit`, `tracks-version`.
The runtime `replace-all` path is strict and atomic with error codes
`key-limit`, `track-limit`, `tracks-version`, `tracks-invalid`.
`replace-all` with `reason:'edit'` additionally checks locked UIDs. Every
gesture is one atomic record write and one replace-all.

Evaluation order each frame is script `onFrame` → static pins → tracks →
transient key preview → deletion guard → OrbitControls → render. A keyed path
owns only that path; muting/deleting releases it to the pin, then the script
baseline. Tracks evaluate while paused and compare before writing. A track is
bound only if its UID is live; unresolved tracks remain in the set and are
reported.

## 9. Assets, parameters and the script API

### 9.1 Name-only asset API

The runtime installs the API before the scene script runs
(`client.js:6991-7153`):

```js
assets.url(name)                       // string|null
assets.texture(name, options?)         // THREE.Texture|null
assets.model(name, onLoad?, onError?)  // THREE.Group|null, holder.ready Promise
assets.hdri(name, onLoad?, onError?)   // THREE.Texture|null
```

`assets.texture` accepts `{srgb, wrap, repeat}`. `srgb:false` selects
`NoColorSpace`; the default is `SRGBColorSpace`. `wrap` must be one of the
three Three.js wrap constants. `repeat` is two finite numbers. Missing names
and wrong-kind requests return `null`. The model helper returns an empty group
whose `ready` promise settles after load; the caller must add the holder to the
scene. Loads are asynchronous and may post `asset-state` / `asset-error`.
Deleted or superseded assets discard late results with `asset-deleted`.

Manifest rows are accepted only with a 22-character `id`, non-empty name up to
256 characters, kind `image|model|hdr`, MIME, and a URL that contains no control
characters and does not start with `javascript:`, `vbscript:`, `blob:` or
`file:` (`client.js:6675-6720`). The runtime accepts a strictly increasing
manifest revision and increments its generation. A same or older revision is
not accepted.

Host limits (`index.js:76-95`): image/GLTF 8 MiB, GLB 32 MiB, HDR 16 MiB,
upload body 32 MiB, embedded GLTF 32 MiB; 24 assets / 48 MiB per Session and
128 assets / 256 MiB globally; name 128 code points; uploads 10/min per Session
(3 concurrent) and 60/min globally; list/delete 60/min per Session. Content
routes use an unguessable 22-character capability id and never contain a
Session id or token. They are GET/HEAD only, return 404 for unknown ids, and
serve `nosniff` plus `content-security-policy: default-src 'none'; sandbox`.
Upload/delete are same-origin JSON/binary endpoints authenticated by the
`x-workbench-session` header (`index.js:5518-5544`, `index.js:6629-6676`).

### 9.2 `wb.expose` and parameters

`wb.expose(schema, apply)` is declared once by the script. The first valid
declaration wins; later valid calls are ignored and counted in
`duplicateCount`. Validation is all-or-nothing: an invalid schema or missing
apply function never calls the callback and keeps the rest of the script
running. Limits: 1..50 parameters, key regex
`[A-Za-z][A-Za-z0-9_]{0,63}`, forbidden keys `__proto__`, `constructor`,
`prototype`, labels trimmed to 80 characters, select 1..100 unique string
options of at most 128 characters, text `maxLength` 1..1024 (default 256).
Number values clamp/snap; colors are exactly `#rrggbb` and stored lowercase.

`apply` receives a fresh frozen object on the initial run and after each
accepted change. It runs after the script body but before UID resolution and
override replay. A throwing initial apply shows `applyError` while retaining
the previous values; a throwing live apply reverts the draft and keeps the last
good values. Accepted values are stored under `params:{v:1,values:...}` in the
per-session v2 editor record; the schema is never stored. Missing/corrupt
values are normalized with the rest of the record. Parameter edits are not undo
entries.

## 10. HTTP routes and share behavior

The Host registers under `/three-workbench` (`index.js:5504-5562`):

| Route | Methods | Purpose |
|---|---|---|
| `/state/<scene-id>` | GET/HEAD resource | latest metadata and revision list; `{missing:true,...}` when absent |
| `/scene/<scene-id>?rev=N` | GET/HEAD resource | full revision record; 404 `not-found`/`revision-not-found` |
| `/thumbnail/<scene-id>/<rev>` | GET/HEAD resource | PNG thumbnail; 404 text otherwise |
| `/runtime/<file.js>` | GET/HEAD resource | vendored runtime, `access-control-allow-origin: *`, safe path only |
| `/assets` | GET/HEAD resource | Session asset list, requires `x-workbench-session`; 404 unknown, 429 rate |
| `/assets/<asset-id>` | GET/HEAD resource | capability content; no Session header required |
| `/assets/upload` | POST handler | raw binary upload with `x-workbench-name`, Session header, strict sniffing/limits |
| `/assets/delete` | POST handler | JSON delete, Session header |
| `/scene/restore` | POST handler | append a restored revision |
| `/share/create` | POST handler | create a frozen share |
| `/share/delete` | POST handler | revoke with `{id,deleteKey}` |
| `/share/<id>`, `/share/<id>/metadata`, `/share/<id>/document` | GET/HEAD resource | constant shell, metadata attachment, document attachment |

### 10.1 Restore

`POST /three-workbench/scene/restore` (`index.js:8668-8900`) accepts exactly:

```js
{ sourceRevision, sourceUpdatedAt, expectedRevision, expectedUpdatedAt, requestId }
```

The body is capped at 4096 bytes, with a 2 s idle and 5 s total read timeout.
Rate/concurrency: 6/min per Session and 30/min global, 1 concurrent per Session
and 2 global; an 8-entry, 10-minute idempotency cache per Session; request id
22 characters. The Host validates the Host allowlist, Origin/Sec-Fetch-Site,
content type/encoding and Session, then applies rate/concurrency limits, then
checks source and head identity. Status codes: 400 `bad-host`/`fields`, 403 `origin`, 404
`session`/`source-revision`, 405 `method`, 408 `timeout`, 409
`conflict`/`source-latest`/`idempotency-conflict`/`too-large`, 413 `too-large`,
415 `content-type`/`encoding`, 429 `rate` with `retry-after`, 500 `internal`.
Success returns only `{ok, revision, sourceRevision, updatedAt}` and appends one
revision under the shared 12-revision trim. Failures append and cache nothing.

### 10.2 Share create, viewer and retention

`POST /three-workbench/share/create` (`index.js:8904-9177`) accepts exactly
`{revision, editorState, stepFps, ttlSeconds, document}`. `editorState` must be
v2 with object maps for `objects`, `tracks` and `params`; optional `camera` must
be an object. `document` must start with `<!doctype html>`. Limits: body
40 MiB, document 26 MiB, state 2 MiB, title 200 code points, metadata 4096
bytes, JSON depth 64, state nodes 200,000, step FPS 1..120. TTL is clamped to
3600..2,592,000 seconds and defaults to 604,800. Quotas: 30 MiB per share,
8 shares / 64 MiB per Session, 32 shares / 128 MiB global. Create is
same-origin, requires a live Session header, and returns
`{ok, id, path, revision, createdAt, expiresAt, deleteKey}`.

The document is a frozen snapshot: the client embeds all Session assets as
`data:` URIs under fresh 22-character ids and never uses the original
capability URLs. Delete and expiry therefore do not break a share; holders can
see unreferenced Session assets. Local drafts and history revisions are never
included. The delete key is returned once and kept only in the creating
browser's bounded 20-entry registry. Revocation posts `{id,deleteKey}`; an
unknown, expired or wrong-key id returns 404. The viewer has no controls, no
token and no Session id: it auto-plays/loops the timeline, applies the frozen
editor state, and supports OrbitControls only. Shell, metadata and document
responses are `no-store`/`nosniff`, have no ACAO, and use
`referrer-policy: no-referrer`, `cross-origin-resource-policy: same-origin`,
and a constant CSP. The shell iframe is exactly the sandbox triple with
`referrerpolicy="no-referrer"`; the document is a `text/plain` attachment with
`content-security-policy: default-src 'none'; sandbox`. Unknown/expired ids
return the same constant 404 body and headers for shell, metadata and document.

## 11. Persistence model (P3-3)

- On Linux, the Host persists scenes, thumbnails, assets and shares under the
  data root. The default root is `DSH_HOME/three-workbench`, or
  `~/.dsh/three-workbench` when `DSH_HOME` is unset; an explicit
  `THREE_WORKBENCH_DATA_DIR` wins (`index.js:1442-1481`). Directories are
  `tmp`, `trash`, `quarantine`, `scenes`, `thumbnails`, `assets`, `shares`
  (`index.js:407`).
- On non-Linux platforms the Host reports `{mode:'memory',status:'disk-unsupported'}`
  and keeps data in memory. A test runner without an isolated root reports
  `test-memory`; a NUL/root error reports degraded `invalid-root`. These are
  availability modes, not data-success claims.
- Scenes: at most 16 Session scene entries, 12 revisions per Session, 240
  global thumbnails (12 per Session), 256 KiB of code. Revisions are trimmed by
  the product cap; a committed revision's title/code/bytes/timestamp survive a
  restart on Linux. Restore appends a normal revision; restore idempotency
  entries and rate/bookkeeping state are memory-only. A lost restore response
  may have committed, so the "did not execute" copy is not guaranteed in that
  crash window; the latest revision is the recovery check.
- Assets: committed assets are persisted per Session on Linux. They survive a
  restart; clearing the Scene Session or evicting it by the 16-session limit
  deletes them. Bytes never enter localStorage, scene code or v2 overrides;
  exports are snapshots. An asset-only Session (committed assets with no
  acknowledged scene) is preserved across restarts, survives scene-directory
  removal, and can be listed, served and deleted without a scene. A later
  committed scene adopts the asset-owner epoch instead of revoking those
  assets. A Session whose scene data is truncated/unscanned is preserved, is
  not counted in the 16-session LRU, and refuses scene appends until the store
  is reduced; its assets remain available.
- Shares are persisted on Linux until TTL expiry or delete-key revocation;
  restarting the Host retains old links. The delete key remains browser-side.
  Share cleanup is expiry/revocation, not a restart.
- Startup bounds (`index.js:186-215`): 5,000 ms startup deadline, 2 GiB root
  budget, 1.5 GiB load budget, 128 MiB staging budget, plus bounded scan
  counters (65,536 entries, 256 scene dirs, 256 entries per scene dir, 32 files
  read, 64 asset sessions, 4,096 asset dirs, 256 share dirs, 4,096 thumbnail
  entries, 4,096 trash entries, 32 quarantine entries). A valid store that
  exceeds a budget degrades and preserves data; some records or shares may be
  unavailable until the store is reduced or an operator intervenes. No
  acknowledged record is deleted by degradation.
- History availability is startup-bounded: routes await storage readiness.
  A store that becomes ready after the deadline still does not serve the
  over-budget portion; callers must treat `missing`/404 as possible even for
  previously seen data during degradation. There is no unlimited retry or
  repair path in the browser protocol.
- `disk-unsupported` means memory fallback, not durability. Do not infer
  persistence from a successful memory-mode write.

## 12. Guarantees vs current intentional behavior

Guarantees (relied on by the parent and tests):

- The sandbox triple never includes `allow-same-origin`; the preview and share
  documents are `srcDoc`/`srcdoc`, never navigable HTML responses.
- The parent ignores messages whose `source` is not the current frame window.
- A correlated ack carries the exact supplied `requestId`.
- Track replacement is atomic; strict failures change no track state.
- Capture sessions restore the saved canvas, pixel ratio, aspect, playhead,
  playing state and helper visibility on end/cancel, including repeated ends.
- Share viewer responses use a constant CSP and constant unavailable body with
  no Session id, token or ACAO.
- The overlay marker keys contain no scene/token/Session data and do not
  change the URL.

Current, intentional limitations and asymmetries (not guarantees to preserve
blindly when extending):

- `select` stale-id behavior differs by shape: a single stale uid gets a
  mutation error and clears selection; an array is silently filtered and
  normalized, with no mutation ack in either success case.
- `params` live success is fire-and-forget; failures are acked. `focus` success
  is silent. `tracks`/`config`, `key-preview`, `locks`, `select-mode`, `gizmo`,
  `resolution`, `pick`, `timeline`, `camera`, `camera-reset`, `capture` and all
  exports use no request correlation.
- Timeline `step` has an infinite upper bound when duration is 0; `set-speed`
  clamps to 0.1..4; the runtime does not enforce a 120 fps step cap (the UI
  does).
- A capture frame error leaves the session active; it does not abort or restore
  by itself. The parent abandons out-of-order/unsolicited frames. A `capture`
  snapshot error posts a plain `error` and never a capture reply.
- The error channel deduplicates identical plain text for 1000 ms; structured
  export errors bypass that dedupe.
- `record` errors are plain `error` messages and are not correlated to a
  request; a recording and a deterministic capture cannot overlap.
- Unknown message types and unknown command names are silently ignored. There
  is no negative ack for an unrecognized command.
- Asset manifests are fire-and-forget apart from their ack; the ack means
  applied, not loaded. Pending loads are polled via `assets-status` at 150 ms
  intervals with a 5 s budget, and captures wait for idle.
- Asset upload/delete/list are same-origin with the Session header; content
  routes are capability-id, no-cookie, no-token URLs. The capability URL is a
  bearer secret in effect; do not print it.
- Share ids and asset ids are unguessable 22-character capability strings, but
  a share is view-only, has no server-side identity check beyond the id, and
  embeds every Session asset. Treat a share URL as a bearer link.
- Mobile runtime thresholds are fixed, not calibrated per device: mouse tap
  slop 4 px / 800 ms; touch tap slop 10 px / 500 ms; long press 500 ms; gizmo
  size 0.85 mouse vs 1.25 touch; transform-live throttle 80 ms. A second finger
  during a gizmo drag is ignored. Long press toggles selection only when the
  editor selection mode is enabled and pick mode is off; it consumes the
  gesture even on empty space.
- The overlay is full-viewport below 776 px and in the 776..1023 px no-dock
  condition (`width === 0`); a docked track in that band stays docked. There is
  no separate tablet layout or tablet-only feature set. The Back marker is
  best-effort and depends on History availability.
- Safe-area insets are CSS-driven; the current Linux/WPE WebKit host reports
  zero, and the Host viewport meta lacks `viewport-fit=cover`. No nonzero
  safe-area or iOS coverage is claimed.
- P4 audit status: FAIL, 0 BLOCKER / 1 MAJOR (IV-SAFE-AREA environment
  coverage) / 1 MINOR (two tautological probe assertions). Do not claim complete
  mobile coverage.

## 13. Extension checklist

When adding a message or command:

1. Decide whether it is correlated. If it needs an ack, require a
   `requestId` and echo it unchanged; add a bounded parent waiter rather than
   waiting forever.
2. Validate the message shape in the runtime before mutating. Prefer
   all-or-nothing validation, as `tracks/replace-all`, `mutate`, `fragments`,
   `manual` and `structure` do.
3. Preserve the sandbox and transport rules. Do not add `allow-same-origin`,
   do not add secrets to messages, and do not claim origin filtering.
4. Decide the success/failure ack asymmetry explicitly. If success is silent,
   document it; failures should still ack when the parent needs to stop a
   gesture.
5. Keep object identity in UIDs, never aliases/names/indices. If the command
   creates objects, use the `m:` manual manifest or runtime `s:` UID path.
6. Keep track and parameter caps centralized in the shared constants
   (`client.js:3683-3699`, `index.js:76-135`) rather than duplicating magic
   numbers.
7. Never add token, Session id, share id or capability URL to a history
   marker, telemetry, error text, README or PROTOCOL example.
8. Add a focused Node test or P5 E2E check for the new shape; the browser
   harness is documented in `README.md` and is not a substitute for runtime
   unit tests.
