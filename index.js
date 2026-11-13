/**
 * Host half of the Three.js workbench.
 *
 * Registers the `three_scene` tool (the model writes a complete, self-contained
 * animation script), keeps the latest scene per session, and serves the scene
 * record plus the vendored Three.js runtime over the Harness web server.
 *
 * The scene is never served as a navigable HTML document: the browser half
 * builds the preview document and mounts it through a sandboxed `srcDoc`
 * iframe, so model-written code only ever runs with an opaque origin.
 *
 * The tool's `presentationMeta` carries only `{ sceneId, revision, title }`, so
 * the browser half can find the scene through the durable `tool/result.meta`
 * record without a bespoke event channel.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIPv6 } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import {
  dirname, isAbsolute, join, relative as relativePath, resolve as resolvePath, sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNTIME_DIR = join(HERE, 'runtime')
const ROUTE_PATH = '/three-workbench'
const TOOL_NAME = 'three_scene'
const PROPOSAL_TOOL_NAME = 'workbench_proposal'
const PROPOSAL_KINDS = ['shots', 'pins', 'measure', 'explode', 'view', 'geometry', 'insert', 'recipe', 'link', 'scene']
const PROPOSAL_VIEW_PRESETS = ['perspective', 'front', 'back', 'left', 'right', 'top', 'bottom', 'plan']
const PROPOSAL_SHAPES = ['box', 'sphere', 'plane', 'cylinder', 'cone', 'torus']
const PROPOSAL_MAX_PARTS = 32
const PROPOSAL_MAX_RATIONALE = 1200

/**
 * Branding and first-paint cover for the kernel-owned boot interval.
 *
 * The Harness boot page and shell are created before any client plugin can
 * run, so the only seam ahead of them is the served index. Head rows rebrand
 * the kernel boot page and install the Studio title; a body cover paints the
 * same prism mark from the first frame and stays until the Studio overlay has
 * mounted. Warm reloads finish the plugin graph before first paint, which used
 * to expose the host shell for a frame; the cover makes that interval
 * Studio-branded instead. The event belongs to the web-server service, so the
 * rows stay plain data.
 */
const BOOT_SPLASH_MARKUP = '<div data-three-workbench-splash role="status" '
  + 'aria-label="Three Studio">'
  + '<div class="three-wb-splash-mark" aria-hidden="true">'
  + '<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
  + 'stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round">'
  + '<path d="M12 2.6 21.2 19.4H2.8Z"/>'
  + '<path d="M2.8 12.4h6.1l2.9-4 3 8 3.2-4h3.2"/></svg></div>'
  + '<div class="three-wb-splash-wordmark">THREE STUDIO</div>'
  + '<div class="three-wb-splash-sub">AI 3D WORKBENCH</div>'
  + '<div class="three-wb-splash-ring" aria-hidden="true"></div></div>'

/**
 * Remove the first-paint cover once Studio has mounted, or once the loader
 * reports a failure or a bounded wait expires. The cover must never trap a
 * page whose plugin failed to load.
 */
const BOOT_SPLASH_SCRIPT = `(function () {
  'use strict'
  var splash = document.querySelector('[data-three-workbench-splash]')
  if (splash === null) return
  var finished = false
  var timer = 0
  function done () {
    if (finished) return
    finished = true
    observer.disconnect()
    if (timer !== 0) clearTimeout(timer)
    splash.setAttribute('data-three-wb-splash-leaving', '')
    setTimeout(function () {
      if (splash.parentNode !== null) splash.parentNode.removeChild(splash)
    }, 200)
  }
  var observer = new MutationObserver(function () {
    if (document.querySelector('[data-three-workbench-studio="root"]') !== null) {
      done()
      return
    }
    var boot = document.querySelector('[data-dsh-boot]')
    if (boot !== null && /Failed to load plugins/i.test(boot.textContent || '')) done()
  })
  observer.observe(document.documentElement || document, { childList: true, subtree: true })
  if (document.querySelector('[data-three-workbench-studio="root"]') !== null) done()
  timer = setTimeout(done, 8000)
})()`

const BOOT_BRAND_ROWS = [
  {
    kind: 'html',
    placement: 'head',
    html: '<title>Three Studio</title>'
      + '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f4f5f8">'
      + '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b0e14">',
  },
  {
    kind: 'style',
    text: '[data-three-workbench-boot]{--three-wb-boot-accent:#2450d8;'
      + 'background-image:radial-gradient(circle at 50% 44%,rgb(36 80 216/.10),transparent 58%)}'
      + 'body[data-ds-dark-theme] [data-three-workbench-boot]{--three-wb-boot-accent:#4f7cff;'
      + 'background-image:radial-gradient(circle at 50% 44%,rgb(79 124 255/.12),transparent 58%)}'
      + '[data-three-workbench-boot] [data-three-workbench-boot-mark]{display:flex;align-items:center;'
      + 'justify-content:center;height:36px;color:var(--three-wb-boot-accent)}'
      + '[data-three-workbench-boot] [data-three-workbench-boot-mark] svg{display:block}'
      + '[data-three-workbench-boot] [data-dsh-boot-spinner]{'
      + 'border-color:color-mix(in srgb,var(--three-wb-boot-accent) 28%,transparent)}'
      + '[data-three-workbench-boot] [data-dsh-boot-spinner]::after{'
      + 'background:conic-gradient(var(--three-wb-boot-accent) var(--dsh-boot-arc,72deg),transparent 0)}'
      + '[data-three-workbench-boot]>div{gap:14px}'
      + '[data-three-workbench-boot]>div>div:not([data-dsh-boot-spinner])'
      + ':not([data-three-workbench-boot-mark]){letter-spacing:.14em}'
      + '[data-three-workbench-boot]>div>div:last-child{letter-spacing:0;font-size:12px;font-weight:400}'
      + '[data-three-workbench-splash]{position:fixed;inset:0;z-index:2147483647;'
      + 'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;'
      + 'background:#f4f5f8;color:#11151c;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;'
      + 'opacity:1;transition:opacity .18s ease}'
      + '[data-three-workbench-splash][data-three-wb-splash-leaving]{opacity:0;pointer-events:none}'
      + 'body[data-ds-dark-theme] [data-three-workbench-splash]{background:#0b0e14;color:#e6e9f0}'
      + '[data-three-workbench-splash] .three-wb-splash-mark{display:flex;align-items:center;'
      + 'justify-content:center;color:#2450d8;margin-bottom:2px}'
      + 'body[data-ds-dark-theme] [data-three-workbench-splash] .three-wb-splash-mark{color:#4f7cff}'
      + '[data-three-workbench-splash] .three-wb-splash-wordmark{font-size:15px;font-weight:700;'
      + 'letter-spacing:.16em;line-height:1}'
      + '[data-three-workbench-splash] .three-wb-splash-sub{font-size:8px;letter-spacing:.26em;'
      + 'color:#7d8796;line-height:1}'
      + '[data-three-workbench-splash] .three-wb-splash-ring{width:22px;height:22px;'
      + 'margin-top:10px;border-radius:50%;border:2px solid rgb(36 80 216/.18);'
      + 'border-top-color:#2450d8;animation:three-wb-splash-spin .85s linear infinite}'
      + 'body[data-ds-dark-theme] [data-three-workbench-splash] .three-wb-splash-ring{'
      + 'border-color:rgb(79 124 255/.2);border-top-color:#4f7cff}'
      + '@keyframes three-wb-splash-spin{to{transform:rotate(360deg)}}'
      + '@media (prefers-reduced-motion:reduce){'
      + '[data-three-workbench-splash] .three-wb-splash-ring{animation:none}}'
      + '@media (max-width:775px){[data-three-workbench-splash]{display:none!important}}',
  },
  {
    kind: 'script',
    placement: 'head',
    text: `(function () {
  'use strict'
  var WORDMARK = 'THREE STUDIO'
  var TITLE = 'Three Studio'
  var HINT = /^zh/i.test(navigator.language || '') ? '正在加载工作台…' : 'Loading workbench…'
  var MARK = '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M12 2.6 21.2 19.4H2.8Z"/><path d="M2.8 12.4h6.1l2.9-4 3 8 3.2-4h3.2"/></svg>'
  var ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#0b0e14"/><path d="M12 3.5 20 18.5H4Z" fill="none" stroke="#4f7cff" stroke-width="1.5" stroke-linejoin="round"/><path d="M4 12.2h5.2l2.6-3.6 2.7 7.2 2.8-3.6H20" fill="none" stroke="#4f7cff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>')
  var seen = false
  var iconAdded = false
  function paint () {
    if (document.title !== TITLE) document.title = TITLE
    var boot = document.querySelector('[data-dsh-boot]')
    if (boot === null) {
      if (seen) observer.disconnect()
      return
    }
    seen = true
    boot.setAttribute('data-three-workbench-boot', '')
    var card = boot.firstElementChild
    if (card === null) return
    if (card.querySelector('[data-three-workbench-boot-mark]') === null) {
      var mark = document.createElement('div')
      mark.setAttribute('data-three-workbench-boot-mark', '')
      mark.innerHTML = MARK
      card.insertBefore(mark, card.firstChild)
    }
    for (var index = 0; index < card.children.length; index += 1) {
      var element = card.children[index]
      if (element.getAttribute('data-three-workbench-boot-mark') !== null) continue
      if (element.hasAttribute('data-dsh-boot-spinner')) continue
      var text = (element.textContent || '').replace(/\\s+/g, ' ').trim()
      if (text === 'HARNESS') element.textContent = WORDMARK
      else if (text === 'Loading plugins…') element.textContent = HINT
    }
    if (!iconAdded) {
      iconAdded = true
      var link = document.createElement('link')
      link.rel = 'icon'
      link.type = 'image/svg+xml'
      link.href = ICON
      document.head.appendChild(link)
    }
  }
  var observer = new MutationObserver(paint)
  observer.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true })
  paint()
})()`,
  },
  { kind: 'html', placement: 'body', html: BOOT_SPLASH_MARKUP },
  { kind: 'script', placement: 'body', text: BOOT_SPLASH_SCRIPT },
]

const MAX_CODE_BYTES = 256 * 1024
const MAX_SCENES = 16
const MAX_REVISIONS = 12
const MAX_THUMBNAILS = 240
const MAX_THUMBNAILS_PER_SESSION = 12
const MAX_THUMBNAIL_BYTES = 512 * 1024
const RESTORE_PATH = `${ROUTE_PATH}/scene/restore`
const RESTORE_REQUEST_ID_RE = /^[A-Za-z0-9_-]{22}$/
const RESTORE_LIMITS = {
  maxBodyBytes: 4096,
  bodyIdleTimeoutMs: 2000,
  bodyTotalTimeoutMs: 5000,
  requestsPerSessionPerMinute: 6,
  requestsGlobalPerMinute: 30,
  concurrentPerSession: 1,
  concurrentGlobal: 2,
  idempotencyEntriesPerSession: 8,
  idempotencyTtlMs: 600000,
  requestIdLength: 22,
  clientTimeoutMs: 20000,
}

/** session id -> { history: [revision record] }; the last record is the latest. */
const scenes = new Map()

/**
 * Memory-only restore bookkeeping: per-Session rate timestamps and active
 * slots, one global rate/slot pair, and per-Session idempotency entries.
 */
const restoreRates = { sessions: new Map(), global: { times: [], active: 0 } }
/** Session id -> Map(requestId, {fingerprint, body, expiresAt}). */
const restoreIdempotency = new Map()
/** Test-injectable clock; reset() restores the real one. */
let restoreNow = Date.now

/** `${sceneId}:${revision}` -> PNG bytes rendered by the preview. */
const thumbnails = new Map()

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const HDR_SIGNATURES = [
  Buffer.from('#?RADIANCE\n', 'latin1'),
  Buffer.from('#?RGBE\n', 'latin1'),
]

const MIB = 1024 * 1024
const ASSET_LIMITS = {
  maxImageBytes: 8 * MIB,
  maxGlbBytes: 32 * MIB,
  maxGltfBytes: 8 * MIB,
  maxHdrBytes: 16 * MIB,
  maxUploadBytes: 32 * MIB,
  maxGltfEmbeddedBytes: 32 * MIB,
  sessionAssets: 24,
  sessionBytes: 48 * MIB,
  globalAssets: 128,
  globalBytes: 256 * MIB,
  nameCodePoints: 128,
  uploadsPerSessionPerMinute: 10,
  concurrentUploadsPerSession: 3,
  uploadsGlobalPerMinute: 60,
  listDeletePerSessionPerMinute: 60,
  maxDeleteBodyBytes: 16 * 1024,
}
const ASSET_ID_RE = /^[A-Za-z0-9_-]{22}$/
const SHARE_PATH = `${ROUTE_PATH}/share`
const SHARE_ID_RE = /^[A-Za-z0-9_-]{22}$/
const SHARE_LIMITS = {
  maxBodyBytes: 40 * MIB,
  maxDocumentBytes: 26 * MIB,
  maxStateBytes: 2 * MIB,
  maxShareBytes: 30 * MIB,
  sessionShares: 8,
  sessionBytes: 64 * MIB,
  globalShares: 32,
  globalBytes: 128 * MIB,
  createsPerSessionPerMinute: 10,
  createsGlobalPerMinute: 30,
  concurrentCreatesGlobal: 2,
  concurrentCreatesSession: 1,
  bodyIdleTimeoutMs: 10_000,
  bodyTotalTimeoutMs: 20_000,
  deletesGlobalPerMinute: 60,
  maxDeleteBodyBytes: 4 * 1024,
  viewerRateGlobalPerMinute: 120,
  viewerRatePerIdPerMinute: 30,
  viewerConcurrentGlobal: 8,
  viewerConcurrentPerId: 2,
  documentRateGlobalPerMinute: 20,
  documentRatePerIdPerMinute: 8,
  documentConcurrentGlobal: 2,
  documentConcurrentPerId: 1,
  defaultTtlSeconds: 604800,
  minTtlSeconds: 3600,
  maxTtlSeconds: 2592000,
  titleCodePoints: 200,
  metadataMaxBytes: 4096,
  maxJsonDepth: 64,
  maxStateNodes: 200000,
  maxStepFps: 120,
}
const SHARE_SHELL_CSP = "default-src 'none'; frame-src about:; script-src 'unsafe-inline' 'unsafe-eval' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' data: blob:; font-src 'self' data:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'; prefetch-src 'none'; navigate-to 'none'"
const SHARE_DOCUMENT_CSP = "default-src 'none'; sandbox"
const SHARE_DOCUMENT_META = `<meta http-equiv="Content-Security-Policy" content="frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src data: blob:">`
const SHARE_UNAVAILABLE_TEXT = 'This share link is unavailable or has expired.\n分享链接不可用或已过期。\n'
const SHARE_BAD_HOST_TEXT = 'Bad request.\n'
const SHARE_RATE_TEXT = 'Too many requests.\n'
const ASSET_FILE_CAPS = {
  png: ASSET_LIMITS.maxImageBytes,
  jpeg: ASSET_LIMITS.maxImageBytes,
  webp: ASSET_LIMITS.maxImageBytes,
  glb: ASSET_LIMITS.maxGlbBytes,
  gltf: ASSET_LIMITS.maxGltfBytes,
  hdr: ASSET_LIMITS.maxHdrBytes,
}
const ASSET_EXTENSIONS = {
  png: ['.png'],
  jpeg: ['.jpg', '.jpeg'],
  webp: ['.webp'],
  glb: ['.glb'],
  gltf: ['.gltf'],
  hdr: ['.hdr'],
}
const GLTF_BUFFER_MIMES = new Set(['', 'application/octet-stream', 'application/gltf-buffer'])
const GLTF_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const GLTF_UNSUPPORTED_EXTENSIONS = new Set([
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_texture_basisu',
])

/**
 * Per-session in-memory asset store. Bytes never leave this process except
 * through a capability-ID content route; v2/localStorage only stores IDs.
 * `sessionId -> Map<assetId, asset>`.
 */
const assets = new Map()
/** `assetId -> sessionId`, the only content-route lookup. */
const assetIndex = new Map()
/** `${sessionId}\0${nameFold} -> assetId`, name uniqueness only. */
const assetNames = new Map()
/** `sessionId -> { count, bytes }`. */
const assetUsage = new Map()
/** `sessionId -> { uploads: number[], active: number, listDelete: number[] }`. */
const assetRates = new Map()
/** Upload timestamps shared by every Session (global 60/min cap). */
const globalUploadTimes = []
const globalUsage = { count: 0, bytes: 0 }

const runtimeCache = new Map()

// ---------------------------------------------------------------------------
// P3-3 durable Host storage. The declarations here are intentionally outside
// every P3-1/P3-2 frozen source slice. No filesystem work happens at import
// time; `apply()` starts the store through its storage effect.
// ---------------------------------------------------------------------------
const MAX_SCENE_TITLE_BYTES = 64 * 1024
const MAX_ROOT_BYTES = 2 * 1024 * 1024 * 1024
const MAX_LOAD_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024)
const MAX_STAGING_BYTES = 128 * 1024 * 1024
const STARTUP_DEADLINE_MS = 5000
const MAX_SCAN_ENTRIES = 65536
const MAX_SCENE_DIRS_SCANNED = 256
const MAX_SCENE_ENTRIES_PER_DIR = 256
const MAX_SCENE_FILES_READ = 32
const MAX_SCENE_MARKER_BYTES = 1024
const MAX_SCENE_READ_BYTES = 512 * 1024 * 1024
const MAX_ASSET_SESSIONS_SCANNED = 64
const MAX_ASSET_DIRS_SCANNED = 4096
const MAX_ASSET_META_BYTES = 64 * 1024 * 1024
const MAX_SHARE_DIRS_SCANNED = 256
const MAX_SHARE_RECORD_SCAN_BYTES = 256 * 1024 * 1024
const MAX_THUMB_INDEX_BYTES = 1024 * 1024
const MAX_THUMB_ENTRIES = 4096
const MAX_THUMB_READ_BYTES = 120 * 1024 * 1024
const MAX_TMP_ENTRIES = 4096
const MAX_TRASH_ENTRIES = 4096
const MAX_TRASH_PRESSURE_BYTES = 128 * 1024 * 1024
// Pressure cleanup runs while an operation queue is held. Bound both the scan
// and the cleanup so a large or unreadable trash tree fails `storage-full`
// instead of holding the queue indefinitely; startup cleanup can drain later.
const MAX_TRASH_PRESSURE_ENTRIES = 4096
const MAX_TRASH_PRESSURE_MS = 250
const MAX_BOUNDARY_INTENT_BYTES = 512
const MAX_BOUNDARY_INTENTS = 4096
const MAX_QUARANTINE_ENTRIES = 32
const MAX_QUARANTINE_BYTES = 64 * 1024 * 1024
const MAX_ORDER = Number.MAX_SAFE_INTEGER - 1_000_000
const MAX_SHARE_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000
const THUMBNAIL_INDEX_MIN_INTERVAL_MS = 50
const REVERSE_SCENES_FSYNC_RETRIES = 1
const MAX_ASSET_META_BYTES_PER_FILE = 16 * 1024
const MAX_SHARE_RECORD_BYTES = 8 * 1024 * 1024
const MAX_ASSET_BODY_BYTES = ASSET_LIMITS.maxGlbBytes
const LOCK_MAX_BYTES = 4096
const HEX64_RE = /^[a-f0-9]{64}$/
const HEX32_RE = /^[a-f0-9]{32}$/
const ORDER16_RE = /^\d{16}$/
const SCENE_REVISION_RE = /^\d{16}\.json$/
const SCENE_MARKER_RE = /^\d{16}\.commit\.json$/
const INTENT_RE = /^([a-f0-9]{32})\.intent\.json$/

/** Session id -> published scene epoch (disk side table). */
const sceneEpochs = new Map()
/** Session id -> Map(revision -> persisted order); disk-only, bounded. */
const sceneRevisionOrderBySession = new Map()
/** Session id -> array of exact visible/hidden ids deleted by the sync helper. */
const deleteAssetSessionRecorded = new Map()
/** sidHash -> validated seven-field owner record. */
const assetOwnerRecords = new Map()
/** sidHash -> Map(assetId -> {assetHash, order, sceneEpoch, sceneId}). */
const preservedStaleAssets = new Map()
/** Asset ids that are staged/pending and must never appear publicly. */
const hiddenAssetIds = new Set()
/** assetId -> persisted order (disk side table). */
const assetOrderById = new Map()
/** assetId -> persisted content hash directory name. */
const assetHashById = new Map()
/** shareId -> persisted order (disk side table). */
const shareOrderById = new Map()
/** thumbnail key -> persisted index metadata. */
const thumbnailIndex = new Map()
/** assetId -> validated disk-only asset metadata, including preserved rows. */
const assetDiskMetaById = new Map()
/** sidHash -> { sessionId, epoch } for scenes intentionally evicted by LRU. */
const sceneProductEvicted = new Map()
/** sidHash -> true when startup saw an unread/truncated scene directory. */
const sceneUnscanned = new Set()
/** sidHash -> true when an owner/asset conflict requires repair/refusal. */
const assetEpochConflict = new Set()
let nextSceneOrder = 1
let nextThumbOrder = 1
let nextAssetOrder = 1
let nextShareOrder = 1
let sceneScanTruncated = false
let sceneWritePreserve = false
let sceneWriteDegraded = false
let thumbnailWriteDegraded = false
let deferredSceneCleanup = []
let diskNow = Date.now
let storage = null

/** A typed storage failure; codes are internal only. */
class DiskError extends Error {
  constructor(code = 'storage-unavailable', cause = undefined) {
    super(String(code))
    this.name = 'DiskError'
    this.code = String(code)
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Built-in scene shown by a preview tab opened before the agent has written
 * one; it also proves the runtime independently of any model call.
 */
const DEMO_SCENE = {
  sceneId: 'demo',
  revision: 0,
  title: '示例场景',
  updatedAt: 0,
  bytes: 0,
  code: `setCamera([0, 2.3, 9.2])

const knot = new THREE.Mesh(
  new THREE.TorusKnotGeometry(1.1, 0.34, 220, 32),
  new THREE.MeshStandardMaterial({ color: 0x6ea8ff, roughness: 0.25, metalness: 0.65, emissive: 0x0b1b3a }),
)
scene.add(knot)

scene.add(new THREE.HemisphereLight(0xaac8ff, 0x0a0a12, 1.1))
const key = new THREE.DirectionalLight(0xffffff, 2.2)
key.position.set(4, 6, 5)
scene.add(key)
const rim = new THREE.PointLight(0xff5ea8, 40, 20)
rim.position.set(-4, -2, -3)
scene.add(rim)

const count = 900
const positions = new Float32Array(count * 3)
for (let i = 0; i < count; i++) {
  const radius = 2.2 + Math.random() * 3.4
  const angle = Math.random() * Math.PI * 2
  const polar = Math.acos(2 * Math.random() - 1)
  positions[i * 3] = Math.sin(polar) * Math.cos(angle) * radius
  positions[i * 3 + 1] = Math.cos(polar) * radius * 0.6
  positions[i * 3 + 2] = Math.sin(polar) * Math.sin(angle) * radius
}
const geometry = new THREE.BufferGeometry()
geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
const stars = new THREE.Points(geometry, new THREE.PointsMaterial({
  color: 0x9fc3ff, size: 0.035, transparent: true, opacity: 0.85, depthWrite: false,
}))
scene.add(stars)

onFrame(({ time }) => {
  knot.rotation.x = time * 0.35
  knot.rotation.y = time * 0.5
  stars.rotation.y = -time * 0.06
  stars.rotation.x = Math.sin(time * 0.2) * 0.15
})
`,
}

export const name = 'three-workbench'
export const inject = ['tools', 'systemPrompt']

const PROMPT = `## Three.js workbench

You can render live Three.js animation for the user with the \`three_scene\` tool.
The user's preview pane updates as soon as the tool returns, so use it for visual
requests ("draw", "animate", "a rotating galaxy", "particle rain", ...).

Write the ENTIRE scene as one self-contained JavaScript script and pass it as
\`code\`. The runtime executes it once; every call replaces the previous scene.

Available inside the script (no imports needed):

- \`THREE\` — the Three.js namespace (r186).
- \`addons\` — \`{ OrbitControls }\`.
- \`scene\`, \`camera\`, \`renderer\`, \`canvas\`, \`clock\` — a prepared stage:
  the camera looks at the origin from (0, 2.5, 7); \`scene.background\` defaults
  to dark; OrbitControls is already attached to the canvas.
- \`onFrame(callback)\` — register a per-frame callback. The callback receives
  \`{ time, delta, elapsed, THREE, scene, camera, renderer, controls, canvas }\`.
- \`setBackground(color)\` — accepts a CSS color or a \`THREE.Color\`.
- \`wb.id(object, name)\` — assign a stable identity to an object and return the
  object. It writes \`object.userData.wbId = name\`; setting
  \`object.userData.wbId\` directly is equivalent. Selection, manual overrides,
  history and exports follow this ID across scene revisions even when
  \`object.name\` changes. Use a unique, stable name for every object the user
  may edit (for example \`scene.add(wb.id(mesh, 'hero'))\`). Duplicate or missing
  IDs are left unbound rather than guessed.
- \`assets\` — files the user uploaded in the **Assets** panel, referenced by
  their user-visible name (never an ID or URL). Name-only helpers:
  \`assets.url(name)\` -> \`string | null\`; \`assets.texture(name, options?)\` ->
  \`THREE.Texture | null\` for image assets, returned immediately (optional
  \`{ srgb:false, wrap, repeat:[x, y] }\`); \`assets.model(name, onLoad?, onError?)\`
  -> \`THREE.Group | null\`, a holder returned immediately that you must add to
  the scene yourself (\`scene.add(holder)\`); on success the loaded scene is
  attached under the holder, \`onLoad(root, gltf)\` runs later, and
  \`holder.ready\` resolves the root or \`null\`; empty or failed loads keep the
  holder empty and call \`onError\`/resolve \`null\`;
  \`assets.hdri(name, onLoad?, onError?)\` -> \`THREE.Texture | null\` for HDR
  assets, so \`scene.environment = assets.hdri('studio')\` is valid before the
  bytes arrive. A \`null\` result plus a non-fatal asset error means the name is
  missing or has the wrong kind, and failures never stop animation. Use
  \`holder.ready\`/\`onError\` and null checks instead of assuming an asset exists;
  never hardcode object URLs or IDs.

The runtime calls \`renderer.render(scene, camera)\` every frame, so add objects
to \`scene\` and move them in \`onFrame\`.

Rules:

- Do not use \`import\`, \`require\`, or top-level \`await\`; the script runs as a
  plain function body.
- Prefer \`wb.id(object, name)\` (or \`object.userData.wbId = name\`) for editable
  objects, and keep those IDs unique within the scene. Names may change; IDs
  should not.
- Do not fetch external URLs or load remote content, except user-uploaded
  assets accessed through \`assets.*\`. Generate everything else procedurally
  (CanvasTexture, shaders, vertex colors) so the preview still works offline.
- Prefer a looping animation that looks good within a few seconds, and keep the
  camera framing sensible.
- Keep \`code\` under 256 KiB.
- To iterate, call \`three_scene\` again with the full revised script. Change only
  what the user asked for; do not drop working parts.
- Call it once when you create the scene, not on every reply.`

const PROPOSAL_PROMPT = `## Workbench proposals

The workbench gives the user an AI-native review loop. Instead of mutating the
scene while the user is exploring, call \`workbench_proposal\` with one of:

- \`shots\` — a short shot list: \`{ shots: [{ name, position:[x,y,z], target:[x,y,z], fov }] }\`.
  Frame the story; the user can preview each shot and apply the sequence.
- \`pins\` — review notes: \`{ pins: [{ uid?, position:[x,y,z], severity:'info'|'warn'|'error', message }] }\`.
  Anchor to a stable \`wb.id\` / \`userData.wbId\` when the object is known.
- \`measure\` — a measurement: \`{ label, from:[x,y,z], to:[x,y,z], uidA?, uidB? }\`.
- \`explode\` — a view-only exploded amount: \`{ amount: 0..2 }\`. It never edits the scene.
- \`view\` — a camera preset or explicit camera: \`{ preset }\` or \`{ position, target, fov }\`.
  Set \`projection:'orthographic'\` (or \`preset:'plan'\`) for a top-down plan view.
- \`geometry\` — a manual primitive parameter patch: \`{ uid, params: { ... } }\`.
- \`insert\` — add validated primitives to the scene as one atomic edit:
  \`{ parts: [{ shape, name?, position:[x,y,z], rotation:[degX,degY,degZ], scale:[x,y,z], params?, material? }], origin? }\`
  or reference a recipe from the context shelf with \`{ recipeId, origin? }\`.
  Shapes: box, sphere, plane, cylinder, cone, torus. This is data, not code.
- \`recipe\` — save a reusable assembly to the editor-only Insert Shelf:
  \`{ name, description?, parts:[...] }\`. It does not change the scene.
- \`link\` — record an editor-only relationship between two existing objects:
  \`{ fromUid, toUid, kind:'relation'|'flow'|'dependency', label }\`. It never
  enters the generated scene, exports or share documents.
- \`scene\` — an instruction for a later \`three_scene\` edit: \`{ prompt }\`.

Rules:

- Always pass \`kind\`, \`payload\`, and a short \`rationale\` the user can read.
- A proposal is data. It does not change the scene until the user applies it, and
  it becomes stale when the scene revision moves past \`baseRevision\`.
- In Ask mode, propose only what answers the question; never write a scene.
- In Edit/Review mode, prefer proposals over direct \`three_scene\` edits when the
  user could reasonably want to inspect the change first.
- Keep shot lists to 3-5 items, review pins to the few that matter, and inserts
  to the smallest assembly that communicates the idea. Use \`insert\` when the
  user asks for a new object or a small assembly; use \`scene\` for a full scene.
- The Insert Shelf is editor metadata. Recipes and links are never scene code;
  never put them in \`three_scene\` output.`

// ---------------------------------------------------------------------------
// Disk subsystem implementation. Everything in this section is inert until
// `apply()` starts the storage effect or a test calls `__diskInternal`.
// ---------------------------------------------------------------------------

const DISK_ROOT_MARKER = 'ROOT.json'
const DISK_VERSION = '1\n'
const SCENE_NAMES = ['tmp', 'trash', 'quarantine', 'scenes', 'thumbnails', 'assets', 'shares']

function diskSha(input) {
  return createHash('sha256').update(input).digest('hex')
}

function sceneSidHash(sessionId) {
  return diskSha(Buffer.concat([Buffer.from('twb:scene:v1\0', 'utf8'), Buffer.from(String(sessionId), 'utf8')]))
}

function thumbKeyHash(sessionId, revision) {
  return diskSha(Buffer.concat([
    Buffer.from('twb:thumb:v1\0', 'utf8'),
    Buffer.from(String(sessionId), 'utf8'),
    Buffer.from('\0', 'utf8'),
    Buffer.from(String(revision), 'utf8'),
  ]))
}

function assetIdHash(assetId) {
  return diskSha(Buffer.concat([Buffer.from('twb:asset:v1\0', 'utf8'), Buffer.from(String(assetId), 'utf8')]))
}

function shareIdHash(shareId) {
  return diskSha(Buffer.concat([Buffer.from('twb:share:v1\0', 'utf8'), Buffer.from(String(shareId), 'utf8')]))
}

function diskRandomHex(bytes = 16) {
  return randomBytes(bytes).toString('hex')
}

function isSafeCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function isSafePositive(value) {
  return Number.isSafeInteger(value) && value > 0
}

function isSafeSceneId(value) {
  if (typeof value !== 'string') return false
  const length = Array.from(value).length
  return length >= 1 && length <= 256 && !/[\u0000-\u001F\u007F-\u009F]/.test(value)
}

function bytesOfText(value) {
  return Buffer.byteLength(value, 'utf8')
}

function canonicalValueBytes(value) {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  if (typeof value === 'number') return Buffer.from(String(value), 'utf8')
  if (value instanceof Uint8Array) return Buffer.from(value)
  return Buffer.from(String(value), 'utf8')
}

function canonicalPairsHash(pairs, prefix = 'twb:record:v1\n') {
  const chunks = [Buffer.from(prefix, 'utf8')]
  for (const [name, value] of pairs) {
    const bytes = canonicalValueBytes(value)
    chunks.push(Buffer.from(String(name), 'utf8'))
    chunks.push(Buffer.from('\0', 'utf8'))
    chunks.push(Buffer.from(String(bytes.length), 'utf8'))
    chunks.push(Buffer.from('\0', 'utf8'))
    chunks.push(bytes)
    chunks.push(Buffer.from('\n', 'utf8'))
  }
  return diskSha(Buffer.concat(chunks))
}

function recordHash(pairs) {
  return canonicalPairsHash(pairs)
}

/**
 * Parse JSON without duplicate keys, prototype effects, excessive depth, or
 * trailing bytes. The returned object/array graph is null-prototype.
 */
function parseDiskJson(buffer, depthLimit = 64) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer)
  let at = 0
  const fail = () => { throw new DiskError('parse') }
  const whitespace = () => {
    while (at < text.length) {
      const code = text.charCodeAt(at)
      if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break
      at += 1
    }
  }
  const parseString = () => {
    if (text[at] !== '"') fail()
    at += 1
    let out = ''
    while (at < text.length) {
      const ch = text[at]
      if (ch === '"') {
        at += 1
        return out
      }
      if (ch === '\\') {
        at += 1
        const esc = text[at]
        if (esc === '"' || esc === '\\' || esc === '/') { out += esc; at += 1 }
        else if (esc === 'b') { out += '\b'; at += 1 }
        else if (esc === 'f') { out += '\f'; at += 1 }
        else if (esc === 'n') { out += '\n'; at += 1 }
        else if (esc === 'r') { out += '\r'; at += 1 }
        else if (esc === 't') { out += '\t'; at += 1 }
        else if (esc === 'u') {
          const hex = text.slice(at + 1, at + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail()
          out += String.fromCharCode(Number.parseInt(hex, 16))
          at += 5
        } else fail()
        continue
      }
      if (ch.charCodeAt(0) < 0x20) fail()
      out += ch
      at += 1
    }
    fail()
  }
  const parseNumber = () => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(at))
    if (match === null) fail()
    at += match[0].length
    const value = Number(match[0])
    if (!Number.isFinite(value)) fail()
    return value
  }
  const parseValue = depth => {
    if (depth > depthLimit) fail()
    whitespace()
    const ch = text[at]
    if (ch === '"') return parseString()
    if (ch === '{') {
      at += 1
      const object = Object.create(null)
      whitespace()
      if (text[at] === '}') { at += 1; return object }
      for (;;) {
        whitespace()
        const key = parseString()
        if (Object.prototype.hasOwnProperty.call(object, key)) fail()
        whitespace()
        if (text[at] !== ':') fail()
        at += 1
        object[key] = parseValue(depth + 1)
        whitespace()
        if (text[at] === ',') { at += 1; continue }
        if (text[at] === '}') { at += 1; return object }
        fail()
      }
    }
    if (ch === '[') {
      at += 1
      const array = []
      whitespace()
      if (text[at] === ']') { at += 1; return array }
      for (;;) {
        array.push(parseValue(depth + 1))
        whitespace()
        if (text[at] === ',') { at += 1; continue }
        if (text[at] === ']') { at += 1; return array }
        fail()
      }
    }
    if (text.startsWith('true', at)) { at += 4; return true }
    if (text.startsWith('false', at)) { at += 5; return false }
    if (text.startsWith('null', at)) { at += 4; return null }
    if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber()
    fail()
  }
  const value = parseValue(0)
  whitespace()
  if (at !== text.length) fail()
  return value
}

function exactKeys(object, keys) {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) return false
  const own = Object.keys(object)
  if (own.length !== keys.length) return false
  for (let index = 0; index < keys.length; index += 1) {
    if (own[index] !== keys[index]) return false
  }
  return true
}

function pathAnchored(fd, name) {
  return `/proc/self/fd/${String(fd)}/${name}`
}

function openDirAt(parentFd, name, flags = fs.constants.O_RDONLY) {
  const fd = fs.openSync(pathAnchored(parentFd, name),
    flags | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  const stat = fs.fstatSync(fd)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) {
    fs.closeSync(fd)
    throw new DiskError('storage-unavailable')
  }
  if ((stat.mode & 0o777) !== 0o700) {
    fs.fchmodSync(fd, 0o700)
    if ((fs.fstatSync(fd).mode & 0o777) !== 0o700) {
      fs.closeSync(fd)
      throw new DiskError('storage-unavailable')
    }
  }
  return fd
}

function fsyncFd(fd) {
  sharedNamespaceGuard(fd)
  const sharedHeld = isSharedNamespaceFd(fd) && storage !== null && storage.fence?.held
  if (sharedHeld) diskBarrierSync('beforeSharedParentFsync')
  fs.fsyncSync(fd)
  if (sharedHeld) diskBarrierSync('afterSharedParentFsync')
}

function readFileAt(parentFd, name, cap) {
  const fd = fs.openSync(pathAnchored(parentFd, name),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > cap) throw new DiskError('size')
    if ((stat.mode & 0o777) !== 0o600) {
      if (stat.uid !== process.getuid?.()) throw new DiskError('storage-unavailable')
      fs.fchmodSync(fd, 0o600)
      if ((fs.fstatSync(fd).mode & 0o777) !== 0o600) throw new DiskError('storage-unavailable')
    }
    const data = Buffer.allocUnsafe(cap + 1)
    let offset = 0
    while (offset <= cap) {
      const read = fs.readSync(fd, data, offset, data.length - offset, offset)
      if (read <= 0) break
      offset += read
    }
    if (offset > cap) throw new DiskError('size')
    return data.subarray(0, offset)
  } finally {
    fs.closeSync(fd)
  }
}

function fileStatAt(parentFd, name) {
  try {
    return fs.lstatSync(pathAnchored(parentFd, name))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function entryExistsAt(parentFd, name) {
  return fileStatAt(parentFd, name) !== null
}

function unlinkAt(parentFd, name) {
  sharedNamespaceGuard(parentFd)
  fs.unlinkSync(pathAnchored(parentFd, name))
}

function rmdirAt(parentFd, name) {
  sharedNamespaceGuard(parentFd)
  fs.rmdirSync(pathAnchored(parentFd, name))
}

function renameAt(fromFd, fromName, toFd, toName) {
  const shared = isSharedNamespaceFd(fromFd) || isSharedNamespaceFd(toFd)
  if (shared) ensureFenceOpen()
  if (shared && storage !== null && storage.fence?.held) diskBarrierSync('beforeSharedParentRename')
  fs.renameSync(pathAnchored(fromFd, fromName), pathAnchored(toFd, toName))
  if (shared && storage !== null && storage.fence?.held) diskBarrierSync('afterSharedParentRename')
}

function linkAt(fromFd, fromName, toFd, toName) {
  fs.linkSync(pathAnchored(fromFd, fromName), pathAnchored(toFd, toName))
}

function writeBufferToFd(fd, bytes) {
  let offset = 0
  while (offset < bytes.length) {
    offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset)
  }
}

function createTempFile(dirFd, bytes) {
  const name = diskRandomHex()
  const fd = fs.openSync(pathAnchored(dirFd, name),
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  try {
    writeBufferToFd(fd, bytes)
    fs.fsyncSync(fd)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new DiskError('storage-unavailable')
    if ((stat.mode & 0o777) !== 0o600) {
      fs.fchmodSync(fd, 0o600)
      if ((fs.fstatSync(fd).mode & 0o777) !== 0o600) throw new DiskError('storage-unavailable')
    }
  } finally {
    fs.closeSync(fd)
  }
  return name
}

function freeBudgetBytes(bytes) {
  if (storage === null || storage.budget === null || !Number.isFinite(bytes) || bytes <= 0) return
  storage.budget.used = Math.max(0, storage.budget.used - bytes)
  storage.budget.pumpStagingWaiters()
}

function addTrashBytes(bytes) {
  if (storage === null || storage.budget === null || !Number.isFinite(bytes) || bytes <= 0) return
  storage.budget.trashBytes += bytes
}

function subtractTrashBytes(bytes) {
  if (storage === null || storage.budget === null || !Number.isFinite(bytes) || bytes <= 0) return
  storage.budget.trashBytes = Math.max(0, storage.budget.trashBytes - bytes)
}

function trashSlotBytes(slotName) {
  if (storage === null || storage.dirFds === null) return 0
  try { return measureTreeBytes(storage.dirFds.trash, slotName) } catch (error) { return 0 }
}

function noteOrdinaryTrashSlot(slotName, bytes) {
  if (storage === null || storage.ordinaryTrash === null || typeof slotName !== 'string') return
  storage.ordinaryTrash.set(slotName, Number.isFinite(bytes) ? Math.max(0, bytes) : 0)
}

function untrackOrdinaryTrashSlot(slotName) {
  if (storage === null || storage.ordinaryTrash === null) return
  storage.ordinaryTrash.delete(slotName)
}

/**
 * Rename a product directory into the shared trash parent while keeping the
 * physical trash accounting exact. Measuring happens before the rename so a
 * later crash can never leave an untracked cleanup slot in this process.
 */
function renameIntoTrash(sourceFd, sourceName, slotName, ordinary) {
  if (storage === null || storage.dirFds === null) throw new DiskError('storage-unavailable')
  let bytes = 0
  try { bytes = measureTreeBytes(sourceFd, sourceName) } catch (error) { bytes = 0 }
  renameAt(sourceFd, sourceName, storage.dirFds.trash, slotName)
  addTrashBytes(bytes)
  if (ordinary === true) noteOrdinaryTrashSlot(slotName, bytes)
  return bytes
}

/** Reverse of `renameIntoTrash`; the old product name is durable afterward. */
function renameOutOfTrash(slotName, destinationFd, destinationName) {
  if (storage === null || storage.dirFds === null) throw new DiskError('storage-unavailable')
  const bytes = trashSlotBytes(slotName)
  renameAt(storage.dirFds.trash, slotName, destinationFd, destinationName)
  subtractTrashBytes(bytes)
  untrackOrdinaryTrashSlot(slotName)
  return bytes
}

function measureTrashUsage() {
  if (storage === null || storage.dirFds === null) return 0
  let bytes = 0
  for (const entry of readdirAt(storage.dirFds.trash)) {
    bytes += measureTreeBytes(storage.dirFds.trash, entry.name)
  }
  return bytes
}

function measureTrashUsageStrict(deadline = Date.now() + MAX_TRASH_PRESSURE_MS) {
  if (storage === null || storage.dirFds === null) return 0
  let entries = 0
  const visit = (parentFd, name, depth) => {
    if (depth > 8) throw new DiskError('storage-full')
    entries += 1
    if (entries > MAX_TRASH_PRESSURE_ENTRIES || Date.now() > deadline) {
      throw new DiskError('storage-full')
    }
    const stat = fs.lstatSync(pathAnchored(parentFd, name))
    if (stat.isSymbolicLink()) return 0
    if (stat.isFile()) return stat.size
    if (!stat.isDirectory()) return 0
    let bytes = 0
    const fd = openDirAt(parentFd, name)
    try {
      for (const entry of readdirAt(fd)) bytes += visit(fd, entry.name, depth + 1)
    } finally {
      fs.closeSync(fd)
    }
    return bytes
  }
  let bytes = 0
  for (const entry of readdirAt(storage.dirFds.trash)) {
    bytes += visit(storage.dirFds.trash, entry.name, 0)
  }
  return bytes
}

/**
 * Trash is a cleanup target, not a second hard budget: a committed delete can
 * temporarily cross the threshold. Before a new mutation is admitted, drain
 * every known ordinary cleanup slot under the namespace fence; if physical
 * trash still exceeds 128 MiB, fail `storage-full` before acknowledgement.
 * Boundary slots with a live intent are never drained by this path.
 */
async function ensureTrashPressure() {
  const state = storage
  if (state === null || state.mode !== 'disk' || state.dirFds === null || state.budget === null) return
  if (state.budget.trashBytes <= MAX_TRASH_PRESSURE_BYTES && state.ordinaryTrash.size === 0) return
  const deadline = Date.now() + MAX_TRASH_PRESSURE_MS
  const release = await acquireFence('cleanup-trash-pressure')
  try {
    ensureFenceOpen()
    let actual
    try { actual = measureTrashUsageStrict(deadline) } catch (error) {
      throw error instanceof DiskError ? error : new DiskError('storage-full', error)
    }
    state.budget.trashBytes = actual
    if (actual <= MAX_TRASH_PRESSURE_BYTES) return
    if (state.startupBoundaryTruncated === true) throw new DiskError('storage-full')
    for (const slotName of [...state.ordinaryTrash.keys()]) {
      if (Date.now() > deadline) break
      drainTrashSlot(slotName, { entries: MAX_TRASH_PRESSURE_ENTRIES, deadline })
    }
    try { actual = measureTrashUsageStrict(deadline) } catch (error) {
      throw new DiskError('storage-full', error)
    }
    state.budget.trashBytes = actual
    if (actual > MAX_TRASH_PRESSURE_BYTES) throw new DiskError('storage-full')
  } finally {
    release()
  }
}

function drainTrashSlot(slotName, options = null) {
  if (storage === null || storage.dirFds === null || typeof slotName !== 'string') return true
  const bytes = trashSlotBytes(slotName)
  try {
    const budget = options === null
      ? undefined
      : { entries: options.entries, bytes: MAX_ROOT_BYTES, deadline: options.deadline }
    removeTreeAt(storage.dirFds.trash, slotName, budget)
    fsyncFd(storage.dirFds.trash)
    subtractTrashBytes(bytes)
    untrackOrdinaryTrashSlot(slotName)
    return true
  } catch (error) {
    return false
  }
}

function removeTreeAt(parentFd, name, budget = { entries: 100000, bytes: MAX_ROOT_BYTES }, freeBudget = true) {
  if (isSharedNamespaceFd(parentFd)) ensureFenceOpen()
  const path = pathAnchored(parentFd, name)
  if (budget.deadline !== undefined && Date.now() > budget.deadline) throw new DiskError('storage-full')
  let stat
  try { stat = fs.lstatSync(path) } catch (error) { if (error?.code === 'ENOENT') return 0; throw error }
  if (!stat.isDirectory()) {
    if (budget.entries-- <= 0) throw new DiskError('storage-full')
    fs.unlinkSync(path)
    if (freeBudget) freeBudgetBytes(stat.size)
    return stat.size
  }
  let bytes = 0
  const fd = openDirAt(parentFd, name)
  try {
    for (const entry of readdirAt(fd)) {
      if (budget.entries-- <= 0) throw new DiskError('storage-full')
      if (budget.deadline !== undefined && Date.now() > budget.deadline) throw new DiskError('storage-full')
      const child = entry.name
      if (entry.isDirectory()) {
        bytes += removeTreeAt(fd, child, budget, false)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const childStat = fs.lstatSync(pathAnchored(fd, child))
        bytes += childStat.size
        fs.unlinkSync(pathAnchored(fd, child))
      } else {
        fs.unlinkSync(pathAnchored(fd, child))
      }
    }
    fsyncFd(fd)
  } finally {
    fs.closeSync(fd)
  }
  rmdirAt(parentFd, name)
  if (freeBudget) freeBudgetBytes(bytes)
  return bytes
}
class VirtualDirent {
  constructor(name, kind) {
    this.name = name
    this.kind = kind
  }
  isFile() { return this.kind === 'file' }
  isDirectory() { return this.kind === 'directory' }
  isSymbolicLink() { return this.kind === 'symlink' }
}

function virtualSpecCount(spec) {
  if (Array.isArray(spec.names)) return spec.names.length
  const repeat = Number(spec.repeat)
  return Number.isSafeInteger(repeat) && repeat > 0 ? repeat : 0
}

function * iterateVirtualSpec(spec, seen) {
  const kind = spec.kind === 'directory' ? 'directory' : spec.kind === 'symlink' ? 'symlink' : 'file'
  if (Array.isArray(spec.names)) {
    for (const value of spec.names) {
      const name = String(value)
      if (seen.has(name)) continue
      seen.add(name)
      yield new VirtualDirent(name, kind)
    }
    return
  }
  const repeat = Number(spec.repeat)
  if (!Number.isSafeInteger(repeat) || repeat <= 0) return
  const start = Number.isSafeInteger(spec.start) ? spec.start : 1
  const pad = Number.isSafeInteger(spec.pad) && spec.pad > 0 ? spec.pad : 0
  const prefix = typeof spec.prefix === 'string' ? spec.prefix : ''
  const suffix = typeof spec.suffix === 'string' ? spec.suffix : ''
  for (let offset = 0; offset < repeat; offset += 1) {
    const number = String(start + offset)
    const name = `${prefix}${pad === 0 ? number : number.padStart(pad, '0')}${suffix}`
    if (seen.has(name)) continue
    seen.add(name)
    yield new VirtualDirent(name, kind)
  }
}

class VirtualDirentList {
  constructor(real, specs) {
    this.real = real
    this.specs = specs
  }
  get length() {
    let count = this.real.length
    for (const spec of this.specs) count += virtualSpecCount(spec)
    return count
  }
  * [Symbol.iterator]() {
    const seen = new Set(this.real.map(entry => entry.name))
    yield * this.real
    for (const spec of this.specs) yield * iterateVirtualSpec(spec, seen)
  }
  map(fn) { return [...this].map(fn) }
  sort(compare) { return [...this].sort(compare) }
}

function readdirAtReal(fd) {
  return fs.readdirSync(`/proc/self/fd/${String(fd)}`, { withFileTypes: true })
}

function readdirAt(fd) {
  const real = readdirAtReal(fd)
  if (storage === null || storage.testMode !== true || storage.virtualDirents.size === 0) return real
  let dir
  try { dir = fs.readlinkSync(`/proc/self/fd/${String(fd)}`) } catch (error) { return real }
  const specs = storage.virtualDirents.get(dir)
  if (specs === undefined || !Array.isArray(specs) || specs.length === 0) return real
  return new VirtualDirentList(real, specs)
}

function mkdirDurableAt(parentFd, name, options = {}) {
  if (isSharedNamespaceFd(parentFd)) ensureFenceOpen()
  diskFaultSync('mkdirDurable', options.at ?? 'beforeMkdir')
  const path = pathAnchored(parentFd, name)
  let created = false
  try {
    fs.mkdirSync(path, 0o700)
    created = true
  } catch (error) {
    if (error?.code !== 'EEXIST') throw new DiskError('storage-unavailable', error)
  }
  const fd = openDirAt(parentFd, name)
  try {
    if (created) {
      fs.fchmodSync(fd, 0o700)
      fsyncFd(fd)
      void options
      diskBarrierSync('afterMkdirChildFsync')
      diskFaultSync('mkdirDurable', options.parentAt ?? 'afterMkdirChildFsync')
      fsyncFd(parentFd)
      diskBarrierSync('afterMkdirParentFsync')
      diskFaultSync('mkdirDurable', options.parentAt ?? 'afterMkdirParentFsync')
    }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
  return fd
}

function noteFaultHit(entry) {
  if (storage === null) return
  const key = `${entry.op}@${entry.at}`
  storage.faultHits.set(key, (storage.faultHits.get(key) ?? 0) + 1)
}

function diskFaultSync(op, at) {
  if (storage === null || storage.faults.length === 0) return
  for (const entry of storage.faults) {
    if (entry.op !== op || entry.at !== at) continue
    if (entry.count !== undefined) {
      if (entry.count <= 0) continue
      entry.count -= 1
    }
    noteFaultHit(entry)
    if (entry.behavior === 'hang') continue
    throw new DiskError(entry.code ?? 'storage-unavailable')
  }
}

async function diskFault(op, at) {
  if (storage === null || storage.faults.length === 0) return
  for (const entry of storage.faults) {
    if (entry.op !== op || entry.at !== at) continue
    if (entry.count !== undefined) {
      if (entry.count <= 0) continue
      entry.count -= 1
    }
    noteFaultHit(entry)
    if (entry.behavior === 'hang') {
      await new Promise(() => {})
    }
    throw new DiskError(entry.code ?? 'storage-unavailable')
  }
}

/**
 * Test-only read stall hook. Armed solely through __diskInternal.faults; an
 * isolated TEST-ROOT plus testMode is required by the only caller that sets
 * it, so production startup is a no-op with no faults.
 */
async function diskReadGate(at) {
  if (storage === null || storage.faults.length === 0) return
  for (const entry of storage.faults) {
    if (entry.op !== 'read' || entry.at !== at) continue
    if (entry.count !== undefined) {
      if (entry.count <= 0) continue
      entry.count -= 1
    }
    noteFaultHit(entry)
    if (entry.behavior === 'hang') {
      await new Promise(resolve => { storage.hangWaiters.push(resolve) })
      return
    }
    throw new DiskError(entry.code ?? 'storage-unavailable')
  }
}

function diskBarrierSync(name) {
  if (storage !== null && storage.crashName === name) {
    try { process.kill(process.pid, 'SIGKILL') } catch (error) { void error }
  }
  if (storage === null || storage.testMode !== true || !Array.isArray(storage.testSyncPauses)) return
  const index = storage.testSyncPauses.findIndex(candidate => candidate.name === name)
  if (index < 0) return
  storage.testSyncPauses.splice(index, 1)
  try { fs.writeSync(1, `SYNC_PAUSE:${name}\n`) } catch (error) { void error }
  try { process.kill(process.pid, 'SIGSTOP') } catch (error) { void error }
}

async function diskBarrier(name) {
  diskBarrierSync(name)
  await diskFault('barrier', name)
  const pauses = storage === null || !Array.isArray(storage.testPauses) ? [] : storage.testPauses
  const pause = pauses.find(candidate => candidate.name === name && candidate.arrived === false)
  if (pause !== undefined) {
    pause.arrived = true
    pause.releasePromise = new Promise(resolve => { pause.releaseResolve = resolve })
    pause.arrivalResolve()
    await pause.releasePromise
  }
}

function quarantineReasonFor(error) {
  const code = error instanceof DiskError ? error.code : 'parse'
  if (['parse', 'schema', 'hash', 'size', 'name', 'version', 'duplicate',
    'unexpected-entry', 'symlink', 'unsupported'].includes(code)) return code
  return 'schema'
}

/**
 * Generic keyed FIFO queue. A lease is held by the caller and released once.
 */
class DiskQueue {
  constructor() {
    this.states = new Map()
    this.pendingTotal = 0
    this.closing = false
  }

  acquire(key, cap) {
    if (this.closing) return Promise.reject(new DiskError('stopping'))
    if (this.pendingTotal >= 512) return Promise.reject(new DiskError('busy'))
    let state = this.states.get(key)
    if (state === undefined) {
      state = { active: false, pending: [] }
      this.states.set(key, state)
    }
    if (state.pending.length >= cap) return Promise.reject(new DiskError('busy'))
    this.pendingTotal += 1
    return new Promise((resolve, reject) => {
      state.pending.push({ resolve, reject })
      this.pump(key, state)
    })
  }

  pump(key, state) {
    if (state.active || state.pending.length === 0) return
    if (this.closing) {
      const rejected = state.pending.length
      for (const waiter of state.pending.splice(0)) waiter.reject(new DiskError('stopping'))
      this.pendingTotal = Math.max(0, this.pendingTotal - rejected)
      return
    }
    const waiter = state.pending.shift()
    this.pendingTotal -= 1
    state.active = true
    let released = false
    waiter.resolve(() => {
      if (released) return
      released = true
      state.active = false
      this.pump(key, state)
      if (!state.active && state.pending.length === 0) this.states.delete(key)
    })
  }

  close() {
    this.closing = true
    for (const [key, state] of [...this.states]) {
      const rejected = state.pending.length
      for (const waiter of state.pending.splice(0)) waiter.reject(new DiskError('stopping'))
      this.pendingTotal = Math.max(0, this.pendingTotal - rejected)
      this.pump(key, state)
    }
  }
}

class DiskBudget {
  constructor(limits) {
    this.limits = limits
    this.used = 0
    this.reserved = 0
    this.staging = 0
    this.trashBytes = 0
    this.credit = 0
    this.stagingCredit = 0
    this.stagingWaiters = []
  }

  pumpStagingWaiters() {
    while (this.stagingWaiters.length > 0) {
      const waiter = this.stagingWaiters[0]
      if (waiter.done) {
        this.stagingWaiters.shift()
        continue
      }
      if (this.used + this.reserved + waiter.bytes > this.limits.maxRootBytes) {
        this.stagingWaiters.shift()
        waiter.done = true
        clearTimeout(waiter.timer)
        waiter.reject(new DiskError('storage-full'))
        continue
      }
      if (this.staging + waiter.stagingBytes > this.limits.maxStagingBytes) return
      this.stagingWaiters.shift()
      waiter.done = true
      clearTimeout(waiter.timer)
      waiter.resolve(this.admitOperation(waiter.bytes, waiter.stagingBytes))
    }
  }

  admitOperation(bytes, stagingBytes) {
    this.reserved += bytes
    this.staging += stagingBytes
    this.credit += bytes
    this.stagingCredit += stagingBytes
    let released = false
    return {
      bytes,
      stagingBytes,
      release: () => {
        if (released) return
        released = true
        this.reserved = Math.max(0, this.reserved - bytes)
        this.staging = Math.max(0, this.staging - stagingBytes)
        this.credit = Math.max(0, this.credit - bytes)
        this.stagingCredit = Math.max(0, this.stagingCredit - stagingBytes)
        this.pumpStagingWaiters()
      },
    }
  }

  /**
   * Reserve the whole peak for one staged mutation. Root exhaustion fails
   * immediately; staging exhaustion waits FIFO for at most 250 ms.
   */
  reserveOperation(bytes, stagingBytes = bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0
      || !Number.isSafeInteger(stagingBytes) || stagingBytes < 0) {
      return Promise.reject(new DiskError('storage-full'))
    }
    return ensureTrashPressure()
      .then(() => this.reserveOperationNow(bytes, stagingBytes))
      .then(hold => ensureTrashPressure().then(
        () => hold,
        error => {
          try { hold.release() } catch (releaseError) { void releaseError }
          throw error
        },
      ))
  }

  reserveOperationNow(bytes, stagingBytes) {
    if (stagingBytes > this.limits.maxStagingBytes) {
      return Promise.reject(new DiskError('storage-full'))
    }
    if (this.used + this.reserved + bytes > this.limits.maxRootBytes) {
      return Promise.reject(new DiskError('storage-full'))
    }
    if (this.staging + stagingBytes <= this.limits.maxStagingBytes) {
      return Promise.resolve(this.admitOperation(bytes, stagingBytes))
    }
    return new Promise((resolve, reject) => {
      const waiter = { bytes, stagingBytes, resolve, reject, done: false, timer: null }
      waiter.timer = setTimeout(() => {
        if (waiter.done) return
        waiter.done = true
        const index = this.stagingWaiters.indexOf(waiter)
        if (index !== -1) this.stagingWaiters.splice(index, 1)
        reject(new DiskError('busy'))
      }, 250)
      waiter.timer.unref?.()
      this.stagingWaiters.push(waiter)
      this.pumpStagingWaiters()
    })
  }

  reserve(bytes, stagingBytes = bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new DiskError('storage-full')
    if (stagingBytes > this.limits.maxStagingBytes) throw new DiskError('storage-full')
    const rootUse = Math.min(this.credit, bytes)
    const stagingUse = Math.min(this.stagingCredit, stagingBytes)
    const rootExtra = bytes - rootUse
    const stagingExtra = stagingBytes - stagingUse
    if (this.staging + stagingExtra > this.limits.maxStagingBytes) throw new DiskError('storage-full')
    if (this.used + this.reserved + rootExtra > this.limits.maxRootBytes) throw new DiskError('storage-full')
    this.credit -= rootUse
    this.stagingCredit -= stagingUse
    this.reserved += rootExtra
    this.staging += stagingExtra
    let released = false
    return {
      bytes,
      stagingBytes,
      release: () => {
        if (released) return
        released = true
        this.reserved = Math.max(0, this.reserved - rootExtra)
        this.staging = Math.max(0, this.staging - stagingExtra)
        this.pumpStagingWaiters()
      },
      commit: added => {
        if (released) return
        released = true
        this.reserved = Math.max(0, this.reserved - rootExtra)
        this.staging = Math.max(0, this.staging - stagingExtra)
        this.used += Math.max(0, added ?? bytes)
        this.pumpStagingWaiters()
      },
    }
  }
}

async function writeFileDurableAt(parentFd, name, bytes, options = {}) {
  const tempDir = storage.dirFds.tmp
  const reservation = storage.budget.reserve(bytes.length + name.length + 64)
  let tempName = null
  try {
    if (options.op !== undefined) await diskFault(options.op, options.at ?? 'beforeWrite')
    await diskBarrier('beforeCandidate')
    tempName = createTempFile(tempDir, bytes)
    await diskFault('fileFsync', options.fileFsyncAt ?? 'afterCandidateFsync')
    await diskFault('write', options.at ?? 'afterCandidateFsync')
    await diskBarrier('afterCandidateFsync')
    if (options.tempFsyncOp !== undefined) await diskFault(options.tempFsyncOp, options.tempFsyncAt ?? 'afterCandidateFsync')
    renameAt(tempDir, tempName, parentFd, name)
    tempName = null
    await diskBarrier('afterRename')
    await diskFault('rename', options.at ?? 'afterRename')
    fsyncFd(parentFd)
    await diskBarrier('afterDirFsync')
    await diskFault('dirFsync', options.dirAt ?? options.at ?? 'afterDirFsync')
    if (options.fileFsyncOp !== undefined) await diskFault(options.fileFsyncOp, options.fileFsyncAt ?? 'afterDirFsync')
    reservation.commit(bytes.length)
    return true
  } catch (error) {
    if (tempName !== null) {
      try { unlinkAt(tempDir, tempName) } catch (cleanupError) { void cleanupError }
    }
    throw error instanceof DiskError ? error : new DiskError('storage-unavailable', error)
  } finally {
    if (tempName !== null) reservation.release()
    else reservation.release()
  }
}

function writeFileDurableSync(parentFd, name, bytes, options = {}) {
  const tempDir = storage.dirFds.tmp
  const reservation = storage.budget.reserve(bytes.length + name.length + 64)
  let tempName = null
  try {
    if (options.op !== undefined) diskFaultSync(options.op, options.at ?? 'beforeWrite')
    diskBarrierSync('beforeCandidate')
    tempName = createTempFile(tempDir, bytes)
    diskBarrierSync(options.barrierAfterCandidate ?? 'afterCandidateFsync')
    diskFaultSync('fileFsync', options.fileFsyncAt ?? 'afterCandidateFsync')
    if (options.tempFsyncOp !== undefined) diskFaultSync(options.tempFsyncOp, options.tempFsyncAt ?? 'afterCandidateFsync')
    diskFaultSync('rename', options.renameAt ?? options.at ?? 'afterRename')
    renameAt(tempDir, tempName, parentFd, name)
    tempName = null
    diskBarrierSync(options.barrierAfterRename ?? 'afterRename')
    fsyncFd(parentFd)
    diskBarrierSync(options.barrierAfterDirFsync ?? 'afterDirFsync')
    if (options.dirFsyncOp !== undefined) diskFaultSync(options.dirFsyncOp, options.dirAt ?? 'afterDirFsync')
    reservation.commit(bytes.length)
  } catch (error) {
    if (tempName !== null) {
      try { unlinkAt(tempDir, tempName) } catch (cleanupError) { void cleanupError }
    }
    throw error instanceof DiskError ? error : new DiskError('storage-unavailable', error)
  } finally {
    reservation.release()
  }
}

function serializeRecord(object) {
  return Buffer.from(JSON.stringify(object), 'utf8')
}

function buildSceneRevisionRecord(fields) {
  const object = {
    v: 1,
    kind: 'scene-revision',
    sceneId: fields.sceneId,
    epoch: fields.epoch,
    revision: fields.revision,
    order: fields.order,
    title: fields.title,
    code: fields.code,
    bytes: fields.bytes,
    updatedAt: fields.updatedAt,
    sha256: diskSha(Buffer.from(fields.code, 'utf8')),
  }
  object.recordSha256 = recordHash([
    ['v', 1], ['kind', object.kind], ['sceneId', object.sceneId], ['epoch', object.epoch],
    ['revision', object.revision], ['order', object.order], ['title', object.title],
    ['code', object.code], ['bytes', object.bytes], ['updatedAt', object.updatedAt],
    ['sha256', object.sha256],
  ])
  return { object, bytes: serializeRecord(object), sha256: object.recordSha256 }
}

function buildSceneMarker(sidHash, order, revision, revisionRecordSha256) {
  const object = {
    v: 1,
    kind: 'scene-commit',
    sidHash,
    order,
    revision,
    recordSha256: revisionRecordSha256,
  }
  object.markerSha256 = canonicalPairsHash([
    ['v', 1], ['kind', object.kind], ['sidHash', object.sidHash], ['order', object.order],
    ['revision', object.revision], ['recordSha256', object.recordSha256],
  ], 'twb:scene-commit:v1\0')
  return { object, bytes: serializeRecord(object) }
}

function intentHashFields(intent) {
  return [
    ['v', 1], ['kind', intent.kind], ['sidHash', intent.sidHash], ['slot', intent.slot],
    ['newEpoch', intent.newEpoch], ['newIncarnation', intent.newIncarnation],
    ['newOrder', intent.newOrder], ['newRevisionRecordSha256', intent.newRevisionRecordSha256],
  ]
}

function buildBoundaryIntent(fields) {
  const intent = {
    v: 1,
    kind: 'scene-generation-boundary',
    sidHash: fields.sidHash,
    slot: fields.slot,
    newEpoch: fields.newEpoch,
    newIncarnation: fields.newIncarnation,
    newOrder: fields.newOrder,
    newRevisionRecordSha256: fields.newRevisionRecordSha256,
  }
  intent.recordSha256 = canonicalPairsHash(intentHashFields(intent), 'twb:scene-boundary-intent:v1\0')
  return { object: intent, bytes: serializeRecord(intent) }
}

function validateBoundaryIntentBytes(bytes, basename) {
  if (bytes.length > MAX_BOUNDARY_INTENT_BYTES) throw new DiskError('size')
  const intent = parseDiskJson(bytes)
  const keys = ['v', 'kind', 'sidHash', 'slot', 'newEpoch', 'newIncarnation',
    'newOrder', 'newRevisionRecordSha256', 'recordSha256']
  if (!exactKeys(intent, keys)) throw new DiskError('schema')
  if (intent.v !== 1 || intent.kind !== 'scene-generation-boundary') throw new DiskError('schema')
  if (!HEX64_RE.test(intent.sidHash) || !HEX32_RE.test(intent.slot)
    || !HEX32_RE.test(intent.newEpoch) || !HEX32_RE.test(intent.newIncarnation)
    || !HEX64_RE.test(intent.newRevisionRecordSha256) || !HEX64_RE.test(intent.recordSha256)) {
    throw new DiskError('schema')
  }
  if (!isSafePositive(intent.newOrder) || intent.newOrder > MAX_ORDER) throw new DiskError('schema')
  const match = INTENT_RE.exec(basename)
  if (match === null || match[1] !== intent.slot) throw new DiskError('name')
  const expected = canonicalPairsHash(intentHashFields(intent), 'twb:scene-boundary-intent:v1\0')
  if (expected !== intent.recordSha256) throw new DiskError('hash')
  const canonical = serializeRecord(intent)
  if (!canonical.equals(bytes)) throw new DiskError('schema')
  return intent
}

function safeTokenEqual(left, right) {
  const a = Buffer.from(String(left), 'utf8')
  const b = Buffer.from(String(right), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function diskConfigFromEnv(env = process.env, platform = process.platform, cwd = process.cwd()) {
  if (platform !== 'linux') return { mode: 'memory', status: 'disk-unsupported' }
  let explicit
  try {
    explicit = String(env.THREE_WORKBENCH_DATA_DIR ?? '').trim()
  } catch (error) {
    return { mode: 'memory', status: 'test-memory', invalid: true }
  }
  if (explicit.includes('\u0000')) return { mode: 'degraded', status: 'invalid-root', invalid: true }
  let rootCandidate
  let homeCandidate = null
  let usedDefault = false
  if (explicit !== '') {
    rootCandidate = expandConfiguredPath(explicit, cwd)
  } else {
    let homeValue
    try { homeValue = String(env.DSH_HOME ?? '').trim() } catch (error) { homeValue = '' }
    if (homeValue.includes('\u0000')) return { mode: 'degraded', status: 'invalid-root', invalid: true }
    if (homeValue === '') {
      homeValue = join(homedir(), '.dsh')
      usedDefault = true
    } else {
      homeValue = expandConfiguredPath(homeValue, cwd)
    }
    rootCandidate = resolvePath(homeValue, 'three-workbench')
    homeCandidate = homeValue
  }
  let root
  let homeRoot = null
  try {
    root = canonicalCandidate(rootCandidate)
    if (homeCandidate !== null) homeRoot = canonicalCandidate(homeCandidate)
  } catch (error) {
    return { mode: 'degraded', status: 'invalid-root', invalid: true }
  }
  const runnerParent = diskParentCmdlineHasTest()
  const isolated = isIsolatedDiskTest(env, root, runnerParent)
  if (runnerParent && !isolated) return { mode: 'memory', status: 'test-memory' }
  return { mode: 'disk-candidate', root, homeRoot, usedDefault, isolatedTest: isolated }
}

function expandConfiguredPath(value, cwd) {
  let expanded = value
  if (expanded === '~') expanded = homedir()
  else if (expanded.startsWith('~/')) expanded = join(homedir(), expanded.slice(2))
  return resolvePath(cwd, expanded)
}

function diskParentCmdlineHasTest() {
  try {
    const raw = fs.readFileSync(`/proc/${String(process.ppid)}/cmdline`)
    const args = raw.toString('utf8').split('\u0000').filter(Boolean)
    return args.includes('--test')
  } catch (error) {
    return false
  }
}

function canonicalCandidate(candidate) {
  const absolute = resolvePath(candidate)
  let existing = absolute
  const suffix = []
  for (;;) {
    try {
      const real = fs.realpathSync(existing)
      const result = resolvePath(real, ...suffix.reverse())
      return result
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      suffix.push(existing.slice(parent.length).replace(/^[/\\]+/, ''))
      existing = parent
    }
  }
}

function isStrictDescendant(candidate, ancestor) {
  const rel = relativePath(ancestor, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function isPathAncestorOrEqual(candidate, target) {
  return candidate === target || isStrictDescendant(target, candidate)
}

function isInsideOrEqual(candidate, ancestor) {
  return candidate === ancestor || isStrictDescendant(candidate, ancestor)
}

function isIsolatedDiskTest(env, root, runnerParent) {
  if (!runnerParent) return false
  if (typeof env.NODE_TEST_CONTEXT !== 'string' || env.NODE_TEST_CONTEXT === '') return false
  let temp
  try { temp = fs.realpathSync(tmpdir()) } catch (error) { return false }
  if (!isStrictDescendant(root, temp)) return false
  try {
    const stat = fs.lstatSync(join(root, 'TEST-ROOT'))
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
      || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) return false
    const bytes = fs.readFileSync(join(root, 'TEST-ROOT'))
    const marker = parseDiskJson(bytes)
    if (!exactKeys(marker, ['v', 'kind', 'token', 'root'])) return false
    if (marker.v !== 1 || marker.kind !== 'three-workbench-test-root'
      || !HEX32_RE.test(marker.token) || marker.root !== root) return false
    return true
  } catch (error) {
    return false
  }
}

function validateRootMarker(bytes) {
  const marker = parseDiskJson(bytes)
  if (!exactKeys(marker, ['v', 'kind', 'token', 'createdAt'])) throw new DiskError('schema')
  if (marker.v !== 1 || marker.kind !== 'three-workbench-root'
    || !HEX32_RE.test(marker.token) || !isSafeCount(marker.createdAt)) throw new DiskError('schema')
  return marker
}

function readProcStartTime(pid) {
  const raw = fs.readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
  const close = raw.lastIndexOf(')')
  if (close < 0) throw new DiskError('storage-unavailable')
  const fields = raw.slice(close + 2).trim().split(/\s+/)
  const value = Number(fields[19])
  if (!Number.isSafeInteger(value) || value < 0) throw new DiskError('storage-unavailable')
  return value
}

function diskBootId() {
  return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
}

function diskPidNamespace() {
  return fs.readlinkSync('/proc/self/ns/pid')
}

function readLockRecord(parentFd) {
  const bytes = readFileAt(parentFd, 'LOCK', LOCK_MAX_BYTES)
  const lock = parseDiskJson(bytes)
  const keys = ['v', 'kind', 'pid', 'procStartTime', 'bootId', 'pidNamespace', 'startedAt', 'token']
  if (!exactKeys(lock, keys) || lock.v !== 1 || lock.kind !== 'three-workbench-lock'
    || !isSafePositive(lock.pid) || !isSafeCount(lock.procStartTime)
    || typeof lock.bootId !== 'string' || typeof lock.pidNamespace !== 'string'
    || !isSafeCount(lock.startedAt) || !HEX32_RE.test(lock.token)) throw new DiskError('schema')
  return { lock, bytes }
}

function lockHolderState(lock) {
  if (lock.bootId !== diskBootId()) return 'stale-other-boot'
  if (lock.pidNamespace !== diskPidNamespace()) return 'ambiguous-namespace'
  try {
    process.kill(lock.pid, 0)
  } catch (error) {
    if (error?.code === 'ESRCH') return 'stale-dead'
    if (error?.code === 'EPERM') return 'ambiguous'
    return 'ambiguous'
  }
  try {
    const start = readProcStartTime(lock.pid)
    return start === lock.procStartTime ? 'live' : 'stale-dead'
  } catch (error) {
    return 'ambiguous'
  }
}

function publishMarkerCandidate(rootFd, finalName, bytes) {
  diskBarrierSync('beforeCandidate')
  const tempName = diskRandomHex()
  const fd = fs.openSync(pathAnchored(rootFd, tempName),
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  try {
    writeBufferToFd(fd, bytes)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  diskBarrierSync('afterCandidateFsync')
  try {
    linkAt(rootFd, tempName, rootFd, finalName)
  } catch (error) {
    try { unlinkAt(rootFd, tempName) } catch (cleanupError) { void cleanupError }
    throw error
  }
  diskFaultSync('link', 'afterLink')
  diskBarrierSync('afterLink')
  fsyncFd(rootFd)
  diskBarrierSync('afterDirFsync')
  return tempName
}

function acquireDiskLock(rootFd) {
  if (entryExistsAt(rootFd, 'LOCK.recover')) throw new DiskError('disk-locked')
  const token = diskRandomHex()
  const lock = {
    v: 1,
    kind: 'three-workbench-lock',
    pid: process.pid,
    procStartTime: readProcStartTime(process.pid),
    bootId: diskBootId(),
    pidNamespace: diskPidNamespace(),
    startedAt: Date.now(),
    token,
  }
  const bytes = serializeRecord(lock)
  let candidate
  try {
    candidate = publishMarkerCandidate(rootFd, 'LOCK', bytes)
  } catch (error) {
    // An existing LOCK is the recovery entry point, not a lock-candidate
    // failure. publishMarkerCandidate already removed its EEXIST candidate;
    // recovery revalidates the observed holder before stealing.
    if (error?.code === 'EEXIST') return recoverDiskLock(rootFd, bytes, token)
    throw error instanceof DiskError ? error : new DiskError('disk-locked', error)
  }
  try {
    let observed
    try {
      observed = readLockRecord(rootFd)
    } catch (error) {
      throw new DiskError('disk-locked', error)
    }
    if (observed.lock.token !== token) throw new DiskError('disk-locked')
    diskBarrierSync('afterLockVerify')
    unlinkAt(rootFd, candidate)
    fsyncFd(rootFd)
    return { token, lock }
  } catch (error) {
    if (entryExistsAt(rootFd, candidate)) {
      try { unlinkAt(rootFd, candidate) } catch (cleanupError) { void cleanupError }
    }
    if (error?.code === 'EEXIST') return recoverDiskLock(rootFd, bytes, token)
    throw error instanceof DiskError ? error : new DiskError('disk-locked', error)
  }
}

function recoverDiskLock(rootFd, newLockBytes, newToken) {
  let observed
  try {
    observed = readLockRecord(rootFd)
  } catch (error) {
    throw new DiskError('disk-locked', error)
  }
  const state = lockHolderState(observed.lock)
  if (state !== 'stale-dead' && state !== 'stale-other-boot') throw new DiskError('disk-locked')
  if (entryExistsAt(rootFd, 'LOCK.recover')) throw new DiskError('disk-locked')
  const guardToken = diskRandomHex()
  const observedHash = diskSha(observed.bytes)
  const guard = serializeRecord({
    v: 1, token: guardToken, lockToken: observed.lock.token, lockSha256: observedHash,
  })
  const guardCandidate = publishMarkerCandidate(rootFd, 'LOCK.recover', guard)
  let guardOwned = true
  let staleName = null
  let newCandidate = null
  try {
    const reread = readLockRecord(rootFd)
    if (diskSha(reread.bytes) !== observedHash || reread.lock.token !== observed.lock.token) {
      throw new DiskError('disk-locked')
    }
    const again = lockHolderState(reread.lock)
    if (again !== 'stale-dead' && again !== 'stale-other-boot') throw new DiskError('disk-locked')
    staleName = `LOCK.stale.${diskRandomHex()}`
    renameAt(rootFd, 'LOCK', rootFd, staleName)
    fsyncFd(rootFd)
    diskBarrierSync('afterRename')
    diskBarrierSync('recoveryBeforeCandidate')
    newCandidate = diskRandomHex()
    fs.writeFileSync(pathAnchored(rootFd, newCandidate), newLockBytes, { mode: 0o600, flag: 'wx' })
    const fd = fs.openSync(pathAnchored(rootFd, newCandidate), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    diskBarrierSync('recoveryAfterCandidateFsync')
    linkAt(rootFd, newCandidate, rootFd, 'LOCK')
    diskFaultSync('link', 'afterLink')
    diskBarrierSync('recoveryAfterLink')
    fsyncFd(rootFd)
    diskBarrierSync('recoveryAfterDirFsync')
    const verified = readLockRecord(rootFd)
    if (verified.lock.token !== newToken) throw new DiskError('disk-locked')
    diskBarrierSync('afterLockVerify')
    unlinkAt(rootFd, newCandidate)
    newCandidate = null
    unlinkAt(rootFd, staleName)
    staleName = null
    unlinkAt(rootFd, 'LOCK.recover')
    guardOwned = false
    fsyncFd(rootFd)
    return { token: newToken, lock: JSON.parse(newLockBytes.toString('utf8')) }
  } catch (error) {
    if (newCandidate !== null) {
      try { unlinkAt(rootFd, newCandidate) } catch (cleanupError) { void cleanupError }
    }
    if (guardOwned) {
      // A failed recovery leaves its fail-closed guard: never blind-steal.
    }
    throw error instanceof DiskError ? error : new DiskError('disk-locked', error)
  } finally {
    if (guardCandidate !== null && !entryExistsAt(rootFd, 'LOCK.recover')) {
      try { unlinkAt(rootFd, guardCandidate) } catch (cleanupError) { void cleanupError }
    }
  }
}

function releaseDiskLock(rootFd, token, releaseRoot = false) {
  try {
    const observed = readLockRecord(rootFd)
    if (!safeTokenEqual(observed.lock.token, token)) return false
    unlinkAt(rootFd, 'LOCK')
    fsyncFd(rootFd)
    if (releaseRoot && rootFd !== undefined) void 0
    return true
  } catch (error) {
    return false
  }
}

function ensureDiskLayout(rootFd) {
  const fds = {}
  for (const name of SCENE_NAMES) {
    let stat = null
    try { stat = fs.lstatSync(pathAnchored(rootFd, name)) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    if (stat !== null && (!stat.isDirectory() || stat.isSymbolicLink())) throw new DiskError('storage-unavailable')
    fds[name] = mkdirDurableAt(rootFd, name)
  }
  return fds
}

function verifyOrWriteVersion(rootFd, initializedHint) {
  let bytes
  try {
    bytes = readFileAt(rootFd, 'VERSION', 64)
  } catch (error) {
    if (error?.code === 'size') throw new DiskError('version')
    if (error?.code === 'parse') throw new DiskError('version')
    try { fs.lstatSync(pathAnchored(rootFd, 'VERSION')) } catch (statError) {
      if (statError?.code === 'ENOENT') {
        if (initializedHint) throw new DiskError('version')
        writeFileDurableSync(rootFd, 'VERSION', Buffer.from(DISK_VERSION, 'utf8'))
        fsyncFd(rootFd)
        return
      }
      throw statError
    }
    throw new DiskError('version', error)
  }
  if (!bytes.equals(Buffer.from(DISK_VERSION, 'utf8'))) throw new DiskError('version')
}

function rootMarkerCandidatePath(rootFd) {
  return `ROOT.tmp.${diskRandomHex()}`
}

function ensureRootMarker(rootFd, testMode) {
  let existing = null
  try { existing = readFileAt(rootFd, DISK_ROOT_MARKER, 4096) } catch (error) {
    if (error?.code === 'ENOENT') existing = null
    else throw new DiskError('storage-unavailable', error)
  }
  if (existing !== null) {
    validateRootMarker(existing)
    return
  }
  const candidate = rootMarkerCandidatePath(rootFd)
  const marker = {
    v: 1,
    kind: 'three-workbench-root',
    token: diskRandomHex(),
    createdAt: Date.now(),
  }
  const bytes = serializeRecord(marker)
  const fd = fs.openSync(pathAnchored(rootFd, candidate),
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  try {
    writeBufferToFd(fd, bytes)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    linkAt(rootFd, candidate, rootFd, DISK_ROOT_MARKER)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const raced = readFileAt(rootFd, DISK_ROOT_MARKER, 4096)
      validateRootMarker(raced)
    } else {
      throw new DiskError('storage-unavailable', error)
    }
  }
  fsyncFd(rootFd)
  validateRootMarker(readFileAt(rootFd, DISK_ROOT_MARKER, 4096))
  unlinkAt(rootFd, candidate)
  fsyncFd(rootFd)
  void testMode
}

function isKnownRootEntry(name) {
  if (['ROOT.json', 'VERSION', 'LOCK', 'LOCK.recover', 'TEST-ROOT', ...SCENE_NAMES].includes(name)) return true
  return /^(?:ROOT|LOCK)\.tmp\.[a-f0-9]{32}$/.test(name)
    || /^LOCK\.stale\.[a-f0-9]{32}$/.test(name)
}

function preflightExistingRoot(root, testMode) {
  const stat = fs.lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DiskError('storage-unavailable')
  if (stat.uid !== process.getuid?.()) throw new DiskError('storage-unavailable')
  const entries = fs.readdirSync(root)
  if (entries.length === 0) return { empty: true }
  if (testMode && entries.length === 1 && entries[0] === 'TEST-ROOT') return { empty: true, testOnly: true }
  const markerPath = join(root, DISK_ROOT_MARKER)
  let markerStat
  try { markerStat = fs.lstatSync(markerPath) } catch (error) {
    if (error?.code === 'ENOENT') throw new DiskError('missing-marker')
    throw new DiskError('storage-unavailable', error)
  }
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.uid !== process.getuid?.()
    || (markerStat.mode & 0o777) !== 0o600) throw new DiskError('missing-marker')
  const markerFd = fs.openSync(markerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  let markerBytes
  try {
    const fdStat = fs.fstatSync(markerFd)
    if (!fdStat.isFile() || fdStat.size > 4096 || fdStat.uid !== process.getuid?.()) throw new DiskError('missing-marker')
    markerBytes = fs.readFileSync(markerFd)
  } finally {
    fs.closeSync(markerFd)
  }
  validateRootMarker(markerBytes)
  return { empty: false }
}

function createMissingRoot(root, usedDefault, homeRoot) {
  const plan = []
  if (usedDefault && typeof homeRoot === 'string' && dirname(root) === homeRoot) {
    try { fs.lstatSync(homeRoot) } catch (error) {
      if (error?.code !== 'ENOENT') throw new DiskError('storage-unavailable', error)
      plan.push(homeRoot)
    }
  }
  plan.push(root)
  for (const target of plan) {
    let stat = null
    try { stat = fs.lstatSync(target) } catch (error) {
      if (error?.code !== 'ENOENT') throw new DiskError('storage-unavailable', error)
    }
    if (stat !== null) {
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) {
        throw new DiskError('storage-unavailable')
      }
      continue
    }
    const parent = dirname(target)
    let parentStat
    try { parentStat = fs.lstatSync(parent) } catch (error) {
      throw new DiskError('storage-unavailable', error)
    }
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new DiskError('storage-unavailable')
    fs.mkdirSync(target, 0o700)
    const childFd = fs.openSync(target,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try {
      const childStat = fs.fstatSync(childFd)
      if (!childStat.isDirectory() || childStat.uid !== process.getuid?.()) throw new DiskError('storage-unavailable')
      if ((childStat.mode & 0o777) !== 0o700) {
        fs.fchmodSync(childFd, 0o700)
        const fixed = fs.fstatSync(childFd)
        if ((fixed.mode & 0o777) !== 0o700) throw new DiskError('storage-unavailable')
      }
      fsyncFd(childFd)
    } finally {
      fs.closeSync(childFd)
    }
    const parentFd = fs.openSync(parent,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    try { fsyncFd(parentFd) } finally { fs.closeSync(parentFd) }
  }
}

function createSceneNamespaceFence() {
  return {
    state: 'open',
    held: false,
    holderKind: null,
    waiters: [],
    waiterCount: 0,
    completedOps: 0,
    boundaryRename: 0,
    boundaryTrashParentFsync: 0,
    boundaryScenesParentFsync: 0,
    cleanupRename: 0,
    cleanupScenesParentFsync: 0,
    startupInertScenesParentFsync: 0,
    startupRestoreScenesParentFsync: 0,
    startupTrashParentFsync: 0,
    startupRestoreRename: 0,
    events: [],
  }
}

function fenceHolderLabel(kind) {
  if (kind === null || kind === undefined) return null
  const value = String(kind)
  if (value.startsWith('boundary-startup') || value.startsWith('startup-')) return 'startup'
  if (value.startsWith('boundary') || value.startsWith('scene-generation-boundary')) return 'boundary'
  if (value.startsWith('cleanup')) return 'cleanup'
  if (value.startsWith('delete')) return 'delete'
  return value
}

function createStorageState() {
  return {
    refs: 0,
    started: false,
    starting: null,
    readyPromise: null,
    readyResolve: null,
    readyDone: false,
    stopping: null,
    closing: false,
    mode: 'memory',
    status: null,
    reason: null,
    root: null,
    homeRoot: null,
    rootFd: null,
    dirFds: null,
    lockToken: null,
    lockHeld: false,
    lockReleaseDeferred: false,
    startupComplete: false,
    activeTasks: 0,
    sawTaskWhileClosing: false,
    deferredReleaseCheck: null,
    budget: null,
    ordinaryTrash: new Map(),
    queues: {
      scene: new DiskQueue(),
      asset: new DiskQueue(),
      thumbnail: new DiskQueue(),
      share: new DiskQueue(),
    },
    fence: createSceneNamespaceFence(),
    faults: [],
    faultHits: new Map(),
    crashName: null,
    testPauses: [],
    testSyncPauses: [],
    virtualDirents: new Map(),
    hangWaiters: [],
    testForcedAppendEpoch: null,
    clock: Date.now,
    startupDeadlineMs: STARTUP_DEADLINE_MS,
    maxRootBytes: MAX_ROOT_BYTES,
    maxLoadBytes: MAX_LOAD_BYTES,
    maxStagingBytes: MAX_STAGING_BYTES,
    maxSceneReadBytes: MAX_SCENE_READ_BYTES,
    startupStartedAt: 0,
    loadBytes: 0,
    sceneReadBytes: 0,
    scanEntries: 0,
    scanCounters: {
      sceneRootEntries: 0,
      sceneDirs: 0,
      sceneSessionEntries: 0,
      sceneCandidateOrders: 0,
      sceneRevisionReads: 0,
      sceneMarkerReads: 0,
      assetRootEntries: 0,
      assetSessions: 0,
      assetDirs: 0,
      shareRootEntries: 0,
      shareDirs: 0,
    },
    quarantineSequence: 0,
    namespacePoison: false,
    lastThumbIndexWriteAt: 0,
    stats: {
      startupBoundaryIntents: 0,
      startupBoundaryRecovery: 0,
      startupBoundaryInvalid: 0,
      startupBoundaryTruncated: 0,
      startupRestored: 0,
      startupInert: 0,
      quarantineFailures: 0,
      quarantined: 0,
      startupTruncatedScenes: 0,
      startupEvictedScenes: 0,
      unacknowledgedSceneSessions: 0,
      reverseScenesFsyncRetries: 0,
      preservedStaleAssets: 0,
      overCapAssets: 0,
      overCapShares: 0,
      thumbnailDegraded: false,
    },
    testConfig: {},
  }
}

function ensureStorage() {
  if (storage === null) storage = createStorageState()
  return storage
}

function diskNowMs() {
  return storage === null ? Date.now() : storage.clock()
}

function startupDeadlineExceeded() {
  if (storage === null) return false
  const forcedAfter = storage.testConfig.forceStartupDeadlineAfterScanEntries
  if (Number.isSafeInteger(forcedAfter) && forcedAfter >= 0
    && storage.scanEntries > forcedAfter) return true
  return storage.startupDeadlineMs > 0
    && Date.now() - storage.startupStartedAt > storage.startupDeadlineMs
}

function noteLoadBytes(bytes) {
  if (storage === null) return
  storage.loadBytes += bytes
  if (storage.loadBytes > storage.maxLoadBytes) throw new DiskError('storage-full')
}

function noteScanEntry() {
  if (storage === null) return
  storage.scanEntries += 1
  if (storage.scanEntries > MAX_SCAN_ENTRIES) throw new DiskError('scan-limit')
}

function setDiskDegraded(status, reason = null) {
  if (storage === null) return
  storage.mode = 'degraded'
  storage.status = status
  storage.reason = reason
}

function resolveStorageReady() {
  if (storage === null || storage.readyDone) return
  storage.readyDone = true
  storage.readyResolve?.()
}

function storagePersistenceAvailable() {
  return storage !== null && storage.mode === 'disk'
}

function diskRouteUnavailable() {
  return storage !== null && storage.mode === 'degraded'
}

async function withDiskTask(fn) {
  const state = ensureStorage()
  if (state.closing) throw new DiskError('stopping')
  state.activeTasks += 1
  try {
    return await fn()
  } finally {
    state.activeTasks -= 1
    maybeDeferredLockRelease()
  }
}

function maybeDeferredLockRelease() {
  const state = storage
  if (state === null || !state.lockHeld || !state.closing || state.activeTasks > 0) return
  if (state.deferredReleaseCheck !== null) return
  state.deferredReleaseCheck = Promise.resolve().then(() => {
    if (state.activeTasks > 0 || !state.lockHeld || !state.closing) return
    releaseStorageLock()
  })
}

async function acquireFence(holderKind) {
  const state = storage
  const fence = state.fence
  let release
  if (fence.held) {
    release = await new Promise(resolve => {
      fence.waiters.push({ holderKind, resolve })
      fence.waiterCount = fence.waiters.length
    })
  } else {
    fence.held = true
    fence.holderKind = holderKind
    release = makeFenceRelease()
  }
  try {
    await diskBarrier('afterSceneNamespaceFenceAcquire')
    await diskFault('fence', 'afterSceneNamespaceFenceAcquire')
    return release
  } catch (error) {
    release()
    throw error
  }
}

function makeFenceRelease() {
  let released = false
  return () => {
    if (released) return
    released = true
    diskBarrierSync('beforeSceneNamespaceFenceRelease')
    const fence = storage.fence
    fence.completedOps += 1
    const following = fence.waiters.shift()
    fence.waiterCount = fence.waiters.length
    if (following !== undefined) {
      fence.holderKind = following.holderKind
      following.resolve(makeFenceRelease())
    } else {
      fence.held = false
      fence.holderKind = null
    }
  }
}

function fencePoisoned() {
  return storage !== null && (storage.namespacePoison || storage.fence.state === 'namespace-recovery-required')
}

function poisonNamespace(reason) {
  if (storage === null) return
  storage.fence.state = 'namespace-recovery-required'
  storage.namespacePoison = true
  storage.reason = storage.reason ?? reason
  sceneWritePreserve = true
  diskBarrierSync('afterSceneNamespaceFencePoison')
}

function ensureFenceOpen() {
  if (fencePoisoned()) throw new DiskError('namespace-recovery-required')
}

function isSharedNamespaceFd(fd) {
  if (storage === null || storage.dirFds === null) return false
  return fd === storage.dirFds.scenes || fd === storage.dirFds.trash
}

function sharedNamespaceGuard(fd) {
  if (isSharedNamespaceFd(fd)) ensureFenceOpen()
}

function noteFenceCounter(name) {
  if (storage !== null && storage.fence !== null && typeof storage.fence[name] === 'number') {
    storage.fence[name] += 1
    if (storage.testConfig.recordFenceEvents === true && Array.isArray(storage.fence.events)) {
      storage.fence.events.push(name)
      if (storage.fence.events.length > 256) storage.fence.events.shift()
    }
  }
}

function acquireDiskQueue(kind, key) {
  const caps = { scene: 32, asset: 8, thumbnail: 64, share: 8 }
  return storage.queues[kind].acquire(key, caps[kind])
}

async function runWithQueues(keys, fn) {
  const releases = []
  try {
    for (const { kind, key } of keys) {
      releases.push(await acquireDiskQueue(kind, key))
    }
    return await fn()
  } finally {
    for (let index = releases.length - 1; index >= 0; index -= 1) releases[index]()
  }
}

async function runStartupPhase(name, fn) {
  if (startupDeadlineExceeded()) throw new DiskError('startup-deadline')
  await diskBarrier(name)
  await diskFault('startup', name)
  await fn()
}

function closeStorageFds() {
  const state = storage
  if (state === null) return
  if (state.dirFds !== null) {
    for (const fd of Object.values(state.dirFds)) {
      try { fs.closeSync(fd) } catch (error) { void error }
    }
    state.dirFds = null
  }
  if (state.rootFd !== null) {
    try { fs.closeSync(state.rootFd) } catch (error) { void error }
    state.rootFd = null
  }
}

function releaseStorageLock() {
  const state = storage
  if (state === null || !state.lockHeld || state.rootFd === null) return false
  const released = releaseDiskLock(state.rootFd, state.lockToken)
  if (released) state.lockHeld = false
  return released
}

async function startStorage() {
  const state = ensureStorage()
  if (state.started) return
  state.started = true
  state.readyPromise = new Promise(resolve => { state.readyResolve = resolve })
  const config = diskConfigFromEnv()
  if (config.mode === 'memory' || config.mode === 'degraded') {
    state.mode = config.mode
    state.status = config.status
    state.readyResolve()
    state.readyDone = true
    return
  }
  state.mode = 'disk-candidate'
  state.status = 'starting'
  state.root = config.root
  state.homeRoot = config.homeRoot
  state.testMode = config.isolatedTest
  state.startupStartedAt = Date.now()
  state.starting = (async () => {
    try {
      await openStorageRoot(config)
      state.mode = 'disk'
      state.status = 'ready'
    } catch (error) {
      const code = error instanceof DiskError ? error.code : 'storage-unavailable'
      setDiskDegraded(code, code)
      // A degraded store never mutates; release any lock acquired before the
      // failure while the anchored root fd is still open.
      try { releaseStorageLock() } catch (lockError) { void lockError }
      try { closeStorageFds() } catch (closeError) { void closeError }
    } finally {
      state.startupComplete = true
      resolveStorageReady()
    }
  })()
}

async function storageReady() {
  const state = ensureStorage()
  if (!state.started) await startStorage()
  if (state.readyPromise === undefined || state.readyPromise === null) return
  await state.readyPromise
}

/**
 * True only while a started Host store is still loading. Direct store-seam
 * test calls that never registered the plugin are memory mode and must keep
 * their historical synchronous entry semantics, so handlers skip the await
 * entirely rather than awaiting an already-resolved promise.
 */
function storageNeedsReady() {
  return storage !== null && storage.started && !storage.readyDone
}

function stopStorage() {
  const state = storage
  if (state === null || !state.started) return Promise.resolve()
  if (state.stopping !== null) return state.stopping
  state.closing = true
  for (const queue of Object.values(state.queues)) queue.close()
  state.stopping = (async () => {
    try {
      await Promise.race([
        state.starting ?? Promise.resolve(),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ])
      const deadline = Date.now() + 5000
      while (state.activeTasks > 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      if (state.activeTasks > 0) {
        state.lockReleaseDeferred = true
        return
      }
      if (state.lockHeld) {
        const released = releaseStorageLock()
        if (!released && state.lockHeld) state.lockReleaseDeferred = true
      }
      closeStorageFds()
    } catch (error) {
      // Stop is idempotent and never rejects; a held lock stays fail-closed.
      void error
    }
  })()
  return state.stopping
}

function storageInspect() {
  const state = storage
  if (state === null) {
    return {
      mode: 'memory', status: 'idle', namespaceFence: null,
    }
  }
  return {
    mode: state.mode === 'disk-candidate' ? 'memory' : state.mode,
    status: state.status,
    reason: state.reason,
    loaded: state.startupComplete,
    counters: {
      ...state.stats,
      sceneWritePreserve,
      sceneWriteDegraded,
      thumbnailWriteDegraded,
    },
    namespaceFence: state.fence === null ? null : {
      state: fencePoisoned() ? 'namespace-recovery-required' : 'normal',
      held: state.fence.held,
      holderKind: state.fence.held ? fenceHolderLabel(state.fence.holderKind) : null,
      waiterCount: state.fence.waiterCount,
      completedOps: state.fence.completedOps,
      boundaryRename: state.fence.boundaryRename,
      boundaryTrashParentFsync: state.fence.boundaryTrashParentFsync,
      boundaryScenesParentFsync: state.fence.boundaryScenesParentFsync,
      cleanupRename: state.fence.cleanupRename,
      cleanupScenesParentFsync: state.fence.cleanupScenesParentFsync,
      startupInertScenesParentFsync: state.fence.startupInertScenesParentFsync,
      startupRestoreScenesParentFsync: state.fence.startupRestoreScenesParentFsync,
      startupTrashParentFsync: state.fence.startupTrashParentFsync,
      startupRestoreRename: state.fence.startupRestoreRename,
    },
  }
}

function validateSceneRevisionBytes(bytes, filenameOrder, expectedSidHash = null) {
  if (bytes.length > 2 * 1024 * 1024) throw new DiskError('size')
  const record = parseDiskJson(bytes)
  const keys = ['v', 'kind', 'sceneId', 'epoch', 'revision', 'order', 'title', 'code',
    'bytes', 'updatedAt', 'sha256', 'recordSha256']
  if (!exactKeys(record, keys)) throw new DiskError('schema')
  if (record.v !== 1 || record.kind !== 'scene-revision') throw new DiskError('schema')
  if (!isSafeSceneId(record.sceneId)) throw new DiskError('schema')
  if (!HEX32_RE.test(record.epoch)) throw new DiskError('schema')
  if (!isSafePositive(record.revision) || record.revision > MAX_ORDER) throw new DiskError('schema')
  if (!isSafePositive(record.order) || record.order > MAX_ORDER) throw new DiskError('schema')
  if (filenameOrder !== undefined && record.order !== filenameOrder) throw new DiskError('name')
  if (typeof record.title !== 'string' || bytesOfText(record.title) > MAX_SCENE_TITLE_BYTES) {
    throw new DiskError('size')
  }
  if (typeof record.code !== 'string' || bytesOfText(record.code) > MAX_CODE_BYTES) throw new DiskError('size')
  if (!isSafeCount(record.bytes) || record.bytes !== bytesOfText(record.code)) throw new DiskError('schema')
  if (!isSafeCount(record.updatedAt)) throw new DiskError('schema')
  if (typeof record.sha256 !== 'string' || !HEX64_RE.test(record.sha256)
    || record.sha256 !== diskSha(Buffer.from(record.code, 'utf8'))) throw new DiskError('hash')
  const expected = recordHash([
    ['v', 1], ['kind', record.kind], ['sceneId', record.sceneId], ['epoch', record.epoch],
    ['revision', record.revision], ['order', record.order], ['title', record.title],
    ['code', record.code], ['bytes', record.bytes], ['updatedAt', record.updatedAt],
    ['sha256', record.sha256],
  ])
  if (record.recordSha256 !== expected) throw new DiskError('hash')
  if (expectedSidHash !== null && sceneSidHash(record.sceneId) !== expectedSidHash) {
    throw new DiskError('hash')
  }
  const memory = {
    sceneId: record.sceneId,
    revision: record.revision,
    title: record.title,
    code: record.code,
    bytes: record.bytes,
    updatedAt: record.updatedAt,
  }
  return { record, memory, recordSha256: expected, order: record.order }
}

function validateSceneMarkerBytes(bytes, sidHash, filenameOrder) {
  if (bytes.length > MAX_SCENE_MARKER_BYTES) throw new DiskError('size')
  const marker = parseDiskJson(bytes)
  const keys = ['v', 'kind', 'sidHash', 'order', 'revision', 'recordSha256', 'markerSha256']
  if (!exactKeys(marker, keys)) throw new DiskError('schema')
  if (marker.v !== 1 || marker.kind !== 'scene-commit') throw new DiskError('schema')
  if (marker.sidHash !== sidHash || marker.order !== filenameOrder) throw new DiskError('name')
  if (!isSafePositive(marker.order) || marker.order > MAX_ORDER
    || !isSafePositive(marker.revision) || marker.revision > MAX_ORDER) throw new DiskError('schema')
  if (!HEX64_RE.test(marker.recordSha256) || !HEX64_RE.test(marker.markerSha256)) throw new DiskError('schema')
  const expected = canonicalPairsHash([
    ['v', 1], ['kind', marker.kind], ['sidHash', marker.sidHash], ['order', marker.order],
    ['revision', marker.revision], ['recordSha256', marker.recordSha256],
  ], 'twb:scene-commit:v1\0')
  if (marker.markerSha256 !== expected) throw new DiskError('hash')
  const canonical = serializeRecord(marker)
  if (!canonical.equals(bytes)) throw new DiskError('schema')
  return marker
}

function validateScenePair(revisionFile, markerFile, sidHash) {
  const revision = revisionFile.validation
  const marker = markerFile.validation
  if (marker === null) return { acknowledged: false }
  if (marker.order !== revision.order || marker.revision !== revision.record.revision
    || marker.recordSha256 !== revision.recordSha256) return { acknowledged: false }
  return { acknowledged: true }
}

function validateOwnerRecordBytes(bytes, sidHash) {
  if (bytes.length > 1024) throw new DiskError('size')
  const owner = parseDiskJson(bytes)
  const keys = ['v', 'kind', 'sidHash', 'sceneEpoch', 'incarnation', 'updatedAt', 'recordSha256']
  if (!exactKeys(owner, keys)) throw new DiskError('schema')
  if (owner.v !== 1 || owner.kind !== 'asset-owner') throw new DiskError('schema')
  if (owner.sidHash !== sidHash || !HEX32_RE.test(owner.sceneEpoch)
    || !HEX32_RE.test(owner.incarnation) || !isSafeCount(owner.updatedAt)) throw new DiskError('schema')
  if (!HEX64_RE.test(owner.recordSha256)) throw new DiskError('schema')
  const expected = recordHash([
    ['v', 1], ['kind', owner.kind], ['sidHash', owner.sidHash], ['sceneEpoch', owner.sceneEpoch],
    ['incarnation', owner.incarnation], ['updatedAt', owner.updatedAt],
  ])
  if (expected !== owner.recordSha256) throw new DiskError('hash')
  const canonical = serializeRecord(owner)
  if (!canonical.equals(bytes)) throw new DiskError('schema')
  return owner
}

function buildOwnerRecord(sidHash, sceneEpoch, incarnation, updatedAt) {
  const object = {
    v: 1,
    kind: 'asset-owner',
    sidHash,
    sceneEpoch,
    incarnation,
    updatedAt,
  }
  object.recordSha256 = recordHash([
    ['v', 1], ['kind', object.kind], ['sidHash', object.sidHash], ['sceneEpoch', object.sceneEpoch],
    ['incarnation', object.incarnation], ['updatedAt', object.updatedAt],
  ])
  return { object, bytes: serializeRecord(object) }
}

function loadAssetOwnerRecord(sessionFd, sidHash) {
  const bytes = readFileAt(sessionFd, 'owner.json', 1024)
  return { owner: validateOwnerRecordBytes(bytes, sidHash), bytes: bytes.length }
}

function writeAssetOwnerRecord(sessionFd, sidHash, sceneEpoch, incarnation, updatedAt, options = {}) {
  const owner = buildOwnerRecord(sidHash, sceneEpoch, incarnation, updatedAt)
  writeFileDurableSync(sessionFd, 'owner.json', owner.bytes, options)
  return owner
}

function currentIncarnationFor(sidHash) {
  const owner = assetOwnerRecords.get(sidHash)
  return owner === undefined || owner === null ? 'legacy' : owner.incarnation
}

function validateAssetMetaBytes(bytes, sidHash, assetHash) {
  if (bytes.length > MAX_ASSET_META_BYTES_PER_FILE) throw new DiskError('size')
  const meta = parseDiskJson(bytes)
  const keys = ['v', 'kind', 'sceneId', 'sceneEpoch', 'id', 'name', 'nameFold', 'assetKind',
    'mime', 'ext', 'bytes', 'order', 'createdAt', 'sha256', 'recordSha256']
  if (!exactKeys(meta, keys)) throw new DiskError('schema')
  if (meta.v !== 1 || meta.kind !== 'asset') throw new DiskError('schema')
  if (!isSafeSceneId(meta.sceneId)) throw new DiskError('schema')
  if (assetIdHash(meta.id) !== assetHash) throw new DiskError('name')
  if (sidHash !== undefined && sidHash !== null && sceneSidHash(meta.sceneId) !== sidHash) {
    throw new DiskError('hash')
  }
  if (!HEX32_RE.test(meta.sceneEpoch)) throw new DiskError('schema')
  if (typeof meta.id !== 'string' || !ASSET_ID_RE.test(meta.id)) throw new DiskError('schema')
  if (typeof meta.name !== 'string' || meta.name === '' || typeof meta.nameFold !== 'string'
    || meta.nameFold === '') throw new DiskError('schema')
  if (!['image', 'model', 'hdri', 'binary'].includes(meta.assetKind)) throw new DiskError('schema')
  if (typeof meta.mime !== 'string' || typeof meta.ext !== 'string') throw new DiskError('schema')
  if (!isSafePositive(meta.bytes) || meta.bytes > ASSET_LIMITS.maxUploadBytes) throw new DiskError('schema')
  if (!isSafePositive(meta.order) || meta.order > MAX_ORDER) throw new DiskError('schema')
  if (!isSafeCount(meta.createdAt)) throw new DiskError('schema')
  if (typeof meta.sha256 !== 'string' || !HEX64_RE.test(meta.sha256)) throw new DiskError('hash')
  if (!HEX64_RE.test(meta.recordSha256)) throw new DiskError('schema')
  const expected = recordHash([
    ['v', 1], ['kind', meta.kind], ['sceneId', meta.sceneId], ['sceneEpoch', meta.sceneEpoch],
    ['id', meta.id], ['name', meta.name], ['nameFold', meta.nameFold], ['assetKind', meta.assetKind],
    ['mime', meta.mime], ['ext', meta.ext], ['bytes', meta.bytes], ['order', meta.order],
    ['createdAt', meta.createdAt], ['sha256', meta.sha256],
  ])
  if (expected !== meta.recordSha256) throw new DiskError('hash')
  const canonical = serializeRecord(meta)
  if (!canonical.equals(bytes)) throw new DiskError('schema')
  void sidHash
  return meta
}

function buildAssetMeta(fields) {
  const meta = {
    v: 1,
    kind: 'asset',
    sceneId: fields.sceneId,
    sceneEpoch: fields.sceneEpoch,
    id: fields.id,
    name: fields.name,
    nameFold: fields.nameFold,
    assetKind: fields.kind,
    mime: fields.mime,
    ext: fields.ext,
    bytes: fields.bytes,
    order: fields.order,
    createdAt: fields.createdAt,
    sha256: fields.sha256,
  }
  meta.recordSha256 = recordHash([
    ['v', 1], ['kind', meta.kind], ['sceneId', meta.sceneId], ['sceneEpoch', meta.sceneEpoch],
    ['id', meta.id], ['name', meta.name], ['nameFold', meta.nameFold], ['assetKind', meta.assetKind],
    ['mime', meta.mime], ['ext', meta.ext], ['bytes', meta.bytes], ['order', meta.order],
    ['createdAt', meta.createdAt], ['sha256', meta.sha256],
  ])
  return { object: meta, bytes: serializeRecord(meta) }
}

function validateShareRecordBytes(bytes, shareHash, document) {
  if (bytes.length > MAX_SHARE_RECORD_BYTES) throw new DiskError('size')
  const record = parseDiskJson(bytes)
  const keys = ['v', 'kind', 'id', 'order', 'ownerSessionHash', 'revision', 'title', 'code',
    'editorState', 'stateText', 'stepFps', 'metadataJson', 'bytes', 'createdAt', 'expiresAt',
    'deleteKeyHash', 'codeSha256', 'documentBytes', 'documentSha256', 'recordSha256']
  if (!exactKeys(record, keys)) throw new DiskError('schema')
  if (record.v !== 1 || record.kind !== 'share-record') throw new DiskError('schema')
  if (typeof record.id !== 'string' || !SHARE_ID_RE.test(record.id)
    || shareIdHash(record.id) !== shareHash) throw new DiskError('name')
  if (!isSafePositive(record.order) || record.order > MAX_ORDER) throw new DiskError('schema')
  if (!HEX64_RE.test(record.ownerSessionHash)) throw new DiskError('schema')
  if (!isSafeCount(record.revision)) throw new DiskError('schema')
  if (typeof record.title !== 'string' || Array.from(record.title).length > SHARE_LIMITS.titleCodePoints) {
    throw new DiskError('size')
  }
  if (typeof record.code !== 'string' || bytesOfText(record.code) > MAX_CODE_BYTES) throw new DiskError('size')
  if (record.editorState === null || typeof record.editorState !== 'object' || Array.isArray(record.editorState)) {
    throw new DiskError('schema')
  }
  if (typeof record.stateText !== 'string' || bytesOfText(record.stateText) > SHARE_LIMITS.maxStateBytes
    || record.stateText !== JSON.stringify(record.editorState)) throw new DiskError('schema')
  if (!Number.isInteger(record.stepFps) || record.stepFps < 1 || record.stepFps > SHARE_LIMITS.maxStepFps) {
    throw new DiskError('schema')
  }
  if (typeof record.metadataJson !== 'string' || bytesOfText(record.metadataJson) > SHARE_LIMITS.metadataMaxBytes) {
    throw new DiskError('size')
  }
  if (!isSafeCount(record.bytes) || !isSafeCount(record.createdAt) || !isSafeCount(record.expiresAt)) {
    throw new DiskError('schema')
  }
  if (record.expiresAt <= record.createdAt
    || record.expiresAt - record.createdAt < SHARE_LIMITS.minTtlSeconds * 1000
    || record.expiresAt - record.createdAt > SHARE_LIMITS.maxTtlSeconds * 1000) throw new DiskError('schema')
  if (diskNowMs() + SHARE_LIMITS.maxTtlSeconds * 1000 + MAX_SHARE_FUTURE_SKEW_MS < record.expiresAt) {
    throw new DiskError('schema')
  }
  if (!HEX64_RE.test(record.deleteKeyHash) || !HEX64_RE.test(record.codeSha256)
    || !isSafePositive(record.documentBytes) || !HEX64_RE.test(record.documentSha256)
    || !HEX64_RE.test(record.recordSha256)) throw new DiskError('schema')
  if (record.codeSha256 !== diskSha(Buffer.from(record.code, 'utf8'))) throw new DiskError('hash')
  if (document === undefined || document === null) {
    if (record.documentBytes > 26 * 1024 * 1024) throw new DiskError('size')
  } else {
    if (document.length !== record.documentBytes
      || diskSha(document) !== record.documentSha256) throw new DiskError('hash')
    if (!/^<!doctype html>/i.test(document.subarray(0, 64).toString('utf8'))) throw new DiskError('schema')
  }
  const expectedBytes = record.documentBytes + bytesOfText(record.metadataJson)
    + bytesOfText(record.code) + bytesOfText(record.stateText) + bytesOfText(record.title)
  if (record.bytes !== expectedBytes || record.bytes > SHARE_LIMITS.maxShareBytes) throw new DiskError('schema')
  const metadataExpected = buildShareMetadata(record.title, record.revision, record.stepFps,
    record.createdAt, record.expiresAt)
  if (record.metadataJson !== metadataExpected) throw new DiskError('hash')
  const expected = recordHash([
    ['v', 1], ['kind', record.kind], ['id', record.id], ['order', record.order],
    ['ownerSessionHash', record.ownerSessionHash], ['revision', record.revision],
    ['title', record.title], ['code', record.code],
    ['editorState', JSON.stringify(record.editorState)], ['stateText', record.stateText],
    ['stepFps', record.stepFps], ['metadataJson', record.metadataJson], ['bytes', record.bytes],
    ['createdAt', record.createdAt], ['expiresAt', record.expiresAt],
    ['deleteKeyHash', record.deleteKeyHash], ['codeSha256', record.codeSha256],
    ['documentBytes', record.documentBytes], ['documentSha256', record.documentSha256],
  ])
  if (expected !== record.recordSha256) throw new DiskError('hash')
  return record
}

function buildShareDiskRecord(record, order, document) {
  const stateText = JSON.stringify(record.editorState)
  const object = {
    v: 1,
    kind: 'share-record',
    id: record.id,
    order,
    ownerSessionHash: record.ownerSessionHash,
    revision: record.revision,
    title: record.title,
    code: record.code,
    editorState: record.editorState,
    stateText,
    stepFps: record.stepFps,
    metadataJson: record.metadataJson,
    bytes: record.bytes,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    deleteKeyHash: record.deleteKeyHash,
    codeSha256: diskSha(Buffer.from(record.code, 'utf8')),
    documentBytes: document.length,
    documentSha256: diskSha(document),
  }
  object.recordSha256 = recordHash([
    ['v', 1], ['kind', object.kind], ['id', object.id], ['order', object.order],
    ['ownerSessionHash', object.ownerSessionHash], ['revision', object.revision],
    ['title', object.title], ['code', object.code],
    ['editorState', typeof object.editorState === 'string' ? object.editorState : JSON.stringify(object.editorState)],
    ['stateText', object.stateText], ['stepFps', object.stepFps], ['metadataJson', object.metadataJson],
    ['bytes', object.bytes], ['createdAt', object.createdAt], ['expiresAt', object.expiresAt],
    ['deleteKeyHash', object.deleteKeyHash], ['codeSha256', object.codeSha256],
    ['documentBytes', object.documentBytes], ['documentSha256', object.documentSha256],
  ])
  return { object, bytes: serializeRecord(object) }
}

function validateThumbIndexBytes(bytes) {
  if (bytes.length > MAX_THUMB_INDEX_BYTES) throw new DiskError('size')
  const index = parseDiskJson(bytes)
  const keys = ['v', 'kind', 'nextOrder', 'entries', 'recordSha256']
  if (!exactKeys(index, keys)) throw new DiskError('schema')
  if (index.v !== 1 || index.kind !== 'thumbnail-index'
    || !isSafePositive(index.nextOrder) || index.nextOrder > MAX_ORDER) throw new DiskError('schema')
  if (!Array.isArray(index.entries) || index.entries.length > MAX_THUMB_ENTRIES) throw new DiskError('size')
  for (const entry of index.entries) {
    const names = ['key', 'sceneId', 'revision', 'order', 'bytes', 'sha256', 'createdAt']
    if (!exactKeys(entry, names)) throw new DiskError('schema')
    if (typeof entry.key !== 'string' || !isSafeSceneId(entry.sceneId)
      || !isSafeCount(entry.revision) || !isSafePositive(entry.order) || entry.order > MAX_ORDER
      || !isSafePositive(entry.bytes) || entry.bytes > MAX_THUMBNAIL_BYTES
      || typeof entry.sha256 !== 'string' || !HEX64_RE.test(entry.sha256)
      || !isSafeCount(entry.createdAt)) throw new DiskError('schema')
    if (entry.key !== `${entry.sceneId}:${String(entry.revision)}`) throw new DiskError('schema')
  }
  const expected = recordHash([
    ['v', 1], ['kind', index.kind], ['nextOrder', index.nextOrder],
    ['entries', JSON.stringify(index.entries)],
  ])
  if (expected !== index.recordSha256) throw new DiskError('hash')
  return index
}

function buildThumbIndex(entries, nextOrder) {
  const object = { v: 1, kind: 'thumbnail-index', nextOrder, entries }
  object.recordSha256 = recordHash([
    ['v', 1], ['kind', object.kind], ['nextOrder', object.nextOrder],
    ['entries', JSON.stringify(object.entries)],
  ])
  return { object, bytes: serializeRecord(object) }
}

function validateThumbEntryIndex(entries, sceneId, revision) {
  let found = null
  for (const entry of entries) {
    if (entry.key !== `${sceneId}:${String(revision)}`) continue
    if (found !== null) throw new DiskError('duplicate')
    found = entry
  }
  return found
}

async function runStartupLoad() {
  const state = storage
  if (state.fence === null) state.fence = createSceneNamespaceFence()
  await runStartupPhase('startupBoundaryReconciliation', startupBoundaryReconciliation)
  await runStartupPhase('startupCleanup', startupCleanup)
  await runStartupPhase('startupScenes', loadScenesPhase)
  await runStartupPhase('startupThumbnails', loadThumbnailsPhase)
  await runStartupPhase('startupAssets', loadAssetsPhase)
  await runStartupPhase('startupShares', loadSharesPhase)
  await runStartupPhase('startupIndexRewrite', startupIndexRewrite)
  if (state.budget !== null && state.dirFds !== null && state.rootFd !== null) {
    state.budget.used = measureRootUsage(state.dirFds, state.rootFd)
    try {
      state.budget.trashBytes = measureTrashUsage()
    } catch (error) {
      state.budget.trashBytes = MAX_TRASH_PRESSURE_BYTES + 1
    }
    state.ordinaryTrash.clear()
    if (state.startupBoundaryTruncated !== true) {
      try {
        for (const entry of readdirAt(state.dirFds.trash)) {
          if (INTENT_RE.test(entry.name)) continue
          if (entry.name.endsWith('.intent.json')) continue
          if (state.startupBoundaryPreservedSlots?.has(entry.name)) continue
          state.ordinaryTrash.set(entry.name, measureTreeBytes(state.dirFds.trash, entry.name))
        }
      } catch (error) {
        // Unknown trash content is preserved and pressure stays fail-closed.
      }
    }
    state.budget.pumpStagingWaiters()
  }
  // Crash exactly after startupIndexRewrite (and the bounded trash scan that
  // follows it) but before storage readiness is published.
  await diskBarrier('startupReady')
}

function startupTrashFsync() {
  if (storage === null || storage.dirFds === null) return
  if (fencePoisoned()) throw new DiskError('namespace-recovery-required')
  fsyncFd(storage.dirFds.trash)
  storage.fence.startupTrashParentFsync += 1
}

async function startupBoundaryReconciliation() {
  const state = storage
  if (state.dirFds === null) return
  const trashFd = state.dirFds.trash
  const scenesFd = state.dirFds.scenes
  let entries
  try { entries = readdirAt(trashFd) } catch (error) { throw new DiskError('storage-unavailable', error) }
  // Complete the intent scan before making any decision that can mutate the
  // namespace. A capped or incomplete scan preserves every intent and slot and
  // must not accept, unlink, or fsync even the entries it managed to inspect.
  const intents = []
  let truncated = false
  try {
    for (const entry of entries) {
      if (startupDeadlineExceeded()) {
        truncated = true
        break
      }
      noteScanEntry()
      if (!INTENT_RE.test(entry.name)) continue
      if (intents.length >= MAX_BOUNDARY_INTENTS) {
        truncated = true
        break
      }
      intents.push(entry)
    }
  } catch (error) {
    truncated = true
  }
  if (!truncated && startupDeadlineExceeded()) truncated = true
  state.stats.startupBoundaryIntents = intents.length
  if (truncated) {
    state.stats.startupBoundaryTruncated = 1
    state.startupBoundaryPreservedSlots = new Set()
    state.startupBoundaryTruncated = true
    sceneWritePreserve = true
    return
  }
  const preservedSlots = new Set()
  const plans = []
  for (const dirent of intents) {
    if (startupDeadlineExceeded()) {
      truncated = true
      break
    }
    const basename = dirent.name
    const prefixMatch = INTENT_RE.exec(basename)
    let intent
    try {
      if (!dirent.isFile() || dirent.isSymbolicLink()) throw new DiskError('symlink')
      const bytes = readFileAt(trashFd, basename, MAX_BOUNDARY_INTENT_BYTES)
      intent = validateBoundaryIntentBytes(bytes, basename)
    } catch (error) {
      state.stats.startupBoundaryInvalid += 1
      if (prefixMatch !== null) preservedSlots.add(prefixMatch[1])
      continue
    }
    const slotName = intent.slot
    let slotStat = null
    try { slotStat = fileStatAt(trashFd, slotName) } catch (error) { slotStat = null }
    if (slotStat !== null) preservedSlots.add(slotName)
    const targetName = intent.sidHash
    let targetStat = null
    try { targetStat = fileStatAt(scenesFd, targetName) } catch (error) { targetStat = null }
    const markerMatch = sceneBoundaryMarkerMatches(scenesFd, targetName, intent)
    if (markerMatch) {
      plans.push({ kind: 'chosen', basename, slotName })
      continue
    }
    if (slotStat === null) {
      if (targetStat === null || !targetStat.isDirectory() || targetStat.isSymbolicLink()) {
        state.stats.startupBoundaryInvalid += 1
        continue
      }
      plans.push({ kind: 'inert', basename })
      continue
    }
    // A slot is present. Validate the whole old-generation slot without edits.
    const classification = classifyBoundarySlot(trashFd, slotName, intent.sidHash)
    if (!classification.ok) {
      state.stats.startupBoundaryRecovery += 1
      sceneWritePreserve = true
      continue
    }
    plans.push({ kind: 'restore', basename, slotName, targetName, targetStat, intent })
  }
  if (!truncated && startupDeadlineExceeded()) truncated = true
  if (truncated) {
    state.stats.startupBoundaryTruncated = 1
    state.startupBoundaryPreservedSlots = preservedSlots
    state.startupBoundaryTruncated = true
    sceneWritePreserve = true
    return
  }
  for (const plan of plans) {
    const basename = plan.basename
    if (plan.kind === 'chosen') {
      // The new generation is acknowledged; the referenced slot is ordinary
      // product trash and the inert intent may be removed. No restoration.
      const release = await acquireFence('boundary-startup-chosen')
      try {
        ensureFenceOpen()
        try { unlinkAt(trashFd, basename) } catch (error) { if (error?.code !== 'ENOENT') throw error }
        preservedSlots.delete(plan.slotName)
        if (!fencePoisoned()) {
          fsyncFd(trashFd)
          noteFenceCounter('startupTrashParentFsync')
        }
      } catch (error) {
        if (error instanceof DiskError && error.code === 'namespace-recovery-required') {
          poisonNamespace('startup')
        } else {
          state.stats.startupBoundaryRecovery += 1
          sceneWritePreserve = true
        }
      } finally {
        release()
      }
      continue
    }
    if (plan.kind === 'inert') {
      // Inert intent: the old directory must already be the live scenes name.
      const release = await acquireFence('boundary-startup-inert')
      try {
        ensureFenceOpen()
        try {
          await diskFault('dirFsync', 'scene-generation-boundary-startup-inert-scenes-parent')
          fsyncFd(scenesFd)
          state.fence.startupInertScenesParentFsync += 1
          state.stats.startupInert += 1
          // The old name is durable; the inert intent is now ordinary trash.
          try { unlinkAt(trashFd, basename) } catch (error) { if (error?.code !== 'ENOENT') throw error }
          fsyncFd(trashFd)
          state.fence.startupTrashParentFsync += 1
        } catch (error) {
          poisonNamespace('startup-inert')
          state.stats.startupBoundaryRecovery += 1
        }
      } finally {
        release()
      }
      continue
    }
    const intent = plan.intent
    const targetName = plan.targetName
    const targetStat = plan.targetStat
    const slotName = plan.slotName
    const release = await acquireFence('boundary-startup-restore')
    try {
      ensureFenceOpen()
      let targetFd = null
      let targetIsDirectory = targetStat !== null && targetStat.isDirectory() && !targetStat.isSymbolicLink()
      if (targetIsDirectory) {
        try {
          targetFd = openDirAt(scenesFd, targetName)
        } catch (error) {
          targetFd = null
          targetIsDirectory = false
        }
      }
      if (targetIsDirectory && targetFd !== null) {
        try {
          const orderName = `${String(intent.newOrder).padStart(16, '0')}.json`
          const markerName = `${String(intent.newOrder).padStart(16, '0')}.commit.json`
          const childStat = fileStatAt(targetFd, orderName)
          if (childStat !== null && childStat.isFile() && !childStat.isSymbolicLink()
            && fileStatAt(targetFd, markerName) === null) {
            try {
              const revision = validateSceneRevisionBytes(
                readFileAt(targetFd, orderName, 2 * 1024 * 1024), intent.newOrder, intent.sidHash)
              if (revision.recordSha256 === intent.newRevisionRecordSha256) {
                unlinkAt(targetFd, orderName)
                fsyncFd(targetFd)
              }
            } catch (error) { void error }
          }
          const remaining = readdirAt(targetFd)
          if (remaining.length > 0) {
            // Present non-empty target: preserve both copies without merging,
            // overwriting, deleting, or renaming either.
            fs.closeSync(targetFd)
            targetFd = null
            state.stats.startupBoundaryRecovery += 1
            sceneWritePreserve = true
            continue
          }
          // Empty target is atomically replaced by the old generation.
          fs.closeSync(targetFd)
          targetFd = null
          try { rmdirAt(scenesFd, targetName) } catch (error) {
            if (error?.code !== 'ENOENT') throw error
          }
        } catch (error) {
          if (targetFd !== null) {
            try { fs.closeSync(targetFd) } catch (closeError) { void closeError }
            targetFd = null
          }
          state.stats.startupBoundaryRecovery += 1
          sceneWritePreserve = true
          continue
        }
      }
      if (targetFd !== null) {
        try { fs.closeSync(targetFd) } catch (error) { void error }
        targetFd = null
      }
      if (targetStat !== null && targetStat.isDirectory() && targetIsDirectory) {
        // handled above
      } else if (targetStat !== null) {
        // A non-empty/non-directory target is preserved with the slot.
        state.stats.startupBoundaryRecovery += 1
        sceneWritePreserve = true
        continue
      }
      let slotFd
      try {
        slotFd = openDirAt(trashFd, slotName)
      } catch (error) {
        state.stats.startupBoundaryRecovery += 1
        sceneWritePreserve = true
        continue
      }
      try {
        try {
          await diskFault('trashRename', 'scene-generation-boundary-startup-restore')
          renameAt(trashFd, slotName, scenesFd, targetName)
          noteFenceCounter('startupRestoreRename')
        } catch (error) {
          state.stats.startupBoundaryRecovery += 1
          sceneWritePreserve = true
          continue
        }
        try {
          await diskFault('dirFsync', 'scene-generation-boundary-startup-restore-scenes-parent')
          fsyncFd(scenesFd)
          state.fence.startupRestoreScenesParentFsync += 1
          state.stats.startupRestored += 1
        } catch (error) {
          poisonNamespace('startup-restore')
          state.stats.startupBoundaryRecovery += 1
          continue
        }
        try {
          unlinkAt(trashFd, basename)
          fsyncFd(trashFd)
          state.fence.startupTrashParentFsync += 1
        } catch (error) {
          if (error instanceof DiskError && error.code === 'namespace-recovery-required') {
            poisonNamespace('startup')
          } else {
            state.stats.startupBoundaryRecovery += 1
            sceneWritePreserve = true
          }
        }
      } finally {
        fs.closeSync(slotFd)
      }
    } catch (error) {
      if (error instanceof DiskError && error.code === 'namespace-recovery-required') {
        poisonNamespace('startup')
      } else {
        state.stats.startupBoundaryRecovery += 1
        sceneWritePreserve = true
      }
    } finally {
      release()
    }
  }
  // Keep the exact preserved slot set for ordinary cleanup, and never let a
  // truncated scan turn into a destructive sweep.
  state.startupBoundaryPreservedSlots = preservedSlots
  state.startupBoundaryTruncated = false
}

function sceneBoundaryMarkerMatches(scenesFd, sidHash, intent) {
  let fd = null
  try {
    fd = openDirAt(scenesFd, sidHash)
  } catch (error) {
    return false
  }
  try {
    const orderName = String(intent.newOrder).padStart(16, '0')
    const markerName = `${orderName}.commit.json`
    let marker
    try {
      marker = validateSceneMarkerBytes(readFileAt(fd, markerName, MAX_SCENE_MARKER_BYTES),
        sidHash, intent.newOrder)
    } catch (error) {
      return false
    }
    if (marker.recordSha256 !== intent.newRevisionRecordSha256) return false
    let revision
    try {
      revision = validateSceneRevisionBytes(readFileAt(fd, `${orderName}.json`, 2 * 1024 * 1024),
        intent.newOrder, sidHash)
    } catch (error) {
      return false
    }
    return revision.recordSha256 === intent.newRevisionRecordSha256
      && revision.record.epoch === intent.newEpoch
  } finally {
    fs.closeSync(fd)
  }
}

function classifyBoundarySlot(trashFd, slotName, sidHash) {
  let slotFd
  try {
    slotFd = openDirAt(trashFd, slotName)
  } catch (error) {
    return { ok: false }
  }
  try {
    let entries = []
    try { entries = readdirAt(slotFd) } catch (error) { return { ok: false } }
    for (const entry of entries) {
      // Only a regular no-follow revision or commit-marker basename is a
      // recognized old-generation entry. Every other entry -- unknown regular,
      // symlink, directory, FIFO, or any non-regular entry with either pattern
      // -- makes the whole slot mismatched/unrestorable. Reconciliation then
      // preserves it and never restores through it.
      if (!entry.isFile() || entry.isSymbolicLink()) return { ok: false }
      if (SCENE_MARKER_RE.test(entry.name)) continue
      if (!SCENE_REVISION_RE.test(entry.name)) return { ok: false }
      const order = Number(entry.name.slice(0, 16))
      try {
        validateSceneRevisionBytes(readFileAt(slotFd, entry.name, 2 * 1024 * 1024), order, sidHash)
      } catch (error) {
        return { ok: false }
      }
    }
    return { ok: true }
  } finally {
    fs.closeSync(slotFd)
  }
}

async function startupCleanup() {
  const state = storage
  if (state.dirFds === null) return
  // Remove only generated pre-lock candidates of this root. LOCK.recover is
  // fail-closed state and is never removed.
  try {
    for (const entry of readdirAt(state.rootFd)) {
      noteScanEntry()
      if (!/^(?:ROOT|LOCK)\.tmp\.[a-f0-9]{32}$/.test(entry.name)
        && !/^LOCK\.stale\.[a-f0-9]{32}$/.test(entry.name)) continue
      try { unlinkAt(state.rootFd, entry.name) } catch (error) { void error }
    }
    fsyncFd(state.rootFd)
  } catch (error) {
    // Candidate cleanup is best-effort; unknown/root entries are preserved.
  }
  if (state.startupBoundaryTruncated === true) return
  const tmpFd = state.dirFds.tmp
  const trashFd = state.dirFds.trash
  try {
    const tmpEntries = readdirAt(tmpFd)
    let removed = 0
    for (const entry of tmpEntries) {
      if (removed >= MAX_TMP_ENTRIES) break
      noteScanEntry()
      try { removeTreeAt(tmpFd, entry.name) } catch (error) { void error }
      removed += 1
    }
    if (removed > 0) fsyncFd(tmpFd)
  } catch (error) {
    // Tmp cleanup is bounded and best-effort; a failure preserves data.
  }
  if (fencePoisoned()) return
  const release = await acquireFence('startup-cleanup')
  try {
    ensureFenceOpen()
    try {
      const entries = readdirAt(trashFd)
      let removed = 0
      let changed = false
      for (const entry of entries) {
        if (removed >= MAX_TRASH_ENTRIES) break
        if (startupDeadlineExceeded()) break
        noteScanEntry()
        if (INTENT_RE.test(entry.name)) continue
        if (state.startupBoundaryPreservedSlots?.has(entry.name)) continue
        try {
          removeTreeAt(trashFd, entry.name)
          removed += 1
          changed = true
        } catch (error) {
          // Preserve anything not safely removable.
        }
      }
      if (changed) {
        try {
          fsyncFd(trashFd)
          state.fence.startupTrashParentFsync += 1
        } catch (error) {
          if (error instanceof DiskError) poisonNamespace('startup-cleanup')
        }
      }
    } catch (error) {
      // Truncated/incomplete cleanup is counted as a preserve condition.
    }
  } finally {
    release()
  }
}

async function loadScenesPhase() {
  const state = storage
  if (state.dirFds === null) return
  const scenesFd = state.dirFds.scenes
  let dirents
  try { dirents = readdirAt(scenesFd) } catch (error) { throw new DiskError('storage-unavailable', error) }
  let globalStop = false
  let globalTruncated = false
  let directoryCapHit = false
  const sessionDirs = []
  for (const dirent of dirents) {
    state.scanCounters.sceneRootEntries += 1
    try { noteScanEntry() } catch (error) { globalStop = true; globalTruncated = true; break }
    if (!HEX64_RE.test(dirent.name)) continue
    if (sessionDirs.length >= MAX_SCENE_DIRS_SCANNED) {
      directoryCapHit = true
      globalTruncated = true
      break
    }
    if (!dirent.isDirectory() || dirent.isSymbolicLink()) {
      // A 64-hex non-directory is not a scene session. It is preserved and
      // counted, never traversed or treated as a no-acknowledged session.
      continue
    }
    sessionDirs.push(dirent.name)
    state.scanCounters.sceneDirs += 1
  }
  const inspectedOrders = []
  const pending = []
  const loaded = []
  let truncatedSessionCount = 0
  const queuePending = (sidHash, name, category) => {
    pending.push({ sidHash, name, category })
  }
  for (const sidHash of sessionDirs) {
    if (globalStop || startupDeadlineExceeded()) {
      globalStop = true
      globalTruncated = true
      break
    }
    let sessionFd
    try { sessionFd = openDirAt(scenesFd, sidHash) } catch (error) {
      globalTruncated = true
      sceneUnscanned.add(sidHash)
      truncatedSessionCount += 1
      continue
    }
    const pendingMark = pending.length
    try {
      let children
      try { children = readdirAt(sessionFd) } catch (error) {
        globalTruncated = true
        sceneUnscanned.add(sidHash)
        truncatedSessionCount += 1
        continue
      }
      let sessionTruncated = false
      const entries = []
      for (const child of children) {
        state.scanCounters.sceneSessionEntries += 1
        try { noteScanEntry() } catch (error) {
          globalStop = true
          globalTruncated = true
          sessionTruncated = true
          break
        }
        const isRevision = SCENE_REVISION_RE.test(child.name)
        const isMarker = SCENE_MARKER_RE.test(child.name)
        if (!isRevision && !isMarker) continue
        const order = Number(child.name.slice(0, 16))
        if (!Number.isSafeInteger(order) || order < 1 || order > MAX_ORDER) continue
        inspectedOrders.push(order)
        if (!child.isFile() || child.isSymbolicLink()) {
          sessionTruncated = true
          continue
        }
        entries.push({ name: child.name, order, isRevision })
      }
      if (entries.length > MAX_SCENE_ENTRIES_PER_DIR) sessionTruncated = true
      const retained = entries.length > MAX_SCENE_ENTRIES_PER_DIR
        ? entries.slice().sort((a, b) => b.order - a.order || a.name.localeCompare(b.name))
          .slice(0, MAX_SCENE_ENTRIES_PER_DIR)
        : entries
      if (globalStop || sessionTruncated) {
        pending.length = pendingMark
        sceneUnscanned.add(sidHash)
        truncatedSessionCount += 1
        continue
      }
      const revisionNames = new Map()
      const markerNames = new Map()
      for (const entry of retained) {
        if (entry.isRevision) revisionNames.set(entry.order, entry.name)
        else markerNames.set(entry.order, entry.name)
      }
      const candidateOrders = []
      for (const order of revisionNames.keys()) {
        if (markerNames.has(order)) candidateOrders.push(order)
      }
      candidateOrders.sort((a, b) => b - a)
      state.scanCounters.sceneCandidateOrders += candidateOrders.length
      if (candidateOrders.length > MAX_SCENE_FILES_READ) sessionTruncated = true
      // Markers for selected revision candidates, plus every orphan marker, are
      // inspected. Markers above the candidate read bound are omitted together
      // with their revisions, so the whole session is truncated and preserved.
      const markerOrders = new Set([...candidateOrders.slice(0, MAX_SCENE_FILES_READ)])
      for (const order of markerNames.keys()) {
        if (!revisionNames.has(order)) markerOrders.add(order)
      }
      const revisions = new Map()
      const markers = new Map()
      const readOrderLimit = candidateOrders.slice(0, MAX_SCENE_FILES_READ)
      for (const order of readOrderLimit) {
        if (startupDeadlineExceeded()) { globalStop = true; sessionTruncated = true; break }
        const name = revisionNames.get(order)
        let bytes
        try {
          await diskReadGate('scene-revision')
          state.scanCounters.sceneRevisionReads += 1
          bytes = readFileAt(sessionFd, name, 2 * 1024 * 1024)
        } catch (error) {
          if (error instanceof DiskError) queuePending(sidHash, name, quarantineReasonFor(error))
          else { sessionTruncated = true }
          continue
        }
        state.sceneReadBytes += bytes.length
        if (state.sceneReadBytes > state.maxSceneReadBytes) {
          globalStop = true
          globalTruncated = true
          sessionTruncated = true
          break
        }
        try {
          revisions.set(order, validateSceneRevisionBytes(bytes, order, sidHash))
        } catch (error) {
          if (error instanceof DiskError) queuePending(sidHash, name, quarantineReasonFor(error))
          else sessionTruncated = true
        }
      }
      if (!globalStop) {
        for (const order of markerOrders) {
          if (startupDeadlineExceeded()) { globalStop = true; sessionTruncated = true; break }
          const name = markerNames.get(order)
          let bytes
          try {
            await diskReadGate('scene-marker')
            state.scanCounters.sceneMarkerReads += 1
            bytes = readFileAt(sessionFd, name, MAX_SCENE_MARKER_BYTES)
          } catch (error) {
            if (error instanceof DiskError) queuePending(sidHash, name, quarantineReasonFor(error))
            else sessionTruncated = true
            continue
          }
          state.sceneReadBytes += bytes.length
          if (state.sceneReadBytes > state.maxSceneReadBytes) {
            globalStop = true
            globalTruncated = true
            sessionTruncated = true
            break
          }
          try {
            markers.set(order, validateSceneMarkerBytes(bytes, sidHash, order))
          } catch (error) {
            if (error instanceof DiskError) queuePending(sidHash, name, quarantineReasonFor(error))
            else sessionTruncated = true
          }
        }
      }
      if (sessionTruncated || globalStop) {
        pending.length = pendingMark
        sceneUnscanned.add(sidHash)
        truncatedSessionCount += 1
        continue
      }
      // A valid marker whose revision is invalid or absent is an orphan; it
      // never creates a revision and is removed/quarantined within bounds.
      for (const order of markers.keys()) {
        if (revisions.has(order)) continue
        queuePending(sidHash, markerNames.get(order), 'orphan')
      }
      const acknowledged = []
      for (const [order, revision] of revisions) {
        const marker = markers.get(order)
        if (marker === undefined) continue
        if (marker.revision === revision.record.revision
          && marker.recordSha256 === revision.recordSha256
          && marker.sidHash === sidHash) acknowledged.push(revision)
      }
      if (acknowledged.length === 0) {
        state.stats.unacknowledgedSceneSessions += 1
        continue
      }
      acknowledged.sort((a, b) => b.order - a.order)
      const chain = []
      const chainNames = new Set()
      let current = acknowledged[0]
      while (current !== undefined) {
        chain.push(current)
        chainNames.add(`${String(current.order).padStart(16, '0')}.json`)
        if (current.record.revision <= 1) break
        const wanted = current.record.revision - 1
        let best = null
        for (const candidate of acknowledged) {
          if (candidate.record.revision !== wanted) continue
          if (candidate.order >= current.order) continue
          if (candidate.record.sceneId !== current.record.sceneId) continue
          if (candidate.record.epoch !== current.record.epoch) continue
          if (best === null || candidate.order > best.order) best = candidate
        }
        if (best === null) break
        current = best
      }
      // Every acknowledged record outside the accepted chain is stale
      // generation evidence. Quarantine the record and its marker, never
      // select/sort/serve it or use its head.
      for (const candidate of acknowledged) {
        const revisionName = `${String(candidate.order).padStart(16, '0')}.json`
        if (chainNames.has(revisionName)) continue
        queuePending(sidHash, revisionName, 'stale-generation')
        const markerName = `${String(candidate.order).padStart(16, '0')}.commit.json`
        if (markers.has(candidate.order)) queuePending(sidHash, markerName, 'stale-generation')
      }
      const selected = chain.slice(0, MAX_REVISIONS)
      const ascending = selected.slice().sort((a, b) => a.record.order - b.record.order)
      const memoryHistory = ascending.map(item => item.memory)
      if (memoryHistory.length === 0) continue
      const sceneId = memoryHistory[0].sceneId
      const orderMap = new Map()
      for (const revision of ascending) orderMap.set(revision.record.revision, revision.order)
      loaded.push({
        sceneId,
        sidHash,
        headOrder: ascending[ascending.length - 1].order,
        epoch: ascending[ascending.length - 1].record.epoch,
        history: memoryHistory,
        orders: orderMap,
      })
    } finally {
      fs.closeSync(sessionFd)
    }
  }
  // Never mutate a store while an unread order may remain. Pending quarantine
  // actions and product eviction are applied only after a complete scene scan.
  if (!globalStop) {
    const seen = new Set()
    for (const action of pending) {
      const key = `${action.sidHash}/${action.name}`
      if (seen.has(key)) continue
      seen.add(key)
      try {
        const fd = openDirAt(scenesFd, action.sidHash)
        try {
          const moved = quarantineRootEntry(fd, action.name, action.category)
          if (!moved) sceneWritePreserve = true
        } finally { fs.closeSync(fd) }
      } catch (error) {
        sceneWritePreserve = true
        state.stats.quarantineFailures += 1
      }
    }
  }
  await diskBarrier('afterStartupSceneQuarantine')
  if (inspectedOrders.length > 0) {
    let maxOrder = nextSceneOrder - 1
    for (const order of inspectedOrders) if (order > maxOrder) maxOrder = order
    nextSceneOrder = Math.max(nextSceneOrder, maxOrder + 1)
  }
  if (globalTruncated || truncatedSessionCount > 0) {
    sceneScanTruncated = true
    sceneWritePreserve = true
    state.stats.startupTruncatedScenes += truncatedSessionCount + (globalTruncated ? 1 : 0)
  }
  if (directoryCapHit) state.stats.startupTruncatedScenes += 1
  if (nextSceneOrder > MAX_ORDER) {
    setDiskDegraded('scene-order', 'scene-order')
    throw new DiskError('storage-unavailable')
  }
  // Install only after the scan. A truncated/unscanned session never occupies
  // a keep slot and never evicts an acknowledged session.
  loaded.sort((a, b) => b.headOrder - a.headOrder || a.sidHash.localeCompare(b.sidHash))
  const keep = loaded.slice(0, MAX_SCENES)
  const evict = loaded.slice(MAX_SCENES)
  for (const item of keep) {
    scenes.set(item.sceneId, { history: item.history })
    sceneEpochs.set(item.sceneId, item.epoch)
    sceneRevisionOrderBySession.set(item.sceneId, item.orders)
  }
  if (evict.length > 0 && !globalStop) {
    for (const item of evict) {
      sceneProductEvicted.set(item.sceneId, true)
      state.stats.startupEvictedScenes += 1
      try {
        const release = await acquireFence('cleanup-product-evict')
        try {
          ensureFenceOpen()
          const slot = diskRandomHex()
          renameIntoTrash(scenesFd, item.sidHash, slot, true)
          noteFenceCounter('cleanupRename')
          fsyncFd(state.dirFds.trash)
          fsyncFd(scenesFd)
          noteFenceCounter('cleanupScenesParentFsync')
        } finally {
          release()
        }
      } catch (error) {
        sceneWritePreserve = true
      }
    }
  }
  // Insert surviving scenes oldest-first so Map order remains the product LRU.
  const ordered = keep.slice().sort((a, b) => a.headOrder - b.headOrder || b.sidHash.localeCompare(a.sidHash))
  const surviving = new Map()
  for (const item of ordered) {
    const entry = scenes.get(item.sceneId)
    if (entry !== undefined) surviving.set(item.sceneId, entry)
  }
  scenes.clear()
  for (const [sceneId, entry] of surviving) scenes.set(sceneId, entry)
}

async function loadThumbnailsPhase() {
  const state = storage
  if (state.dirFds === null) return
  const thumbFd = state.dirFds.thumbnails
  const removeOrphanThumbnails = (wanted) => {
    for (const dirent of readdirAt(thumbFd)) {
      noteScanEntry()
      if (dirent.name === 'index.json') continue
      if (!wanted.has(dirent.name)) {
        try { removeTreeAt(thumbFd, dirent.name) } catch (error) { void error }
      }
    }
  }
  let indexBytes
  try {
    indexBytes = readFileAt(thumbFd, 'index.json', MAX_THUMB_INDEX_BYTES)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try { quarantineRootEntry(thumbFd, 'index.json', quarantineReasonFor(error)) } catch (qError) { void qError }
    }
    removeOrphanThumbnails(new Set())
    state.stats.thumbnailDegraded = false
    return
  }
  let index
  try {
    index = validateThumbIndexBytes(indexBytes)
  } catch (error) {
    try { quarantineRootEntry(thumbFd, 'index.json', quarantineReasonFor(error)) } catch (qError) { void qError }
    removeOrphanThumbnails(new Set())
    state.stats.thumbnailDegraded = false
    return
  }
  const keys = new Set()
  const orders = new Set()
  const unique = []
  const orderedIndex = index.entries.slice().sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
  for (const entry of orderedIndex) {
    if (keys.has(entry.key) || orders.has(entry.order)) continue
    keys.add(entry.key)
    orders.add(entry.order)
    unique.push(entry)
  }
  const selected = []
  const selectedPerSession = new Map()
  for (const entry of unique.sort((a, b) => b.order - a.order)) {
    if (selected.length >= MAX_THUMBNAILS) break
    const count = selectedPerSession.get(entry.sceneId) ?? 0
    if (count >= MAX_THUMBNAILS_PER_SESSION) continue
    selectedPerSession.set(entry.sceneId, count + 1)
    selected.push(entry)
  }
  const perSession = new Map()
  const finalEntries = []
  let readBytes = 0
  for (const entry of selected) {
    const count = perSession.get(entry.sceneId) ?? 0
    if (readBytes + entry.bytes > MAX_THUMB_READ_BYTES) continue
    readBytes += entry.bytes
    let png
    const filename = thumbnailEntryFilename(entry)
    try {
      png = readFileAt(thumbFd, filename, entry.bytes)
      if (diskSha(png) !== entry.sha256
        || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new DiskError('hash')
    } catch (error) {
      try { quarantineRootEntry(thumbFd, filename, quarantineReasonFor(error)) } catch (qError) { void qError }
      continue
    }
    perSession.set(entry.sceneId, count + 1)
    finalEntries.push({ ...entry, png })
    nextThumbOrder = Math.max(nextThumbOrder, entry.order + 1)
  }
  finalEntries.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
  for (const entry of finalEntries) {
    thumbnails.set(entry.key, entry.png)
    thumbnailIndex.set(entry.key, {
      key: entry.key,
      sceneId: entry.sceneId,
      revision: entry.revision,
      order: entry.order,
      bytes: entry.bytes,
      sha256: entry.sha256,
      createdAt: entry.createdAt,
    })
  }
  nextThumbOrder = Math.max(nextThumbOrder, index.nextOrder)
  if (nextThumbOrder > MAX_ORDER) throw new DiskError('storage-unavailable')
  const wanted = new Set(finalEntries.map(entry => thumbnailEntryFilename(entry)))
  removeOrphanThumbnails(wanted)
}

async function loadAssetsPhase() {
  const state = storage
  if (state.dirFds === null) return
  const assetsFd = state.dirFds.assets
  let sessionEntries
  try { sessionEntries = readdirAt(assetsFd) } catch (error) { throw new DiskError('storage-unavailable', error) }
  let sessionsScanned = 0
  let dirsScanned = 0
  let metadataBytes = 0
  const loaded = []
  let maxInspectedAssetOrder = 0
  for (const sessionEntry of sessionEntries) {
    state.scanCounters.assetRootEntries += 1
    noteScanEntry()
    if (!HEX64_RE.test(sessionEntry.name) || !sessionEntry.isDirectory() || sessionEntry.isSymbolicLink()) continue
    if (sessionsScanned >= MAX_ASSET_SESSIONS_SCANNED) break
    sessionsScanned += 1
    state.scanCounters.assetSessions += 1
    const sidHash = sessionEntry.name
    let sessionFd
    try { sessionFd = openDirAt(assetsFd, sidHash) } catch (error) { continue }
    try {
      let owner = null
      try {
        const loadedOwner = loadAssetOwnerRecord(sessionFd, sidHash)
        metadataBytes += loadedOwner.bytes
        owner = loadedOwner.owner
        assetOwnerRecords.set(sidHash, owner)
      } catch (error) {
        owner = null
      }
      const assetEntries = []
      for (const dirent of readdirAt(sessionFd)) {
        noteScanEntry()
        if (dirent.name === 'owner.json') continue
        if (!HEX64_RE.test(dirent.name) || !dirent.isDirectory() || dirent.isSymbolicLink()) continue
        if (dirsScanned >= MAX_ASSET_DIRS_SCANNED) break
        dirsScanned += 1
        state.scanCounters.assetDirs += 1
        assetEntries.push(dirent.name)
      }
      const candidates = []
      for (const assetHash of assetEntries) {
        let assetFd
        try { assetFd = openDirAt(sessionFd, assetHash) } catch (error) { continue }
        try {
          if (fileStatAt(assetFd, 'COMMITTED') === null) {
            try { fs.closeSync(assetFd); assetFd = null; removeTreeAt(sessionFd, assetHash) } catch (error) { void error }
            continue
          }
          const names = new Set(readdirAt(assetFd).map(entry => entry.name))
          if (names.size !== 3 || !names.has('meta.json') || !names.has('body.bin')
            || !names.has('COMMITTED')) {
            try { quarantineRootEntry(sessionFd, assetHash, 'unexpected-entry') } catch (qError) { void qError }
            continue
          }
          try {
            const committed = readFileAt(assetFd, 'COMMITTED', 0)
            if (committed.length !== 0) throw new DiskError('schema')
          } catch (error) {
            try { quarantineRootEntry(sessionFd, assetHash, quarantineReasonFor(error)) } catch (qError) { void qError }
            continue
          }
          let metaBytes
          try {
            metaBytes = readFileAt(assetFd, 'meta.json', MAX_ASSET_META_BYTES_PER_FILE)
          } catch (error) {
            try { quarantineRootEntry(sessionFd, assetHash, quarantineReasonFor(error)) } catch (qError) { void qError }
            continue
          }
          metadataBytes += metaBytes.length
          if (metadataBytes > MAX_ASSET_META_BYTES) throw new DiskError('storage-full')
          let meta
          try {
            meta = validateAssetMetaBytes(metaBytes, sidHash, assetHash)
          } catch (error) {
            try { quarantineRootEntry(sessionFd, assetHash, quarantineReasonFor(error)) } catch (qError) { void qError }
            continue
          }
          maxInspectedAssetOrder = Math.max(maxInspectedAssetOrder, meta.order)
          candidates.push({ assetHash, meta, assetFd })
          assetFd = null
        } finally {
          if (assetFd !== null) {
            try { fs.closeSync(assetFd) } catch (error) { void error }
          }
        }
      }
      let served = []
      if (candidates.length > 0) {
        const sceneId = candidates[0].meta.sceneId
        const sceneEpoch = sceneEpochs.get(sceneId)
        const hasScene = scenes.has(sceneId)
        const candidateEpochs = [...new Set(candidates.map(item => item.meta.sceneEpoch))]
        let authoritative = null
        if (hasScene && sceneEpoch !== undefined) authoritative = sceneEpoch
        else if (owner !== null) authoritative = owner.sceneEpoch
        else if (candidateEpochs.length === 1) authoritative = candidateEpochs[0]
        if (sceneProductEvicted.has(sceneId)) {
          // Product eviction already owns this generation. Validate for the
          // later generation-checked cleanup, but never serve or account it.
          for (const candidate of candidates) {
            preservedStaleAssets.set(candidate.meta.id, {
              sidHash, assetHash: candidate.assetHash, meta: candidate.meta,
            })
            state.stats.preservedStaleAssets += 1
          }
          served = []
        } else if (authoritative === null) {
          served = candidates
          sceneWritePreserve = true
        } else {
          for (const candidate of candidates) {
            if (candidate.meta.sceneEpoch === authoritative) {
              served.push(candidate)
            } else {
              preservedStaleAssets.set(candidate.meta.id, {
                sidHash, assetHash: candidate.assetHash, meta: candidate.meta,
              })
              state.stats.preservedStaleAssets += 1
            }
          }
          if (hasScene && owner !== null && owner.sceneEpoch !== sceneEpoch) {
            try {
              const rebuilt = buildOwnerRecord(sidHash, sceneEpoch, diskRandomHex(), diskNowMs())
              writeFileDurableSync(sessionFd, 'owner.json', rebuilt.bytes)
              assetOwnerRecords.set(sidHash, rebuilt.object)
            } catch (error) { sceneWritePreserve = true }
          }
        }
        if (!hasScene && owner === null && candidateEpochs.length > 1) sceneWritePreserve = true
      }
      const accepted = []
      const acceptedByHash = new Map()
      const ids = new Set()
      const folds = new Map()
      const orders = new Map()
      served.sort((a, b) => b.meta.order - a.meta.order || a.assetHash.localeCompare(b.assetHash))
      for (const candidate of served) {
        const { meta, assetHash } = candidate
        const foldKey = `${meta.nameFold}`
        if (orders.has(meta.order)) {
          const kept = orders.get(meta.order)
          if (assetHash.localeCompare(kept.assetHash) < 0) {
            try { quarantineRootEntry(sessionFd, kept.assetHash, 'duplicate') } catch (error) { void error }
            acceptedByHash.delete(kept.assetHash)
            const at = accepted.indexOf(kept)
            if (at >= 0) accepted.splice(at, 1)
            ids.delete(kept.meta.id)
            const keptFold = `${kept.meta.nameFold}`
            if (folds.get(keptFold) === kept) folds.delete(keptFold)
          } else {
            try { quarantineRootEntry(sessionFd, assetHash, 'duplicate') } catch (error) { void error }
            continue
          }
        }
        if (ids.has(meta.id)) {
          try { quarantineRootEntry(sessionFd, assetHash, 'duplicate') } catch (error) { void error }
          continue
        }
        if (folds.has(foldKey) && folds.get(foldKey) !== candidate) {
          try { quarantineRootEntry(sessionFd, assetHash, 'duplicate') } catch (error) { void error }
          continue
        }
        ids.add(meta.id)
        folds.set(foldKey, candidate)
        orders.set(meta.order, candidate)
        accepted.push(candidate)
        acceptedByHash.set(assetHash, candidate)
      }
      void acceptedByHash
      for (const candidate of accepted) {
        let assetFd
        try { assetFd = openDirAt(sessionFd, candidate.assetHash) } catch (error) { continue }
        try {
          let body
          try {
            body = readFileAt(assetFd, 'body.bin', Math.min(MAX_ASSET_BODY_BYTES, candidate.meta.bytes))
            noteLoadBytes(body.length)
            if (body.length !== candidate.meta.bytes || diskSha(body) !== candidate.meta.sha256) {
              throw new DiskError('hash')
            }
            const sniff = sniffAssetBytes(body)
            if (sniff === null || sniff.kind !== candidate.meta.assetKind) throw new DiskError('schema')
          } catch (error) {
            try { quarantineRootEntry(sessionFd, candidate.assetHash, quarantineReasonFor(error)) } catch (qError) { void qError }
            continue
          }
          insertLoadedAsset(candidate.meta, body)
          loaded.push(candidate)
          nextAssetOrder = Math.max(nextAssetOrder, candidate.meta.order + 1)
        } finally {
          fs.closeSync(assetFd)
        }
      }
      if (accepted.length === 0 && owner === null && fileStatAt(sessionFd, 'owner.json') === null) {
        // Fully empty session directory is ordinary empty state; leave it for
        // index rewrite's generation check, never delete assets here.
      }
    } finally {
      fs.closeSync(sessionFd)
    }
  }
  nextAssetOrder = Math.max(nextAssetOrder, maxInspectedAssetOrder + 1)
  if (nextAssetOrder > MAX_ORDER) throw new DiskError('storage-unavailable')
  void loaded
}

function insertLoadedAsset(meta, body) {
  let list = assets.get(meta.sceneId)
  if (list === undefined) {
    list = new Map()
    assets.set(meta.sceneId, list)
  }
  const asset = {
    id: meta.id,
    name: meta.name,
    nameFold: meta.nameFold,
    kind: meta.assetKind,
    mime: meta.mime,
    ext: meta.ext,
    bytes: meta.bytes,
    buffer: body,
    createdAt: meta.createdAt,
  }
  list.set(meta.id, asset)
  assetIndex.set(meta.id, meta.sceneId)
  assetNames.set(assetNameKey(meta.sceneId, meta.nameFold), meta.id)
  const usage = assetUsage.get(meta.sceneId) ?? { count: 0, bytes: 0 }
  usage.count += 1
  usage.bytes += meta.bytes
  assetUsage.set(meta.sceneId, usage)
  globalUsage.count += 1
  globalUsage.bytes += meta.bytes
  assetOrderById.set(meta.id, meta.order)
  assetHashById.set(meta.id, assetHashForId(meta.id))
  assetDiskMetaById.set(meta.id, {
    sceneId: meta.sceneId,
    sceneEpoch: meta.sceneEpoch,
    order: meta.order,
    sha256: meta.sha256,
  })
}

async function loadSharesPhase() {
  const state = storage
  if (state.dirFds === null) return
  const sharesFd = state.dirFds.shares
  let entries
  try { entries = readdirAt(sharesFd) } catch (error) { throw new DiskError('storage-unavailable', error) }
  let scanned = 0
  let metadataBytes = 0
  const loaded = []
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const dirent of entries) {
    state.scanCounters.shareRootEntries += 1
    noteScanEntry()
    if (!HEX64_RE.test(dirent.name) || !dirent.isDirectory() || dirent.isSymbolicLink()) continue
    if (scanned >= MAX_SHARE_DIRS_SCANNED) break
    scanned += 1
    state.scanCounters.shareDirs += 1
    const shareHash = dirent.name
    let shareFd
    try { shareFd = openDirAt(sharesFd, shareHash) } catch (error) { continue }
    try {
      if (fileStatAt(shareFd, 'COMMITTED') === null) {
        try { fs.closeSync(shareFd); shareFd = null; removeTreeAt(sharesFd, shareHash) } catch (error) { void error }
        continue
      }
      const names = new Set(readdirAt(shareFd).map(entry => entry.name))
      if (names.size !== 3 || !names.has('record.json') || !names.has('document.bin')
        || !names.has('COMMITTED')) {
        try { quarantineRootEntry(sharesFd, shareHash, 'unexpected-entry') } catch (qError) { void qError }
        continue
      }
      try {
        const committed = readFileAt(shareFd, 'COMMITTED', 0)
        if (committed.length !== 0) throw new DiskError('schema')
      } catch (error) {
        try { quarantineRootEntry(sharesFd, shareHash, quarantineReasonFor(error)) } catch (qError) { void qError }
        continue
      }
      let recordBytes
      try {
        recordBytes = readFileAt(shareFd, 'record.json', MAX_SHARE_RECORD_BYTES)
      } catch (error) {
        try { quarantineRootEntry(sharesFd, shareHash, quarantineReasonFor(error)) } catch (qError) { void qError }
        continue
      }
      if (metadataBytes + recordBytes.length > MAX_SHARE_RECORD_SCAN_BYTES) break
      metadataBytes += recordBytes.length
      let document
      try {
        document = readFileAt(shareFd, 'document.bin', 26 * 1024 * 1024)
        noteLoadBytes(document.length)
      } catch (error) {
        try { quarantineRootEntry(sharesFd, shareHash, quarantineReasonFor(error)) } catch (qError) { void qError }
        continue
      }
      let record
      try {
        record = validateShareRecordBytes(recordBytes, shareHash, document)
      } catch (error) {
        try { quarantineRootEntry(sharesFd, shareHash, quarantineReasonFor(error)) } catch (qError) { void qError }
        continue
      }
      if (diskNowMs() >= record.expiresAt) {
        try { removeTreeAt(sharesFd, shareHash) } catch (error) { void error }
        continue
      }
      loaded.push({ record, document })
    } finally {
      if (shareFd !== null) fs.closeSync(shareFd)
    }
  }
  loaded.sort((a, b) => a.record.order - b.record.order)
  const byId = new Map()
  for (const item of loaded) {
    const existing = byId.get(item.record.id)
    if (existing === undefined) {
      byId.set(item.record.id, item)
      continue
    }
    if (item.record.order > existing.record.order) {
      try { quarantineRootEntry(sharesFd, shareIdHash(existing.record.id), 'duplicate') } catch (error) { void error }
      byId.set(item.record.id, item)
    } else {
      try { quarantineRootEntry(sharesFd, shareIdHash(item.record.id), 'duplicate') } catch (error) { void error }
    }
  }
  const adopted = [...byId.values()].sort((a, b) => a.record.order - b.record.order)
  for (const item of adopted) {
    const memory = {
      id: item.record.id,
      v: 1,
      ownerSessionHash: item.record.ownerSessionHash,
      revision: item.record.revision,
      title: item.record.title,
      code: item.record.code,
      editorState: item.record.editorState,
      stepFps: item.record.stepFps,
      documentBuffer: item.document,
      metadataJson: item.record.metadataJson,
      bytes: item.record.bytes,
      createdAt: item.record.createdAt,
      expiresAt: item.record.expiresAt,
      deleteKeyHash: item.record.deleteKeyHash,
    }
    if (shares.has(memory.id)) {
      const existing = shares.get(memory.id)
      if (existing !== undefined) deleteShareRecord(existing.id)
    }
    insertShare(memory)
    shareOrderById.set(memory.id, item.record.order)
    nextShareOrder = Math.max(nextShareOrder, item.record.order + 1)
  }
  if (nextShareOrder > MAX_ORDER) throw new DiskError('storage-unavailable')
}

async function cleanupStartupEvictedSessions() {
  const state = storage
  if (state.dirFds === null || sceneProductEvicted.size === 0) return
  for (const sessionId of [...sceneProductEvicted.keys()]) {
    if (scenes.has(sessionId)) continue
    const sidHash = sceneSidHash(sessionId)
    const captured = []
    const list = assets.get(sessionId)
    if (list !== undefined) {
      for (const asset of list.values()) {
        captured.push({
          id: asset.id,
          bytes: asset.bytes,
          nameFold: asset.nameFold,
          hash: assetIdHash(asset.id),
          epoch: assetDiskMetaById.get(asset.id)?.sceneEpoch ?? null,
        })
      }
    }
    deleteAssetSession(sessionId)
    const recorded = deleteAssetSessionRecorded.get(sessionId)
    const owner = assetOwnerRecords.get(sidHash) ?? null
    const token = {
      kind: 'session-eviction',
      sessionId,
      sidHash,
      epoch: owner === null ? null : owner.sceneEpoch,
      revisionVictims: [],
      assetVictims: sceneAssetVictimUnion(sessionId, sidHash, recorded),
      ownerEpoch: owner === null ? null : owner.sceneEpoch,
      ownerIncarnation: owner === null ? 'legacy' : owner.incarnation,
    }
    try { await cleanupSessionEvictionToken(token) } catch (error) {
      sceneWritePreserve = true
    }
    deleteAssetSessionRecorded.delete(sessionId)
    void captured
  }
}

async function startupIndexRewrite() {
  const state = storage
  if (state.dirFds === null) return
  await cleanupStartupEvictedSessions()
  // Product scene caps are already enforced by loadScenesPhase. Thumbnail
  // index rewrite below is generation-checked because every referenced PNG is
  // in the current in-memory index.
  if (!state.stats.thumbnailDegraded) {
    const entries = [...thumbnailIndex.values()].sort((a, b) => a.order - b.order)
    const { bytes } = buildThumbIndex(entries, nextThumbOrder)
    try {
      const current = readFileAt(state.dirFds.thumbnails, 'index.json', MAX_THUMB_INDEX_BYTES)
      if (!current.equals(bytes)) {
        await diskBarrier('startupIndexRewrite')
        writeFileDurableSync(state.dirFds.thumbnails, 'index.json', bytes)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        state.stats.thumbnailDegraded = true
        thumbnailWriteDegraded = true
      } else {
        try { writeFileDurableSync(state.dirFds.thumbnails, 'index.json', bytes) } catch (writeError) {
          state.stats.thumbnailDegraded = true
          thumbnailWriteDegraded = true
        }
      }
    }
  }
  for (const sidHash of [...assetOwnerRecords.keys()]) {
    if (scenes.size > 0) {
      let live = false
      for (const sessionId of scenes.keys()) {
        if (sceneSidHash(sessionId) === sidHash) { live = true; break }
      }
      if (live) continue
    }
    const record = assetOwnerRecords.get(sidHash)
    if (record === undefined) continue
    let sessionFd = null
    try { sessionFd = openDirAt(state.dirFds.assets, sidHash) } catch (error) { continue }
    try {
      let committed = false
      for (const entry of readdirAt(sessionFd)) {
        if (entry.name === 'owner.json') continue
        if (!HEX64_RE.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue
        let assetFd = null
        try {
          assetFd = openDirAt(sessionFd, entry.name)
          if (fileStatAt(assetFd, 'COMMITTED') !== null) { committed = true; break }
        } catch (error) { committed = true } finally {
          if (assetFd !== null) fs.closeSync(assetFd)
        }
      }
      if (committed) continue
      // An empty owner-only hint is removed only after the startup generation
      // check and only when no deferred token for this sidHash can need it.
      if (pendingCleanupTokenForSidHash(sidHash)) continue
      if (!entryExistsAt(sessionFd, 'owner.json')) continue
      unlinkAt(sessionFd, 'owner.json')
      fsyncFd(sessionFd)
      assetOwnerRecords.delete(sidHash)
      removeEmptyAssetSessionDir(sidHash)
    } catch (error) {
      sceneWritePreserve = true
    } finally {
      fs.closeSync(sessionFd)
    }
  }
  state.stats.overCapAssets = Math.max(0, assets.size - ASSET_LIMITS.sessionAssets)
  state.stats.overCapShares = Math.max(0, shares.size - SHARE_LIMITS.globalShares)
}

function assetHashForId(id) {
  return assetIdHash(id)
}

/**
 * Current committed-asset evidence for new-scene epoch resolution. Only the
 * in-memory visible/hidden rows for this Session and their durable metadata are
 * current; `preservedStaleAssets` and still-present COMMITTED directories are
 * not evidence after eviction removes the committed row.
 */
function currentCommittedAssetEpochs(sessionId) {
  const list = assets.get(sessionId)
  if (list === undefined) return []
  const epochs = new Set()
  for (const asset of list.values()) {
    const meta = assetDiskMetaById.get(asset.id)
    if (meta === undefined || meta.sceneId !== sessionId) continue
    if (typeof meta.sceneEpoch !== 'string' || !HEX32_RE.test(meta.sceneEpoch)) continue
    epochs.add(meta.sceneEpoch)
  }
  return [...epochs]
}

function resolveSceneEpochForAppend(sessionId, sidHash) {
  const live = sceneEpochs.get(sessionId)
  if (live !== undefined) return { epoch: live, source: 'live', ownerPresent: false }
  const owner = assetOwnerRecords.get(sidHash) ?? null
  const epochs = currentCommittedAssetEpochs(sessionId)
  if (owner !== null) {
    if (epochs.length > 0) {
      return { epoch: owner.sceneEpoch, source: 'owner', ownerPresent: true }
    }
    // A valid owner with no current committed rows is only a hint. Continue
    // with a fresh epoch and supersede it; preserved committed directories and
    // the stale owner epoch must not re-epoch a future asset-only session.
    return { epoch: diskRandomHex(), source: 'fresh-owner', ownerPresent: true }
  }
  if (epochs.length === 1) {
    return { epoch: epochs[0], source: 'fallback', ownerPresent: false }
  }
  if (epochs.length > 1) {
    return { epoch: null, source: 'disagreement', ownerPresent: false }
  }
  return { epoch: diskRandomHex(), source: 'fresh', ownerPresent: false }
}

async function writeAssetOwnerDurable(sidHash, sceneEpoch, incarnationInput = null) {
  const state = storage
  const sessionFd = mkdirDurableAt(state.dirFds.assets, sidHash)
  try {
    const incarnation = typeof incarnationInput === 'string' && HEX32_RE.test(incarnationInput)
      ? incarnationInput
      : diskRandomHex()
    await diskFault('assetOwnerWrite', 'beforeOwnerWrite')
    const owner = writeAssetOwnerRecord(sessionFd, sidHash, sceneEpoch, incarnation, diskNowMs(),
      { op: 'assetOwnerWrite', at: 'beforeOwnerWrite' })
    await diskFault('assetOwnerFsync', 'afterOwnerWrite')
    fsyncFd(sessionFd)
    assetOwnerRecords.set(sidHash, owner.object)
    await diskBarrier('afterAssetOwnerRecord')
    return owner.object
  } finally {
    fs.closeSync(sessionFd)
  }
}

async function ensureSceneDir(sidHash, fenceHeld = false) {
  const state = storage
  const scenesFd = state.dirFds.scenes
  try {
    return openDirAt(scenesFd, sidHash)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new DiskError('storage-unavailable', error)
  }
  const alreadyHeld = fenceHeld === true
  const release = alreadyHeld ? null : await acquireFence('cleanup-mkdir')
  try {
    ensureFenceOpen()
    try {
      return openDirAt(scenesFd, sidHash)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new DiskError('storage-unavailable', error)
    }
    return mkdirDurableAt(scenesFd, sidHash)
  } finally {
    if (release !== null) release()
  }
}

function sceneIntentName(slot) {
  return `${slot}.intent.json`
}

async function writeBoundaryIntentDurable(intentFields) {
  const state = storage
  const trashFd = state.dirFds.trash
  const intent = buildBoundaryIntent(intentFields)
  await diskBarrier('beforeSceneGenerationBoundaryIntent')
  writeFileDurableSync(trashFd, sceneIntentName(intentFields.slot), intent.bytes)
  fsyncFd(trashFd)
  await diskBarrier('afterSceneGenerationBoundaryIntent')
  return intent.object
}

async function performSceneGenerationBoundary(sidHash, fields) {
  const state = storage
  const trashFd = state.dirFds.trash
  const scenesFd = state.dirFds.scenes
  const release = await acquireFence('scene-generation-boundary')
  const descriptor = {
    sidHash,
    slot: fields.slot,
    intentName: sceneIntentName(fields.slot),
    newEpoch: fields.newEpoch,
    newIncarnation: fields.newIncarnation,
    newOrder: fields.newOrder,
    newRevisionRecordSha256: fields.newRevisionRecordSha256,
    oldDirPresent: true,
    boundary: true,
    forwardTrashFsync: false,
    trashBytes: 0,
    renamed: false,
  }
  try {
    ensureFenceOpen()
    await diskBarrier('beforeSceneGenerationBoundary')
    await writeBoundaryIntentDurable(fields)
    descriptor.intentWritten = true
    await diskBarrier('afterSceneGenerationBoundaryIntent')
    try {
      await diskFault('trashRename', 'scene-generation-boundary')
      renameAt(scenesFd, sidHash, trashFd, fields.slot)
      descriptor.renamed = true
      try { descriptor.trashBytes = measureTreeBytes(trashFd, fields.slot) } catch (error) { descriptor.trashBytes = 0 }
      addTrashBytes(descriptor.trashBytes)
      noteFenceCounter('boundaryRename')
      await diskBarrier('afterSceneGenerationBoundaryRename')
    } catch (error) {
      // Pre-rename failure leaves the old directory and owner/assets intact.
      try { unlinkAt(trashFd, descriptor.intentName); fsyncFd(trashFd) } catch (cleanupError) { void cleanupError }
      throw new DiskError('storage-unavailable', error)
    }
    try {
      await diskFault('dirFsync', 'scene-generation-boundary-trash-parent')
      fsyncFd(trashFd)
      descriptor.forwardTrashFsync = true
      noteFenceCounter('boundaryTrashParentFsync')
      await diskBarrier('afterSceneGenerationBoundaryTrashParentFsync')
      await diskFault('dirFsync', 'scene-generation-boundary-scenes-parent')
      fsyncFd(scenesFd)
      noteFenceCounter('boundaryScenesParentFsync')
      await diskBarrier('afterSceneGenerationBoundaryScenesParentFsync')
    } catch (error) {
      await reverseBoundaryAfterForwardFailure(descriptor)
      throw new DiskError('storage-unavailable', error)
    }
    await diskBarrier('afterSceneGenerationBoundary')
    return { descriptor, release }
  } catch (error) {
    descriptor.boundaryFailed = true
    if (!descriptor.renamed) {
      release()
      throw error instanceof DiskError ? error : new DiskError('storage-unavailable', error)
    }
    return { descriptor, release }
  }
}

async function reverseBoundaryAfterForwardFailure(descriptor) {
  const state = storage
  const trashFd = state.dirFds.trash
  const scenesFd = state.dirFds.scenes
  if (!descriptor.renamed) return
  try {
    await diskFault('trashRename', 'scene-generation-boundary-reverse')
    renameOutOfTrash(descriptor.slot, scenesFd, descriptor.sidHash)
    descriptor.renamed = false
    try {
      await diskFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent')
      fsyncFd(scenesFd)
    } catch (error) {
      // The reverse rename succeeded but its parent fsync did not. From this
      // point the session is write-preserve even if the single retry makes the
      // old name durable; only startup reconciliation or a complete scan can
      // clear that availability state.
      sceneWritePreserve = true
      let retryFailed = true
      for (let attempt = 0; attempt < REVERSE_SCENES_FSYNC_RETRIES; attempt += 1) {
        try {
          state.stats.reverseScenesFsyncRetries += 1
          await diskFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent-retry')
          fsyncFd(scenesFd)
          retryFailed = false
          break
        } catch (retryError) {
          retryFailed = true
        }
      }
      if (retryFailed) {
        poisonNamespace('scene-generation-boundary-reverse-fsync')
        state.stats.startupBoundaryRecovery += 1
        descriptor.boundaryRecovery = true
        return
      }
    }
    try {
      unlinkAt(trashFd, descriptor.intentName)
      if (!fencePoisoned()) fsyncFd(trashFd)
      descriptor.intentWritten = false
    } catch (error) {
      // The old name is durable; a leftover intent becomes inert at startup.
    }
  } catch (error) {
    if (!descriptor.forwardTrashFsync) poisonNamespace('scene-generation-boundary-reverse-rename')
    state.stats.startupBoundaryRecovery += 1
    sceneWritePreserve = true
    descriptor.boundaryRecovery = true
  }
}

async function rollbackSceneBoundaryNoMarker(descriptor) {
  const state = storage
  if (descriptor === null || !descriptor.boundary) return
  if (descriptor.boundaryRecovery) return
  if (fencePoisoned()) return
  const scenesFd = state.dirFds.scenes
  const trashFd = state.dirFds.trash
  let release = null
  if (!descriptor.fenceHeld) {
    release = await acquireFence('scene-boundary-rollback')
    descriptor.fenceHeld = true
  }
  try {
    ensureFenceOpen()
    let sceneFd = null
    try { sceneFd = openDirAt(scenesFd, descriptor.sidHash) } catch (error) { sceneFd = null }
    if (sceneFd !== null) {
      try {
        const orderName = `${String(descriptor.order).padStart(16, '0')}.json`
        const markerName = `${orderName.slice(0, 16)}.commit.json`
        if (fileStatAt(sceneFd, markerName) === null && fileStatAt(sceneFd, orderName) !== null) {
          try {
            const revision = validateSceneRevisionBytes(
              readFileAt(sceneFd, orderName, 2 * 1024 * 1024), descriptor.order, descriptor.sidHash)
            if (revision.recordSha256 === descriptor.newRevisionRecordSha256) {
              unlinkAt(sceneFd, orderName)
              fsyncFd(sceneFd)
            }
          } catch (error) { void error }
        }
        const remaining = readdirAt(sceneFd)
        if (remaining.length === 0) {
          fs.closeSync(sceneFd)
          sceneFd = null
          rmdirAt(scenesFd, descriptor.sidHash)
          fsyncFd(scenesFd)
        }
      } finally {
        if (sceneFd !== null) fs.closeSync(sceneFd)
      }
    }
    if (!entryExistsAt(trashFd, descriptor.slot)) {
      // Inert: the old name never left or was already reversed.
      return
    }
    try {
      await diskFault('trashRename', 'scene-generation-boundary-reverse')
      renameOutOfTrash(descriptor.slot, scenesFd, descriptor.sidHash)
      descriptor.renamed = false
    } catch (error) {
      if (!descriptor.forwardTrashFsync) poisonNamespace('scene-generation-boundary-rollback-rename')
      state.stats.startupBoundaryRecovery += 1
      sceneWritePreserve = true
      descriptor.boundaryRecovery = true
      return
    }
    try {
      await diskFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent')
      fsyncFd(scenesFd)
    } catch (error) {
      let retryFailed = true
      for (let attempt = 0; attempt < REVERSE_SCENES_FSYNC_RETRIES; attempt += 1) {
        try {
          state.stats.reverseScenesFsyncRetries += 1
          await diskFault('dirFsync', 'scene-generation-boundary-reverse-scenes-parent-retry')
          fsyncFd(scenesFd)
          retryFailed = false
          break
        } catch (retryError) {
          retryFailed = true
        }
      }
      if (retryFailed) poisonNamespace('scene-generation-boundary-rollback-fsync')
      return
    }
    try {
      unlinkAt(trashFd, descriptor.intentName)
      if (!fencePoisoned()) fsyncFd(trashFd)
      descriptor.intentWritten = false
    } catch (error) { void error }
  } finally {
    if (release !== null) release()
  }
}

function restoreSceneRevisionOrders(descriptor) {
  if (descriptor === null) return
  if (descriptor.revisionOrderSnapshot === null) {
    sceneRevisionOrderBySession.delete(descriptor.sessionId)
  } else {
    sceneRevisionOrderBySession.set(descriptor.sessionId,
      new Map(descriptor.revisionOrderSnapshot))
  }
}

async function appendSceneWithDurability(sessionId, input, commitFn) {
  if (storageNeedsReady()) await storageReady()
  const state = storage
  if (state !== null && state.mode === 'degraded') throw new DiskError('storage-unavailable')
  if (state === null || state.mode !== 'disk') {
    return { scene: commitFn(null) }
  }
  const sidHash = sceneSidHash(sessionId)
  const queueKeys = [{ kind: 'scene', key: sessionId }]
  const newScene = !scenes.has(sessionId)
  if (newScene) queueKeys.push({ kind: 'asset', key: sidHash })
  return runWithQueues(queueKeys, async () => {
    let descriptor = null
    try {
      if (sceneWritePreserve || sceneWriteDegraded || sceneScanTruncated) {
        throw new DiskError('storage-unavailable')
      }
      descriptor = await prepareSceneAppendDurable(sessionId, input)
      if (descriptor === null) throw new DiskError('storage-unavailable')
      const scene = commitFn(descriptor)
      // Test-only synchronous throw after the commit call has updated the
      // revision-order map but before the memory commit is sealed. With no
      // armed fault this is a production no-op.
      diskFaultSync('sceneMemoryCommit', 'afterRevisionOrderUpdate')
      descriptor.memoryCommitted = true
      captureSceneCommitCleanupTokens(descriptor)
      await diskBarrier('afterSceneMemoryCommit')
      await finalizeSceneAppendDurable(descriptor, scene, scenes.get(sessionId))
      return { scene }
    } catch (error) {
      if (descriptor !== null && descriptor.cleanedUp !== true && descriptor.memoryCommitted !== true) {
        if (descriptor.isNewScene) sceneEpochs.delete(descriptor.sessionId)
        if (descriptor.epochSnapshot !== null) sceneEpochs.set(descriptor.sessionId, descriptor.epochSnapshot)
        restoreSceneRevisionOrders(descriptor)
        deleteAssetSessionRecorded.delete(descriptor.sessionId)
      }
      if (descriptor !== null && descriptor.cleanedUp !== true) {
        try { await cleanupFailedPreMarkerAppend(descriptor) } catch (cleanupError) { void cleanupError }
      }
      throw error instanceof DiskError ? error : new DiskError('storage-unavailable', error)
    }
  })
}

function snapshotSceneRevisionOrders(sessionId) {
  const all = new Map()
  for (const [id, map] of sceneRevisionOrderBySession) all.set(id, new Map(map))
  return {
    session: sceneRevisionOrderBySession.has(sessionId)
      ? new Map(sceneRevisionOrderBySession.get(sessionId))
      : null,
    all,
  }
}

async function prepareSceneAppendDurable(sessionId, input) {
  const state = storage
  if (!storagePersistenceAvailable()) {
    if (state.mode === 'degraded') throw new DiskError('storage-unavailable')
    return null
  }
  if (sceneWriteDegraded || storagePersistenceAvailable() === false) throw new DiskError('storage-unavailable')
  if (sceneWritePreserve) throw new DiskError('storage-unavailable')
  if (sceneScanTruncated) throw new DiskError('storage-unavailable')
  const sidHash = sceneSidHash(sessionId)
  const isNewScene = !scenes.has(sessionId)
  const epochInfo = isNewScene
    ? resolveSceneEpochForAppend(sessionId, sidHash)
    : { epoch: sceneEpochs.get(sessionId), source: 'live', ownerPresent: false }
  if (isNewScene && epochInfo.source === 'disagreement') throw new DiskError('storage-unavailable')
  if (typeof epochInfo.epoch !== 'string' || !HEX32_RE.test(epochInfo.epoch)) {
    throw new DiskError('storage-unavailable')
  }
  const head = isNewScene ? undefined : scenes.get(sessionId).history.at(-1)
  const revision = (head?.revision ?? 0) + 1
  if (revision > MAX_ORDER) throw new DiskError('storage-unavailable')
  const order = nextSceneOrder
  if (!isSafePositive(order) || order > MAX_ORDER) throw new DiskError('storage-unavailable')
  const updatedAt = isSafeCount(input.updatedAt) ? input.updatedAt : diskNowMs()
  const title = input.title
  const code = input.code
  const bytes = input.bytes ?? bytesOfText(code)
  if (bytesOfText(title) > MAX_SCENE_TITLE_BYTES || bytes > MAX_CODE_BYTES) throw new DiskError('storage-unavailable')
  const revisionRecord = buildSceneRevisionRecord({
    sceneId: sessionId, epoch: epochInfo.epoch, revision, order, title, code, bytes, updatedAt,
  })
  const markerRecord = buildSceneMarker(sidHash, order, revision, revisionRecord.sha256)
  const peakBytes = revisionRecord.bytes.length + markerRecord.bytes.length
  let budgetHold
  try {
    budgetHold = await state.budget.reserveOperation(peakBytes, peakBytes)
  } catch (error) {
    throw error instanceof DiskError ? error : new DiskError('storage-full', error)
  }
  const revisionOrderSnapshots = snapshotSceneRevisionOrders(sessionId)
  const descriptor = {
    sessionId,
    sidHash,
    isNewScene,
    budgetHold,
    epoch: epochInfo.epoch,
    epochSource: epochInfo.source,
    order,
    revision,
    revisionBytes: revisionRecord.bytes,
    newRevisionRecordSha256: revisionRecord.sha256,
    memoryRecord: {
      sceneId: sessionId, revision, title, code, bytes, updatedAt,
    },
    ownerIncarnation: null,
    boundary: false,
    intentWritten: false,
    renamed: false,
    fenceHeld: false,
    sceneFd: null,
    epochSnapshot: sceneEpochs.has(sessionId) ? sceneEpochs.get(sessionId) : null,
    revisionOrderSnapshot: revisionOrderSnapshots.session,
    sceneIdsSnapshot: [...scenes.keys()],
    sceneHistorySnapshot: scenes.has(sessionId) ? scenes.get(sessionId).history.slice() : null,
    victimOrderSnapshots: revisionOrderSnapshots.all,
    trimVictims: [],
    evictedTokens: [],
    memoryCommitted: false,
    markerCommitted: false,
  }
  const needsBoundary = isNewScene
    && (epochInfo.source === 'owner' || epochInfo.source === 'fallback')
    && entryExistsAt(state.dirFds.scenes, sidHash)
  let release = null
  try {
    if (isNewScene && needsBoundary) {
      descriptor.ownerIncarnation = diskRandomHex()
      const boundary = await performSceneGenerationBoundary(sidHash, {
        sidHash,
        slot: diskRandomHex(),
        newEpoch: epochInfo.epoch,
        newIncarnation: descriptor.ownerIncarnation,
        newOrder: order,
        newRevisionRecordSha256: revisionRecord.sha256,
      })
      descriptor.boundary = true
      descriptor.slot = boundary.descriptor.slot
      descriptor.intentName = boundary.descriptor.intentName
      descriptor.intentWritten = boundary.descriptor.intentWritten
      descriptor.fenceHeld = true
      descriptor.fenceRelease = boundary.release
      descriptor.forwardTrashFsync = boundary.descriptor.forwardTrashFsync
      descriptor.boundaryRecovery = boundary.descriptor.boundaryRecovery === true
      if (boundary.descriptor.boundaryFailed) {
        descriptor.boundaryFailed = true
        if (descriptor.fenceRelease !== undefined) {
          const pending = descriptor.fenceRelease
          descriptor.fenceRelease = undefined
          descriptor.fenceHeld = false
          pending()
        }
        throw new DiskError('storage-unavailable')
      }
      // The fence is a leaf around the intent/rename/both parent fsyncs only.
      descriptor.fenceRelease()
      descriptor.fenceRelease = undefined
      descriptor.fenceHeld = false
    }
    if (isNewScene) {
      const shouldWriteOwner = epochInfo.source !== 'fresh'
      if (shouldWriteOwner) {
        const incarnation = descriptor.ownerIncarnation ?? diskRandomHex()
        descriptor.ownerIncarnation = incarnation
        const owner = await writeAssetOwnerDurable(sidHash, epochInfo.epoch, incarnation)
        descriptor.ownerIncarnation = owner.incarnation
        if (epochInfo.source === 'owner' || epochInfo.source === 'fallback') {
          await diskBarrier('afterAssetOwnerAdoption')
        }
      }
    }
    descriptor.sceneFd = await ensureSceneDir(sidHash, false)
    await diskBarrier('beforeSceneRevision')
    await diskFault('write', 'scene-revision')
    await diskFault('revisionWrite', 'beforeRevisionWrite')
    writeFileDurableSync(descriptor.sceneFd, `${String(order).padStart(16, '0')}.json`, revisionRecord.bytes)
    await diskFault('revisionWrite', 'afterRevisionWrite')
    fsyncFd(descriptor.sceneFd)
    await diskBarrier('afterRevisionDirFsync')
    await diskFault('dirFsync', 'afterRevisionDirFsync')
    descriptor.revisionDurable = true
    if (release !== null) {
      descriptor.fenceRelease = release
      release = null
    }
    return descriptor
  } catch (error) {
    if (release !== null) release()
    await cleanupFailedPreMarkerAppend(descriptor)
    throw error instanceof DiskError ? error : new DiskError('storage-unavailable', error)
  }
}

function releaseSceneAppendBudget(descriptor) {
  if (descriptor === null || descriptor === undefined) return
  const hold = descriptor.budgetHold
  descriptor.budgetHold = null
  if (hold !== null && hold !== undefined) {
    try { hold.release() } catch (error) { void error }
  }
}

async function cleanupFailedPreMarkerAppend(descriptor) {
  if (descriptor === null) return
  if (descriptor.cleanedUp === true) return
  descriptor.cleanedUp = true
  if (descriptor.boundary && descriptor.intentWritten) {
    await rollbackSceneBoundaryNoMarker(descriptor)
  } else {
    const sceneFd = descriptor.sceneFd
    if (sceneFd !== null) {
      try {
        const orderName = `${String(descriptor.order).padStart(16, '0')}.json`
        if (entryExistsAt(sceneFd, orderName)) {
          try {
            const revision = validateSceneRevisionBytes(
              readFileAt(sceneFd, orderName, 2 * 1024 * 1024), descriptor.order, descriptor.sidHash)
            if (revision.recordSha256 === descriptor.newRevisionRecordSha256) {
              unlinkAt(sceneFd, orderName)
              fsyncFd(sceneFd)
            }
          } catch (error) { void error }
        }
        if (descriptor.isNewScene) {
          const remaining = readdirAt(sceneFd)
          if (remaining.length === 0) {
            fs.closeSync(sceneFd)
            descriptor.sceneFd = null
            const release = await acquireFence('cleanup-scene-new')
            try {
              ensureFenceOpen()
              try { rmdirAt(storage.dirFds.scenes, descriptor.sidHash) } catch (error) { if (error?.code !== 'ENOENT') throw error }
              fsyncFd(storage.dirFds.scenes)
            } finally {
              release()
            }
          }
        }
      } catch (error) { void error }
    }
  }
  if (descriptor.fenceRelease !== undefined) {
    try { descriptor.fenceRelease() } catch (error) { void error }
    descriptor.fenceRelease = undefined
    descriptor.fenceHeld = false
  }
  if (descriptor.sceneFd !== null) {
    try { fs.closeSync(descriptor.sceneFd) } catch (error) { void error }
    descriptor.sceneFd = null
  }
  releaseSceneAppendBudget(descriptor)
}

function consumeForcedAppendEpochForTests() {
  if (storage === null || storage.testMode !== true) return null
  const forced = storage.testForcedAppendEpoch
  if (typeof forced !== 'string' || !HEX32_RE.test(forced)) return null
  storage.testForcedAppendEpoch = null
  return forced
}

function publishSceneEpochForCommit(sessionId, epoch) {
  if (storage === null || storage.mode !== 'disk') return
  const forced = consumeForcedAppendEpochForTests()
  if (forced !== null) {
    sceneEpochs.set(sessionId, forced)
    diskBarrierSync('afterSceneEpochPublish')
    diskFaultSync('sceneMemoryCommit', 'afterSceneEpochPublish')
    return
  }
  sceneEpochs.set(sessionId, epoch)
  diskBarrierSync('afterSceneEpochPublish')
  diskFaultSync('sceneMemoryCommit', 'afterSceneEpochPublish')
}

function updateSceneRevisionOrders(descriptor, record) {
  if (descriptor === null || storage === null || storage.mode !== 'disk') return
  let map = sceneRevisionOrderBySession.get(descriptor.sessionId)
  if (map === undefined) {
    map = new Map()
    sceneRevisionOrderBySession.set(descriptor.sessionId, map)
  }
  map.set(record.revision, descriptor.order)
  while (map.size > MAX_REVISIONS) {
    const first = map.keys().next().value
    if (first === undefined) break
    map.delete(first)
  }
  nextSceneOrder = Math.max(nextSceneOrder, descriptor.order + 1)
}

function updateSceneRevisionOrderForCommit(descriptor, record) {
  updateSceneRevisionOrders(descriptor, record)
}

function sceneAssetVictimUnion(sessionId, sidHash, recorded) {
  const byHash = new Map()
  const add = (entry) => {
    if (entry === null || entry === undefined) return
    const assetHash = entry.assetHash ?? entry.hash
    if (typeof assetHash !== 'string' || !HEX64_RE.test(assetHash)) return
    const key = assetHash
    const prior = byHash.get(key)
    const next = {
      assetHash,
      assetId: typeof entry.assetId === 'string' ? entry.assetId : entry.id,
      epoch: typeof entry.epoch === 'string' ? entry.epoch : entry.capturedEpoch ?? null,
    }
    if (prior === undefined) byHash.set(key, next)
  }
  if (Array.isArray(recorded)) for (const entry of recorded) add(entry)
  for (const entry of preservedStaleAssets.values()) {
    if (entry.sidHash !== sidHash) continue
    add({ assetHash: entry.assetHash, assetId: entry.meta?.id, epoch: entry.meta?.sceneEpoch })
  }
  for (const [assetId, meta] of assetDiskMetaById) {
    if (meta.sceneId !== sessionId) continue
    add({ assetHash: assetHashById.get(assetId) ?? assetIdHash(assetId), assetId, epoch: meta.sceneEpoch })
  }
  return [...byHash.values()].sort((a, b) => a.assetHash.localeCompare(b.assetHash))
}

function capturedRevisionVictims(previous, current, sessionId) {
  const victims = []
  if (previous === undefined || previous === null) return victims
  const liveOrders = new Set(current === undefined || current === null ? [] : current.values())
  for (const [revision, order] of previous) {
    if (liveOrders.has(order)) continue
    victims.push({ revision, order })
  }
  void sessionId
  return victims.sort((a, b) => a.order - b.order || a.revision - b.revision)
}

function fixtureVictimView(sessionId) {
  const victimSet = {}
  for (const [label, entry] of diskFixtureLabels) victimSet[label] = entry.session === sessionId
  return victimSet
}

function noteLastCleanupToken(token) {
  const revisionOrders = (Array.isArray(token.revisionVictims) ? token.revisionVictims : [])
    .map(victim => ({ revision: victim.revision, order: victim.order }))
    .sort((left, right) => left.order - right.order || left.revision - right.revision)
  const assetHashes = (Array.isArray(token.assetVictims) ? token.assetVictims : [])
    .map(victim => victim.assetHash).sort()
  lastCleanupTokenView = {
    epoch: token.epoch ?? null,
    orderCount: revisionOrders.length,
    assetCount: assetHashes.length,
    revisionOrders,
    assetHashes,
    ownerEpoch: typeof token.ownerEpoch === 'string' ? token.ownerEpoch : null,
    ownerIncarnation: typeof token.ownerIncarnation === 'string' ? token.ownerIncarnation : null,
    victimSet: fixtureVictimView(token.sessionId),
  }
  lastCleanupTokensView.push(lastCleanupTokenView)
  if (lastCleanupTokensView.length > 32) lastCleanupTokensView.shift()
}

function buildSceneCleanupToken(descriptor, victimId, previous) {
  const sidHash = sceneSidHash(victimId)
  const captured = capturedRevisionVictims(previous, undefined, victimId)
  const recorded = deleteAssetSessionRecorded.get(victimId)
  const owner = assetOwnerRecords.get(sidHash) ?? null
  return {
    kind: 'session-eviction',
    sessionId: victimId,
    sidHash,
    epoch: previousEpochForScene(victimId, descriptor),
    revisionVictims: captured,
    assetVictims: sceneAssetVictimUnion(victimId, sidHash, recorded),
    ownerEpoch: owner === null ? null : owner.sceneEpoch,
    ownerIncarnation: currentIncarnationFor(sidHash),
  }
}

/**
 * Runs synchronously in the commit task, after the exact memory commit and
 * before any await. It captures actual removed sessions and the exact trimmed
 * revision identities, builds generation tokens, and removes side entries only
 * after each victim token has captured them.
 */
function captureSceneCommitCleanupTokens(descriptor) {
  if (descriptor === null || storage === null || storage.mode !== 'disk') return
  const live = new Set(scenes.keys())
  const removed = descriptor.sceneIdsSnapshot.filter(id => !live.has(id))
  for (const victimId of removed) {
    const previous = descriptor.victimOrderSnapshots.get(victimId)
    const token = buildSceneCleanupToken(descriptor, victimId, previous)
    descriptor.evictedTokens.push(token)
    noteLastCleanupToken(token)
    sceneEpochs.delete(victimId)
    sceneRevisionOrderBySession.delete(victimId)
    deleteAssetSessionRecorded.delete(victimId)
    sceneProductEvicted.set(victimId, true)
  }
  const current = sceneRevisionOrderBySession.get(descriptor.sessionId)
  descriptor.trimVictims = capturedRevisionVictims(descriptor.revisionOrderSnapshot, current, descriptor.sessionId)
  if (descriptor.trimVictims.length > 0) {
    noteLastCleanupToken({
      epoch: previousEpochForScene(descriptor.sessionId, descriptor),
      sessionId: descriptor.sessionId,
      revisionVictims: descriptor.trimVictims,
      assetVictims: [],
    })
  }
}

function previousEpochForScene(sessionId, descriptor) {
  if (descriptor.sessionId === sessionId) {
    const prior = descriptor.epochSnapshot
    if (typeof prior === 'string' && HEX32_RE.test(prior)) return prior
  }
  const live = sceneEpochs.get(sessionId)
  return typeof live === 'string' && HEX32_RE.test(live) ? live : null
}

async function finalizeSceneAppendDurable(descriptor, sceneRecord, memoryEntry) {
  if (descriptor === null) return
  const state = storage
  if (!storagePersistenceAvailable()) throw new DiskError('storage-unavailable')
  const sceneFd = descriptor.sceneFd
  const orderText = String(descriptor.order).padStart(16, '0')
  const marker = buildSceneMarker(descriptor.sidHash, descriptor.order, sceneRecord.revision,
    descriptor.newRevisionRecordSha256)
  let markerDurable = false
  try {
    try {
      // Marker faults before publication are part of the guarded marker
      // transaction: they must enter scene-write-degraded and use the same
      // marker-absent rollback path as a write/fsync failure.
      await diskBarrier('beforeSceneCommitMarker')
      await diskFault('sceneCommitMarker', 'beforeSceneCommitMarker')
      await diskFault('commitMarker', 'beforeCommitMarker')
      writeFileDurableSync(sceneFd, `${orderText}.commit.json`, marker.bytes, {
        renameAt: 'afterCommitMarker',
        dirFsyncOp: 'commitMarker',
        dirAt: 'afterCommitMarker',
      })
      fsyncFd(sceneFd)
      await diskBarrier('afterSceneCommitMarker')
      await diskFault('sceneCommitMarker', 'afterSceneCommitMarker')
      await diskFault('commitMarker', 'afterCommitMarker')
      descriptor.markerCommitted = true
      markerDurable = true
    } catch (error) {
      markerDurable = sceneMarkerSurvives(descriptor, sceneFd, orderText)
      sceneWriteDegraded = true
      deleteAssetSessionRecorded.delete(descriptor.sessionId)
      if (!markerDurable) {
        restoreSceneMarkerFailureMemory(descriptor)
        await rollbackAfterFailedMarker(descriptor)
      }
      descriptor.cleanedUp = true
      throw new DiskError('storage-unavailable', error)
    }
    if (state.closing) {
      descriptor.cleanedUp = true
      throw new DiskError('stopping')
    }
    updateSceneRevisionOrderForCommit(descriptor, sceneRecord)
    await diskBarrier('afterSceneEpochPublish')
    if (descriptor.fenceRelease !== undefined) {
      try { descriptor.fenceRelease() } catch (error) { void error }
      descriptor.fenceRelease = undefined
      descriptor.fenceHeld = false
    }
    if (descriptor.sceneFd !== null) {
      fs.closeSync(descriptor.sceneFd)
      descriptor.sceneFd = null
    }
    if (descriptor.boundary && descriptor.intentWritten && !fencePoisoned()) {
      const release = await acquireFence('scene-boundary-intent-unlink')
      try {
        ensureFenceOpen()
        let intentRemoved = false
        try { unlinkAt(state.dirFds.trash, descriptor.intentName); intentRemoved = true } catch (error) { void error }
        try { fsyncFd(state.dirFds.trash) } catch (error) { void error }
        if (intentRemoved) {
          // Without its intent the old generation slot is ordinary cleanup
          // trash; pressure cleanup may drain it before the next mutation.
          noteOrdinaryTrashSlot(descriptor.slot, trashSlotBytes(descriptor.slot))
        }
      } catch (error) { void error }
      finally { release() }
    }
    scheduleSceneDurableCleanup(descriptor, sceneRecord, memoryEntry)
    releaseSceneAppendBudget(descriptor)
  } catch (error) {
    if (descriptor.sceneFd !== null) {
      try { fs.closeSync(descriptor.sceneFd) } catch (closeError) { void closeError }
      descriptor.sceneFd = null
    }
    if (descriptor.fenceRelease !== undefined) {
      try { descriptor.fenceRelease() } catch (releaseError) { void releaseError }
      descriptor.fenceRelease = undefined
    }
    releaseSceneAppendBudget(descriptor)
    throw error instanceof DiskError ? error : new DiskError('storage-unavailable', error)
  }
  void markerDurable
}

function sceneMarkerSurvives(descriptor, sceneFd, orderText) {
  try {
    const bytes = readFileAt(sceneFd, `${orderText}.commit.json`, MAX_SCENE_MARKER_BYTES)
    const marker = validateSceneMarkerBytes(bytes, descriptor.sidHash, descriptor.order)
    return marker.revision === descriptor.revision
      && marker.recordSha256 === descriptor.newRevisionRecordSha256
  } catch (error) {
    return false
  }
}

function restoreSceneMarkerFailureMemory(descriptor) {
  if (descriptor === null) return
  if (descriptor.sceneHistorySnapshot === null) {
    scenes.delete(descriptor.sessionId)
  } else {
    scenes.set(descriptor.sessionId, { history: descriptor.sceneHistorySnapshot.slice() })
  }
  if (descriptor.isNewScene) sceneEpochs.delete(descriptor.sessionId)
  else if (descriptor.epochSnapshot !== null) sceneEpochs.set(descriptor.sessionId, descriptor.epochSnapshot)
  if (descriptor.revisionOrderSnapshot === null) {
    sceneRevisionOrderBySession.delete(descriptor.sessionId)
  } else {
    sceneRevisionOrderBySession.set(descriptor.sessionId, new Map(descriptor.revisionOrderSnapshot))
  }
  deleteAssetSessionRecorded.delete(descriptor.sessionId)
}

async function rollbackAfterFailedMarker(descriptor) {
  if (descriptor.boundary && descriptor.intentWritten) {
    if (descriptor.sceneFd !== null) {
      const orderName = `${String(descriptor.order).padStart(16, '0')}.json`
      try {
        if (entryExistsAt(descriptor.sceneFd, orderName)) {
          const revision = validateSceneRevisionBytes(
            readFileAt(descriptor.sceneFd, orderName, 2 * 1024 * 1024), descriptor.order, descriptor.sidHash)
          if (revision.recordSha256 === descriptor.newRevisionRecordSha256
            && fileStatAt(descriptor.sceneFd, `${String(descriptor.order).padStart(16, '0')}.commit.json`) === null) {
            unlinkAt(descriptor.sceneFd, orderName)
            fsyncFd(descriptor.sceneFd)
          }
        }
      } catch (error) { void error }
    }
    await rollbackSceneBoundaryNoMarker(descriptor)
  }
}

function scheduleSceneDurableCleanup(descriptor, sceneRecord, memoryEntry) {
  if (storage === null || storage.mode !== 'disk') return
  const tokens = []
  if (descriptor.trimVictims.length > 0) {
    tokens.push({
      kind: 'revision-trim',
      sessionId: descriptor.sessionId,
      sidHash: descriptor.sidHash,
      epoch: descriptor.epoch,
      revisionVictims: descriptor.trimVictims,
    })
  }
  for (const token of descriptor.evictedTokens) tokens.push(token)
  descriptor.trimVictims = []
  descriptor.evictedTokens = []
  if (tokens.length === 0) return
  deferredSceneCleanup.push(...tokens)
  void memoryEntry
  void pumpDeferredSceneCleanup()
}

let deferredSceneCleanupPumping = false

async function pumpDeferredSceneCleanup() {
  if (deferredSceneCleanupPumping || storage === null || storage.mode !== 'disk') return
  deferredSceneCleanupPumping = true
  try {
    while (deferredSceneCleanup.length > 0) {
      const token = deferredSceneCleanup.shift()
      if (token === undefined) break
      if (storage.closing) {
        deferredSceneCleanup = []
        break
      }
      try {
        await diskBarrier('beforeCleanupQueue')
        await runWithQueues([{ kind: 'asset', key: token.sidHash }], async () => {
          await diskBarrier('beforeCleanup')
          await cleanupSceneToken(token)
          await diskBarrier('afterCleanup')
        })
      } catch (error) {
        // Write-behind cleanup is reconciled on restart.
      }
    }
  } finally {
    deferredSceneCleanupPumping = false
  }
}

function sceneOrderIsLive(sessionId, order) {
  const live = sceneRevisionOrderBySession.get(sessionId)
  if (live === undefined) return false
  for (const value of live.values()) if (value === order) return true
  return false
}

async function unlinkCapturedRevision(sceneFd, token, victim) {
  const orderText = String(victim.order).padStart(16, '0')
  const revisionName = `${orderText}.json`
  const markerName = `${orderText}.commit.json`
  if (sceneOrderIsLive(token.sessionId, victim.order)) return
  let revision
  try {
    revision = validateSceneRevisionBytes(readFileAt(sceneFd, revisionName, 2 * 1024 * 1024),
      victim.order, token.sidHash)
  } catch (error) {
    return
  }
  if (revision.record.revision !== victim.revision) return
  if (token.epoch !== null && revision.record.epoch !== token.epoch) return
  let freed = 0
  try { freed += fileStatAt(sceneFd, revisionName)?.size ?? 0 } catch (error) { void error }
  unlinkAt(sceneFd, revisionName)
  fsyncFd(sceneFd)
  await diskBarrier('afterSceneRevisionUnlink')
  await diskFault('unlink', 'afterSceneRevisionUnlink')
  await diskBarrier('beforeSceneMarkerUnlink')
  await diskFault('unlink', 'beforeSceneMarkerUnlink')
  try {
    try { freed += fileStatAt(sceneFd, markerName)?.size ?? 0 } catch (error) { void error }
    unlinkAt(sceneFd, markerName)
  } catch (error) { if (error?.code !== 'ENOENT') throw error }
  fsyncFd(sceneFd)
  freeBudgetBytes(freed)
}

async function cleanupRevisionTrimToken(token) {
  const state = storage
  if (state.dirFds === null) return
  let sceneFd = null
  try { sceneFd = openDirAt(state.dirFds.scenes, token.sidHash) } catch (error) { return }
  try {
    for (const victim of token.revisionVictims) {
      if (scenes.has(token.sessionId) !== true) {
        // The in-memory scene disappeared; captured names are still safe to
        // remove only through the exact generation check.
      }
      await unlinkCapturedRevision(sceneFd, token, victim)
    }
  } finally {
    fs.closeSync(sceneFd)
  }
}

async function removeCapturedAssetDirectories(token) {
  const state = storage
  if (state.dirFds === null) return false
  let sessionFd = null
  try { sessionFd = openDirAt(state.dirFds.assets, token.sidHash) } catch (error) { return true }
  try {
    for (const victim of token.assetVictims) {
      if (scenes.has(token.sessionId)) return false
      const assetHash = victim.assetHash
      if (!entryExistsAt(sessionFd, assetHash)) continue
      const release = await acquireFence('cleanup-asset-trash')
      try {
        ensureFenceOpen()
        if (scenes.has(token.sessionId)) return false
        const slot = diskRandomHex()
        renameIntoTrash(sessionFd, assetHash, slot, true)
        fsyncFd(state.dirFds.trash)
        fsyncFd(sessionFd)
        drainTrashSlot(slot)
      } finally {
        release()
      }
      preservedStaleAssets.delete(victim.assetId)
    }
    return true
  } finally {
    fs.closeSync(sessionFd)
  }
}

function removeEmptyAssetSessionDir(sidHash) {
  const state = storage
  if (state === null || state.dirFds === null) return
  let sessionFd = null
  try {
    sessionFd = openDirAt(state.dirFds.assets, sidHash)
    const entries = readdirAt(sessionFd)
    if (entries.length !== 0) return
    fs.closeSync(sessionFd)
    sessionFd = null
    rmdirAt(state.dirFds.assets, sidHash)
    fsyncFd(state.dirFds.assets)
  } catch (error) {
    if (sessionFd !== null) { try { fs.closeSync(sessionFd) } catch (closeError) { void closeError } }
  }
}

function pendingCleanupTokenForSidHash(sidHash) {
  for (const token of deferredSceneCleanup) {
    if (token.sidHash === sidHash) return true
  }
  return false
}

async function maybeDeleteProductOwner(token) {
  const state = storage
  if (state.dirFds === null) return
  if (scenes.has(token.sessionId)) return
  const current = assetOwnerRecords.get(token.sidHash)
  if (current === undefined) return
  if (token.ownerIncarnation === 'legacy') return
  if (current.incarnation !== token.ownerIncarnation || current.sceneEpoch !== token.ownerEpoch) return
  if (pendingCleanupTokenForSidHash(token.sidHash)) return
  let sessionFd = null
  try { sessionFd = openDirAt(state.dirFds.assets, token.sidHash) } catch (error) { return }
  try {
    for (const entry of readdirAt(sessionFd)) {
      if (entry.name === 'owner.json') continue
      if (HEX64_RE.test(entry.name) && entry.isDirectory()) return
    }
    if (!entryExistsAt(sessionFd, 'owner.json')) return
    unlinkAt(sessionFd, 'owner.json')
    fsyncFd(sessionFd)
    assetOwnerRecords.delete(token.sidHash)
  } catch (error) {
    // Product owner removal is best-effort and reconciled at startup.
  } finally {
    fs.closeSync(sessionFd)
  }
  removeEmptyAssetSessionDir(token.sidHash)
}

async function cleanupSessionEvictionToken(token) {
  const state = storage
  if (state.dirFds === null) return
  let sceneFd = null
  try { sceneFd = openDirAt(state.dirFds.scenes, token.sidHash) } catch (error) { sceneFd = null }
  if (sceneFd !== null) {
    try {
      if (!scenes.has(token.sessionId)) {
        // No newer generation: remove the whole scene session atomically.
        const release = await acquireFence('cleanup-session-evict')
        try {
          ensureFenceOpen()
          if (!scenes.has(token.sessionId) && entryExistsAt(state.dirFds.scenes, token.sidHash)) {
            const slot = diskRandomHex()
            renameIntoTrash(state.dirFds.scenes, token.sidHash, slot, true)
            fsyncFd(state.dirFds.trash)
            fsyncFd(state.dirFds.scenes)
            noteFenceCounter('cleanupRename')
            noteFenceCounter('cleanupScenesParentFsync')
            drainTrashSlot(slot)
          }
        } finally {
          release()
        }
      } else {
        for (const victim of token.revisionVictims) await unlinkCapturedRevision(sceneFd, token, victim)
      }
    } finally {
      try { fs.closeSync(sceneFd) } catch (error) { void error }
    }
  }
  if (scenes.has(token.sessionId)) return
  const currentOwner = assetOwnerRecords.get(token.sidHash)
  if (currentOwner === undefined) {
    if (token.ownerIncarnation !== 'legacy') return
  } else if (token.ownerIncarnation === 'legacy'
    || currentOwner.incarnation !== token.ownerIncarnation
    || currentOwner.sceneEpoch !== token.ownerEpoch) {
    return
  }
  await removeCapturedAssetDirectories(token)
  await maybeDeleteProductOwner(token)
}

async function cleanupSceneToken(token) {
  if (token.kind === 'revision-trim') return cleanupRevisionTrimToken(token)
  if (token.kind === 'session-eviction') return cleanupSessionEvictionToken(token)
}

async function openStorageRoot(config) {
  const state = storage
  const testMode = config.isolatedTest === true
  const forbidden = forbiddenRootTargets()
  if (forbidden.some(target => isPathAncestorOrEqual(config.root, target))) {
    throw new DiskError('forbidden-root')
  }
  let rootExists = false
  try {
    const stat = fs.lstatSync(config.root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) {
      throw new DiskError('storage-unavailable')
    }
    rootExists = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error instanceof DiskError ? error : new DiskError('storage-unavailable', error)
  }
  if (!rootExists) {
    createMissingRoot(config.root, config.usedDefault, config.homeRoot ?? defaultDshHome())
  }
  let preflight
  try {
    preflight = preflightExistingRoot(config.root, testMode)
  } catch (error) {
    throw error instanceof DiskError ? error : new DiskError('storage-unavailable', error)
  }
  let rootFd
  try {
    rootFd = fs.openSync(config.root,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  } catch (error) {
    throw new DiskError('storage-unavailable', error)
  }
  const rootStat = fs.fstatSync(rootFd)
  if (!rootStat.isDirectory() || rootStat.uid !== process.getuid?.()) {
    fs.closeSync(rootFd)
    throw new DiskError('storage-unavailable')
  }
  if ((rootStat.mode & 0o777) !== 0o700) {
    try {
      fs.fchmodSync(rootFd, 0o700)
      const again = fs.fstatSync(rootFd)
      if ((again.mode & 0o777) !== 0o700 || (again.mode & 0o077) !== 0) throw new DiskError('storage-unavailable')
      fsyncFd(rootFd)
    } catch (error) {
      fs.closeSync(rootFd)
      throw error instanceof DiskError ? error : new DiskError('storage-unavailable', error)
    }
  }
  state.rootFd = rootFd
  try {
    if (preflight.empty) {
      ensureRootMarker(rootFd, testMode)
      preflight = preflightExistingRoot(config.root, testMode)
    }
    const hadVersion = entryExistsAt(rootFd, 'VERSION')
    const initialized = hadVersion || rootHasDataArtifacts(rootFd)
    const lock = acquireDiskLock(rootFd)
    state.lockToken = lock.token
    state.lockHeld = true
    state.dirFds = ensureDiskLayout(rootFd)
    state.budget = new DiskBudget({
      maxRootBytes: state.maxRootBytes,
      maxStagingBytes: state.maxStagingBytes,
    })
    verifyOrWriteVersion(rootFd, initialized)
    verifyDiskWriteProbe(rootFd)
    state.budget.used = measureRootUsage(state.dirFds, rootFd)
    await runStartupLoad()
    state.namespacePoison = fencePoisoned()
  } catch (error) {
    throw error instanceof DiskError ? error : new DiskError('storage-unavailable', error)
  }
}

function rootHasDataArtifacts(rootFd) {
  for (const name of ['scenes', 'thumbnails', 'assets', 'shares']) {
    try {
      const fd = openDirAt(rootFd, name)
      try { if (readdirAt(fd).length > 0) return true } finally { fs.closeSync(fd) }
    } catch (error) { void error }
  }
  let entries
  try { entries = readdirAt(rootFd) } catch (error) { return true }
  for (const entry of entries) {
    if (isKnownRootEntry(entry.name)) continue
    if (entry.name === DISK_ROOT_MARKER) continue
    return true
  }
  return false
}

function defaultDshHome() {
  let homeValue = ''
  try { homeValue = String(process.env.DSH_HOME ?? '').trim() } catch (error) { void error }
  if (homeValue === '') return join(homedir(), '.dsh')
  return expandConfiguredPath(homeValue, process.cwd())
}

function forbiddenRootTargets() {
  const targets = ['/', homedir(), tmpdir(), process.cwd()]
  try { targets.push(fs.realpathSync('.')) } catch (error) { void error }
  return [...new Set(targets.map(target => { try { return fs.realpathSync(target) } catch (error) { return resolvePath(target) } }))]
}

function verifyDiskWriteProbe(rootFd) {
  const tmpFd = storage.dirFds.tmp
  const name = diskRandomHex()
  const fd = fs.openSync(pathAnchored(tmpFd, name),
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  try {
    writeBufferToFd(fd, Buffer.from('probe', 'utf8'))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  const stat = fs.lstatSync(pathAnchored(tmpFd, name))
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
    throw new DiskError('storage-unavailable')
  }
  unlinkAt(tmpFd, name)
  fsyncFd(tmpFd)
  fsyncFd(rootFd)
}

function measureRootUsage(dirFds, rootFd) {
  let bytes = 0
  const visit = (parentFd, name, depth) => {
    if (depth > 8) return
    let stat
    try { stat = fs.lstatSync(pathAnchored(parentFd, name)) } catch (error) { return }
    if (stat.isSymbolicLink()) return
    if (stat.isFile()) { bytes += stat.size; return }
    if (!stat.isDirectory()) return
    let fd
    try { fd = openDirAt(parentFd, name) } catch (error) { return }
    try {
      for (const entry of readdirAtReal(fd)) visit(fd, entry.name, depth + 1)
    } finally {
      fs.closeSync(fd)
    }
  }
  for (const name of SCENE_NAMES) visit(rootFd, name, 0)
  for (const name of ['ROOT.json', 'VERSION', 'LOCK']) {
    try { bytes += fs.lstatSync(pathAnchored(rootFd, name)).size } catch (error) { void error }
  }
  void dirFds
  return bytes
}

function measureTreeBytes(parentFd, name, depth = 0) {
  if (depth > 8) return 0
  let stat
  try { stat = fs.lstatSync(pathAnchored(parentFd, name)) } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return stat.size
  let bytes = 0
  let fd
  try { fd = openDirAt(parentFd, name) } catch (error) { return 0 }
  try {
    for (const entry of readdirAtReal(fd)) bytes += measureTreeBytes(fd, entry.name, depth + 1)
  } finally {
    fs.closeSync(fd)
  }
  return bytes
}

function quarantineRootEntry(parentFd, sourceName, category) {
  const state = storage
  if (state === null || state.dirFds === null) return false
  const quarantineFd = state.dirFds.quarantine
  let slotFd = null
  let slotName = null
  try {
    const sourceBytes = measureTreeBytes(parentFd, sourceName)
    if (sourceBytes > MAX_QUARANTINE_BYTES) {
      state.stats.quarantineFailures += 1
      return false
    }
    const entries = readdirAt(quarantineFd)
    let sequence = 0
    let total = 0
    let totalBytes = 0
    const existing = []
    for (const entry of entries) {
      total += 1
      totalBytes += measureTreeBytes(quarantineFd, entry.name)
      const match = /^q-(\d{26})-([a-f0-9]{32})$/.exec(entry.name)
      if (match === null || !entry.isDirectory()) continue
      existing.push({ name: entry.name, sequence: Number(match[1]) })
      sequence = Math.max(sequence, Number(match[1]))
    }
    existing.sort((a, b) => a.sequence - b.sequence)
    while ((total >= MAX_QUARANTINE_ENTRIES || totalBytes + sourceBytes + 1024 > MAX_QUARANTINE_BYTES)
      && existing.length > 0) {
      const oldest = existing.shift()
      if (oldest === undefined) break
      let removed = 0
      try {
        removed = removeTreeAt(quarantineFd, oldest.name)
        fsyncFd(quarantineFd)
      } catch (error) {
        void error
      }
      total = Math.max(0, total - 1)
      totalBytes = Math.max(0, totalBytes - removed)
    }
    if (total >= MAX_QUARANTINE_ENTRIES || totalBytes + sourceBytes + 1024 > MAX_QUARANTINE_BYTES) {
      state.stats.quarantineFailures += 1
      return false
    }
    sequence += 1
    slotName = `q-${String(sequence).padStart(26, '0')}-${diskRandomHex()}`
    slotFd = mkdirDurableAt(quarantineFd, slotName)
    let renamed = false
    try {
      diskFaultSync('quarantineRename', 'beforeQuarantineRename')
      renameAt(parentFd, sourceName, slotFd, 'artifact')
      renamed = true
      diskBarrierSync('afterQuarantineRename')
      diskFaultSync('quarantineRename', 'afterQuarantineRename')
      fsyncFd(parentFd)
      const reason = serializeRecord({ v: 1, category, reason: category })
      writeFileDurableSync(slotFd, 'reason.json', reason)
      diskBarrierSync('afterQuarantineReasonWrite')
      diskFaultSync('quarantineReason', 'afterQuarantineReasonWrite')
      fsyncFd(slotFd)
      diskBarrierSync('afterQuarantineSlotFsync')
      diskFaultSync('quarantineFsync', 'afterQuarantineSlotFsync')
      fsyncFd(quarantineFd)
      fsyncFd(parentFd)
      state.stats.quarantined += 1
      return true
    } catch (error) {
      if (renamed) {
        try {
          renameAt(slotFd, 'artifact', parentFd, sourceName)
          fsyncFd(parentFd)
          if (slotName !== null) {
            try { removeTreeAt(quarantineFd, slotName) } catch (cleanupError) { void cleanupError }
          }
        } catch (reverseError) {
          state.stats.quarantineFailures += 1
        }
      } else {
        state.stats.quarantineFailures += 1
        if (slotName !== null) {
          try { removeTreeAt(quarantineFd, slotName) } catch (cleanupError) { void cleanupError }
        }
      }
      return false
    }
  } catch (error) {
    state.stats.quarantineFailures += 1
    return false
  } finally {
    if (slotFd !== null) fs.closeSync(slotFd)
  }
}

/**
 * Register the tool, its prompt guidance, and the preview routes.
 * @param ctx - host plugin context.
 */
export function apply(ctx) {
  const state = ensureStorage()
  state.refs += 1
  ctx.effect(() => {
    startStorage()
    return () => {
      state.refs = Math.max(0, state.refs - 1)
      if (state.refs === 0) stopStorage()
    }
  }, 'three-workbench: durable storage')
  ctx.effect(() => ctx.tools.register({
    name: TOOL_NAME,
    description: 'Create or replace the live Three.js animation shown in the user\'s preview pane. '
      + 'Pass the complete scene script as `code`; it runs in a sandbox with THREE, scene, camera, '
      + 'renderer, clock, controls, addons.OrbitControls, onFrame(cb) and name-only asset '
      + 'helpers (assets.url, assets.texture, assets.model, assets.hdri) available. '
      + 'Call again with the full revised script to iterate.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          description: 'Short human title for this scene, shown in the preview pane.',
        },
        code: {
          type: 'string',
          description: 'The complete scene script. Runs once in the preview sandbox; use onFrame(cb) for animation.',
        },
      },
      required: ['code'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sceneId: { type: 'string' },
          revision: { type: 'integer' },
          bytes: { type: 'integer' },
          title: { type: 'string' },
        },
        required: ['sceneId', 'revision', 'bytes', 'title'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Scene "${value.title}" is live in the preview pane (revision ${String(value.revision)}, ${String(value.bytes)} bytes).`,
      }],
      presentationMeta: (_args, value) => ({
        sceneId: value.sceneId,
        revision: value.revision,
        title: value.title,
      }),
    },
    async execute(args, exec) {
      if (storageNeedsReady()) await storageReady()
      const sessionId = exec.agent?.session?.id
      if (sessionId === undefined) {
        throw new Error('three_scene requires an owning agent session')
      }
      const code = args.code
      const bytes = Buffer.byteLength(code, 'utf8')
      if (bytes > MAX_CODE_BYTES) {
        throw new Error(`three_scene code is ${String(bytes)} bytes; the limit is ${String(MAX_CODE_BYTES)} bytes. Split the scene or simplify it.`)
      }
      const sceneId = String(sessionId)
      const input = {
        title: typeof args.title === 'string' && args.title.trim() !== '' ? args.title.trim() : 'Three.js scene',
        code,
        bytes,
        updatedAt: Date.now(),
      }
      const appended = await appendSceneWithDurability(sceneId, input, descriptor => {
        if (descriptor !== null) publishSceneEpochForCommit(sceneId, descriptor.epoch)
        const scene = commitSceneRevision(sceneId, {
          title: input.title,
          code: input.code,
          bytes: input.bytes,
          updatedAt: input.updatedAt,
        })
        if (descriptor !== null) updateSceneRevisionOrderForCommit(descriptor, scene)
        return scene
      })
      const scene = appended.scene
      return {
        sceneId: scene.sceneId,
        revision: scene.revision,
        bytes: scene.bytes,
        title: scene.title,
      }
    },
  }), 'three-workbench: three_scene tool')

  ctx.effect(() => ctx.tools.register({
    name: PROPOSAL_TOOL_NAME,
    description: 'Propose an AI-native workbench change for the user to preview and approve. '
      + 'A proposal never mutates the scene by itself. Kinds: shots (camera shot list), pins '
      + '(review notes or labels anchored to object uid or world position), measure (two world points), '
      + 'explode (view-only exploded-view amount), view (camera preset, explicit camera, or orthographic plan view), '
      + 'geometry (manual primitive parameter patch), insert (validated primitive assembly data), '
      + 'recipe (save a reusable assembly to the editor-only shelf), link (editor-only object relationship), '
      + 'scene (a prompt for a later three_scene edit). '
      + 'The user can Preview, Apply, Reject, or ask why. Always include a short rationale. '
      + 'Prefer this over calling three_scene directly when the UI is in Ask, Edit or Review mode.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: PROPOSAL_KINDS },
        baseRevision: {
          type: 'integer', minimum: 0,
          description: 'Scene revision this proposal is based on. Defaults to the current revision.',
        },
        rationale: {
          type: 'string', maxLength: PROPOSAL_MAX_RATIONALE,
          description: 'Why this proposal helps. Shown on the proposal card.',
        },
        payload: {
          type: 'object', additionalProperties: true,
          description: 'Kind-specific data. shots: {shots:[{name,position:[x,y,z],target:[x,y,z],fov}]}; '
            + 'pins: {pins:[{uid,position,severity,message,kind}]}; measure: {label,from:[x,y,z],to:[x,y,z],uidA,uidB}; '
            + 'explode: {amount}; view: {preset,projection} or {position,target,fov,projection}; geometry: {uid,params}; '
            + 'insert: {parts:[{shape,name,position,rotation,scale,params,material}],origin} or {recipeId,origin}; '
            + 'recipe: {name,description,parts}; link: {fromUid,toUid,kind,label}; scene: {prompt}.',
        },
      },
      required: ['kind', 'payload'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          baseRevision: { type: 'integer' },
          rationale: { type: 'string' },
          payload: { type: 'object', additionalProperties: true },
        },
        required: ['id', 'kind', 'baseRevision', 'rationale', 'payload'],
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Proposed ${value.kind} change for approval (revision ${String(value.baseRevision)}).`,
      }],
      presentationMeta: (_args, value) => ({ proposal: value }),
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session?.id
      if (sessionId === undefined) {
        throw new Error('workbench_proposal requires an owning agent session')
      }
      const kind = typeof args.kind === 'string' ? args.kind : ''
      if (!PROPOSAL_KINDS.includes(kind)) {
        throw new Error(`workbench_proposal kind must be one of ${PROPOSAL_KINDS.join(', ')}`)
      }
      const payload = args.payload !== null && typeof args.payload === 'object' && !Array.isArray(args.payload)
        ? args.payload : null
      if (payload === null) throw new Error('workbench_proposal payload must be an object')
      const isVector = value => Array.isArray(value) && value.length === 3
        && value.every(component => typeof component === 'number' && Number.isFinite(component))
      const isPart = part => {
        if (part === null || typeof part !== 'object' || Array.isArray(part)) return false
        if (!PROPOSAL_SHAPES.includes(part.shape)) return false
        if (part.position !== undefined && !isVector(part.position)) return false
        if (part.rotation !== undefined && !isVector(part.rotation)) return false
        if (part.scale !== undefined && (!isVector(part.scale)
          || part.scale.some(component => component < 0.01 || component > 1000))) return false
        if (part.params !== undefined && (part.params === null || typeof part.params !== 'object'
          || Array.isArray(part.params))) return false
        if (part.params !== undefined) {
          for (const value of Object.values(part.params)) {
            if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1000000) return false
          }
        }
        if (part.material !== undefined) {
          if (part.material === null || typeof part.material !== 'object' || Array.isArray(part.material)) return false
          if (part.material.color !== undefined
            && (typeof part.material.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(part.material.color))) return false
        }
        return true
      }
      const isPartList = value => Array.isArray(value) && value.length >= 1
        && value.length <= PROPOSAL_MAX_PARTS && value.every(isPart)
      if ((kind === 'shots' || kind === 'pins') && !Array.isArray(payload[kind === 'shots' ? 'shots' : 'pins'])) {
        throw new Error(`workbench_proposal ${kind} payload needs a ${kind} array`)
      }
      if (kind === 'measure' && (!isVector(payload.from) || !isVector(payload.to))) {
        throw new Error('workbench_proposal measure payload needs from and to [x,y,z] points')
      }
      if (kind === 'explode' && (typeof payload.amount !== 'number' || !Number.isFinite(payload.amount))) {
        throw new Error('workbench_proposal explode payload needs a numeric amount')
      }
      if (kind === 'view') {
        const preset = typeof payload.preset === 'string' && PROPOSAL_VIEW_PRESETS.includes(payload.preset)
        const camera = isVector(payload.position) && isVector(payload.target)
        if (!preset && !camera) {
          throw new Error('workbench_proposal view payload needs a preset or position and target points')
        }
        if (payload.projection !== undefined
          && payload.projection !== 'perspective' && payload.projection !== 'orthographic') {
          throw new Error('workbench_proposal view projection must be perspective or orthographic')
        }
      }
      if (kind === 'insert') {
        const hasParts = isPartList(payload.parts)
        const hasShape = payload.shape !== undefined && isPart(payload)
        const hasRecipe = typeof payload.recipeId === 'string' && payload.recipeId.trim() !== ''
        if (!hasParts && !hasShape && !hasRecipe) {
          throw new Error('workbench_proposal insert payload needs validated parts, a shape, or a recipeId')
        }
        if (payload.origin !== undefined && !isVector(payload.origin)) {
          throw new Error('workbench_proposal insert origin must be an [x,y,z] point')
        }
      }
      if (kind === 'recipe') {
        if (typeof payload.name !== 'string' || payload.name.trim() === '' || !isPartList(payload.parts)) {
          throw new Error('workbench_proposal recipe payload needs a name and validated parts')
        }
      }
      if (kind === 'link') {
        if (typeof payload.fromUid !== 'string' || payload.fromUid.trim() === ''
          || typeof payload.toUid !== 'string' || payload.toUid.trim() === ''
          || payload.fromUid.trim() === payload.toUid.trim()) {
          throw new Error('workbench_proposal link payload needs two different object uids')
        }
      }
      if (kind === 'geometry') {
        if (typeof payload.uid !== 'string' || payload.uid.trim() === ''
          || payload.params === null || typeof payload.params !== 'object' || Array.isArray(payload.params)
          || Object.keys(payload.params).length === 0) {
          throw new Error('workbench_proposal geometry payload needs uid and a non-empty params object')
        }
      }
      if (kind === 'scene' && (typeof payload.prompt !== 'string' || payload.prompt.trim() === '')) {
        throw new Error('workbench_proposal scene payload needs a prompt')
      }
      const sceneId = String(sessionId)
      const entry = scenes.get(sceneId)
      const head = entry === undefined ? undefined : latestOf(entry)
      const requested = Number.isSafeInteger(args.baseRevision) && args.baseRevision >= 0 ? args.baseRevision : null
      const baseRevision = requested ?? (head === undefined ? 0 : head.revision)
      const rationale = typeof args.rationale === 'string'
        ? args.rationale.trim().slice(0, PROPOSAL_MAX_RATIONALE) : ''
      return {
        id: 'proposal_' + randomBytes(12).toString('hex'),
        kind,
        baseRevision,
        rationale,
        payload,
      }
    },
  }), 'three-workbench: workbench_proposal tool')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:three-scene',
    order: 2500,
    text: PROMPT,
  }), 'three-workbench: prompt section')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'tool:workbench-proposal',
    order: 2501,
    text: PROPOSAL_PROMPT,
  }), 'three-workbench: proposal prompt section')

  // The preview routes exist only where a browser-facing server is composed;
  // headless profiles still get the tool and prompt.
  ctx.inject(['webServer'], (scope) => {
    // The boot page precedes every client plugin, so brand it through the
    // served index. Guarded for recording contexts that expose only register().
    if (typeof scope.on === 'function') {
      scope.effect(() => scope.on('webserver/index-inject', (table) => {
        if (!Array.isArray(table)) return
        for (const row of BOOT_BRAND_ROWS) table.push(row)
      }), 'three-workbench: boot branding')
    }
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      resource: serve,
    }), 'three-workbench: preview routes')
    // Resource routes are GET/HEAD only; thumbnail upload needs its own handler.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PATH}/thumbnail`,
      handler: uploadThumbnail,
    }), 'three-workbench: thumbnail upload')
    // Asset upload/delete are Node handlers (raw binary and JSON bodies);
    // the list and capability content routes are resources (GET/HEAD only).
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PATH}/assets/upload`,
      handler: uploadAsset,
    }), 'three-workbench: asset upload')
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PATH}/assets/delete`,
      handler: deleteAsset,
    }), 'three-workbench: asset delete')
    // P3-2 restore is the only browser route that can append a revision. It is
    // exact, same-origin, session-header authenticated and copies Host memory.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: RESTORE_PATH,
      handler: restoreHandler,
    }), 'three-workbench: history restore')
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PATH}/assets`,
      resource: assetListResponse,
    }), 'three-workbench: asset list')
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: `${ROUTE_PATH}/assets`,
      resource: assetContentResponse,
    }), 'three-workbench: asset content')
    // P3-1 share links. The exact write routes take precedence over the
    // viewer prefix; the viewer resource handles only GET/HEAD.
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: `${SHARE_PATH}/create`,
      handler: shareCreateHandler,
    }), 'three-workbench: share create')
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: `${SHARE_PATH}/delete`,
      handler: shareDeleteHandler,
    }), 'three-workbench: share delete')
    scope.effect(() => scope.webServer.register({
      kind: 'prefix',
      path: SHARE_PATH,
      resource: shareViewerResponse,
    }), 'three-workbench: share viewer')
  })
}

/**
 * Answer one request under the workbench prefix.
 * @param request - incoming Fetch request.
 * @returns the response for a preview, scene record, or runtime file.
 */
async function serve(request) {
  if (storageNeedsReady()) await storageReady()
  const url = new URL(request.url, 'http://localhost')
  const pathname = url.pathname
  try {
    if (pathname.startsWith(`${ROUTE_PATH}/state/`)) {
      const sceneId = decodeURIComponent(pathname.slice(`${ROUTE_PATH}/state/`.length))
      const entry = entryFor(sceneId)
      if (entry === undefined) return jsonResponse({ missing: true, sceneId, revision: null, revisions: [] })
      const latest = latestOf(entry)
      return jsonResponse({
        sceneId,
        revision: latest.revision,
        title: latest.title,
        bytes: latest.bytes,
        updatedAt: latest.updatedAt,
        revisions: entry.history.map(record => ({
          revision: record.revision,
          title: record.title,
          bytes: record.bytes,
          updatedAt: record.updatedAt,
        })),
      })
    }
    if (pathname.startsWith(`${ROUTE_PATH}/scene/`)) {
      const sceneId = decodeURIComponent(pathname.slice(`${ROUTE_PATH}/scene/`.length))
      const entry = entryFor(sceneId)
      if (entry === undefined) return jsonResponse({ error: 'not-found' }, 404)
      const requested = url.searchParams.get('rev')
      const record = requested === null ? latestOf(entry) : entry.history.find(row => row.revision === Number(requested))
      if (record === undefined) return jsonResponse({ error: 'revision-not-found' }, 404)
      return jsonResponse({
        sceneId,
        revision: record.revision,
        title: record.title,
        code: record.code,
        bytes: record.bytes,
        updatedAt: record.updatedAt,
      })
    }
    if (pathname.startsWith(`${ROUTE_PATH}/thumbnail/`)) {
      const rest = pathname.slice(`${ROUTE_PATH}/thumbnail/`.length)
      const slash = rest.lastIndexOf('/')
      if (slash <= 0) return textResponse('Not found.', 404)
      const key = `${decodeURIComponent(rest.slice(0, slash))}:${String(Number(rest.slice(slash + 1)))}`
      const body = thumbnails.get(key)
      if (body === undefined) return textResponse('Not found.', 404)
      return new Response(request.method === 'HEAD' ? null : body, {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
        },
      })
    }
    if (pathname.startsWith(`${ROUTE_PATH}/runtime/`)) {
      const file = decodeURIComponent(pathname.slice(`${ROUTE_PATH}/runtime/`.length))
      // Only plain .js under runtime/, no traversal, no dotfiles.
      const safe = /^[A-Za-z0-9_./-]+\.js$/.test(file) && !file.includes('..') && !file.startsWith('/')
        && !file.split('/').some(part => part.startsWith('.'))
      if (!safe) {
        return textResponse('Not found.', 404)
      }
      const body = await runtimeFile(file)
      return new Response(body, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'public, max-age=31536000, immutable',
          'access-control-allow-origin': '*',
        },
      })
    }
    return textResponse('Not found.', 404)
  } catch (error) {
    return textResponse(`three-workbench: ${error instanceof Error ? error.message : String(error)}`, 500)
  }
}

/**
 * @param sceneId - session id or the demo id.
 * @returns the stored scene entry, or undefined.
 */
function entryFor(sceneId) {
  if (sceneId === DEMO_SCENE.sceneId) return { history: [DEMO_SCENE] }
  return scenes.get(sceneId)
}

/**
 * @param entry - scene entry with at least one revision.
 * @returns its newest record.
 */
function latestOf(entry) {
  return entry.history[entry.history.length - 1]
}

/**
 * Append one revision with the tool/restore shared append/trim/LRU algorithm.
 * The caller owns title, code and updatedAt; the helper owns the revision
 * number, bytes, trimming and Session eviction cleanup. It is synchronous.
 * @param sessionId - owning Session.
 * @param input - `{title, code, bytes?, updatedAt}`.
 * @returns the appended record (also the new head).
 */
function commitSceneRevision(sessionId, input) {
  const previous = scenes.get(sessionId)
  const history = previous === undefined ? [] : previous.history
  const head = history.length === 0 ? undefined : history[history.length - 1]
  const record = {
    sceneId: sessionId,
    revision: (head?.revision ?? 0) + 1,
    title: input.title,
    code: input.code,
    bytes: input.bytes === undefined ? Buffer.byteLength(input.code, 'utf8') : input.bytes,
    updatedAt: input.updatedAt,
  }
  const nextHistory = [...history, record]
  while (nextHistory.length > MAX_REVISIONS) nextHistory.shift()
  scenes.delete(sessionId)
  scenes.set(sessionId, { history: nextHistory })
  while (scenes.size > MAX_SCENES) {
    const oldest = scenes.keys().next().value
    if (oldest === undefined) break
    scenes.delete(oldest)
    // Assets are Session-scoped capabilities: evicting the Session's scene
    // must revoke its assets and restore state too, never just forget the map.
    deleteAssetSession(oldest)
    clearRestoreSessionState(oldest)
  }
  return record
}

/**
 * Store one rendered PNG for a session revision.
 * @param payload - `{ sessionId, revision, dataUrl }`.
 * @returns true, or a status and message for a rejected body.
 */
function validateThumbnailPayload(payload) {
  if (payload === null || typeof payload !== 'object') return { status: 400, message: 'expected a JSON body' }
  const { sessionId, revision, dataUrl } = payload
  if (typeof sessionId !== 'string' || sessionId === '' || !Number.isInteger(revision) || revision < 0) {
    return { status: 400, message: 'expected sessionId and revision' }
  }
  // A session id alone is a capability; only accept both halves of the pair
  // the Host actually stores, so arbitrary ids cannot grow the map.
  const entry = scenes.get(sessionId)
  if (entry === undefined) return { status: 404, message: 'unknown session' }
  if (!entry.history.some(record => record.revision === revision)) {
    return { status: 404, message: 'unknown revision' }
  }
  const match = typeof dataUrl === 'string' ? /^data:image\/png;base64,(.+)$/.exec(dataUrl) : null
  if (match === null) return { status: 400, message: 'expected a PNG data URL' }
  const buffer = Buffer.from(match[1], 'base64')
  if (buffer.length > MAX_THUMBNAIL_BYTES) return { status: 413, message: 'thumbnail too large' }
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return { status: 415, message: 'not a PNG' }
  return { ok: true, sessionId, revision, buffer }
}

function storeThumbnail(payload) {
  const validated = validateThumbnailPayload(payload)
  if (validated.ok !== true) return validated
  const { sessionId, revision, buffer } = validated
  const key = `${sessionId}:${String(revision)}`
  thumbnails.set(key, buffer)
  // Revisions age out of a long session, but the thumbnail map would keep one
  // entry per revision ever seen. Bound each session independently, evicting
  // its oldest thumbnail (the filmstrip no longer lists that revision).
  const prefix = `${sessionId}:`
  const sessionKeys = [...thumbnails.keys()].filter(existing => existing.startsWith(prefix))
  while (sessionKeys.length > MAX_THUMBNAILS_PER_SESSION) {
    const oldest = sessionKeys.shift()
    if (oldest === undefined) break
    if (oldest !== key) thumbnails.delete(oldest)
  }
  while (thumbnails.size > MAX_THUMBNAILS) {
    const oldest = thumbnails.keys().next().value
    if (oldest === undefined) break
    thumbnails.delete(oldest)
  }
  return true
}

function thumbnailDiskEntries() {
  return [...thumbnailIndex.values()].map(entry => ({ ...entry }))
}

function thumbnailEntryFilename(entry) {
  return `${thumbKeyHash(entry.sceneId, entry.revision)}-${entry.sha256}.png`
}

function planThumbnailEvictions(entries, sessionId, keepKey) {
  const planned = entries.map(entry => ({ ...entry }))
  const sessionKeys = planned.filter(entry => entry.sceneId === sessionId)
  while (sessionKeys.length > MAX_THUMBNAILS_PER_SESSION) {
    const oldest = sessionKeys.shift()
    if (oldest === undefined) break
    if (oldest.key === keepKey) continue
    const index = planned.findIndex(entry => entry.key === oldest.key)
    if (index >= 0) planned.splice(index, 1)
  }
  while (planned.length > MAX_THUMBNAILS) {
    const oldest = planned.shift()
    if (oldest === undefined) break
    if (oldest.key === keepKey) {
      planned.push(oldest)
      break
    }
  }
  return planned
}

function sameThumbnailEntry(left, right) {
  return left.key === right.key && left.sceneId === right.sceneId
    && left.revision === right.revision && left.order === right.order
    && left.bytes === right.bytes && left.sha256 === right.sha256
    && left.createdAt === right.createdAt
}

async function writeThumbnailIndexDurable(state, entries, plannedNextOrder) {
  const built = buildThumbIndex(entries, plannedNextOrder)
  const now = diskNowMs()
  const wait = state.lastThumbIndexWriteAt + THUMBNAIL_INDEX_MIN_INTERVAL_MS - now
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
  const previous = (() => {
    try { return readFileAt(state.dirFds.thumbnails, 'index.json', MAX_THUMB_INDEX_BYTES) } catch (error) { return null }
  })()
  await writeFileDurableAt(state.dirFds.thumbnails, 'index.json', built.bytes,
    { op: 'indexRename', at: 'afterIndexRename' })
  await diskBarrier('afterIndexRename')
  await diskFault('indexRename', 'afterIndexRename')
  state.lastThumbIndexWriteAt = diskNowMs()
  return { built, previous }
}

function cleanupThumbnailFiles(state, previousEntries, currentEntries, protectedName) {
  const referenced = new Set(currentEntries.map(entry => thumbnailEntryFilename(entry)))
  if (protectedName !== null) referenced.add(protectedName)
  let changed = false
  try {
    for (const dirent of readdirAt(state.dirFds.thumbnails)) {
      if (dirent.name === 'index.json') continue
      if (!dirent.isFile() || dirent.isSymbolicLink()) continue
      if (referenced.has(dirent.name)) continue
      if (previousEntries.some(entry => thumbnailEntryFilename(entry) === dirent.name)) {
        // A previously referenced PNG is still safe to remove only after the
        // committed index no longer names it; never leave unreferenced data.
      }
      try { unlinkAt(state.dirFds.thumbnails, dirent.name); changed = true } catch (error) { void error }
    }
    if (changed) fsyncFd(state.dirFds.thumbnails)
  } catch (error) {
    // Thumbnail cleanup is write-behind; startup reconciles.
  }
}

async function performDiskThumbnailUpload(sessionId, revision, buffer, payload) {
  const state = storage
  if (state === null || state.dirFds === null || state.mode !== 'disk') return false
  if (thumbnailWriteDegraded) return false
  await ensureTrashPressure()
  const thumbFd = state.dirFds.thumbnails
  const key = `${sessionId}:${String(revision)}`
  const sha256 = diskSha(buffer)
  const existing = thumbnailIndex.get(key) ?? null
  const previousEntries = thumbnailDiskEntries()
  const createdAt = existing === null ? diskNowMs() : existing.createdAt
  const order = existing === null ? nextThumbOrder : existing.order
  if (!isSafePositive(order) || order > MAX_ORDER) return false
  const entry = {
    key, sceneId: sessionId, revision, order, bytes: buffer.length, sha256, createdAt,
  }
  const plannedEntries = previousEntries.filter(item => item.key !== key)
  plannedEntries.push(entry)
  const evictedEntries = planThumbnailEvictions(plannedEntries, sessionId, key)
  const plannedNextOrder = existing === null ? order + 1 : nextThumbOrder
  if (plannedNextOrder > MAX_ORDER) return false
  const filename = thumbnailEntryFilename(entry)
  let wroteNewPng = false
  let reused = false
  let indexWritten = false
  try {
    let existingStat = null
    try { existingStat = fileStatAt(thumbFd, filename) } catch (error) { existingStat = null }
    if (existingStat !== null) {
      if (!existingStat.isFile() || existingStat.isSymbolicLink() || existingStat.size !== buffer.length) {
        throw new DiskError('thumbnail-conflict')
      }
      const existingBytes = readFileAt(thumbFd, filename, MAX_THUMBNAIL_BYTES)
      if (diskSha(existingBytes) !== sha256) throw new DiskError('thumbnail-conflict')
      reused = true
    } else {
      await diskBarrier('beforeThumbnailPublish')
      await diskFault('publish', 'beforeThumbnailPublish')
      await writeFileDurableAt(thumbFd, filename, buffer,
        { op: 'publish', at: 'afterThumbnailPublish' })
      await diskBarrier('afterThumbnailPublish')
      await diskFault('publish', 'afterThumbnailPublish')
      wroteNewPng = true
    }
    await writeThumbnailIndexDurable(state, evictedEntries, plannedNextOrder)
    indexWritten = true
    const mem = storeThumbnail(payload)
    if (mem !== true) {
      // The index may already be live; restore the previous index best-effort.
      try {
        if (previousEntries.length === 0) {
          try { unlinkAt(thumbFd, 'index.json') } catch (error) { if (error?.code !== 'ENOENT') throw error }
        } else {
          const restored = buildThumbIndex(previousEntries, nextThumbOrder)
          writeFileDurableSync(thumbFd, 'index.json', restored.bytes)
        }
      } catch (error) {
        thumbnailWriteDegraded = true
        state.stats.thumbnailDegraded = true
        return false
      }
      if (wroteNewPng) {
        try { unlinkAt(thumbFd, filename) } catch (error) { void error }
      }
      return false
    }
    thumbnailIndex.clear()
    for (const planned of evictedEntries) thumbnailIndex.set(planned.key, { ...planned })
    nextThumbOrder = Math.max(nextThumbOrder, plannedNextOrder)
    cleanupThumbnailFiles(state, previousEntries, evictedEntries, reused ? filename : null)
    return true
  } catch (error) {
    if (!indexWritten) {
      if (wroteNewPng) {
        try { unlinkAt(thumbFd, filename) } catch (cleanupError) { void cleanupError }
        try { fsyncFd(thumbFd) } catch (cleanupError) { void cleanupError }
      }
      return false
    }
    // Post-index failure: adopt the planned index into memory when possible,
    // advance the order, and still never send 200.
    let adopted = false
    try {
      const observed = readFileAt(thumbFd, 'index.json', MAX_THUMB_INDEX_BYTES)
      const parsed = validateThumbIndexBytes(observed)
      const matches = parsed.entries.length === evictedEntries.length
        && parsed.entries.every((item, index) => sameThumbnailEntry(item, evictedEntries[index]))
      if (matches) {
        const mem = storeThumbnail(payload)
        if (mem === true) {
          thumbnailIndex.clear()
          for (const planned of evictedEntries) thumbnailIndex.set(planned.key, { ...planned })
          nextThumbOrder = Math.max(nextThumbOrder, plannedNextOrder,
            ...evictedEntries.map(item => item.order + 1))
          cleanupThumbnailFiles(state, previousEntries, evictedEntries, reused ? filename : null)
          adopted = true
        }
      }
      if (!adopted) {
        try {
          if (previousEntries.length === 0) {
            try { unlinkAt(thumbFd, 'index.json') } catch (restoreError) { if (restoreError?.code !== 'ENOENT') throw restoreError }
          } else {
            const restored = buildThumbIndex(previousEntries, nextThumbOrder)
            writeFileDurableSync(thumbFd, 'index.json', restored.bytes)
          }
          if (wroteNewPng) {
            try { unlinkAt(thumbFd, filename) } catch (cleanupError) { void cleanupError }
          }
        } catch (restoreError) {
          thumbnailWriteDegraded = true
          state.stats.thumbnailDegraded = true
        }
      }
    } catch (adoptError) {
      thumbnailWriteDegraded = true
      state.stats.thumbnailDegraded = true
    }
    return false
  }
}

/**
 * POST handler for thumbnail uploads; resource routes answer GET/HEAD only.
 * @param req - Node request carrying `{ sessionId, revision, dataUrl }`.
 * @param res - Node response.
 */
async function uploadThumbnail(req, res) {
  if (storageNeedsReady()) await storageReady()
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' })
    res.end()
    return
  }
  const chunks = []
  let size = 0
  req.on('data', chunk => {
    size += chunk.length
    if (size <= MAX_THUMBNAIL_BYTES * 2) chunks.push(chunk)
  })
  req.on('end', () => {
    void (async () => {
      if (size > MAX_THUMBNAIL_BYTES * 2) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('too large')
        return
      }
      let payload
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch (error) {
        void error
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('invalid JSON')
        return
      }
      const validated = validateThumbnailPayload(payload)
      if (validated.ok !== true) {
        res.writeHead(validated.status, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(validated.message)
        return
      }
      if (storage !== null && storage.mode === 'disk') {
        let release = null
        try {
          release = await acquireDiskQueue('thumbnail', 'global')
          const rechecked = validateThumbnailPayload(payload)
          if (rechecked.ok !== true) {
            res.writeHead(rechecked.status, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(rechecked.message)
            return
          }
          const ok = await performDiskThumbnailUpload(
            rechecked.sessionId, rechecked.revision, rechecked.buffer, payload)
          if (!ok) {
            res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('thumbnail storage failed')
            return
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end('{"ok":true}')
          return
        } catch (error) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('thumbnail storage failed')
          return
        } finally {
          if (release !== null) release()
        }
      }
      if (storage !== null && storage.mode === 'degraded') {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('thumbnail storage failed')
        return
      }
      const outcome = storeThumbnail(payload)
      if (outcome !== true) {
        res.writeHead(outcome.status, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(outcome.message)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end('{"ok":true}')
    })()
  })
  req.on('error', () => {
    try {
      res.writeHead(400)
      res.end()
    } catch (error) {
      void error
    }
  })
}

// ---------------------------------------------------------------------------
// Asset store and routes (P1-9). Everything here treats uploaded bytes as
// untrusted data: only sniffed raster/GLB/GLTF/HDR bytes are stored, always
// served with the sniffed MIME and a capability ID, never executed.
// ---------------------------------------------------------------------------

/**
 * @param sessionId - Session id.
 * @param nameFold - case-folded display name.
 * @returns the uniqueness key for one Session.
 */
function assetNameKey(sessionId, nameFold) {
  return `${sessionId}\u0000${nameFold}`
}

/**
 * @param req - Node request.
 * @param name - lower-case header name.
 * @returns the string header value, or null.
 */
function requestHeader(req, name) {
  const value = req.headers === undefined ? undefined : req.headers[name]
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return null
}

/**
 * Decode the percent-encoded upload name once.
 * @param value - raw `x-workbench-name` header.
 * @returns the decoded string, or null when malformed.
 */
function decodeAssetNameHeader(value) {
  if (typeof value !== 'string' || value === '' || value.length > 8192) return null
  try {
    return decodeURIComponent(value)
  } catch (error) {
    void error
    return null
  }
}

/**
 * Normalize a display name into a safe API key: NFC, trimmed, controls and
 * bidi controls removed, path separators and `..` removed, 128 code points.
 * @param value - decoded name.
 * @returns the safe name, or null when it exceeds the 128-code-point cap.
 */
function sanitizeAssetName(value) {
  if (typeof value !== 'string') return null
  let name = value.normalize('NFC').trim()
  name = name.replace(/[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/g, '')
  name = name.replace(/[/\\:]/g, '')
  name = name.replace(/\.\./g, '')
  name = name.replace(/^[.\s]+|[.\s]+$/g, '')
  if (name === '') name = 'asset'
  if (Array.from(name).length > ASSET_LIMITS.nameCodePoints) return null
  return name
}

/**
 * @param buffer - candidate bytes.
 * @param offset - start offset.
 * @returns true for JSON whitespace.
 */
function isJsonWhitespaceByte(buffer, offset) {
  const byte = buffer[offset]
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

/**
 * @param buffer - candidate bytes.
 * @returns true when the WebP container is internally consistent.
 */
function isWebpBuffer(buffer) {
  if (buffer.length < 16) return false
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WEBP') return false
  if (buffer.readUInt32LE(4) !== buffer.length - 8) return false
  const chunk = buffer.toString('latin1', 12, 16)
  return chunk === 'VP8 ' || chunk === 'VP8L' || chunk === 'VP8X'
}

/**
 * @param buffer - candidate bytes.
 * @returns true when the GLB header and first JSON chunk are consistent.
 */
function isGlbBuffer(buffer) {
  if (buffer.length < 20) return false
  if (buffer.toString('latin1', 0, 4) !== 'glTF') return false
  if (buffer.readUInt32LE(4) !== 2) return false
  if (buffer.readUInt32LE(8) !== buffer.length) return false
  const chunkLength = buffer.readUInt32LE(12)
  if (chunkLength === 0) return false
  if (buffer.readUInt32LE(16) !== 0x4e4f534a) return false
  if (20 + chunkLength > buffer.length) return false
  return buffer[20] === 0x7b
}

/**
 * @param buffer - candidate bytes.
 * @returns the parsed glTF JSON document, or null when the signature fails.
 */
function sniffGltfBuffer(buffer) {
  let offset = 0
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) offset = 3
  let first = offset
  while (first < buffer.length && isJsonWhitespaceByte(buffer, first)) first += 1
  if (first >= buffer.length || buffer[first] !== 0x7b) return null
  let json
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(offset))
    json = JSON.parse(text)
  } catch (error) {
    void error
    return null
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return null
  const version = json.asset === null || json.asset === undefined ? undefined : json.asset.version
  if (typeof version !== 'string' || !version.startsWith('2.')) return null
  return json
}

/**
 * Sniff one upload by its bytes only, in the design's fixed order.
 * @param buffer - upload bytes.
 * @returns `{kind, subtype, mime, ext, json?}` or null when no signature matches.
 */
function sniffAssetBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null
  if (buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { kind: 'image', subtype: 'png', mime: 'image/png', ext: '.png' }
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { kind: 'image', subtype: 'jpeg', mime: 'image/jpeg', ext: '.jpg' }
  }
  if (isWebpBuffer(buffer)) {
    return { kind: 'image', subtype: 'webp', mime: 'image/webp', ext: '.webp' }
  }
  if (isGlbBuffer(buffer)) {
    return { kind: 'model', subtype: 'glb', mime: 'model/gltf-binary', ext: '.glb' }
  }
  const gltfJson = sniffGltfBuffer(buffer)
  if (gltfJson !== null) {
    return { kind: 'model', subtype: 'gltf', mime: 'model/gltf+json', ext: '.gltf', json: gltfJson }
  }
  for (const signature of HDR_SIGNATURES) {
    if (buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature)) {
      return { kind: 'hdr', subtype: 'hdr', mime: 'image/vnd.radiance', ext: '.hdr' }
    }
  }
  return null
}

/**
 * @param uri - buffer/image URI from a glTF document.
 * @returns `{mime, bytes}` for a base64 data URI, or null.
 */
function parseGltfDataUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('data:')) return null
  const comma = uri.indexOf(',')
  if (comma < 0) return null
  const meta = uri.slice(5, comma)
  const payload = uri.slice(comma + 1)
  const parts = meta.split(';')
  const mime = parts[0].toLowerCase()
  const base64 = parts.slice(1).some(part => part.toLowerCase() === 'base64')
  if (!base64) return null
  if (payload.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null
  const decoded = Buffer.from(payload, 'base64')
  // Reject non-canonical base64 that Buffer would silently truncate; accept
  // either padded or unpadded payloads.
  if (decoded.toString('base64').replace(/=+$/, '') !== payload.replace(/=+$/, '')) return null
  return { mime, bytes: decoded.length }
}

/**
 * Enforce the embedded-data-URI and decoder-extension policy for glTF JSON.
 * @param json - parsed glTF/GLB JSON document.
 * @returns an error outcome, or `{ok:true, embeddedBytes}`.
 */
function validateGltfPolicy(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, status: 422, code: 'unsupported-gltf', message: 'invalid glTF JSON' }
  }
  for (const key of ['extensionsRequired', 'extensionsUsed']) {
    const list = json[key]
    if (!Array.isArray(list)) continue
    for (const extension of list) {
      if (typeof extension === 'string' && GLTF_UNSUPPORTED_EXTENSIONS.has(extension)) {
        return {
          ok: false, status: 422, code: 'unsupported-extension',
          message: `unsupported glTF extension: ${extension}`,
        }
      }
    }
  }
  let embeddedBytes = 0
  const check = (entry, allowedMimes, label) => {
    if (entry === null || typeof entry !== 'object' || !Object.prototype.hasOwnProperty.call(entry, 'uri')) return null
    const parsed = parseGltfDataUri(entry.uri)
    if (parsed === null || !allowedMimes.has(parsed.mime)) {
      return {
        ok: false, status: 422, code: 'gltf-external-uri',
        message: `${label} must be an embedded base64 data URI`,
      }
    }
    embeddedBytes += parsed.bytes
    return null
  }
  if (Array.isArray(json.buffers)) {
    for (const entry of json.buffers) {
      const failure = check(entry, GLTF_BUFFER_MIMES, 'buffer')
      if (failure !== null) return failure
    }
  }
  if (Array.isArray(json.images)) {
    for (const entry of json.images) {
      const failure = check(entry, GLTF_IMAGE_MIMES, 'image')
      if (failure !== null) return failure
    }
  }
  if (embeddedBytes > ASSET_LIMITS.maxGltfEmbeddedBytes) {
    return {
      ok: false, status: 413, code: 'too-large',
      message: 'embedded glTF data exceeds the 32 MiB limit',
      limit: 'gltf-embedded', max: ASSET_LIMITS.maxGltfEmbeddedBytes,
    }
  }
  return { ok: true, embeddedBytes }
}

/**
 * @param buffer - GLB bytes.
 * @returns parsed JSON chunk when it happens to be valid JSON, else null.
 */
function parseGlbJson(buffer) {
  try {
    const length = buffer.readUInt32LE(12)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(20, 20 + length))
    const json = JSON.parse(text)
    return json !== null && typeof json === 'object' && !Array.isArray(json) ? json : null
  } catch (error) {
    void error
    return null
  }
}

/**
 * Validate one upload against the extension/sniff/per-file/glTF matrix.
 * @param buffer - complete upload bytes.
 * @param name - sanitized display name.
 * @returns `{ok:true, kind, mime, ext}` or a failure outcome.
 */
function validateAssetBytes(buffer, name) {
  const dot = name.lastIndexOf('.')
  const declaredExtension = dot < 0 ? '' : name.slice(dot).toLowerCase()
  const sniffed = sniffAssetBytes(buffer)
  if (sniffed === null) {
    return { ok: false, status: 415, code: 'unsupported-type', message: 'unsupported asset type' }
  }
  const allowed = ASSET_EXTENSIONS[sniffed.subtype]
  if (allowed === undefined || !allowed.includes(declaredExtension)) {
    return {
      ok: false, status: 415, code: 'extension-mismatch',
      message: `extension ${declaredExtension === '' ? '(none)' : declaredExtension} does not match ${sniffed.mime}`,
    }
  }
  const cap = ASSET_FILE_CAPS[sniffed.subtype]
  if (buffer.length > cap) {
    return {
      ok: false, status: 413, code: 'too-large',
      message: `file exceeds the ${String(cap / MIB)} MiB limit`,
      limit: 'file', max: cap,
    }
  }
  let json = null
  if (sniffed.subtype === 'gltf') json = sniffed.json
  if (sniffed.subtype === 'glb') json = parseGlbJson(buffer)
  if (json !== null) {
    const policy = validateGltfPolicy(json)
    if (!policy.ok) return policy
  }
  return { ok: true, kind: sniffed.kind, mime: sniffed.mime, ext: sniffed.ext }
}

/**
 * @param asset - stored asset.
 * @returns its public metadata row (never bytes or Session).
 */
function publicAsset(asset) {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    mime: asset.mime,
    bytes: asset.bytes,
    createdAt: asset.createdAt,
  }
}

/**
 * @param sessionId - Session id.
 * @returns true when a stored scene pair exists for the Session.
 */
function isAssetSession(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 256
    && scenes.has(sessionId)
}

function visibleAssetRows(sessionId) {
  const list = assets.get(sessionId)
  if (list === undefined) return []
  const rows = []
  for (const asset of list.values()) {
    if (hiddenAssetIds.has(asset.id)) continue
    if (preservedStaleAssets.has(asset.id)) continue
    rows.push(publicAsset(asset))
  }
  return rows
}

function isAssetOwnerSession(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) return false
  return isAssetSession(sessionId) || visibleAssetRows(sessionId).length > 0
}

/**
 * @param sessionId - Session id.
 * @returns its rate state, creating it lazily.
 */
function assetRateState(sessionId) {
  let state = assetRates.get(sessionId)
  if (state === undefined) {
    state = { uploads: [], active: 0, listDelete: [] }
    assetRates.set(sessionId, state)
  }
  return state
}

/**
 * @param times - ascending timestamp list.
 * @param now - current time.
 */
function pruneRateTimes(times, now) {
  while (times.length > 0 && now - times[0] >= 60_000) times.shift()
}

/**
 * Atomically check and count one upload against all upload rate limits.
 * @param sessionId - Session id.
 * @returns `{ok:true,state}` or a 429 failure.
 */
function beginUploadRate(sessionId) {
  const now = Date.now()
  const state = assetRateState(sessionId)
  pruneRateTimes(state.uploads, now)
  pruneRateTimes(globalUploadTimes, now)
  if (state.active >= ASSET_LIMITS.concurrentUploadsPerSession
    || state.uploads.length >= ASSET_LIMITS.uploadsPerSessionPerMinute
    || globalUploadTimes.length >= ASSET_LIMITS.uploadsGlobalPerMinute) {
    return { ok: false, status: 429, code: 'rate-limited', message: 'too many uploads' }
  }
  state.uploads.push(now)
  globalUploadTimes.push(now)
  state.active += 1
  return { ok: true, state }
}

/**
 * @param sessionId - Session id.
 * @returns true when this list/delete request is within its rate limit.
 */
function takeListDeleteRate(sessionId) {
  const now = Date.now()
  const state = assetRateState(sessionId)
  pruneRateTimes(state.listDelete, now)
  if (state.listDelete.length >= ASSET_LIMITS.listDeletePerSessionPerMinute) return false
  state.listDelete.push(now)
  return true
}

/**
 * Drop one asset from every index and counter.
 * @param sessionId - owning Session.
 * @param assetId - capability id.
 * @returns true when the asset existed in that Session.
 */
function dropAsset(sessionId, assetId) {
  const list = assets.get(sessionId)
  const asset = list === undefined ? undefined : list.get(assetId)
  if (asset === undefined || assetIndex.get(assetId) !== sessionId) return false
  list.delete(assetId)
  if (list.size === 0) assets.delete(sessionId)
  assetIndex.delete(assetId)
  assetNames.delete(assetNameKey(sessionId, asset.nameFold))
  const usage = assetUsage.get(sessionId)
  if (usage !== undefined) {
    usage.count -= 1
    usage.bytes -= asset.bytes
    if (usage.count <= 0) assetUsage.delete(sessionId)
  }
  globalUsage.count -= 1
  globalUsage.bytes -= asset.bytes
  hiddenAssetIds.delete(assetId)
  assetOrderById.delete(assetId)
  assetHashById.delete(assetId)
  assetDiskMetaById.delete(assetId)
  preservedStaleAssets.delete(assetId)
  return true
}

/**
 * Atomically check duplicate/quota limits, allocate a random capability id,
 * and commit one fully validated asset.
 * @param sessionId - Session id.
 * @param data - `{name,nameFold,kind,mime,ext,bytes,buffer}`.
 * @returns `{ok:true,asset}` or a failure outcome.
 */
function putAsset(sessionId, data) {
  if (assetNames.has(assetNameKey(sessionId, data.nameFold))) {
    return { ok: false, status: 409, code: 'duplicate-name', message: 'an asset with this name already exists' }
  }
  const usage = assetUsage.get(sessionId) ?? { count: 0, bytes: 0 }
  if (usage.count >= ASSET_LIMITS.sessionAssets) {
    return {
      ok: false, status: 413, code: 'session-quota', message: 'Session asset count limit reached',
      limit: 'session-assets', max: ASSET_LIMITS.sessionAssets,
    }
  }
  if (usage.bytes + data.bytes > ASSET_LIMITS.sessionBytes) {
    return {
      ok: false, status: 413, code: 'session-quota', message: 'Session asset byte limit reached',
      limit: 'session-bytes', max: ASSET_LIMITS.sessionBytes,
    }
  }
  if (globalUsage.count >= ASSET_LIMITS.globalAssets) {
    return {
      ok: false, status: 413, code: 'global-quota', message: 'global asset count limit reached',
      limit: 'global-assets', max: ASSET_LIMITS.globalAssets,
    }
  }
  if (globalUsage.bytes + data.bytes > ASSET_LIMITS.globalBytes) {
    return {
      ok: false, status: 413, code: 'global-quota', message: 'global asset byte limit reached',
      limit: 'global-bytes', max: ASSET_LIMITS.globalBytes,
    }
  }
  let id
  do {
    id = randomBytes(16).toString('base64url')
  } while (assetIndex.has(id))
  const asset = {
    id,
    name: data.name,
    nameFold: data.nameFold,
    kind: data.kind,
    mime: data.mime,
    ext: data.ext,
    bytes: data.bytes,
    buffer: data.buffer,
    createdAt: Date.now(),
  }
  let list = assets.get(sessionId)
  if (list === undefined) {
    list = new Map()
    assets.set(sessionId, list)
  }
  list.set(id, asset)
  assetIndex.set(id, sessionId)
  assetNames.set(assetNameKey(sessionId, data.nameFold), id)
  usage.count += 1
  usage.bytes += data.bytes
  assetUsage.set(sessionId, usage)
  globalUsage.count += 1
  globalUsage.bytes += data.bytes
  return { ok: true, asset }
}

/**
 * @param assetId - capability id.
 * @returns the asset, or undefined.
 */
function getAsset(assetId) {
  const sessionId = assetIndex.get(assetId)
  if (sessionId === undefined) return undefined
  const list = assets.get(sessionId)
  return list === undefined ? undefined : list.get(assetId)
}

/**
 * Remove every asset and all rate state belonging to one Session.
 * @param sessionId - Session id.
 */
function deleteAssetSession(sessionId) {
  const list = assets.get(sessionId)
  if (list !== undefined) {
    const captured = []
    for (const asset of list.values()) {
      assetIndex.delete(asset.id)
      globalUsage.count -= 1
      globalUsage.bytes -= asset.bytes
      captured.push({
        id: asset.id,
        bytes: asset.bytes,
        nameFold: asset.nameFold,
        hash: assetIdHash(asset.id),
        epoch: assetDiskMetaById.get(asset.id)?.sceneEpoch ?? null,
      })
    }
    deleteAssetSessionRecorded.set(sessionId, captured)
    assets.delete(sessionId)
  } else {
    deleteAssetSessionRecorded.set(sessionId, [])
  }
  const prefix = `${sessionId}\u0000`
  for (const key of [...assetNames.keys()]) {
    if (key.startsWith(prefix)) assetNames.delete(key)
  }
  assetUsage.delete(sessionId)
  assetRates.delete(sessionId)
}

/**
 * @param sessionId - Session id.
 * @returns the existing Session usage meter.
 */
function assetUsageFor(sessionId) {
  const usage = assetUsage.get(sessionId)
  return usage === undefined ? { count: 0, bytes: 0 } : usage
}

/**
 * @param code - stable error code.
 * @param message - human message.
 * @param extra - optional `limit`/`max`.
 * @returns the documented JSON error body.
 */
function assetErrorBody(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } }
}

/**
 * @param body - JSON body.
 * @param status - HTTP status.
 * @param extraHeaders - additional headers.
 * @returns a Fetch response with JSON and no-store.
 */
function assetJsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  })
}

/**
 * Send one JSON response from a Node handler.
 * @param res - Node response.
 * @param status - HTTP status.
 * @param body - JSON body.
 * @param extraHeaders - additional headers.
 */
function sendAssetJson(res, status, body, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(payload)),
    ...extraHeaders,
  })
  res.end(payload)
}

/**
 * @returns true when the Session header is absent or belongs to no scene.
 * @param sessionId - header value.
 */
function unknownAssetSession(sessionId) {
  return !isAssetSession(sessionId)
}

/**
 * Exact GET /three-workbench/assets resource.
 * @param request - Fetch request.
 * @returns Session-scoped list JSON (never another Session's rows).
 */
async function assetListResponse(request) {
  if (storageNeedsReady()) await storageReady()
  const method = request.method
  if (method !== 'GET' && method !== 'HEAD') {
    return assetJsonResponse(assetErrorBody('method-not-allowed', 'GET or HEAD required'), 405, { allow: 'GET, HEAD' })
  }
  const sessionId = request.headers.get('x-workbench-session')
  if (!isAssetOwnerSession(sessionId)) {
    return assetJsonResponse(assetErrorBody('unknown-session', 'unknown Session'), 404)
  }
  if (!takeListDeleteRate(sessionId)) {
    return assetJsonResponse(assetErrorBody('rate-limited', 'too many list/delete requests'), 429, { 'retry-after': '10' })
  }
  const rows = assetStore.list(sessionId)
  const usage = rows.reduce((total, row) => ({
    count: total.count + 1,
    bytes: total.bytes + row.bytes,
  }), { count: 0, bytes: 0 })
  const payload = JSON.stringify({ ok: true, assets: rows, usage })
  return new Response(method === 'HEAD' ? null : payload, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(payload)),
    },
  })
}

/**
 * @param asset - stored asset.
 * @returns every security/metadata header for a content response.
 */
function assetContentHeaders(asset) {
  const disposition = asset.kind === 'image' ? 'inline' : 'attachment'
  return {
    'content-type': asset.mime,
    'content-length': String(asset.bytes),
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*',
    'cross-origin-resource-policy': 'cross-origin',
    'content-disposition': `${disposition}; filename="asset-${asset.id}${asset.ext}"`,
    'cache-control': 'private, no-cache',
    'etag': `"a-${asset.id}-${asset.createdAt}"`,
    'content-security-policy': "default-src 'none'; sandbox",
    'referrer-policy': 'no-referrer',
  }
}

/**
 * Prefix GET/HEAD /three-workbench/assets/<id> capability resource.
 * @param request - Fetch request.
 * @returns raw bytes with fixed security headers, 304, or 404.
 */
async function assetContentResponse(request) {
  if (storageNeedsReady()) await storageReady()
  const method = request.method
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method not allowed.', {
      status: 405,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', allow: 'GET, HEAD' },
    })
  }
  const url = new URL(request.url, 'http://localhost')
  const prefix = `${ROUTE_PATH}/assets/`
  if (!url.pathname.startsWith(prefix)) return new Response('Not found.', {
    status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
  const assetId = url.pathname.slice(prefix.length)
  if (!ASSET_ID_RE.test(assetId)) return new Response('Not found.', {
    status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
  const asset = assetStore.get(assetId)
  if (asset === undefined) return new Response('Not found.', {
    status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
  const headers = assetContentHeaders(asset)
  const ifNoneMatch = request.headers.get('if-none-match')
  if (ifNoneMatch !== null) {
    const candidates = ifNoneMatch.split(',').map(value => value.trim())
    if (candidates.includes(headers.etag) || candidates.includes('*')) {
      const revalidationHeaders = { ...headers }
      delete revalidationHeaders['content-type']
      delete revalidationHeaders['content-length']
      delete revalidationHeaders['content-disposition']
      return new Response(null, { status: 304, headers: revalidationHeaders })
    }
  }
  return new Response(method === 'HEAD' ? null : asset.buffer, { status: 200, headers })
}

function assetStorageFailureBody() {
  return assetErrorBody('storage', 'could not store asset')
}

function assetDeleteStorageFailureBody() {
  return assetErrorBody('storage', 'could not delete asset')
}

async function currentOwnerForSidHash(sidHash) {
  const known = assetOwnerRecords.get(sidHash)
  if (known !== undefined && known !== null) return known
  const state = storage
  if (state.dirFds === null) return null
  let sessionFd = null
  try { sessionFd = openDirAt(state.dirFds.assets, sidHash) } catch (error) { return null }
  try {
    const owner = loadAssetOwnerRecord(sessionFd, sidHash).owner
    assetOwnerRecords.set(sidHash, owner)
    return owner
  } catch (error) {
    return null
  } finally {
    fs.closeSync(sessionFd)
  }
}

async function publishAssetDurable(sessionId, asset, epoch, order) {
  const state = storage
  const sidHash = sceneSidHash(sessionId)
  const assetHash = assetIdHash(asset.id)
  const tmpFd = state.dirFds.tmp
  const assetsFd = state.dirFds.assets
  const slotName = diskRandomHex()
  let slotFd = null
  let capturedDir = false
  let createdOwner = false
  let sessionFd = null
  const metaBytes = buildAssetMeta({
    sceneId: sessionId,
    sceneEpoch: epoch,
    id: asset.id,
    name: asset.name,
    nameFold: asset.nameFold,
    kind: asset.kind,
    mime: asset.mime,
    ext: asset.ext,
    bytes: asset.bytes,
    order,
    createdAt: asset.createdAt,
    sha256: diskSha(asset.buffer),
  }).bytes
  try {
    const owner = await currentOwnerForSidHash(sidHash)
    if (owner === null || owner.sceneEpoch !== epoch) {
      await writeAssetOwnerDurable(sidHash, epoch)
      createdOwner = true
    }
    sessionFd = mkdirDurableAt(assetsFd, sidHash)
    if (entryExistsAt(sessionFd, assetHash)) throw new DiskError('schema')
    slotFd = mkdirDurableAt(tmpFd, slotName)
    await diskFault('publish', 'beforeAssetStaging')
    writeFileDurableSync(slotFd, 'meta.json', metaBytes)
    writeFileDurableSync(slotFd, 'body.bin', asset.buffer)
    fsyncFd(slotFd)
    await diskBarrier('afterAssetPendingInsert')
    await diskBarrier('afterAssetStaging')
    await diskFault('publish', 'afterAssetStaging')
    try {
      await diskFault('rename', 'asset-publish')
      renameAt(tmpFd, slotName, sessionFd, assetHash)
      capturedDir = true
    } catch (error) {
      throw new DiskError('storage-unavailable', error)
    }
    await diskBarrier('afterAssetRename')
    await diskFault('publish', 'afterAssetRename')
    fsyncFd(sessionFd)
    fsyncFd(assetsFd)
    try {
      await diskFault('commitMarker', 'beforeAssetCommitMarker')
      writeFileDurableSync(sessionFd, `${assetHash}/COMMITTED`, Buffer.alloc(0))
      await diskBarrier('afterAssetCommitMarker')
      await diskFault('commitMarker', 'afterAssetCommitMarker')
      const committedFd = openDirAt(sessionFd, assetHash)
      try {
        if (fileStatAt(committedFd, 'COMMITTED') === null) throw new DiskError('storage-unavailable')
        fsyncFd(committedFd)
      } finally {
        fs.closeSync(committedFd)
      }
    } catch (error) {
      throw new DiskError('storage-unavailable', error)
    }
    return { sidHash, assetHash, metaBytes, createdOwner, order, epoch, committed: true }
  } catch (error) {
    if (slotFd !== null) {
      try { fs.closeSync(slotFd) } catch (e) { void e }
      slotFd = null
    }
    if (capturedDir) {
      // Make a partial committed directory unreachable; startup deletes an
      // unmarked directory. Never delete another asset path.
      try {
        if (sessionFd !== null) {
          try { unlinkAt(sessionFd, `${assetHash}/COMMITTED`) } catch (e) { void e }
        }
      } catch (e) { void e }
    }
    try { if (slotFd === null) removeTreeAt(tmpFd, slotName) } catch (e) { void e }
    throw error instanceof DiskError ? error : new DiskError('storage-unavailable', error)
  } finally {
    if (slotFd !== null) { try { fs.closeSync(slotFd) } catch (e) { void e } }
    if (sessionFd !== null) { try { fs.closeSync(sessionFd) } catch (e) { void e } }
  }
}

async function rollbackPublishedAsset(sessionId, published) {
  const state = storage
  if (published === null || state.dirFds === null) return false
  let sessionFd = null
  try { sessionFd = openDirAt(state.dirFds.assets, published.sidHash) } catch (error) { return false }
  try {
    if (!entryExistsAt(sessionFd, published.assetHash)) return true
    const slot = diskRandomHex()
    let release = null
    try {
      release = await acquireFence('cleanup-asset-rollback')
      ensureFenceOpen()
      await diskFault('deleteRename', 'beforeDeleteRename')
      renameIntoTrash(sessionFd, published.assetHash, slot, true)
      await diskBarrier('afterDeleteRename')
      await diskFault('deleteRename', 'afterDeleteRename')
      try { fsyncFd(state.dirFds.trash) } catch (error) { void error }
      try { fsyncFd(sessionFd) } catch (error) { void error }
      drainTrashSlot(slot)
      return true
    } catch (error) {
      return false
    } finally {
      if (release !== null) release()
    }
  } finally {
    fs.closeSync(sessionFd)
  }
}

async function deleteAssetDurable(sessionId, asset) {
  const state = storage
  if (state.dirFds === null) return false
  const sidHash = sceneSidHash(sessionId)
  let sessionFd = null
  try { sessionFd = openDirAt(state.dirFds.assets, sidHash) } catch (error) { return true }
  try {
    const assetHash = assetIdHash(asset.id)
    if (!entryExistsAt(sessionFd, assetHash)) return true
    const slot = diskRandomHex()
    let release = null
    try {
      release = await acquireFence('cleanup-asset-delete')
      ensureFenceOpen()
      try {
        await diskFault('deleteRename', 'beforeDeleteRename')
        renameIntoTrash(sessionFd, assetHash, slot, true)
        await diskBarrier('afterDeleteRename')
        await diskFault('deleteRename', 'afterDeleteRename')
      } catch (error) {
        return false
      }
      // Rename success is committed even when a following fsync fails.
      try { fsyncFd(state.dirFds.trash) } catch (error) { void error }
      try { fsyncFd(sessionFd) } catch (error) { void error }
      drainTrashSlot(slot)
      return true
    } finally {
      if (release !== null) release()
    }
  } finally {
    fs.closeSync(sessionFd)
  }
}

async function maybeRemoveOwnerAfterLastAsset(sessionId, sidHash, createdOwner) {
  const state = storage
  if (state.dirFds === null) return
  if (scenes.has(sessionId)) return
  if (preservedStaleAssets.size > 0) {
    for (const value of preservedStaleAssets.values()) {
      if (value.sidHash === sidHash) return
    }
  }
  for (const token of deferredSceneCleanup) {
    if (token.sidHash === sidHash) return
  }
  let sessionFd = null
  try { sessionFd = openDirAt(state.dirFds.assets, sidHash) } catch (error) { return }
  try {
    let remaining = false
    for (const entry of readdirAt(sessionFd)) {
      if (entry.name === 'owner.json') continue
      if (HEX64_RE.test(entry.name) && entry.isDirectory()) remaining = true
    }
    if (remaining) return
    if (entryExistsAt(sessionFd, 'owner.json')) {
      try {
        unlinkAt(sessionFd, 'owner.json')
        fsyncFd(sessionFd)
        assetOwnerRecords.delete(sidHash)
      } catch (error) { void error }
    }
    void createdOwner
  } finally {
    fs.closeSync(sessionFd)
  }
  removeEmptyAssetSessionDir(sidHash)
}

async function performDiskAssetUpload(sessionId, body, name, nameFold, validation, reply) {
  const state = storage
  const sidHash = sceneSidHash(sessionId)
  const release = await acquireDiskQueue('asset', sidHash)
  let stored = null
  let published = null
  let order = null
  let budgetHold = null
  try {
    if (!scenes.has(sessionId)) {
      reply(404, assetErrorBody('unknown-session', 'unknown Session'))
      return
    }
    const epoch = sceneEpochs.get(sessionId)
    if (typeof epoch !== 'string' || !HEX32_RE.test(epoch)) {
      reply(503, assetStorageFailureBody())
      return
    }
    order = nextAssetOrder
    if (!isSafePositive(order) || order > MAX_ORDER) {
      reply(503, assetStorageFailureBody())
      return
    }
    nextAssetOrder += 1
    stored = putAsset(sessionId, {
      name,
      nameFold,
      kind: validation.kind,
      mime: validation.mime,
      ext: validation.ext,
      bytes: body.length,
      buffer: body,
    })
    if (!stored.ok) {
      reply(stored.status, assetErrorBody(stored.code, stored.message, {
        ...(stored.limit === undefined ? {} : { limit: stored.limit }),
        ...(stored.max === undefined ? {} : { max: stored.max }),
      }))
      return
    }
    hiddenAssetIds.add(stored.asset.id)
    await diskBarrier('afterAssetPendingInsert')
    try {
      const metaForBudget = buildAssetMeta({
        sceneId: sessionId,
        sceneEpoch: epoch,
        id: stored.asset.id,
        name: stored.asset.name,
        nameFold: stored.asset.nameFold,
        kind: stored.asset.kind,
        mime: stored.asset.mime,
        ext: stored.asset.ext,
        bytes: stored.asset.bytes,
        order,
        createdAt: stored.asset.createdAt,
        sha256: diskSha(body),
      }).bytes
      const peak = metaForBudget.length + body.length
      budgetHold = await state.budget.reserveOperation(peak, peak)
      published = await publishAssetDurable(sessionId, stored.asset, epoch, order)
    } catch (error) {
      dropAsset(sessionId, stored.asset.id)
      hiddenAssetIds.delete(stored.asset.id)
      reply(503, assetStorageFailureBody())
      return
    }
    if (storage.closing) {
      await rollbackPublishedAsset(sessionId, published)
      dropAsset(sessionId, stored.asset.id)
      reply(503, assetStorageFailureBody())
      return
    }
    await diskBarrier('beforeAssetPostCommitRecheck')
    const currentEpoch = sceneEpochs.get(sessionId)
    const live = scenes.has(sessionId)
    if (!live) {
      const removed = await rollbackPublishedAsset(sessionId, published)
      dropAsset(sessionId, stored.asset.id)
      hiddenAssetIds.delete(stored.asset.id)
      if (removed) {
        await maybeRemoveOwnerAfterLastAsset(sessionId, sidHash, published.createdOwner)
      }
      reply(404, assetErrorBody('unknown-session', 'unknown Session'))
      return
    }
    if (currentEpoch !== epoch) {
      const removed = await rollbackPublishedAsset(sessionId, published)
      dropAsset(sessionId, stored.asset.id)
      hiddenAssetIds.delete(stored.asset.id)
      if (removed) await maybeRemoveOwnerAfterLastAsset(sessionId, sidHash, published.createdOwner)
      reply(currentEpoch === undefined ? 503 : 404,
        currentEpoch === undefined ? assetStorageFailureBody() : assetErrorBody('unknown-session', 'unknown Session'))
      return
    }
    hiddenAssetIds.delete(stored.asset.id)
    assetOrderById.set(stored.asset.id, order)
    assetHashById.set(stored.asset.id, assetIdHash(stored.asset.id))
    assetDiskMetaById.set(stored.asset.id, {
      sceneId: sessionId, sceneEpoch: epoch, order, sha256: diskSha(body),
    })
    reply(201, { ok: true, asset: publicAsset(stored.asset) })
  } catch (error) {
    if (stored !== null && stored.ok && stored.asset !== undefined) {
      try { dropAsset(sessionId, stored.asset.id) } catch (e) { void e }
      hiddenAssetIds.delete(stored.asset.id)
    }
    if (published !== null) await rollbackPublishedAsset(sessionId, published)
    reply(503, assetStorageFailureBody())
  } finally {
    if (budgetHold !== null) {
      try { budgetHold.release() } catch (budgetError) { void budgetError }
    }
    release()
  }
}

/**
 * POST handler for raw binary uploads.
 * @param req - Node request.
 * @param res - Node response.
 */
async function uploadAsset(req, res) {
  if (storageNeedsReady()) await storageReady()
  if (req.method !== 'POST') {
    sendAssetJson(res, 405, assetErrorBody('method-not-allowed', 'POST required'), { allow: 'POST' })
    req.resume()
    return
  }
  const encoding = requestHeader(req, 'content-encoding')
  if (encoding !== null && encoding.toLowerCase() !== 'identity') {
    sendAssetJson(res, 400, assetErrorBody('invalid-encoding', 'content-encoding must be identity'))
    req.resume()
    return
  }
  const sessionId = requestHeader(req, 'x-workbench-session')
  if (unknownAssetSession(sessionId)) {
    sendAssetJson(res, 404, assetErrorBody('unknown-session', 'unknown Session'))
    req.resume()
    return
  }
  const decodedName = decodeAssetNameHeader(requestHeader(req, 'x-workbench-name'))
  const name = decodedName === null ? null : sanitizeAssetName(decodedName)
  if (name === null) {
    sendAssetJson(res, 400, assetErrorBody('invalid-name', 'a valid percent-encoded name is required'))
    req.resume()
    return
  }
  const nameFold = name.normalize('NFC').toLowerCase()
  const lengthHeader = requestHeader(req, 'content-length')
  let declared = null
  if (lengthHeader !== null) {
    if (!/^\d{1,20}$/.test(lengthHeader)) {
      sendAssetJson(res, 400, assetErrorBody('invalid-body', 'invalid content-length'))
      req.resume()
      return
    }
    declared = Number(lengthHeader)
    if (!Number.isSafeInteger(declared) || declared === 0) {
      sendAssetJson(res, 400, assetErrorBody('invalid-body', 'empty upload body'))
      req.resume()
      return
    }
    if (declared > ASSET_LIMITS.maxUploadBytes) {
      sendAssetJson(res, 413, assetErrorBody(
        'too-large',
        'file exceeds the 32 MiB upload limit',
        { limit: 'upload', max: ASSET_LIMITS.maxUploadBytes },
      ), { connection: 'close' })
      req.resume()
      return
    }
  }
  const rate = beginUploadRate(sessionId)
  if (!rate.ok) {
    sendAssetJson(res, 429, assetErrorBody(rate.code, rate.message), { 'retry-after': '10' })
    req.resume()
    return
  }
  const rateState = rate.state
  let released = false
  const release = () => {
    if (released) return
    released = true
    rateState.active = Math.max(0, rateState.active - 1)
  }
  let responded = false
  const reply = (status, body, headers = {}) => {
    if (responded) return
    responded = true
    release()
    sendAssetJson(res, status, body, headers)
  }
  const chunks = []
  let size = 0
  let over = false
  let endSeen = false
  req.on('data', chunk => {
    size += chunk.length
    if (!over) {
      if (size > ASSET_LIMITS.maxUploadBytes) {
        over = true
        chunks.length = 0
      } else {
        chunks.push(chunk)
      }
    }
    if (size > ASSET_LIMITS.maxUploadBytes * 2) {
      reply(413, assetErrorBody(
        'too-large',
        'file exceeds the upload limit',
        { limit: 'upload', max: ASSET_LIMITS.maxUploadBytes },
      ), { connection: 'close' })
      req.destroy()
    }
  })
  req.on('end', async () => {
    endSeen = true
    if (responded) {
      release()
      return
    }
    if (over) {
      reply(413, assetErrorBody(
        'too-large',
        'file exceeds the upload limit',
        { limit: 'upload', max: ASSET_LIMITS.maxUploadBytes },
      ))
      return
    }
    const buffer = Buffer.concat(chunks)
    if (buffer.length === 0) {
      reply(400, assetErrorBody('invalid-body', 'empty upload body'))
      return
    }
    if (declared !== null && buffer.length !== declared) {
      reply(400, assetErrorBody('invalid-body', 'body length does not match content-length'))
      return
    }
    const validation = validateAssetBytes(buffer, name)
    if (!validation.ok) {
      reply(validation.status, assetErrorBody(validation.code, validation.message, {
        ...(validation.limit === undefined ? {} : { limit: validation.limit }),
        ...(validation.max === undefined ? {} : { max: validation.max }),
      }))
      return
    }
    // The scene may have been evicted while the body streamed in.
    if (unknownAssetSession(sessionId)) {
      reply(404, assetErrorBody('unknown-session', 'unknown Session'))
      return
    }
    if (storage !== null && storage.mode === 'disk') {
      await performDiskAssetUpload(sessionId, buffer, name, nameFold, validation, reply)
      return
    }
    if (storage !== null && storage.mode === 'degraded') {
      reply(503, assetStorageFailureBody())
      return
    }
    const stored = putAsset(sessionId, {
      name,
      nameFold,
      kind: validation.kind,
      mime: validation.mime,
      ext: validation.ext,
      bytes: buffer.length,
      buffer,
    })
    if (!stored.ok) {
      reply(stored.status, assetErrorBody(stored.code, stored.message, {
        ...(stored.limit === undefined ? {} : { limit: stored.limit }),
        ...(stored.max === undefined ? {} : { max: stored.max }),
      }))
      return
    }
    reply(201, { ok: true, asset: publicAsset(stored.asset) })
  })
  req.on('error', () => {
    if (endSeen) return
    if (!responded) reply(400, assetErrorBody('invalid-body', 'upload aborted'))
    else release()
  })
  req.on('aborted', () => {
    if (endSeen) return
    if (!responded) reply(400, assetErrorBody('invalid-body', 'upload aborted'))
    else release()
  })
  req.on('close', () => {
    // `close` follows `end` on a completed request. Once the body is complete,
    // the asynchronous durable publish owns the one reply; treating that close
    // as an abort would suppress the 201/404/503 after commit.
    if (responded || endSeen) return
    responded = true
    release()
  })
}

/**
 * POST handler for `{id}` asset deletion. Cross-Session ids are a plain 404.
 * @param req - Node request.
 * @param res - Node response.
 */
async function deleteAsset(req, res) {
  if (storageNeedsReady()) await storageReady()
  if (req.method !== 'POST') {
    sendAssetJson(res, 405, assetErrorBody('method-not-allowed', 'POST required'), { allow: 'POST' })
    req.resume()
    return
  }
  const encoding = requestHeader(req, 'content-encoding')
  if (encoding !== null && encoding.toLowerCase() !== 'identity') {
    sendAssetJson(res, 400, assetErrorBody('invalid-encoding', 'content-encoding must be identity'))
    req.resume()
    return
  }
  const sessionId = requestHeader(req, 'x-workbench-session')
  if (!isAssetOwnerSession(sessionId)) {
    sendAssetJson(res, 404, assetErrorBody('unknown-session', 'unknown Session'))
    req.resume()
    return
  }
  if (!takeListDeleteRate(sessionId)) {
    sendAssetJson(res, 429, assetErrorBody('rate-limited', 'too many list/delete requests'), { 'retry-after': '10' })
    req.resume()
    return
  }
  const chunks = []
  let size = 0
  let over = false
  req.on('data', chunk => {
    size += chunk.length
    if (!over && size > ASSET_LIMITS.maxDeleteBodyBytes) {
      over = true
      chunks.length = 0
    } else if (!over) {
      chunks.push(chunk)
    }
  })
  req.on('end', async () => {
    if (res.destroyed || res.writableEnded) return
    if (over) {
      sendAssetJson(res, 400, assetErrorBody('invalid-body', 'delete body too large'))
      return
    }
    let payload
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch (error) {
      void error
      sendAssetJson(res, 400, assetErrorBody('invalid-body', 'expected a JSON body'))
      return
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      sendAssetJson(res, 400, assetErrorBody('invalid-body', 'expected a JSON object'))
      return
    }
    const assetId = payload.id
    if (typeof assetId !== 'string' || !ASSET_ID_RE.test(assetId)) {
      sendAssetJson(res, 404, assetErrorBody('not-found', 'unknown asset'))
      return
    }
    if (storage !== null && storage.mode === 'disk') {
      const sidHash = sceneSidHash(sessionId)
      const release = await acquireDiskQueue('asset', sidHash)
      try {
        if (hiddenAssetIds.has(assetId) || preservedStaleAssets.has(assetId)) {
          sendAssetJson(res, 404, assetErrorBody('not-found', 'unknown asset'))
          return
        }
        const asset = getAsset(assetId)
        if (asset === undefined || assetIndex.get(assetId) !== sessionId) {
          sendAssetJson(res, 404, assetErrorBody('not-found', 'unknown asset'))
          return
        }
        if (!(await deleteAssetDurable(sessionId, asset))) {
          sendAssetJson(res, 503, assetDeleteStorageFailureBody())
          return
        }
        dropAsset(sessionId, assetId)
        await maybeRemoveOwnerAfterLastAsset(sessionId, sidHash, false)
        sendAssetJson(res, 200, { ok: true })
      } catch (error) {
        sendAssetJson(res, 503, assetDeleteStorageFailureBody())
      } finally {
        release()
      }
      return
    }
    if (storage !== null && storage.mode === 'degraded') {
      sendAssetJson(res, 503, assetDeleteStorageFailureBody())
      return
    }
    if (!dropAsset(sessionId, assetId)) {
      sendAssetJson(res, 404, assetErrorBody('not-found', 'unknown asset'))
      return
    }
    sendAssetJson(res, 200, { ok: true })
  })
  req.on('error', () => {
    if (!res.destroyed && !res.writableEnded) {
      sendAssetJson(res, 400, assetErrorBody('invalid-body', 'delete aborted'))
    }
  })
}

/**
 * Host-side seam for the P3-3 disk store: routes use this interface only.
 * The v1 implementation is memory-only per design.
 */
const assetStore = {
  put: putAsset,
  list: sessionId => visibleAssetRows(sessionId),
  get: assetId => {
    if (hiddenAssetIds.has(assetId) || preservedStaleAssets.has(assetId)) return undefined
    return getAsset(assetId)
  },
  delete: dropAsset,
  deleteSession: deleteAssetSession,
  usage: assetUsageFor,
  stats: () => ({
    assets: globalUsage.count,
    bytes: globalUsage.bytes,
    sessions: assets.size,
  }),
}

/**
 * Test-only inspection surface for the pure validation/store/route helpers.
 * Never exposed to the browser or the model.
 */
export const __assetInternal = {
  limits: ASSET_LIMITS,
  idPattern: ASSET_ID_RE,
  sniffAssetBytes,
  sanitizeAssetName,
  decodeAssetNameHeader,
  validateGltfPolicy,
  parseGltfDataUri,
  validateAssetBytes,
  assetContentHeaders,
  listResponse: assetListResponse,
  contentResponse: assetContentResponse,
  uploadHandler: uploadAsset,
  deleteHandler: deleteAsset,
  thumbnailHandler: uploadThumbnail,
  store: assetStore,
  seedSession(sessionId) {
    scenes.set(String(sessionId), {
      history: [{
        sceneId: String(sessionId), revision: 0, title: 'seed', code: '', bytes: 0, updatedAt: Date.now(),
      }],
    })
  },
  reset() {
    assets.clear()
    assetIndex.clear()
    assetNames.clear()
    assetUsage.clear()
    assetRates.clear()
    globalUploadTimes.length = 0
    globalUsage.count = 0
    globalUsage.bytes = 0
  },
  usage: sessionId => ({ ...assetUsageFor(sessionId) }),
  globalUsage: () => ({ ...globalUsage }),
  rawAsset: getAsset,
}

// ---------------------------------------------------------------------------
// Share links (P3-1). A share is an immutable opaque snapshot: the Host stores
// the caller-built document plus its own scene metadata, never executes it,
// and serves it only as an attachment. The viewer is a constant shell whose
// CSP contains no request-derived value; every share route first passes a
// strict Host allowlist.
// ---------------------------------------------------------------------------

/** id -> share record; memory-only behind `shareStore` (P3-3 persists it). */
const shares = new Map()
/** ownerSessionHash -> { count, bytes }; the plaintext Session is never stored. */
const shareUsageByOwner = new Map()
const shareGlobalUsage = { count: 0, bytes: 0 }
/** Rate/concurrency state, pruned to a 60 s window and removed when empty. */
const shareRates = {
  createsBySession: new Map(),
  createGlobal: { times: [], active: 0 },
  deleteGlobal: { times: [], active: 0 },
  viewerGlobal: { times: [], active: 0 },
  viewerById: new Map(),
  documentGlobal: { times: [], active: 0 },
  documentById: new Map(),
}

const SHARE_SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shared scene</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0d10; color: #e8edf4; }
  body { display: flex; flex-direction: column; }
  #bar { flex: 0 0 auto; padding: 6px 10px; font: 12px/1.4 system-ui, sans-serif;
    background: #12161b; border-bottom: 1px solid rgba(255,255,255,.12); }
  #bar[hidden] { display: none; }
  #view { flex: 1 1 auto; width: 100%; border: 0; background: #0b0d10; }
</style>
</head>
<body>
<div id="bar"><span id="status">Loading shared scene… / 正在加载分享场景…</span></div>
<iframe id="view" sandbox="allow-scripts allow-pointer-lock allow-downloads" referrerpolicy="no-referrer"></iframe>
<script>
(() => {
  'use strict'
  const bar = document.getElementById('bar')
  const status = document.getElementById('status')
  const frame = document.getElementById('view')
  const META = ${JSON.stringify(SHARE_DOCUMENT_META)}
  const LOADING = 'Loading shared scene… / 正在加载分享场景…'
  const UNAVAILABLE = 'This share link is unavailable or has expired. / 分享链接不可用或已过期。'
  const DOCTYPE = /^<!doctype html>/i
  let generation = 0
  let timer = 0
  let loadedOnce = false
  const showUnavailable = () => {
    bar.hidden = false
    status.textContent = UNAVAILABLE
    frame.removeAttribute('srcdoc')
  }
  const injectMeta = text => {
    const match = /<head[^>]*>/i.exec(text)
    if (match === null) return META + text
    const at = match.index + match[0].length
    return text.slice(0, at) + META + text.slice(at)
  }
  const start = async () => {
    const mine = ++generation
    bar.hidden = false
    status.textContent = LOADING
    timer = setTimeout(() => {
      if (mine !== generation) return
      generation += 1
      timer = 0
      showUnavailable()
    }, 10000)
    try {
      const metaResponse = await fetch(location.pathname + '/metadata', {
        cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
      })
      if (mine !== generation) return
      if (!metaResponse.ok) throw new Error('metadata')
      const metadata = await metaResponse.json()
      if (mine !== generation) return
      if (metadata === null || typeof metadata !== 'object' || metadata.ok !== true) throw new Error('metadata')
      if (typeof metadata.title === 'string') document.title = metadata.title
      const documentResponse = await fetch(location.pathname + '/document', {
        cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
      })
      if (mine !== generation) return
      if (!documentResponse.ok) throw new Error('document')
      const text = await documentResponse.text()
      if (mine !== generation) return
      if (typeof text !== 'string' || !DOCTYPE.test(text)) throw new Error('document')
      if (timer !== 0) {
        clearTimeout(timer)
        timer = 0
      }
      frame.addEventListener('load', () => {
        if (loadedOnce) {
          showUnavailable()
          return
        }
        loadedOnce = true
        bar.hidden = true
      })
      frame.srcdoc = injectMeta(text)
    } catch (error) {
      if (mine !== generation) return
      generation += 1
      if (timer !== 0) {
        clearTimeout(timer)
        timer = 0
      }
      showUnavailable()
    }
  }
  void start()
})()
<\/script>
</body>
</html>`

/**
 * @param sessionId - owning Session id.
 * @returns the stored owner quota key; the plaintext id never enters a record.
 */
function shareOwnerHash(sessionId) {
  return createHash('sha256').update(`wb-share-owner:${String(sessionId)}`).digest('hex')
}

/**
 * @param key - client delete capability.
 * @returns the stored hash for timing-safe comparison.
 */
function shareDeleteKeyHash(key) {
  return createHash('sha256').update(`wb-share-delete:${String(key)}`).digest('hex')
}

/**
 * Strict Host allowlist: lowercase DNS labels, strict dotted-decimal IPv4,
 * bracketed IPv6 via `net.isIPv6`, and an optional port 1..65535.
 * @param value - raw Host header.
 * @returns normalized `host[:port]`, or null when the value is not allowed.
 */
function validateShareHost(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return null
  let hostPart
  let portPart = null
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close < 0) return null
    hostPart = value.slice(0, close + 1)
    const rest = value.slice(close + 1)
    if (rest !== '') {
      if (!rest.startsWith(':')) return null
      portPart = rest.slice(1)
    }
    const inner = hostPart.slice(1, -1)
    if (inner === '' || inner.includes('%') || !isIPv6(inner)) return null
  } else {
    if (value.includes('[') || value.includes(']')) return null
    const colon = value.indexOf(':')
    if (colon >= 0) {
      if (value.indexOf(':', colon + 1) >= 0) return null
      hostPart = value.slice(0, colon)
      portPart = value.slice(colon + 1)
    } else {
      hostPart = value
    }
    if (hostPart === '') return null
    // Numeric dotted forms are IPv4 or rejected; never silently reinterpret a
    // leading-zero/incomplete numeric host as a DNS name.
    if (/^[0-9.]+$/.test(hostPart)) {
      if (!isStrictShareIpv4(hostPart)) return null
    } else if (!isShareDnsName(hostPart)) {
      return null
    }
  }
  let normalized = hostPart
  if (portPart !== null) {
    if (!/^\d{1,5}$/.test(portPart)) return null
    const port = Number(portPart)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null
    normalized += `:${String(port)}`
  }
  return normalized
}

/**
 * @param value - candidate DNS name.
 * @returns true only for the lowercase label grammar in the design.
 */
function isShareDnsName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false
  if (!/^[a-z0-9.-]+$/.test(value)) return false
  for (const label of value.split('.')) {
    if (label.length === 0 || label.length > 63) return false
    if (label.startsWith('-') || label.endsWith('-')) return false
  }
  return true
}

/**
 * @param value - candidate IPv4 literal.
 * @returns true for four decimal octets 0-255 with no leading zeros.
 */
function isStrictShareIpv4(value) {
  const parts = value.split('.')
  if (parts.length !== 4) return false
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return false
    if (Number(part) > 255) return false
  }
  return true
}

/**
 * @param host - normalized Host value.
 * @returns both-scheme normalized Origins for writes, or null.
 */
function shareAllowedOrigins(host) {
  if (typeof host !== 'string' || host === '') return null
  try {
    return new Set([
      new URL(`http://${host}`).origin,
      new URL(`https://${host}`).origin,
    ])
  } catch (error) {
    void error
    return null
  }
}

/**
 * Both-scheme Origin check. An absent Origin is accepted only with an absent
 * or same-origin `Sec-Fetch-Site`; the custom session header blocks form CSRF.
 * @param host - normalized Host.
 * @param origin - raw Origin header or null.
 * @param secFetchSite - raw Sec-Fetch-Site header or null.
 * @returns true when the write request may proceed.
 */
function shareOriginAllowed(host, origin, secFetchSite) {
  if (secFetchSite !== null) {
    if (typeof secFetchSite !== 'string' || secFetchSite.toLowerCase() !== 'same-origin') return false
  }
  if (origin === null) return true
  if (typeof origin !== 'string' || origin === '') return false
  let parsed
  try {
    parsed = new URL(origin)
  } catch (error) {
    void error
    return false
  }
  // Reject path/query/fragment or a non-canonical spelling: the Origin header
  // is an authority, and only the normalized both-scheme forms may match.
  if (parsed.origin !== origin) return false
  const allowed = shareAllowedOrigins(host)
  return allowed !== null && allowed.has(origin)
}

/**
 * @param value - raw Content-Type.
 * @returns true for application/json with an optional UTF-8 charset.
 */
function sameShareJsonContentType(value) {
  return typeof value === 'string'
    && /^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?\s*)?$/i.test(value.trim())
}

/**
 * @param times - ascending timestamps.
 * @param now - current epoch ms.
 */
function pruneShareRateTimes(times, now) {
  while (times.length > 0 && now - times[0] >= 60_000) times.shift()
}

/**
 * @param times - pruned timestamp list.
 * @param now - current epoch ms.
 * @returns the design's retry-after value in whole seconds.
 */
function shareRetryAfter(times, now) {
  pruneShareRateTimes(times, now)
  if (times.length === 0) return 1
  return Math.max(1, Math.ceil((times[0] + 60_000 - now) / 1000))
}

/**
 * @param map - per-key rate map.
 * @param key - map key.
 * @returns the lazily created state.
 */
function shareIdRateState(map, key) {
  let state = map.get(key)
  if (state === undefined) {
    state = { times: [], active: 0 }
    map.set(key, state)
  }
  return state
}

/**
 * @param map - per-key rate map.
 * @param key - map key.
 * @param state - its state.
 * @param now - current time, for pruning.
 */
function cleanupShareRateState(map, key, state, now) {
  pruneShareRateTimes(state.times, now)
  if (state.active <= 0 && state.times.length === 0) map.delete(key)
}

/**
 * Reserve a create slot (global 2, per Session 1) and count the request in
 * both 60 s windows. Release is idempotent and always runs in `finally`.
 * @param sessionId - Session id.
 * @param now - current epoch ms.
 * @returns `{ok:true, release}` or `{ok:false, retryAfter}`.
 */
function beginShareCreate(sessionId, now) {
  const session = shareIdRateState(shareRates.createsBySession, sessionId)
  const global = shareRates.createGlobal
  pruneShareRateTimes(session.times, now)
  pruneShareRateTimes(global.times, now)
  if (session.active >= SHARE_LIMITS.concurrentCreatesSession
    || global.active >= SHARE_LIMITS.concurrentCreatesGlobal
    || session.times.length >= SHARE_LIMITS.createsPerSessionPerMinute
    || global.times.length >= SHARE_LIMITS.createsGlobalPerMinute) {
    const retryAfter = Math.max(
      shareRetryAfter(session.times, now),
      shareRetryAfter(global.times, now),
      1,
    )
    cleanupShareRateState(shareRates.createsBySession, sessionId, session, now)
    return { ok: false, retryAfter }
  }
  session.times.push(now)
  global.times.push(now)
  session.active += 1
  global.active += 1
  let released = false
  return {
    ok: true,
    release() {
      if (released) return
      released = true
      session.active = Math.max(0, session.active - 1)
      global.active = Math.max(0, global.active - 1)
      cleanupShareRateState(shareRates.createsBySession, sessionId, session, now)
    },
  }
}

/**
 * Reserve a global delete window slot (60/min).
 * @param now - current epoch ms.
 * @returns `{ok:true}` or `{ok:false, retryAfter}`.
 */
function takeShareDeleteRate(now) {
  const global = shareRates.deleteGlobal
  pruneShareRateTimes(global.times, now)
  if (global.times.length >= SHARE_LIMITS.deletesGlobalPerMinute) {
    return { ok: false, retryAfter: shareRetryAfter(global.times, now) }
  }
  global.times.push(now)
  return { ok: true }
}

/**
 * @param kind - `viewer` (shell + metadata) or `document`.
 * @returns the global state, limits and per-id map for one viewer kind.
 */
function shareViewerBucket(kind) {
  return kind === 'document'
    ? {
      global: shareRates.documentGlobal,
      byId: shareRates.documentById,
      globalPerMinute: SHARE_LIMITS.documentRateGlobalPerMinute,
      perIdPerMinute: SHARE_LIMITS.documentRatePerIdPerMinute,
      globalConcurrent: SHARE_LIMITS.documentConcurrentGlobal,
      perIdConcurrent: SHARE_LIMITS.documentConcurrentPerId,
    }
    : {
      global: shareRates.viewerGlobal,
      byId: shareRates.viewerById,
      globalPerMinute: SHARE_LIMITS.viewerRateGlobalPerMinute,
      perIdPerMinute: SHARE_LIMITS.viewerRatePerIdPerMinute,
      globalConcurrent: SHARE_LIMITS.viewerConcurrentGlobal,
      perIdConcurrent: SHARE_LIMITS.viewerConcurrentPerId,
    }
}

/**
 * Reserve the global viewer window and global concurrency slot. Called before
 * the record lookup so unknown IDs cannot grow per-id state.
 * @param kind - viewer kind.
 * @param now - current epoch ms.
 * @returns `{ok:true, release}` or `{ok:false, retryAfter}`.
 */
function beginShareViewerGlobal(kind, now) {
  const bucket = shareViewerBucket(kind)
  pruneShareRateTimes(bucket.global.times, now)
  if (bucket.global.active >= bucket.globalConcurrent
    || bucket.global.times.length >= bucket.globalPerMinute) {
    return { ok: false, retryAfter: shareRetryAfter(bucket.global.times, now) }
  }
  bucket.global.times.push(now)
  bucket.global.active += 1
  let released = false
  return {
    ok: true,
    release() {
      if (released) return
      released = true
      bucket.global.active = Math.max(0, bucket.global.active - 1)
    },
  }
}

/**
 * Reserve the per-share viewer window and concurrency slot after a successful
 * lookup. Every exit goes through the returned release.
 * @param kind - viewer kind.
 * @param id - share id.
 * @param now - current epoch ms.
 * @returns `{ok:true, release}` or `{ok:false, retryAfter}`.
 */
function beginShareViewerId(kind, id, now) {
  const bucket = shareViewerBucket(kind)
  const state = shareIdRateState(bucket.byId, id)
  pruneShareRateTimes(state.times, now)
  if (state.active >= bucket.perIdConcurrent || state.times.length >= bucket.perIdPerMinute) {
    const retryAfter = shareRetryAfter(state.times, now)
    cleanupShareRateState(bucket.byId, id, state, now)
    return { ok: false, retryAfter }
  }
  state.times.push(now)
  state.active += 1
  let released = false
  return {
    ok: true,
    release() {
      if (released) return
      released = true
      state.active = Math.max(0, state.active - 1)
      cleanupShareRateState(bucket.byId, id, state, now)
    },
  }
}

/**
 * @param ownerHash - hashed Session quota key.
 * @returns its usage meter (never a plaintext Session).
 */
function shareUsageFor(ownerHash) {
  const usage = shareUsageByOwner.get(ownerHash)
  return usage === undefined ? { count: 0, bytes: 0 } : usage
}

/**
 * Coarse pre-body quota check: only caps already reached are refused.
 * @param ownerHash - hashed Session quota key.
 * @returns a failure object, or null.
 */
function shareCoarseQuotaFailure(ownerHash) {
  const usage = shareUsageFor(ownerHash)
  if (usage.count >= SHARE_LIMITS.sessionShares || usage.bytes >= SHARE_LIMITS.sessionBytes
    || shareGlobalUsage.count >= SHARE_LIMITS.globalShares || shareGlobalUsage.bytes >= SHARE_LIMITS.globalBytes) {
    return { status: 507, code: 'quota' }
  }
  return null
}

/**
 * Final quota check including this exact record's accounted bytes.
 * @param ownerHash - hashed Session quota key.
 * @param bytes - `bytes` formula for the new record.
 * @returns a failure object, or null.
 */
function shareFinalQuotaFailure(ownerHash, bytes) {
  const usage = shareUsageFor(ownerHash)
  if (bytes > SHARE_LIMITS.maxShareBytes
    || usage.count >= SHARE_LIMITS.sessionShares
    || usage.bytes + bytes > SHARE_LIMITS.sessionBytes
    || shareGlobalUsage.count >= SHARE_LIMITS.globalShares
    || shareGlobalUsage.bytes + bytes > SHARE_LIMITS.globalBytes) {
    return { status: 507, code: 'quota' }
  }
  return null
}

/**
 * Insert a validated record and account its bytes. No await may separate the
 * final quota check from this call in the create handler.
 * @param record - complete share record.
 */
function insertShare(record) {
  shares.set(record.id, record)
  let usage = shareUsageByOwner.get(record.ownerSessionHash)
  if (usage === undefined) {
    usage = { count: 0, bytes: 0 }
    shareUsageByOwner.set(record.ownerSessionHash, usage)
  }
  usage.count += 1
  usage.bytes += record.bytes
  shareGlobalUsage.count += 1
  shareGlobalUsage.bytes += record.bytes
}

/**
 * Drop per-id viewer rate state for a share that no longer exists.
 * @param id - share id.
 */
function deleteShareRateKeys(id) {
  shareRates.viewerById.delete(id)
  shareRates.documentById.delete(id)
}

async function stageShareDurable(record, order) {
  const state = storage
  if (state === null || state.dirFds === null || state.mode !== 'disk') {
    throw new DiskError('storage-unavailable')
  }
  const tmpFd = state.dirFds.tmp
  const slot = diskRandomHex()
  const built = buildShareDiskRecord(record, order, record.documentBuffer)
  const peak = built.bytes.length + record.documentBuffer.length
  const budgetHold = await state.budget.reserveOperation(peak, peak)
  let slotFd = null
  try {
    slotFd = mkdirDurableAt(tmpFd, slot)
    writeFileDurableSync(slotFd, 'record.json', built.bytes)
    writeFileDurableSync(slotFd, 'document.bin', record.documentBuffer)
    fsyncFd(slotFd)
    fsyncFd(tmpFd)
    return { slot, slotFd, shareHash: shareIdHash(record.id), budgetHold }
  } catch (error) {
    if (slotFd !== null) {
      try { fs.closeSync(slotFd) } catch (closeError) { void closeError }
      slotFd = null
    }
    try { removeTreeAt(tmpFd, slot) } catch (cleanupError) { void cleanupError }
    try { budgetHold.release() } catch (budgetError) { void budgetError }
    throw error instanceof DiskError ? error : new DiskError('storage-unavailable', error)
  }
}

function discardShareStaging(staged) {
  if (staged === null || storage === null || storage.dirFds === null) return
  if (staged.slotFd !== null) {
    try { fs.closeSync(staged.slotFd) } catch (error) { void error }
    staged.slotFd = null
  }
  try { removeTreeAt(storage.dirFds.tmp, staged.slot) } catch (error) { void error }
  if (staged.budgetHold !== null && staged.budgetHold !== undefined) {
    try { staged.budgetHold.release() } catch (error) { void error }
    staged.budgetHold = null
  }
}

async function publishShareStaged(record, order, staged) {
  const state = storage
  if (state === null || state.dirFds === null) throw new DiskError('storage-unavailable')
  const tmpFd = state.dirFds.tmp
  const sharesFd = state.dirFds.shares
  const shareHash = staged.shareHash
  let renamed = false
  let markerWritten = false
  let release = null
  try {
    if (staged.slotFd !== null) {
      fs.closeSync(staged.slotFd)
      staged.slotFd = null
    }
    await diskFault('publish', 'beforeSharePublish')
    renameAt(tmpFd, staged.slot, sharesFd, shareHash)
    renamed = true
    await diskBarrier('afterSharePublish')
    await diskFault('publish', 'afterSharePublish')
    fsyncFd(sharesFd)
    const shareFd = openDirAt(sharesFd, shareHash)
    try {
      await diskFault('commitMarker', 'beforeShareCommitMarker')
      writeFileDurableSync(shareFd, 'COMMITTED', Buffer.alloc(0))
      markerWritten = true
      await diskBarrier('afterShareCommitMarker')
      await diskFault('commitMarker', 'afterShareCommitMarker')
      fsyncFd(shareFd)
    } finally {
      fs.closeSync(shareFd)
    }
    return { shareHash, order }
  } catch (error) {
    if (renamed && !markerWritten) {
      try { removeTreeAt(sharesFd, shareHash) } catch (cleanupError) { void cleanupError }
    }
    throw error instanceof DiskError ? error : new DiskError('storage-unavailable', error)
  } finally {
    if (release !== null) release()
    if (staged.budgetHold !== null && staged.budgetHold !== undefined) {
      try { staged.budgetHold.release() } catch (error) { void error }
      staged.budgetHold = null
    }
  }
}

async function publishShareDurable(record, order) {
  const state = storage
  if (state.dirFds === null) throw new DiskError('storage-unavailable')
  const shareHash = shareIdHash(record.id)
  const tmpFd = state.dirFds.tmp
  const sharesFd = state.dirFds.shares
  const slot = diskRandomHex()
  const built = buildShareDiskRecord(record, order, record.documentBuffer)
  let slotFd = null
  let renamed = false
  try {
    slotFd = mkdirDurableAt(tmpFd, slot)
    await diskFault('publish', 'beforeShareStaging')
    writeFileDurableSync(slotFd, 'record.json', built.bytes)
    writeFileDurableSync(slotFd, 'document.bin', record.documentBuffer)
    fsyncFd(slotFd)
    await diskBarrier('afterShareStaging')
    await diskFault('publish', 'afterShareStaging')
    renameAt(tmpFd, slot, sharesFd, shareHash)
    renamed = true
    await diskBarrier('afterSharePublish')
    await diskFault('publish', 'afterSharePublish')
    fsyncFd(sharesFd)
    await diskFault('commitMarker', 'beforeShareCommitMarker')
    writeFileDurableSync(sharesFd, `${shareHash}/COMMITTED`, Buffer.alloc(0))
    await diskBarrier('afterShareCommitMarker')
    await diskFault('commitMarker', 'afterShareCommitMarker')
    const shareFd = openDirAt(sharesFd, shareHash)
    try { fsyncFd(shareFd) } finally { fs.closeSync(shareFd) }
    return { shareHash, order, slot }
  } catch (error) {
    if (slotFd !== null) {
      try { fs.closeSync(slotFd); slotFd = null } catch (e) { void e }
    }
    if (!renamed) {
      try { removeTreeAt(tmpFd, slot) } catch (e) { void e }
    } else {
      try { removeTreeAt(sharesFd, shareHash) } catch (e) { void e }
    }
    throw error instanceof DiskError ? error : new DiskError('storage-unavailable', error)
  } finally {
    if (slotFd !== null) { try { fs.closeSync(slotFd) } catch (e) { void e } }
  }
}

async function deleteShareDurable(record) {
  const state = storage
  if (state.dirFds === null) throw new DiskError('storage-unavailable')
  const shareHash = shareIdHash(record.id)
  let shareStat = null
  try { shareStat = fileStatAt(state.dirFds.shares, shareHash) } catch (error) { shareStat = null }
  if (shareStat === null) return true
  let release = null
  try {
    release = await acquireFence('cleanup-share-delete')
    ensureFenceOpen()
    let trashSlot = null
    try {
      await diskFault('deleteRename', 'beforeDeleteRename')
      trashSlot = diskRandomHex()
      renameIntoTrash(state.dirFds.shares, shareHash, trashSlot, true)
      await diskBarrier('afterDeleteRename')
      await diskFault('deleteRename', 'afterDeleteRename')
    } catch (error) {
      throw new DiskError('storage-unavailable', error)
    }
    try { fsyncFd(state.dirFds.trash) } catch (error) { void error }
    try { fsyncFd(state.dirFds.shares) } catch (error) { void error }
    drainTrashSlot(trashSlot)
    return true
  } finally {
    if (release !== null) release()
  }
}

/**
 * Remove one record from the store and every counter.
 * @param id - share id.
 * @returns true when the record existed.
 */
function scheduleShareDiskCleanup(record) {
  if (storage === null || storage.mode !== 'disk') return
  void (async () => {
    let release = null
    try {
      release = await acquireDiskQueue('share', shareIdHash(record.id))
      await deleteShareDurable(record)
    } catch (error) {
      // Expiry cleanup is write-behind; startup/orphan cleanup reconciles.
    } finally {
      if (release !== null) release()
    }
  })()
}

function deleteShareRecord(id) {
  const record = shares.get(id)
  if (record === undefined) return false
  shares.delete(id)
  const usage = shareUsageByOwner.get(record.ownerSessionHash)
  if (usage !== undefined) {
    usage.count -= 1
    usage.bytes -= record.bytes
    if (usage.count <= 0) shareUsageByOwner.delete(record.ownerSessionHash)
  }
  shareGlobalUsage.count -= 1
  shareGlobalUsage.bytes -= record.bytes
  deleteShareRateKeys(id)
  return true
}

/**
 * Drop expired records and prune empty rate state. There is no timer; create,
 * delete and quota paths call this.
 * @param now - current epoch ms.
 */
function sweepShares(now) {
  for (const [id, record] of [...shares]) {
    if (now >= record.expiresAt) {
      deleteShareRecord(id)
      scheduleShareDiskCleanup(record)
    }
  }
  for (const map of [shareRates.createsBySession, shareRates.viewerById, shareRates.documentById]) {
    for (const [key, state] of [...map]) {
      cleanupShareRateState(map, key, state, now)
    }
  }
  for (const state of [shareRates.createGlobal, shareRates.deleteGlobal,
    shareRates.viewerGlobal, shareRates.documentGlobal]) {
    pruneShareRateTimes(state.times, now)
  }
}

/**
 * Host seam for P3-3. Records carry Buffers; no route serializes the store.
 */
const shareStore = {
  put: record => insertShare(record),
  get(id, now = Date.now()) {
    const record = shares.get(id)
    if (record === undefined) return undefined
    if (now >= record.expiresAt) {
      deleteShareRecord(id)
      return undefined
    }
    return record
  },
  delete: id => deleteShareRecord(id),
  sweep: now => sweepShares(now),
  stats: () => ({
    shares: shares.size,
    bytes: shareGlobalUsage.bytes,
    owners: shareUsageByOwner.size,
  }),
}

/**
 * Read a streamed JSON body with a hard byte cap and idle/total timeouts.
 * @param req - Node request.
 * @param options - `{maxBytes, idleTimeoutMs, totalTimeoutMs}`.
 * @returns a promise resolving `{ok:true, buffer}` or `{ok:false,status,code}`.
 */
function readShareBody(req, options = {}) {
  const maxBytes = options.maxBytes ?? SHARE_LIMITS.maxBodyBytes
  const idleTimeoutMs = options.idleTimeoutMs ?? SHARE_LIMITS.bodyIdleTimeoutMs
  const totalTimeoutMs = options.totalTimeoutMs ?? SHARE_LIMITS.bodyTotalTimeoutMs
  return new Promise(resolve => {
    const chunks = []
    let size = 0
    let settled = false
    let idleTimer = 0
    let totalTimer = 0
    const cleanup = () => {
      if (idleTimer !== 0) clearTimeout(idleTimer)
      if (totalTimer !== 0) clearTimeout(totalTimer)
      idleTimer = 0
      totalTimer = 0
      req.removeListener?.('data', onData)
      req.removeListener?.('end', onEnd)
      req.removeListener?.('error', onError)
      req.removeListener?.('aborted', onAbort)
      req.removeListener?.('close', onClose)
    }
    const finish = outcome => {
      if (settled) return
      settled = true
      cleanup()
      if (!outcome.ok) {
        try { req.resume?.() } catch (error) { void error }
      }
      resolve(outcome)
    }
    const resetIdle = () => {
      if (idleTimer !== 0) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        finish({ ok: false, status: 408, code: 'timeout' })
      }, idleTimeoutMs)
      idleTimer.unref?.()
    }
    const onData = chunk => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        finish({ ok: false, status: 413, code: 'too-large' })
        return
      }
      chunks.push(chunk)
      resetIdle()
    }
    const onEnd = () => {
      finish({ ok: true, buffer: Buffer.concat(chunks) })
    }
    const onError = () => {
      finish({ ok: false, status: 400, code: 'fields' })
    }
    const onAbort = onError
    const onClose = () => {
      if (!settled) finish({ ok: false, status: 400, code: 'fields' })
    }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAbort)
    req.on('close', onClose)
    totalTimer = setTimeout(() => {
      finish({ ok: false, status: 408, code: 'timeout' })
    }, totalTimeoutMs)
    totalTimer.unref?.()
    resetIdle()
  })
}

/**
 * Scan raw JSON bytes outside strings/escapes for nesting depth. A body that
 * would overflow JSON.parse is rejected before the parser sees it.
 * @param buffer - raw request body.
 * @param limit - maximum nesting depth.
 * @returns `{ok:true, depth}` or `{ok:false}`.
 */
function scanShareJsonDepth(buffer, limit = SHARE_LIMITS.maxJsonDepth) {
  let depth = 0
  let maximum = 0
  let inString = false
  let escaped = false
  for (const byte of buffer) {
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (byte === 0x5c) {
        escaped = true
      } else if (byte === 0x22) {
        inString = false
      }
      continue
    }
    if (byte === 0x22) {
      inString = true
      continue
    }
    if (byte === 0x7b || byte === 0x5b) {
      depth += 1
      if (depth > limit) return { ok: false }
      if (depth > maximum) maximum = depth
      continue
    }
    if (byte === 0x7d || byte === 0x5d) {
      depth -= 1
      if (depth < 0) return { ok: false }
    }
  }
  return { ok: depth === 0 && !inString, depth: maximum }
}

/**
 * Iteratively bound an editorState by depth and node count before stringify.
 * @param value - parsed state.
 * @returns `{ok:true,nodes}` or `{ok:false,reason}`.
 */
function shareStateDepthAndNodes(value) {
  const stack = [{ value, depth: 1 }]
  const seen = new WeakSet()
  let nodes = 0
  while (stack.length > 0) {
    const entry = stack.pop()
    nodes += 1
    if (nodes > SHARE_LIMITS.maxStateNodes) return { ok: false, reason: 'nodes' }
    const item = entry.value
    if (item === null || typeof item !== 'object') continue
    if (entry.depth > SHARE_LIMITS.maxJsonDepth) return { ok: false, reason: 'depth' }
    if (seen.has(item)) return { ok: false, reason: 'cycle' }
    seen.add(item)
    if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item[index], depth: entry.depth + 1 })
      }
    } else {
      const keys = Object.keys(item)
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        stack.push({ value: item[keys[index]], depth: entry.depth + 1 })
      }
    }
  }
  return { ok: true, nodes }
}

/**
 * @param value - Host title.
 * @returns the first 200 Unicode code points (never split a surrogate pair).
 */
function truncateShareTitle(value) {
  const text = typeof value === 'string' ? value : ''
  const points = Array.from(text)
  return points.length > SHARE_LIMITS.titleCodePoints
    ? points.slice(0, SHARE_LIMITS.titleCodePoints).join('')
    : text
}

/**
 * @returns the pre-serialized metadata object (no document/code/state).
 */
function buildShareMetadata(title, revision, stepFps, createdAt, expiresAt) {
  return JSON.stringify({ ok: true, title, revision, stepFps, createdAt, expiresAt })
}

/**
 * @param values - strings scanned for the owning Session id.
 * @param sessionId - Session id.
 * @returns true when any value embeds the id.
 */
function shareLeaksSession(values, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  for (const value of values) {
    if (typeof value === 'string' && value.includes(sessionId)) return true
  }
  return false
}

/**
 * @param payload - parsed create body.
 * @returns `{ok:true,...}` or a status/code failure; never echoes input.
 */
function validateShareFields(payload) {
  const allowed = new Set(['revision', 'editorState', 'stepFps', 'ttlSeconds', 'document'])
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) return { ok: false, status: 400, code: 'fields' }
  }
  if (!Number.isInteger(payload.revision) || payload.revision < 0) {
    return { ok: false, status: 400, code: 'fields' }
  }
  const state = payload.editorState
  if (state === null || typeof state !== 'object' || Array.isArray(state) || state.v !== 2) {
    return { ok: false, status: 400, code: 'editor-state' }
  }
  for (const key of ['objects', 'tracks', 'params']) {
    const value = state[key]
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, status: 400, code: 'editor-state' }
    }
  }
  if (state.camera !== null && (state.camera === undefined || typeof state.camera !== 'object' || Array.isArray(state.camera))) {
    return { ok: false, status: 400, code: 'editor-state' }
  }
  const walk = shareStateDepthAndNodes(state)
  if (!walk.ok) return { ok: false, status: 400, code: 'editor-state' }
  let stateText
  try {
    stateText = JSON.stringify(state)
  } catch (error) {
    void error
    return { ok: false, status: 400, code: 'editor-state' }
  }
  if (Buffer.byteLength(stateText, 'utf8') > SHARE_LIMITS.maxStateBytes) {
    return { ok: false, status: 413, code: 'editor-state' }
  }
  let stepFps = 30
  if (payload.stepFps !== undefined) {
    if (!Number.isInteger(payload.stepFps) || payload.stepFps < 1 || payload.stepFps > SHARE_LIMITS.maxStepFps) {
      return { ok: false, status: 400, code: 'fields' }
    }
    stepFps = payload.stepFps
  }
  let ttlSeconds = SHARE_LIMITS.defaultTtlSeconds
  if (payload.ttlSeconds !== undefined) {
    if (!Number.isInteger(payload.ttlSeconds)) return { ok: false, status: 400, code: 'fields' }
    ttlSeconds = Math.min(SHARE_LIMITS.maxTtlSeconds, Math.max(SHARE_LIMITS.minTtlSeconds, payload.ttlSeconds))
  }
  if (typeof payload.document !== 'string' || !/^<!doctype html>/i.test(payload.document)) {
    return { ok: false, status: 400, code: 'document' }
  }
  const documentBuffer = Buffer.from(payload.document, 'utf8')
  if (documentBuffer.length > SHARE_LIMITS.maxDocumentBytes) {
    return { ok: false, status: 413, code: 'document' }
  }
  return { ok: true, stateText, stepFps, ttlSeconds, documentBuffer }
}

/**
 * @returns a fresh 22-character base64url capability id (128 bits).
 */
function newShareId() {
  return randomBytes(16).toString('base64url')
}

/**
 * @param res - Node response.
 * @param status - HTTP status.
 * @param body - JSON value.
 * @param extraHeaders - additional response headers (never ACAO).
 */
function sendShareJson(res, status, body, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': String(Buffer.byteLength(payload)),
    ...extraHeaders,
  })
  res.end(payload)
}

/**
 * @param res - Node response.
 * @param status - HTTP status.
 * @param body - JSON value.
 * @param extraHeaders - additional response headers (never ACAO).
 */
function sendRestoreJson(res, status, body, extraHeaders = {}) {
  if (res.destroyed || res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': String(Buffer.byteLength(payload)),
    ...extraHeaders,
  })
  res.end(payload)
}

/**
 * @param req - Node request.
 * @returns true when the request target carries a non-empty query string.
 */
function restoreRequestHasQuery(req) {
  const raw = typeof req.url === 'string' ? req.url : ''
  try {
    return new URL(raw, 'http://restore.invalid').search !== ''
  } catch (error) {
    void error
    const mark = raw.indexOf('?')
    return mark >= 0 && raw.slice(mark + 1) !== ''
  }
}

/**
 * @param times - ascending timestamps.
 * @param now - current epoch ms.
 */
function pruneRestoreTimes(times, now) {
  while (times.length > 0 && now - times[0] >= 60_000) times.shift()
}

/**
 * @param times - pruned timestamp list.
 * @param now - current epoch ms.
 * @returns retry-after seconds for that limiter.
 */
function restoreRetryAfter(times, now) {
  pruneRestoreTimes(times, now)
  if (times.length === 0) return 1
  return Math.max(1, Math.ceil((times[0] + 60_000 - now) / 1000))
}

/**
 * Reserve one Session and one global restore slot, or report the limiter.
 * @param sessionId - Session id.
 * @param now - current epoch ms.
 * @returns `{ok:true}` or `{ok:false,retryAfter}`.
 */
function reserveRestoreSlot(sessionId, now) {
  let session = restoreRates.sessions.get(sessionId)
  if (session === undefined) {
    session = { times: [], active: 0 }
    restoreRates.sessions.set(sessionId, session)
  }
  pruneRestoreTimes(session.times, now)
  pruneRestoreTimes(restoreRates.global.times, now)
  const sessionLimited = session.active >= RESTORE_LIMITS.concurrentPerSession
    || session.times.length >= RESTORE_LIMITS.requestsPerSessionPerMinute
  const globalLimited = restoreRates.global.active >= RESTORE_LIMITS.concurrentGlobal
    || restoreRates.global.times.length >= RESTORE_LIMITS.requestsGlobalPerMinute
  if (sessionLimited || globalLimited) {
    const retryAfter = Math.max(
      sessionLimited ? restoreRetryAfter(session.times, now) : 1,
      globalLimited ? restoreRetryAfter(restoreRates.global.times, now) : 1,
    )
    if (session.active <= 0 && session.times.length === 0) restoreRates.sessions.delete(sessionId)
    return { ok: false, retryAfter }
  }
  session.times.push(now)
  session.active += 1
  restoreRates.global.times.push(now)
  restoreRates.global.active += 1
  return { ok: true }
}

/**
 * Release a reservation acquired by {@link reserveRestoreSlot}.
 * @param sessionId - Session id.
 */
function releaseRestoreSlot(sessionId) {
  const session = restoreRates.sessions.get(sessionId)
  if (session !== undefined) {
    session.active = Math.max(0, session.active - 1)
    if (session.active === 0 && session.times.length === 0) restoreRates.sessions.delete(sessionId)
  }
  restoreRates.global.active = Math.max(0, restoreRates.global.active - 1)
}

/**
 * Remove all restore rate counters and idempotency entries for one Session.
 * @param sessionId - Session id.
 */
function clearRestoreSessionState(sessionId) {
  restoreRates.sessions.delete(sessionId)
  restoreIdempotency.delete(sessionId)
}

/**
 * Clear every restore counter/cache while leaving the clock unchanged.
 */
function clearAllRestoreState() {
  restoreRates.sessions.clear()
  restoreRates.global.times.length = 0
  restoreRates.global.active = 0
  restoreIdempotency.clear()
}

/**
 * @param fields - validated request fields.
 * @returns the idempotency fingerprint (no request id).
 */
function restoreFingerprint(fields) {
  return JSON.stringify([
    fields.sourceRevision,
    fields.sourceUpdatedAt,
    fields.expectedRevision,
    fields.expectedUpdatedAt,
  ])
}

/**
 * Validate the five-field restore body without touching Host state.
 * @param payload - parsed JSON value.
 * @returns `{ok:true,fields}` or `{ok:false,status,code}`.
 */
function validateRestoreFields(payload) {
  const fail = { ok: false, status: 400, code: 'fields' }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return fail
  const keys = Object.keys(payload)
  if (keys.length !== 5) return fail
  const required = ['sourceRevision', 'sourceUpdatedAt', 'expectedRevision', 'expectedUpdatedAt', 'requestId']
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) return fail
  }
  if (!Number.isSafeInteger(payload.sourceRevision) || payload.sourceRevision < 1) return fail
  if (!Number.isSafeInteger(payload.sourceUpdatedAt) || payload.sourceUpdatedAt < 0) return fail
  if (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 0) return fail
  if (!Number.isSafeInteger(payload.expectedUpdatedAt) || payload.expectedUpdatedAt < 0) return fail
  if (typeof payload.requestId !== 'string' || !RESTORE_REQUEST_ID_RE.test(payload.requestId)) return fail
  return {
    ok: true,
    fields: {
      sourceRevision: payload.sourceRevision,
      sourceUpdatedAt: payload.sourceUpdatedAt,
      expectedRevision: payload.expectedRevision,
      expectedUpdatedAt: payload.expectedUpdatedAt,
      requestId: payload.requestId,
    },
  }
}

/**
 * @param now - current epoch ms.
 * @param headUpdatedAt - current head timestamp.
 * @returns the restore timestamp, or null on overflow/malformed input.
 */
function nextRestoreUpdatedAt(now, headUpdatedAt) {
  if (!Number.isSafeInteger(now) || now < 0) return null
  if (!Number.isSafeInteger(headUpdatedAt) || headUpdatedAt === Number.MAX_SAFE_INTEGER) return null
  return Math.max(now, headUpdatedAt + 1)
}

/**
 * @param sessionId - Session id.
 * @param requestId - validated request id.
 * @param now - current epoch ms.
 * @returns the live idempotency entry, or undefined (expired entries removed).
 */
function lookupRestoreEntry(sessionId, requestId, now) {
  const cache = restoreIdempotency.get(sessionId)
  if (cache === undefined) return undefined
  const entry = cache.get(requestId)
  if (entry === undefined) return undefined
  if (now >= entry.expiresAt) {
    cache.delete(requestId)
    if (cache.size === 0) restoreIdempotency.delete(sessionId)
    return undefined
  }
  return entry
}

/**
 * Cache one committed success; the id becomes the newest and the TTL is fixed.
 * @param sessionId - Session id.
 * @param requestId - validated request id.
 * @param fingerprint - request fingerprint.
 * @param body - exact success body.
 * @param now - commit timestamp.
 */
function cacheRestoreSuccess(sessionId, requestId, fingerprint, body, now) {
  let cache = restoreIdempotency.get(sessionId)
  if (cache === undefined) {
    cache = new Map()
    restoreIdempotency.set(sessionId, cache)
  }
  cache.delete(requestId)
  cache.set(requestId, {
    fingerprint,
    body,
    expiresAt: now + RESTORE_LIMITS.idempotencyTtlMs,
  })
  while (cache.size > RESTORE_LIMITS.idempotencyEntriesPerSession) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/**
 * @param sessionId - Session id.
 * @param requestId - validated request id.
 * @param entry - live idempotency entry to make newest.
 */
function touchRestoreEntry(sessionId, requestId, entry) {
  const cache = restoreIdempotency.get(sessionId)
  if (cache === undefined) return
  cache.delete(requestId)
  cache.set(requestId, entry)
}

/**
 * POST /three-workbench/scene/restore.
 * @param req - Node request.
 * @param res - Node response.
 * @param options - test-only `{now, bodyIdleTimeoutMs, bodyTotalTimeoutMs}`.
 */
async function restoreHandler(req, res, options = {}) {
  if (storageNeedsReady()) await storageReady()
  // Step 0: method and exact query grammar precede everything else.
  if (req.method !== 'POST') {
    sendRestoreJson(res, 405, { ok: false, code: 'method' }, { allow: 'POST' })
    req.resume?.()
    return
  }
  if (restoreRequestHasQuery(req)) {
    sendRestoreJson(res, 400, { ok: false, code: 'fields' })
    req.resume?.()
    return
  }
  // Step 1: strict Host allowlist.
  const host = validateShareHost(requestHeader(req, 'host'))
  if (host === null) {
    sendRestoreJson(res, 400, { ok: false, code: 'bad-host' })
    req.resume?.()
    return
  }
  // Step 2: content type/encoding/declared length.
  if (!sameShareJsonContentType(requestHeader(req, 'content-type'))) {
    sendRestoreJson(res, 415, { ok: false, code: 'content-type' })
    req.resume?.()
    return
  }
  if (req.headers !== undefined && Object.prototype.hasOwnProperty.call(req.headers, 'content-encoding')) {
    sendRestoreJson(res, 415, { ok: false, code: 'encoding' })
    req.resume?.()
    return
  }
  const lengthHeader = requestHeader(req, 'content-length')
  let declared = null
  if (lengthHeader !== null) {
    if (!/^\d{1,15}$/.test(lengthHeader)) {
      sendRestoreJson(res, 400, { ok: false, code: 'fields' })
      req.resume?.()
      return
    }
    declared = Number(lengthHeader)
    if (!Number.isSafeInteger(declared)) {
      sendRestoreJson(res, 400, { ok: false, code: 'fields' })
      req.resume?.()
      return
    }
    if (declared > RESTORE_LIMITS.maxBodyBytes) {
      sendRestoreJson(res, 413, { ok: false, code: 'too-large' })
      req.resume?.()
      return
    }
  }
  // Step 3: Origin / Sec-Fetch-Site.
  if (!shareOriginAllowed(host, requestHeader(req, 'origin'), requestHeader(req, 'sec-fetch-site'))) {
    sendRestoreJson(res, 403, { ok: false, code: 'origin' })
    req.resume?.()
    return
  }
  // Step 4: exactly one non-empty Session header naming a live Session.
  const rawSession = req.headers === undefined ? undefined : req.headers['x-workbench-session']
  if (typeof rawSession !== 'string' || rawSession.length === 0 || rawSession.length > 256
    || !scenes.has(rawSession)) {
    sendRestoreJson(res, 404, { ok: false, code: 'session' })
    req.resume?.()
    return
  }
  const sessionId = rawSession
  const clock = typeof options.now === 'function' ? options.now : restoreNow
  let nowMs
  try {
    nowMs = clock()
  } catch (error) {
    void error
    nowMs = NaN
  }
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    sendRestoreJson(res, 500, { ok: false, code: 'internal' })
    req.resume?.()
    return
  }
  // Step 5: reserve rate/concurrency before the body is read.
  const reservation = reserveRestoreSlot(sessionId, nowMs)
  if (!reservation.ok) {
    sendRestoreJson(res, 429, { ok: false, code: 'rate' }, {
      'retry-after': String(reservation.retryAfter),
    })
    req.resume?.()
    return
  }
  try {
    // Step 6: capped, timed, depth-scanned JSON body.
    const body = await readShareBody(req, {
      maxBytes: RESTORE_LIMITS.maxBodyBytes,
      idleTimeoutMs: options.bodyIdleTimeoutMs ?? RESTORE_LIMITS.bodyIdleTimeoutMs,
      totalTimeoutMs: options.bodyTotalTimeoutMs ?? RESTORE_LIMITS.bodyTotalTimeoutMs,
    })
    if (!body.ok) {
      sendRestoreJson(res, body.status, { ok: false, code: body.code })
      return
    }
    if (declared !== null && body.buffer.length !== declared) {
      sendRestoreJson(res, 400, { ok: false, code: 'fields' })
      return
    }
    if (!scanShareJsonDepth(body.buffer).ok) {
      sendRestoreJson(res, 400, { ok: false, code: 'fields' })
      return
    }
    let payload
    try {
      payload = JSON.parse(body.buffer.toString('utf8'))
    } catch (error) {
      void error
      sendRestoreJson(res, 400, { ok: false, code: 'fields' })
      return
    }
    // Step 7: exact five-field validation.
    const checked = validateRestoreFields(payload)
    if (!checked.ok) {
      sendRestoreJson(res, checked.status, { ok: false, code: checked.code })
      return
    }
    const fields = checked.fields
    const fingerprint = restoreFingerprint(fields)
    // Step 8: idempotency lookup happens before source/head validation.
    const cached = lookupRestoreEntry(sessionId, fields.requestId, nowMs)
    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprint) {
        sendRestoreJson(res, 409, { ok: false, code: 'idempotency-conflict' })
        return
      }
      touchRestoreEntry(sessionId, fields.requestId, cached)
      sendRestoreJson(res, 200, cached.body)
      return
    }
    // Step 9: source lookup and source identity.
    const entry = scenes.get(sessionId)
    if (entry === undefined) {
      sendRestoreJson(res, 404, { ok: false, code: 'source-revision' })
      return
    }
    if (!Array.isArray(entry.history)) {
      sendRestoreJson(res, 500, { ok: false, code: 'internal' })
      return
    }
    const history = entry.history
    const source = history.find(record => record !== null && typeof record === 'object'
      && record.revision === fields.sourceRevision)
    if (source === undefined || source.updatedAt !== fields.sourceUpdatedAt) {
      sendRestoreJson(res, 404, { ok: false, code: 'source-revision' })
      return
    }
    // Step 10: head identity.
    const head = history[history.length - 1]
    if (head === null || head === undefined || typeof head !== 'object') {
      sendRestoreJson(res, 500, { ok: false, code: 'internal' })
      return
    }
    if (head.revision !== fields.expectedRevision || head.updatedAt !== fields.expectedUpdatedAt) {
      sendRestoreJson(res, 409, { ok: false, code: 'conflict' })
      return
    }
    // Step 11: a copy of the current head is not a restore.
    if (fields.sourceRevision === head.revision) {
      sendRestoreJson(res, 409, { ok: false, code: 'source-latest' })
      return
    }
    // Step 12: recheck the internal record shape and overflow bounds.
    let malformed = false
    for (const record of history) {
      if (record === null || typeof record !== 'object' || Array.isArray(record)
        || record.sceneId !== sessionId
        || typeof record.title !== 'string'
        || typeof record.code !== 'string'
        || !Number.isSafeInteger(record.revision)
        || !Number.isSafeInteger(record.updatedAt)) {
        malformed = true
        break
      }
    }
    if (malformed) {
      sendRestoreJson(res, 500, { ok: false, code: 'internal' })
      return
    }
    if (Buffer.byteLength(source.code, 'utf8') > MAX_CODE_BYTES) {
      sendRestoreJson(res, 409, { ok: false, code: 'too-large' })
      return
    }
    const newRevision = head.revision + 1
    const newUpdatedAt = nextRestoreUpdatedAt(nowMs, head.updatedAt)
    if (!Number.isSafeInteger(newRevision) || newUpdatedAt === null) {
      sendRestoreJson(res, 500, { ok: false, code: 'internal' })
      return
    }
    // Step 13: durable revision, then the synchronous append/trim/LRU commit.
    let record
    try {
      const appended = await appendSceneWithDurability(sessionId, {
        title: source.title,
        code: source.code,
        bytes: Buffer.byteLength(source.code, 'utf8'),
        updatedAt: newUpdatedAt,
      }, descriptor => {
        if (descriptor !== null) publishSceneEpochForCommit(sessionId, descriptor.epoch)
        const record = commitSceneRevision(sessionId, {
          title: source.title,
          code: source.code,
          updatedAt: newUpdatedAt,
        })
        if (descriptor !== null) updateSceneRevisionOrderForCommit(descriptor, record)
        return record
      })
      record = appended.scene
    } catch (error) {
      sendRestoreJson(res, 500, { ok: false, code: 'internal' })
      return
    }
    const success = {
      ok: true,
      revision: record.revision,
      sourceRevision: source.revision,
      updatedAt: record.updatedAt,
    }
    cacheRestoreSuccess(sessionId, fields.requestId, fingerprint, success, nowMs)
    sendRestoreJson(res, 200, success)
  } finally {
    // Step 14: every path releases the reservation exactly once.
    releaseRestoreSlot(sessionId)
  }
}

/**
 * POST /three-workbench/share/create.
 * @param req - Node request.
 * @param res - Node response.
 * @param options - test-only `{now, makeId, makeDeleteKey, bodyIdleTimeoutMs, bodyTotalTimeoutMs}`.
 */
async function shareCreateHandler(req, res, options = {}) {
  if (storageNeedsReady()) await storageReady()
  const now = typeof options.now === 'function' ? options.now : Date.now
  const makeId = typeof options.makeId === 'function' ? options.makeId : newShareId
  const makeDeleteKey = typeof options.makeDeleteKey === 'function' ? options.makeDeleteKey : newShareId
  const host = validateShareHost(requestHeader(req, 'host'))
  if (host === null) {
    sendShareJson(res, 400, { ok: false, code: 'bad-host' })
    req.resume?.()
    return
  }
  if (req.method !== 'POST') {
    sendShareJson(res, 405, { ok: false, code: 'method' }, { allow: 'POST' })
    req.resume?.()
    return
  }
  if (!sameShareJsonContentType(requestHeader(req, 'content-type'))) {
    sendShareJson(res, 415, { ok: false, code: 'content-type' })
    req.resume?.()
    return
  }
  const encoding = requestHeader(req, 'content-encoding')
  if (encoding !== null && encoding.toLowerCase() !== 'identity') {
    sendShareJson(res, 415, { ok: false, code: 'encoding' })
    req.resume?.()
    return
  }
  const lengthHeader = requestHeader(req, 'content-length')
  let declared = null
  if (lengthHeader !== null) {
    if (!/^\d{1,15}$/.test(lengthHeader)) {
      sendShareJson(res, 400, { ok: false, code: 'fields' })
      req.resume?.()
      return
    }
    declared = Number(lengthHeader)
    if (!Number.isSafeInteger(declared)) {
      sendShareJson(res, 400, { ok: false, code: 'fields' })
      req.resume?.()
      return
    }
    if (declared > SHARE_LIMITS.maxBodyBytes) {
      sendShareJson(res, 413, { ok: false, code: 'too-large' }, { connection: 'close' })
      req.resume?.()
      return
    }
  }
  if (!shareOriginAllowed(host, requestHeader(req, 'origin'), requestHeader(req, 'sec-fetch-site'))) {
    sendShareJson(res, 403, { ok: false, code: 'origin' })
    req.resume?.()
    return
  }
  const sessionId = requestHeader(req, 'x-workbench-session')
  if (!isAssetSession(sessionId)) {
    sendShareJson(res, 404, { ok: false, code: 'session' })
    req.resume?.()
    return
  }
  const reservation = beginShareCreate(sessionId, now())
  if (!reservation.ok) {
    sendShareJson(res, 429, { ok: false, code: 'rate' }, { 'retry-after': String(reservation.retryAfter) })
    req.resume?.()
    return
  }
  try {
    const ownerHash = shareOwnerHash(sessionId)
    // Expired records must not keep the coarse quota full: sweep before the
    // pre-body check (and again before the final check after accounting).
    sweepShares(now())
    const coarse = shareCoarseQuotaFailure(ownerHash)
    if (coarse !== null) {
      sendShareJson(res, coarse.status, { ok: false, code: coarse.code })
      req.resume?.()
      return
    }
    const body = await readShareBody(req, {
      maxBytes: SHARE_LIMITS.maxBodyBytes,
      idleTimeoutMs: options.bodyIdleTimeoutMs ?? SHARE_LIMITS.bodyIdleTimeoutMs,
      totalTimeoutMs: options.bodyTotalTimeoutMs ?? SHARE_LIMITS.bodyTotalTimeoutMs,
    })
    if (!body.ok) {
      sendShareJson(res, body.status, { ok: false, code: body.code },
        body.status === 413 || body.status === 408 ? { connection: 'close' } : {})
      if (body.status === 413 || body.status === 408) req.destroy?.()
      return
    }
    if (declared !== null && body.buffer.length !== declared) {
      sendShareJson(res, 400, { ok: false, code: 'fields' })
      return
    }
    const depth = scanShareJsonDepth(body.buffer)
    if (!depth.ok) {
      sendShareJson(res, 400, { ok: false, code: 'fields' })
      return
    }
    let payload
    try {
      payload = JSON.parse(body.buffer.toString('utf8'))
    } catch (error) {
      void error
      sendShareJson(res, 400, { ok: false, code: 'fields' })
      return
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      sendShareJson(res, 400, { ok: false, code: 'fields' })
      return
    }
    // Revision is a body field: it is validated immediately after parse, before
    // the heavier state/title/leak work. Unknown revisions are 404.
    if (!Number.isInteger(payload.revision) || payload.revision < 0) {
      sendShareJson(res, 400, { ok: false, code: 'fields' })
      return
    }
    const fieldResult = validateShareFields(payload)
    if (!fieldResult.ok) {
      sendShareJson(res, fieldResult.status, { ok: false, code: fieldResult.code })
      return
    }
    const scene = scenes.get(sessionId)
    const hostRecord = scene === undefined
      ? undefined
      : scene.history.find(record => record.revision === payload.revision)
    if (hostRecord === undefined) {
      sendShareJson(res, 404, { ok: false, code: 'revision' })
      return
    }
    const hostCode = typeof hostRecord.code === 'string' ? hostRecord.code : ''
    const fullTitle = typeof hostRecord.title === 'string' ? hostRecord.title : 'Three.js scene'
    const title = truncateShareTitle(fullTitle)
    const createdAt = now()
    const expiresAt = createdAt + fieldResult.ttlSeconds * 1000
    const metadataJson = buildShareMetadata(title, hostRecord.revision, fieldResult.stepFps, createdAt, expiresAt)
    if (Buffer.byteLength(metadataJson, 'utf8') > SHARE_LIMITS.metadataMaxBytes) {
      sendShareJson(res, 400, { ok: false, code: 'fields' })
      return
    }
    // The full untruncated title is scanned: a Session id split by the
    // 200-code-point cut must still be rejected.
    if (shareLeaksSession([
      payload.document,
      fieldResult.stateText,
      hostCode,
      fullTitle,
      metadataJson,
    ], sessionId)) {
      sendShareJson(res, 400, { ok: false, code: 'session-leak' })
      return
    }
    const bytes = fieldResult.documentBuffer.length
      + Buffer.byteLength(metadataJson, 'utf8')
      + Buffer.byteLength(hostCode, 'utf8')
      + Buffer.byteLength(fieldResult.stateText, 'utf8')
      + Buffer.byteLength(title, 'utf8')
    if (bytes > SHARE_LIMITS.maxShareBytes) {
      sendShareJson(res, 507, { ok: false, code: 'quota' })
      return
    }
    const diskMode = storage !== null && storage.mode === 'disk'
    if (diskMode) {
      // Step 3 uses the existing global create reservation, not the share
      // queue. A first final-quota check before staging avoids writing a
      // candidate that already cannot be inserted.
      sweepShares(createdAt)
      const initialQuota = shareFinalQuotaFailure(ownerHash, bytes)
      if (initialQuota !== null) {
        sendShareJson(res, initialQuota.status, { ok: false, code: initialQuota.code })
        return
      }
    }
    const makeCandidate = requestedOrder => {
      let id = null
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const candidate = String(makeId())
        if (SHARE_ID_RE.test(candidate) && !shares.has(candidate)) {
          id = candidate
          break
        }
      }
      const deleteKey = String(makeDeleteKey())
      if (id === null || !SHARE_ID_RE.test(deleteKey)) return null
      const record = {
        id,
        v: 1,
        ownerSessionHash: ownerHash,
        revision: hostRecord.revision,
        title,
        code: hostCode,
        editorState: payload.editorState,
        stepFps: fieldResult.stepFps,
        documentBuffer: fieldResult.documentBuffer,
        metadataJson,
        bytes,
        createdAt,
        expiresAt,
        deleteKeyHash: shareDeleteKeyHash(deleteKey),
      }
      return { id, deleteKey, record, order: requestedOrder }
    }
    let stagedShare = null
    let diskCandidate = null
    if (diskMode) {
      const diskOrder = nextShareOrder
      if (!isSafePositive(diskOrder) || diskOrder > MAX_ORDER) {
        sendShareJson(res, 507, { ok: false, code: 'quota' })
        return
      }
      nextShareOrder += 1
      diskCandidate = makeCandidate(diskOrder)
      if (diskCandidate === null) {
        sendShareJson(res, 500, { ok: false, code: 'internal' })
        return
      }
      try {
        stagedShare = await stageShareDurable(diskCandidate.record, diskOrder)
      } catch (error) {
        sendShareJson(res, 500, { ok: false, code: 'internal' })
        return
      }
    }
    sweepShares(createdAt)
    const finalQuota = shareFinalQuotaFailure(ownerHash, bytes)
    if (finalQuota !== null) {
      if (stagedShare !== null) discardShareStaging(stagedShare)
      sendShareJson(res, finalQuota.status, { ok: false, code: finalQuota.code })
      return
    }
    // From the final quota check to the insert there is deliberately no await.
    let candidate = diskCandidate
    if (candidate === null) {
      candidate = makeCandidate(null)
      if (candidate === null) {
        sendShareJson(res, 500, { ok: false, code: 'internal' })
        return
      }
    }
    const { id, deleteKey, record } = candidate
    insertShare(record)
    if (diskMode) {
      try {
        await publishShareStaged(record, diskCandidate.order, stagedShare)
        stagedShare = null
        shareOrderById.set(record.id, diskCandidate.order)
      } catch (error) {
        if (stagedShare !== null) discardShareStaging(stagedShare)
        deleteShareRecord(record.id)
        sendShareJson(res, 500, { ok: false, code: 'internal' })
        return
      }
    } else if (storage !== null && storage.mode === 'degraded') {
      deleteShareRecord(record.id)
      sendShareJson(res, 500, { ok: false, code: 'internal' })
      return
    }
    sendShareJson(res, 200, {
      ok: true,
      id,
      path: `${SHARE_PATH}/${id}`,
      revision: record.revision,
      createdAt,
      expiresAt,
      deleteKey,
    })
  } catch (error) {
    void error
    sendShareJson(res, 500, { ok: false, code: 'internal' })
  } finally {
    reservation.release()
  }
}

/**
 * POST /three-workbench/share/delete. Authorization is the 128-bit delete
 * capability only; an owner Session header is ignored.
 * @param req - Node request.
 * @param res - Node response.
 * @param options - test-only `{now, bodyIdleTimeoutMs, bodyTotalTimeoutMs}`.
 */
async function shareDeleteHandler(req, res, options = {}) {
  if (storageNeedsReady()) await storageReady()
  const now = typeof options.now === 'function' ? options.now : Date.now
  const host = validateShareHost(requestHeader(req, 'host'))
  if (host === null) {
    sendShareJson(res, 400, { ok: false, code: 'bad-host' })
    req.resume?.()
    return
  }
  if (req.method !== 'POST') {
    sendShareJson(res, 405, { ok: false, code: 'method' }, { allow: 'POST' })
    req.resume?.()
    return
  }
  if (!sameShareJsonContentType(requestHeader(req, 'content-type'))) {
    sendShareJson(res, 415, { ok: false, code: 'content-type' })
    req.resume?.()
    return
  }
  const encoding = requestHeader(req, 'content-encoding')
  if (encoding !== null && encoding.toLowerCase() !== 'identity') {
    sendShareJson(res, 415, { ok: false, code: 'encoding' })
    req.resume?.()
    return
  }
  const lengthHeader = requestHeader(req, 'content-length')
  let declared = null
  if (lengthHeader !== null) {
    if (!/^\d{1,15}$/.test(lengthHeader)) {
      sendShareJson(res, 400, { ok: false, code: 'fields' })
      req.resume?.()
      return
    }
    declared = Number(lengthHeader)
    if (!Number.isSafeInteger(declared)) {
      sendShareJson(res, 400, { ok: false, code: 'fields' })
      req.resume?.()
      return
    }
    if (declared > SHARE_LIMITS.maxDeleteBodyBytes) {
      sendShareJson(res, 413, { ok: false, code: 'too-large' }, { connection: 'close' })
      req.resume?.()
      return
    }
  }
  if (!shareOriginAllowed(host, requestHeader(req, 'origin'), requestHeader(req, 'sec-fetch-site'))) {
    sendShareJson(res, 403, { ok: false, code: 'origin' })
    req.resume?.()
    return
  }
  // Reclaim expired records before the delete rate check and lookup so a
  // successful, unknown or malformed delete still frees their quota.
  sweepShares(now())
  const rate = takeShareDeleteRate(now())
  if (!rate.ok) {
    sendShareJson(res, 429, { ok: false, code: 'rate' }, { 'retry-after': String(rate.retryAfter) })
    req.resume?.()
    return
  }
  const body = await readShareBody(req, {
    maxBytes: SHARE_LIMITS.maxDeleteBodyBytes,
    idleTimeoutMs: options.bodyIdleTimeoutMs ?? SHARE_LIMITS.bodyIdleTimeoutMs,
    totalTimeoutMs: options.bodyTotalTimeoutMs ?? SHARE_LIMITS.bodyTotalTimeoutMs,
  })
  if (!body.ok) {
    sendShareJson(res, body.status, { ok: false, code: body.code },
      body.status === 413 || body.status === 408 ? { connection: 'close' } : {})
    if (body.status === 413 || body.status === 408) req.destroy?.()
    return
  }
  if (declared !== null && body.buffer.length !== declared) {
    sendShareJson(res, 400, { ok: false, code: 'fields' })
    return
  }
  const depth = scanShareJsonDepth(body.buffer)
  if (!depth.ok) {
    sendShareJson(res, 400, { ok: false, code: 'fields' })
    return
  }
  let payload
  try {
    payload = JSON.parse(body.buffer.toString('utf8'))
  } catch (error) {
    void error
    sendShareJson(res, 400, { ok: false, code: 'fields' })
    return
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    sendShareJson(res, 400, { ok: false, code: 'fields' })
    return
  }
  for (const key of Object.keys(payload)) {
    if (key !== 'id' && key !== 'deleteKey') {
      sendShareJson(res, 400, { ok: false, code: 'fields' })
      return
    }
  }
  if (typeof payload.id !== 'string' || !SHARE_ID_RE.test(payload.id)
    || typeof payload.deleteKey !== 'string' || !SHARE_ID_RE.test(payload.deleteKey)) {
    sendShareJson(res, 404, { ok: false, code: 'not-found' })
    return
  }
  const record = shares.get(payload.id)
  if (record === undefined || now() >= record.expiresAt) {
    if (record !== undefined) deleteShareRecord(payload.id)
    sendShareJson(res, 404, { ok: false, code: 'not-found' })
    return
  }
  const expected = Buffer.from(record.deleteKeyHash, 'hex')
  const actual = Buffer.from(shareDeleteKeyHash(payload.deleteKey), 'hex')
  const keyMatches = expected.length === actual.length && timingSafeEqual(expected, actual)
  if (!keyMatches) {
    sendShareJson(res, 404, { ok: false, code: 'not-found' })
    return
  }
  let queueRelease = null
  try {
    if (storage !== null && storage.mode === 'disk') {
      queueRelease = await acquireDiskQueue('share', shareIdHash(payload.id))
      const current = shares.get(payload.id)
      if (current === undefined || now() >= current.expiresAt) {
        if (current !== undefined) deleteShareRecord(payload.id)
        sendShareJson(res, 404, { ok: false, code: 'not-found' })
        return
      }
      const currentExpected = Buffer.from(current.deleteKeyHash, 'hex')
      const currentActual = Buffer.from(shareDeleteKeyHash(payload.deleteKey), 'hex')
      if (currentExpected.length !== currentActual.length
        || !timingSafeEqual(currentExpected, currentActual)) {
        sendShareJson(res, 404, { ok: false, code: 'not-found' })
        return
      }
      try {
        await deleteShareDurable(current)
      } catch (error) {
        sendShareJson(res, 500, { ok: false, code: 'internal' })
        return
      }
      deleteShareRecord(payload.id)
      sendShareJson(res, 200, { ok: true })
      return
    }
    if (storage !== null && storage.mode === 'degraded') {
      sendShareJson(res, 500, { ok: false, code: 'internal' })
      return
    }
    deleteShareRecord(payload.id)
    sendShareJson(res, 200, { ok: true })
  } finally {
    if (queueRelease !== null) queueRelease()
  }
}

/**
 * @param body - constant text.
 * @param status - HTTP status.
 * @param extraHeaders - additional headers.
 * @returns text/plain with no ACAO and a sandbox CSP.
 */
function shareTextResponse(body, status, extraHeaders = {}, method = 'GET') {
  return new Response(method === 'HEAD' ? null : body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'cross-origin-resource-policy': 'same-origin',
      'content-security-policy': SHARE_DOCUMENT_CSP,
      'content-length': String(Buffer.byteLength(body, 'utf8')),
      ...extraHeaders,
    },
  })
}

/**
 * @param method - GET or HEAD.
 * @returns the identical per-route 404 (constant body and headers).
 */
function shareNotFoundResponse(method) {
  return shareTextResponse(SHARE_UNAVAILABLE_TEXT, 404, {}, method)
}

/**
 * @param retryAfter - whole seconds.
 * @param method - GET or HEAD.
 * @returns a constant 429 with retry-after, no server text.
 */
function shareRateResponse(retryAfter, method = 'GET') {
  return shareTextResponse(SHARE_RATE_TEXT, 429, { 'retry-after': String(Math.max(1, retryAfter)) }, method)
}

/**
 * @param body - shell HTML.
 * @param method - GET or HEAD.
 * @returns constant shell 200 with the fixed CSP.
 */
function shareShellResponse(body, method) {
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': SHARE_SHELL_CSP,
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  }
  return new Response(method === 'HEAD' ? null : body, { status: 200, headers })
}

/**
 * @param record - share record.
 * @param method - GET or HEAD.
 * @returns the pre-serialized metadata attachment.
 */
function shareMetadataResponse(record, method) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': 'attachment; filename="share.json"',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': SHARE_DOCUMENT_CSP,
    'content-length': String(Buffer.byteLength(record.metadataJson, 'utf8')),
  }
  return new Response(method === 'HEAD' ? null : record.metadataJson, { status: 200, headers })
}

/**
 * @param record - share record.
 * @param method - GET or HEAD.
 * @returns the opaque document as a text/plain attachment.
 */
function shareDocumentResponse(record, method) {
  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    'content-disposition': 'attachment; filename="share.txt"',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': SHARE_DOCUMENT_CSP,
    'content-length': String(record.documentBuffer.length),
  }
  return new Response(method === 'HEAD' ? null : record.documentBuffer, { status: 200, headers })
}

/**
 * Wrap a successful viewer response so its rate/concurrency reservation
 * remains held until the body is consumed, closed or cancelled. A HEAD
 * response has no body and releases immediately.
 * @param response - the response built by a route builder.
 * @param release - idempotent id/global reservation release.
 * @param signal - request abort signal, raised when the client disconnects.
 * @returns a response streaming the same headers and bytes.
 */
function shareHeldResponse(response, release, signal) {
  const body = response.body
  if (body === null) {
    release()
    return response
  }
  const reader = body.getReader()
  const declared = Number(response.headers.get('content-length'))
  const expected = Number.isSafeInteger(declared) && declared >= 0 ? declared : null
  let sent = 0
  let cancelled = false
  let released = false
  const finish = () => {
    if (released) return
    released = true
    signal?.removeEventListener('abort', finish)
    release()
  }
  signal?.addEventListener('abort', finish, { once: true })
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          // Unknown-length bodies keep the reservation through a short grace
          // period so concurrent requests still observe the stream in flight.
          if (expected === null) await new Promise(resolve => setTimeout(resolve, 25))
          if (cancelled) return
          controller.close()
          finish()
          return
        }
        sent += result.value.byteLength
        const finalChunk = expected !== null && sent >= expected
        if (finalChunk) {
          // Delay the bytes that complete the declared length. The reservation
          // covers this visible in-flight window, then releases before those
          // final bytes reach the client, so a sequential follow-up request
          // does not race the stream's final read.
          await new Promise(resolve => setTimeout(resolve, 25))
          if (cancelled) return
        }
        controller.enqueue(result.value)
        if (finalChunk) {
          controller.close()
          finish()
        }
      } catch (error) {
        finish()
        try { controller.error(error) } catch (closeError) { void closeError }
      }
    },
    cancel(reason) {
      cancelled = true
      finish()
      return reader.cancel(reason)
    },
  }, { highWaterMark: 0 })
  try {
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  } catch (error) {
    finish()
    reader.cancel(error).catch(() => undefined)
    throw error
  }
}

/**
 * Prefix resource for `GET|HEAD /three-workbench/share/<id>[...]`.
 * @param request - Fetch request.
 * @param options - test-only `{now}`.
 * @returns shell, metadata, document, or the constant 404/400/429.
 */
async function shareViewerResponse(request, options = {}) {
  if (storageNeedsReady()) await storageReady()
  const now = typeof options.now === 'function' ? options.now : Date.now
  const host = validateShareHost(request.headers.get('host'))
  if (host === null) {
    return new Response(SHARE_BAD_HOST_TEXT, {
      status: 400,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': SHARE_DOCUMENT_CSP,
        'content-length': String(Buffer.byteLength(SHARE_BAD_HOST_TEXT, 'utf8')),
      },
    })
  }
  const method = request.method
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method not allowed.\n', {
      status: 405,
      headers: {
        allow: 'GET, HEAD',
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': SHARE_DOCUMENT_CSP,
      },
    })
  }
  const url = new URL(request.url, 'http://localhost')
  const pathname = url.pathname
  if (!pathname.startsWith(`${SHARE_PATH}/`)) return shareNotFoundResponse(method)
  const rest = pathname.slice(SHARE_PATH.length + 1)
  const parts = rest.split('/')
  if (parts.length > 2) return shareNotFoundResponse(method)
  if (parts.length === 2 && parts[1] === '') return shareNotFoundResponse(method)
  const id = parts[0]
  if (!SHARE_ID_RE.test(id)) return shareNotFoundResponse(method)
  const suffix = parts.length === 2 ? parts[1] : ''
  let kind
  if (suffix === '') kind = 'viewer'
  else if (suffix === 'metadata') kind = 'viewer'
  else if (suffix === 'document') kind = 'document'
  else return shareNotFoundResponse(method)
  const nowValue = now()
  const globalRate = beginShareViewerGlobal(kind, nowValue)
  if (!globalRate.ok) return shareRateResponse(globalRate.retryAfter, method)
  let idRate = null
  let released = false
  const release = () => {
    if (released) return
    released = true
    idRate?.release()
    globalRate.release()
  }
  try {
    const record = shareStore.get(id, nowValue)
    if (record === undefined) {
      release()
      return shareNotFoundResponse(method)
    }
    const nextIdRate = beginShareViewerId(kind, id, nowValue)
    if (!nextIdRate.ok) {
      release()
      return shareRateResponse(nextIdRate.retryAfter, method)
    }
    idRate = nextIdRate
    let response
    if (suffix === '') response = shareShellResponse(SHARE_SHELL_HTML, method)
    else if (suffix === 'metadata') response = shareMetadataResponse(record, method)
    else response = shareDocumentResponse(record, method)
    return shareHeldResponse(response, release, request.signal)
  } catch (error) {
    release()
    throw error
  }
}

/**
 * Test-only seed helper for share route tests. `options.history` may hold
 * explicit revision records; otherwise revisions 0..options.revision share the
 * supplied title/code.
 * @param sessionId - Session id.
 * @param options - `{revision,title,code,history}`.
 */
function seedShareSession(sessionId, options = {}) {
  const id = String(sessionId)
  let history
  if (Array.isArray(options.history)) {
    history = options.history.map(record => ({
      sceneId: id,
      revision: Number.isInteger(record.revision) ? record.revision : 0,
      title: typeof record.title === 'string' ? record.title : 'seed',
      code: typeof record.code === 'string' ? record.code : '',
      bytes: typeof record.code === 'string' ? Buffer.byteLength(record.code, 'utf8') : 0,
      updatedAt: 0,
    }))
  } else {
    const revision = Number.isInteger(options.revision) && options.revision >= 0 ? options.revision : 0
    const title = typeof options.title === 'string' ? options.title : 'seed'
    const code = typeof options.code === 'string' ? options.code : ''
    history = []
    for (let value = 0; value <= revision; value += 1) {
      history.push({
        sceneId: id,
        revision: value,
        title,
        code,
        bytes: Buffer.byteLength(code, 'utf8'),
        updatedAt: 0,
      })
    }
  }
  scenes.set(id, { history })
}

/**
 * @param sessionId - Session id.
 * @returns the plaintext Session usage mirror for tests.
 */
function shareSessionUsage(sessionId) {
  return { ...shareUsageFor(shareOwnerHash(String(sessionId))) }
}

/**
 * Test-only inspection surface for P3-1. Never registered as a route and
 * never exposed to the browser or the model.
 */
export const __shareInternal = {
  limits: SHARE_LIMITS,
  idPattern: SHARE_ID_RE,
  path: SHARE_PATH,
  shellHtml: SHARE_SHELL_HTML,
  shellCsp: SHARE_SHELL_CSP,
  documentCsp: SHARE_DOCUMENT_CSP,
  documentMeta: SHARE_DOCUMENT_META,
  unavailableText: SHARE_UNAVAILABLE_TEXT,
  validateHost: validateShareHost,
  allowedOrigins: shareAllowedOrigins,
  originAllowed: shareOriginAllowed,
  jsonContentType: sameShareJsonContentType,
  jsonDepth: scanShareJsonDepth,
  stateDepthAndNodes: shareStateDepthAndNodes,
  truncateTitle: truncateShareTitle,
  buildMetadata: buildShareMetadata,
  ownerHash: shareOwnerHash,
  deleteKeyHash: shareDeleteKeyHash,
  newId: newShareId,
  readBody: readShareBody,
  validateFields: validateShareFields,
  buildShell: () => SHARE_SHELL_HTML,
  createHandler: shareCreateHandler,
  deleteHandler: shareDeleteHandler,
  viewerResponse: shareViewerResponse,
  shellResponse: shareShellResponse,
  metadataResponse: shareMetadataResponse,
  documentResponse: shareDocumentResponse,
  store: shareStore,
  seedSession: seedShareSession,
  clearScene(sessionId) {
    const key = String(sessionId)
    scenes.delete(key)
    sceneEpochs.delete(key)
    sceneRevisionOrderBySession.delete(key)
    deleteAssetSessionRecorded.delete(key)
  },
  resetScenes() {
    scenes.clear()
    sceneEpochs.clear()
    sceneRevisionOrderBySession.clear()
    deleteAssetSessionRecorded.clear()
  },
  reset() {
    shares.clear()
    shareUsageByOwner.clear()
    shareGlobalUsage.count = 0
    shareGlobalUsage.bytes = 0
    shareRates.createsBySession.clear()
    shareRates.createGlobal.times.length = 0
    shareRates.createGlobal.active = 0
    shareRates.deleteGlobal.times.length = 0
    shareRates.deleteGlobal.active = 0
    shareRates.viewerGlobal.times.length = 0
    shareRates.viewerGlobal.active = 0
    shareRates.viewerById.clear()
    shareRates.documentGlobal.times.length = 0
    shareRates.documentGlobal.active = 0
    shareRates.documentById.clear()
  },
  usage: shareSessionUsage,
  globalUsage: () => ({ ...shareGlobalUsage }),
  rawShare: id => shares.get(id),
  stats: () => shareStore.stats(),
}

/**
 * Test-only inspection surface for P3-2. Never registered as a route and never
 * exposed to the browser or the model. Session ids are accepted as fixtures
 * only; no hook returns code through an error and stats carry no ids.
 */
export const __historyInternal = {
  path: RESTORE_PATH,
  limits: RESTORE_LIMITS,
  restoreHandler,
  validateHost: validateShareHost,
  originAllowed: shareOriginAllowed,
  jsonContentType: sameShareJsonContentType,
  readBody: readShareBody,
  validateFields: validateRestoreFields,
  nextUpdatedAt: nextRestoreUpdatedAt,
  seedSession(sessionId, history) {
    const key = String(sessionId)
    scenes.set(key, {
      history: Array.isArray(history)
        ? history.map(record => record !== null && typeof record === 'object' ? { ...record } : record)
        : history,
    })
  },
  history(sessionId) {
    const entry = scenes.get(String(sessionId))
    if (entry === undefined) return null
    return {
      history: Array.isArray(entry.history)
        ? entry.history.map(record => record !== null && typeof record === 'object' ? { ...record } : record)
        : entry.history,
    }
  },
  stats() {
    let idempotencyEntries = 0
    for (const cache of restoreIdempotency.values()) idempotencyEntries += cache.size
    return {
      rateSessions: restoreRates.sessions.size,
      globalTimes: restoreRates.global.times.length,
      globalActive: restoreRates.global.active,
      idempotencySessions: restoreIdempotency.size,
      idempotencyEntries,
    }
  },
  setNow(fn) {
    restoreNow = typeof fn === 'function' ? fn : Date.now
  },
  clearScene(sessionId) {
    const key = String(sessionId)
    scenes.delete(key)
    sceneEpochs.delete(key)
    sceneRevisionOrderBySession.delete(key)
    deleteAssetSessionRecorded.delete(key)
    clearRestoreSessionState(key)
  },
  resetScenes() {
    scenes.clear()
    sceneEpochs.clear()
    sceneRevisionOrderBySession.clear()
    deleteAssetSessionRecorded.clear()
    clearAllRestoreState()
  },
  reset() {
    scenes.clear()
    clearAllRestoreState()
    restoreNow = Date.now
  },
}

/**
 * Test-only durable-store inspection and fault surface. It exposes no route,
 * path, token, raw Session id, asset id/hash, share id or delete key.
 */
export const __diskInternal = {
  mode: () => storageInspect().mode,
  status: () => storageInspect().status,
  ready: () => storage === null || !storage.started || storage.readyDone,
  stats: () => {
    const view = storageInspect()
    return {
      mode: view.mode,
      status: view.status,
      counters: { ...(view.counters ?? {}) },
      bytes: storage !== null && storage.budget !== null
        ? {
            used: storage.budget.used,
            reserved: storage.budget.reserved,
            staging: storage.budget.staging,
          }
        : null,
    }
  },
  limits: {
    MAX_SCENES,
    MAX_REVISIONS,
    MAX_THUMBNAILS_PER_SESSION,
    MAX_THUMBNAILS,
    MAX_ROOT_BYTES,
    MAX_LOAD_BYTES,
    MAX_STAGING_BYTES,
    STARTUP_DEADLINE_MS,
    MAX_ORDER,
    MAX_BOUNDARY_INTENTS,
    THUMBNAIL_INDEX_MIN_INTERVAL_MS,
    REVERSE_SCENES_FSYNC_RETRIES,
  },
  helpers: {
    sceneSidHash,
    thumbKeyHash,
    assetIdHash,
    shareIdHash,
  },
  inspect: () => {
    const view = storageInspect()
    const keys = [...diskFixtureLabels.keys()].sort()
    const fixtures = {}
    for (const [label, entry] of diskFixtureLabels) {
      const orderMap = sceneRevisionOrderBySession.get(entry.session)
      const ordersByRevision = {}
      if (orderMap !== undefined) {
        const revisions = [...orderMap.keys()].sort((a, b) => a - b).slice(0, 64)
        for (const revision of revisions) ordersByRevision[String(revision)] = orderMap.get(revision)
      }
      const recorded = deleteAssetSessionRecorded.get(entry.session)
      let preservedCount = 0
      const fixtureSidHash = sceneSidHash(entry.session)
      for (const preserved of preservedStaleAssets.values()) {
        if (preserved.sidHash === fixtureSidHash) preservedCount += 1
      }
      fixtures[label] = {
        epoch: sceneEpochs.get(entry.session) ?? null,
        revisionOrderCount: orderMap === undefined ? 0 : orderMap.size,
        ordersByRevision,
        recordedEntryPresent: recorded !== undefined,
        recordedAssetCount: Array.isArray(recorded) ? recorded.length : 0,
        preservedCount,
      }
    }
    return {
      mode: view.mode,
      status: view.status,
      loaded: view.loaded === true,
      keys,
      fixtures,
      lastCleanupToken: lastCleanupTokenView,
      lastCleanupTokens: lastCleanupTokensView.map(token => ({
        ...token,
        revisionOrders: token.revisionOrders.map(victim => ({ ...victim })),
        assetHashes: token.assetHashes.slice(),
        victimSet: { ...token.victimSet },
      })),
      namespaceFence: view.namespaceFence,
      counters: { ...(view.counters ?? {}) },
    }
  },
  markTestModeForTests() {
    const state = ensureStorage()
    if (state.testMode === true) return true
    if (state.started) return false
    const config = diskConfigFromEnv()
    if (config.isolatedTest !== true) return false
    state.testMode = true
    return true
  },
  faults: {
    set(entry) {
      const state = ensureStorage()
      if (state.testMode !== true) return false
      if (entry === null || typeof entry !== 'object') return false
      const op = String(entry.op ?? '')
      const at = String(entry.at ?? '')
      if (op === '' || at === '') return false
      const count = entry.count === undefined
        ? undefined
        : Math.max(0, Math.floor(Number.isFinite(Number(entry.count)) ? Number(entry.count) : 0))
      const behavior = entry.behavior === 'hang' ? 'hang' : 'error'
      const code = typeof entry.code === 'string' && entry.code !== '' ? entry.code : 'storage-unavailable'
      state.faults.push({ op, at, code, count, behavior })
      return true
    },
    clear() {
      if (storage !== null) {
        storage.faults.length = 0
        storage.faultHits.clear()
      }
    },
  },
  crashAt(name) {
    const state = ensureStorage()
    state.crashName = String(name)
  },
  pauseAtForTests(name) {
    const state = ensureStorage()
    let arrivalResolve
    const arrival = new Promise(resolve => { arrivalResolve = resolve })
    const pause = {
      name: String(name),
      arrived: false,
      releasePromise: null,
      releaseResolve: null,
      arrivalResolve,
    }
    state.testPauses.push(pause)
    return {
      arrival,
      release() {
        const index = state.testPauses.indexOf(pause)
        if (index < 0) return false
        state.testPauses.splice(index, 1)
        if (pause.releaseResolve !== null) pause.releaseResolve()
        return true
      },
    }
  },
  async cleanupIdleForTests(timeoutMs = 10000) {
    const deadline = Date.now() + Math.max(1, Math.floor(timeoutMs))
    while (Date.now() < deadline) {
      if (!deferredSceneCleanupPumping && deferredSceneCleanup.length === 0
        && (storage === null || storage.queues.asset.pendingTotal === 0)) return true
      await new Promise(resolve => setImmediate(resolve))
    }
    return false
  },
  fenceEventsForTests() {
    return storage === null || storage.fence === null ? [] : storage.fence.events.slice()
  },
  pathsFor() {
    const state = storage
    const out = { categories: [], names: {}, open: state !== null && state.dirFds !== null }
    if (state === null || state.dirFds === null) return out
    for (const [category, fd] of Object.entries(state.dirFds)) {
      out.categories.push(category)
      try {
        const names = readdirAt(fd).map(entry => entry.name).sort().slice(0, 256)
        out.names[category] = names
      } catch (error) {
        out.names[category] = []
      }
    }
    return out
  },
  configureForTests(options = {}) {
    const state = ensureStorage()
    if (Number.isSafeInteger(options.startupDeadlineMs) && options.startupDeadlineMs >= 0) {
      state.startupDeadlineMs = options.startupDeadlineMs
      state.testConfig.startupDeadlineMs = options.startupDeadlineMs
    }
    if (Object.hasOwn(options, 'forceStartupDeadlineAfterScanEntries')) {
      const value = options.forceStartupDeadlineAfterScanEntries
      if (Number.isSafeInteger(value) && value >= 0) {
        state.testConfig.forceStartupDeadlineAfterScanEntries = value
      } else {
        delete state.testConfig.forceStartupDeadlineAfterScanEntries
      }
    }
    if (Object.hasOwn(options, 'recordFenceEvents')) {
      state.testConfig.recordFenceEvents = options.recordFenceEvents === true
      if (state.fence !== null) state.fence.events.length = 0
    }
    for (const key of ['maxRootBytes', 'maxLoadBytes', 'maxStagingBytes', 'maxSceneReadBytes']) {
      if (Number.isSafeInteger(options[key]) && options[key] > 0) {
        state[key] = options[key]
        state.testConfig[key] = options[key]
        if (state.budget !== null) {
          if (key === 'maxRootBytes') state.budget.limits.maxRootBytes = options[key]
          if (key === 'maxStagingBytes') state.budget.limits.maxStagingBytes = options[key]
        }
      }
    }
    if (state.budget !== null) state.budget.pumpStagingWaiters()
    return { ...state.testConfig }
  },
  scanForTests() {
    const state = storage
    if (state === null || state.testMode !== true) return null
    return {
      scanEntries: state.scanEntries,
      sceneReadBytes: state.sceneReadBytes,
      maxSceneReadBytes: state.maxSceneReadBytes,
      loadBytes: state.loadBytes,
      maxLoadBytes: state.maxLoadBytes,
      maxStagingBytes: state.maxStagingBytes,
      maxRootBytes: state.maxRootBytes,
      budgetUsed: state.budget === null ? 0 : state.budget.used,
      budgetStaging: state.budget === null ? 0 : state.budget.staging,
      counters: { ...state.scanCounters },
      stats: { ...state.stats },
    }
  },
  faultHitsForTests() {
    if (storage === null || storage.testMode !== true) return {}
    return Object.fromEntries([...storage.faultHits.entries()].sort())
  },
  clearCleanupTokensForTests() {
    if (storage === null || storage.testMode !== true) return false
    lastCleanupTokensView = []
    return true
  },
  releaseHangsForTests() {
    if (storage === null || storage.testMode !== true) return 0
    const waiters = storage.hangWaiters.splice(0)
    for (const release of waiters) release()
    return waiters.length
  },
  hangWaiterCountForTests() {
    return storage === null || storage.testMode !== true ? 0 : storage.hangWaiters.length
  },
  setVirtualDirentsForTests(entries) {
    const state = ensureStorage()
    if (state.testMode !== true) return false
    if (!Array.isArray(entries)) return false
    state.virtualDirents.clear()
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || typeof entry.dir !== 'string') continue
      const specs = Array.isArray(entry.specs) ? entry.specs : [entry]
      const normalized = []
      for (const spec of specs) {
        if (spec === null || typeof spec !== 'object') continue
        normalized.push({ ...spec })
      }
      if (normalized.length > 0) state.virtualDirents.set(entry.dir, normalized)
    }
    return true
  },
  clearVirtualDirentsForTests() {
    if (storage === null || storage.testMode !== true) return false
    storage.virtualDirents.clear()
    return true
  },
  pauseSyncAtForTests(name) {
    const state = ensureStorage()
    if (state.testMode !== true) return false
    state.testSyncPauses.push({ name: String(name) })
    return true
  },
  withDiskTaskForTests(fn) {
    const state = ensureStorage()
    if (state.testMode !== true || typeof fn !== 'function') return Promise.reject(new Error('test mode required'))
    return withDiskTask(fn)
  },
  holdQueueForTests(kind, key) {
    const state = ensureStorage()
    if (state.testMode !== true || typeof state.queues[kind]?.acquire !== 'function') {
      return Promise.reject(new Error('test mode required'))
    }
    return acquireDiskQueue(kind, String(key))
  },
  forceNextAppendEpochForTests(epoch) {
    const state = ensureStorage()
    if (state.testMode !== true) return false
    state.testForcedAppendEpoch = typeof epoch === 'string' && HEX32_RE.test(epoch) ? epoch : null
    return true
  },
  releaseLockTokenForTests(token) {
    const state = storage
    if (state === null || state.testMode !== true || state.rootFd === null) return false
    return releaseDiskLock(state.rootFd, String(token))
  },
  lockHeldForTests() {
    return storage !== null && storage.lockHeld === true
  },
  async restartBeginForTests() {
    const config = diskConfigFromEnv()
    if (config.isolatedTest !== true) throw new Error('disk test root required')
    if (storage !== null && storage.started) await stopStorage()
    if (storage !== null && storage.lockHeld) {
      if (storage.deferredReleaseCheck !== null) await storage.deferredReleaseCheck
      if (storage.lockHeld) throw new Error('disk lock release pending')
    }
    const previous = storage
    resetInMemoryStoresForTests()
    const next = createStorageState()
    if (previous !== null) {
      next.testConfig = { ...previous.testConfig }
      next.faults = previous.faults
      next.faultHits = previous.faultHits
      next.crashName = previous.crashName
      next.clock = previous.clock
      next.startupDeadlineMs = previous.startupDeadlineMs
      next.maxRootBytes = previous.maxRootBytes
      next.maxLoadBytes = previous.maxLoadBytes
      next.maxStagingBytes = previous.maxStagingBytes
      next.maxSceneReadBytes = previous.maxSceneReadBytes
      next.virtualDirents = previous.virtualDirents
    }
    storage = next
    void startStorage()
    return { mode: next.mode, status: next.status, ready: next.readyDone }
  },
  async waitReadyForTests() {
    await storageReady()
    return { mode: storage === null ? 'memory' : storage.mode, status: storage === null ? null : storage.status }
  },
  setClockForTests(fn) {
    const state = ensureStorage()
    state.clock = typeof fn === 'function' ? fn : Date.now
    diskNow = state.clock
  },
  seedSceneForTests(options) {
    return seedSceneFixture(options)
  },
  clearFixtureLabelsForTests() {
    if (storage === null || storage.testMode !== true) return false
    diskFixtureLabels.clear()
    return true
  },
  dropSceneEpochForTests(sessionId) {
    if (storage === null || storage.testMode !== true) return false
    return sceneEpochs.delete(String(sessionId))
  },
  sceneEpochForTests(sessionId) {
    if (storage === null || storage.testMode !== true) return null
    return sceneEpochs.get(String(sessionId)) ?? null
  },
  restartForTests() {
    return diskRestartForTests()
  },
  closeForTests() {
    return stopStorage()
  },
  resetForTests() {
    return diskResetForTests()
  },
  generatedNames: {
    intent: slot => `${slot}.intent.json`,
    sceneRevision: order => `${String(order).padStart(16, '0')}.json`,
    sceneMarker: order => `${String(order).padStart(16, '0')}.commit.json`,
    quarantine: (sequence, token) => `q-${String(sequence).padStart(26, '0')}-${token}`,
    thumbnail: (thumbHash, sha256) => `${thumbHash}-${sha256}.png`,
  },
}

let lastCleanupTokenView = { epoch: null, orderCount: 0, assetCount: 0, victimSet: {} }
let lastCleanupTokensView = []
const diskFixtureLabels = new Map()

function resetInMemoryStoresForTests() {
  scenes.clear()
  thumbnails.clear()
  assets.clear()
  assetIndex.clear()
  assetNames.clear()
  assetUsage.clear()
  globalUsage.count = 0
  globalUsage.bytes = 0
  assetRates.clear()
  shares.clear()
  shareUsageByOwner.clear()
  shareOrderById.clear()
  shareGlobalUsage.count = 0
  shareGlobalUsage.bytes = 0
  shareRates.createsBySession.clear()
  shareRates.createGlobal.times.length = 0
  shareRates.createGlobal.active = 0
  shareRates.deleteGlobal.times.length = 0
  shareRates.deleteGlobal.active = 0
  shareRates.viewerGlobal.times.length = 0
  shareRates.viewerGlobal.active = 0
  shareRates.viewerById.clear()
  shareRates.documentGlobal.times.length = 0
  shareRates.documentGlobal.active = 0
  shareRates.documentById.clear()
  sceneEpochs.clear()
  sceneRevisionOrderBySession.clear()
  deleteAssetSessionRecorded.clear()
  assetOwnerRecords.clear()
  preservedStaleAssets.clear()
  hiddenAssetIds.clear()
  assetOrderById.clear()
  assetHashById.clear()
  thumbnailIndex.clear()
  assetDiskMetaById.clear()
  sceneProductEvicted.clear()
  sceneUnscanned.clear()
  assetEpochConflict.clear()
  restoreIdempotency.clear()
  restoreRates.sessions.clear()
  restoreRates.global.times.length = 0
  restoreRates.global.active = 0
  nextSceneOrder = 1
  nextThumbOrder = 1
  nextAssetOrder = 1
  nextShareOrder = 1
  sceneScanTruncated = false
  sceneWritePreserve = false
  sceneWriteDegraded = false
  thumbnailWriteDegraded = false
  deferredSceneCleanup = []
}

async function diskRestartForTests() {
  const config = diskConfigFromEnv()
  if (config.isolatedTest !== true) throw new Error('disk test root required')
  if (storage !== null && storage.started) await stopStorage()
  if (storage !== null && storage.lockHeld) {
    if (storage.deferredReleaseCheck !== null) await storage.deferredReleaseCheck
    if (storage.lockHeld) throw new Error('disk lock release pending')
  }
  const previous = storage
  resetInMemoryStoresForTests()
  const next = createStorageState()
  if (previous !== null) {
    next.testConfig = { ...previous.testConfig }
    next.faults = previous.faults
    next.crashName = previous.crashName
    next.clock = previous.clock
    next.startupDeadlineMs = previous.startupDeadlineMs
    next.maxRootBytes = previous.maxRootBytes
    next.maxLoadBytes = previous.maxLoadBytes
    next.maxStagingBytes = previous.maxStagingBytes
    next.maxSceneReadBytes = previous.maxSceneReadBytes
    next.virtualDirents = previous.virtualDirents
    next.testSyncPauses = previous.testSyncPauses
  }
  storage = next
  await startStorage()
  await storageReady()
  return { mode: next.mode, status: next.status, reason: next.reason }
}

async function diskResetForTests() {
  if (storage !== null && storage.started) await stopStorage()
  if (storage !== null && storage.lockHeld) {
    if (storage.deferredReleaseCheck !== null) await storage.deferredReleaseCheck
    if (storage.lockHeld) throw new Error('disk lock release pending')
  }
  const previous = storage
  resetInMemoryStoresForTests()
  const next = createStorageState()
  if (previous !== null) {
    next.testConfig = { ...previous.testConfig }
    next.faults = previous.faults
    next.clock = previous.clock
    next.startupDeadlineMs = previous.startupDeadlineMs
    next.maxRootBytes = previous.maxRootBytes
    next.maxLoadBytes = previous.maxLoadBytes
    next.maxStagingBytes = previous.maxStagingBytes
    next.maxSceneReadBytes = previous.maxSceneReadBytes
    next.virtualDirents = previous.virtualDirents
  }
  storage = next
  return { mode: next.mode, status: next.status }
}

function fixturePngBytes(seed, size = 24) {
  const body = Buffer.alloc(Math.max(PNG_SIGNATURE.length + 8, size))
  PNG_SIGNATURE.copy(body, 0)
  const digest = createHash('sha256').update(String(seed), 'utf8').digest()
  for (let index = PNG_SIGNATURE.length; index < body.length; index += 1) {
    body[index] = digest[(index - PNG_SIGNATURE.length) % digest.length]
  }
  return body
}

function fixtureAssetId(seed) {
  return createHash('sha256').update(`fixture-asset:${String(seed)}`, 'utf8')
    .digest('base64url').slice(0, 22)
}

/**
 * Bounded test-only fixture writer. It writes acknowledged scene revisions,
 * markers, an optional owner and committed PNG assets without touching the
 * in-memory product stores or applying product eviction.
 */
async function seedSceneFixture(options = {}) {
  const state = storage
  if (state === null || state.dirFds === null || state.testMode !== true) {
    throw new Error('disk test root required')
  }
  const session = options.session ?? options.sessionId
  const label = typeof options.label === 'string' && options.label !== ''
    ? options.label
    : `F${String(diskFixtureLabels.size + 1)}`
  if (typeof session !== 'string' || session === '' || !isSafeSceneId(session)) throw new Error('fixture session')
  if (!diskFixtureLabels.has(label) && diskFixtureLabels.size >= 64) throw new Error('fixture session cap')
  const epoch = typeof options.epoch === 'string' && HEX32_RE.test(options.epoch)
    ? options.epoch
    : diskSha(`fixture-epoch:${label}:${session}`).slice(0, 32)
  const revisionInput = options.revisions ?? 1
  const revisionCount = typeof revisionInput === 'number'
    ? Math.floor(revisionInput)
    : Array.isArray(revisionInput) ? revisionInput.length : 0
  if (!Number.isSafeInteger(revisionCount) || revisionCount < 1 || revisionCount > 64) {
    throw new Error('fixture revision cap')
  }
  const assetInput = options.assets ?? 0
  const assetCount = typeof assetInput === 'number'
    ? Math.floor(assetInput)
    : Array.isArray(assetInput) ? assetInput.length : 0
  if (!Number.isSafeInteger(assetCount) || assetCount < 0 || assetCount > 64) {
    throw new Error('fixture asset cap')
  }
  const sidHash = sceneSidHash(session)
  const scenesFd = state.dirFds.scenes
  let sessionFd = null
  let createdSession = false
  try {
    try {
      sessionFd = openDirAt(scenesFd, sidHash)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      sessionFd = mkdirDurableAt(scenesFd, sidHash)
      createdSession = true
    }
    let totalBytes = 0
    const usedOrders = new Set()
    const baseOrder = Number.isSafeInteger(options.baseOrder) && options.baseOrder > 0
      ? options.baseOrder
      : nextSceneOrder
    for (let index = 0; index < revisionCount; index += 1) {
      const revisionNumber = index + 1
      const order = baseOrder + index
      if (!isSafePositive(order) || order > MAX_ORDER) throw new Error('fixture order')
      if (usedOrders.has(order)) throw new Error('fixture order duplicate')
      usedOrders.add(order)
      const source = Array.isArray(revisionInput) && revisionInput[index] !== null
        && typeof revisionInput[index] === 'object' ? revisionInput[index] : {}
      const code = typeof source.code === 'string'
        ? source.code
        : `// fixture ${label} revision ${String(revisionNumber)}\nconst value = ${String(revisionNumber)}\n`
      const title = typeof source.title === 'string' ? source.title : `fixture ${label}`
      const updatedAt = Number.isSafeInteger(source.updatedAt) ? source.updatedAt : 1000 + revisionNumber
      const built = buildSceneRevisionRecord({
        sceneId: session, epoch, revision: revisionNumber, order, title, code,
        bytes: Buffer.byteLength(code, 'utf8'), updatedAt,
      })
      totalBytes += built.bytes.length
      if (totalBytes > 64 * 1024 * 1024) throw new Error('fixture byte cap')
      const orderName = `${String(order).padStart(16, '0')}.json`
      const markerName = `${String(order).padStart(16, '0')}.commit.json`
      writeFileDurableSync(sessionFd, orderName, built.bytes)
      const marker = buildSceneMarker(sidHash, order, revisionNumber, built.sha256)
      writeFileDurableSync(sessionFd, markerName, marker.bytes)
    }
    fsyncFd(sessionFd)
    nextSceneOrder = Math.max(nextSceneOrder, baseOrder + revisionCount)
    let assetsFd = state.dirFds.assets
    let assetSessionFd = null
    let owner = null
    if (assetCount > 0) {
      try { assetSessionFd = openDirAt(assetsFd, sidHash) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        assetSessionFd = mkdirDurableAt(assetsFd, sidHash)
      }
      try {
        try {
          owner = validateOwnerRecordBytes(readFileAt(assetSessionFd, 'owner.json', 1024), sidHash)
        } catch (error) {
          owner = buildOwnerRecord(sidHash, epoch, diskRandomHex(), 1000).object
          writeFileDurableSync(assetSessionFd, 'owner.json', serializeRecord(owner))
        }
        const baseAssetOrder = Number.isSafeInteger(options.baseAssetOrder) && options.baseAssetOrder > 0
          ? options.baseAssetOrder
          : nextAssetOrder
        for (let index = 0; index < assetCount; index += 1) {
          const source = Array.isArray(assetInput) && assetInput[index] !== null
            && typeof assetInput[index] === 'object' ? assetInput[index] : {}
          const assetId = typeof source.id === 'string' && ASSET_ID_RE.test(source.id)
            ? source.id
            : fixtureAssetId(`${label}:${String(index)}`)
          const body = fixturePngBytes(`${label}:${String(index)}`,
            Number.isSafeInteger(source.bytes) && source.bytes > 24 ? Math.min(source.bytes, 1024 * 1024) : 24)
          const assetHash = assetIdHash(assetId)
          const order = baseAssetOrder + index
          const meta = buildAssetMeta({
            sceneId: session,
            sceneEpoch: epoch,
            id: assetId,
            name: typeof source.name === 'string' ? source.name : `fixture-${String(index)}.png`,
            nameFold: typeof source.name === 'string' ? source.name.toLowerCase() : `fixture-${String(index)}.png`,
            kind: 'image',
            mime: 'image/png',
            ext: '.png',
            bytes: body.length,
            order,
            createdAt: 1000 + index,
            sha256: diskSha(body),
          })
          totalBytes += meta.bytes.length + body.length
          if (totalBytes > 64 * 1024 * 1024) throw new Error('fixture byte cap')
          let assetFd
          try { assetFd = openDirAt(assetSessionFd, assetHash) } catch (error) {
            if (error?.code !== 'ENOENT') throw error
            assetFd = mkdirDurableAt(assetSessionFd, assetHash)
          }
          try {
            writeFileDurableSync(assetFd, 'meta.json', meta.bytes)
            writeFileDurableSync(assetFd, 'body.bin', body)
            writeFileDurableSync(assetFd, 'COMMITTED', Buffer.alloc(0))
            fsyncFd(assetFd)
          } finally {
            fs.closeSync(assetFd)
          }
        }
        fsyncFd(assetSessionFd)
        nextAssetOrder = Math.max(nextAssetOrder, baseAssetOrder + assetCount)
      } finally {
        fs.closeSync(assetSessionFd)
      }
    }
    void assetsFd
    diskFixtureLabels.set(label, { session })
    return { label, revisions: revisionCount, assets: assetCount, createdSession }
  } finally {
    if (sessionFd !== null) fs.closeSync(sessionFd)
  }
}

/**
 * Read one vendored runtime file once and reuse it.
 * @param file - path inside `runtime/`, for example `exporters/GLTFExporter.js`.
 * @returns file bytes.
 */
async function runtimeFile(file) {
  const cached = runtimeCache.get(file)
  if (cached !== undefined) return cached
  const body = await readFile(join(RUNTIME_DIR, file))
  runtimeCache.set(file, body)
  return body
}

/**
 * @param body - JSON value.
 * @param status - HTTP status.
 * @returns JSON response readable from the app page.
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * @param body - plain text body.
 * @param status - HTTP status.
 * @returns text response.
 */
function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  })
}
