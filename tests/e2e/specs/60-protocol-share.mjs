// P5-1 read-only share viewer check. Opt-in: the operator must supply an
// existing share link in WORKBENCH_SHARE_URL. The default non-mutating run
// never creates or revokes a share; without the env var every check SKIPs.
//
// The viewer is a constant shell with a sandboxed srcdoc runtime and no
// message bridge, so camera/track/loop facts are asserted from the injected
// document markers and behaviour is observed through the viewer's own HUD
// clock and canvas. No srcdoc/HTML is logged or written to an artifact.
import assert from 'node:assert/strict'
import { skipCheck, sleep, waitFor } from '../lib/harness.mjs'

const CHECK_IDS = [
  'share/shell-metadata-sandbox',
  'share/document-camera-tracks-loop',
  'share/runtime-render-autoplay',
]

const SANDBOX = 'allow-scripts allow-pointer-lock allow-downloads'

async function shellState(page) {
  return page.evaluate(() => {
    const frame = document.getElementById('view')
    const bar = document.getElementById('bar')
    const status = document.getElementById('status')
    const srcdoc = frame === null ? null : frame.getAttribute('srcdoc')
    return {
      title: document.title,
      barHidden: bar === null ? null : bar.hidden === true,
      statusText: status === null ? null : status.textContent,
      hasFrame: frame !== null,
      sandbox: frame === null ? null : frame.getAttribute('sandbox'),
      srcdocLength: typeof srcdoc === 'string' ? srcdoc.length : 0,
      srcdocDoctype: typeof srcdoc === 'string' && /^<!doctype html>/i.test(srcdoc),
      contentDocumentNull: frame === null ? null : frame.contentDocument === null,
    }
  })
}

async function documentMarkers(page) {
  return page.evaluate(() => {
    const frame = document.getElementById('view')
    const text = frame === null ? '' : (frame.getAttribute('srcdoc') || '')
    const stateMatch = /const INITIAL_EDITOR_STATE = ([\s\S]*?)\nconst INITIAL_ASSETS =/.exec(text)
    const cameraMatch = /const INITIAL_CAMERA = ([\s\S]*?)\nconst INITIAL_EDITOR_STATE =/.exec(text)
    let state = null
    let camera = null
    try { state = stateMatch === null ? null : JSON.parse(stateMatch[1]) } catch { state = null }
    try { camera = cameraMatch === null ? null : JSON.parse(cameraMatch[1]) } catch { camera = null }
    return {
      doctype: /^<!doctype html>/i.test(text),
      hasInitialState: text.includes('const INITIAL_EDITOR_STATE ='),
      hasInitialCamera: text.includes('const INITIAL_CAMERA ='),
      initialCameraApplied: /if \(INITIAL_CAMERA\) \{/.test(text),
      initializeTracks: text.includes('initializeTracks(INITIAL_EDITOR_STATE)'),
      playingDefault: /timeline = \{ playing: true/.test(text),
      loopDefault: /loop: true/.test(text),
      animationLoop: text.includes('renderer.setAnimationLoop('),
      stateKind: state !== null && typeof state === 'object' ? 'object' : 'null',
      stateDuration: state !== null && state.timeline && typeof state.timeline === 'object'
        && Number.isFinite(state.timeline.duration) ? state.timeline.duration : null,
      tracksArray: state !== null && state.tracks && Array.isArray(state.tracks.items),
      trackCount: state !== null && state.tracks && Array.isArray(state.tracks.items)
        ? state.tracks.items.length : null,
      cameraKind: camera === null ? 'null'
        : (Array.isArray(camera.position) && Array.isArray(camera.target) ? 'captured' : 'invalid'),
    }
  })
}

async function runtimeState(page) {
  const frames = page.frames().filter(frame => frame !== page.mainFrame())
  if (frames.length === 0) return { available: false, reason: 'no runtime frame' }
  const frame = frames[0]
  try {
    const result = await frame.evaluate(() => {
      const hud = document.getElementById('hud')
      const err = document.getElementById('err')
      const canvas = document.getElementById('c')
      const match = hud === null ? null : /t=([0-9]+(?:\.[0-9]+)?)s/.exec(hud.textContent || '')
      return {
        hudTime: match === null ? null : Number(match[1]),
        errorHidden: err === null ? null : err.hidden === true,
        canvasWidth: canvas === null ? 0 : canvas.width,
        canvasHeight: canvas === null ? 0 : canvas.height,
      }
    })
    return { available: true, frame, ...result }
  } catch {
    return { available: false, reason: 'frame is not inspectable in this browser' }
  }
}

async function canvasStatistics(page, frame) {
  const buffer = await frame.locator('canvas#c').first().screenshot()
  return page.evaluate(async dataUrl => {
    const image = new Image()
    image.src = dataUrl
    await image.decode()
    const off = document.createElement('canvas')
    off.width = image.width
    off.height = image.height
    const context = off.getContext('2d', { willReadFrequently: true })
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, off.width, off.height).data
    const buckets = new Set()
    let sum = 0
    let sumSquares = 0
    const total = off.width * off.height
    for (let offset = 0; offset < pixels.length; offset += 4) {
      buckets.add((pixels[offset] >> 4) + ':' + (pixels[offset + 1] >> 4) + ':' + (pixels[offset + 2] >> 4))
      const luminance = 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2]
      sum += luminance
      sumSquares += luminance * luminance
    }
    const mean = sum / total
    return { width: off.width, height: off.height, colors: buckets.size, variance: sumSquares / total - mean * mean }
  }, 'data:image/png;base64,' + buffer.toString('base64'))
}

export default {
  name: 'share-viewer',
  async run(h) {
    if (!h.shareUrl) {
      for (const id of CHECK_IDS) {
        h.skip(id, 'WORKBENCH_SHARE_URL is not set; share checks are read-only opt-in and the default run never creates a share')
      }
      return
    }

    async function openShare() {
      const { page } = await h.newRawPage({ viewport: { width: 1280, height: 800 } })
      const response = await page.goto(h.shareUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
      const status = response === null ? null : response.status()
      if (status !== null && status >= 400) {
        throw new Error('share viewer returned HTTP ' + status + ' (unavailable or expired)')
      }
      await waitFor(async () => {
        const state = await shellState(page)
        return state.hasFrame && state.srcdocLength > 0 && state.barHidden === true ? state : null
      }, { timeout: 30000, interval: 150, label: 'share viewer shell load' })
      return { page, response }
    }

    // Contexts are closed by Harness.check after a failure screenshot is taken.
    await h.check('share/shell-metadata-sandbox', async () => {
      const { page, response } = await openShare()
      assert.ok(response !== null, 'share navigation returned a response')
      const headers = response.headers()
      assert.match(String(headers['content-type']), /^text\/html/i, 'viewer is served as HTML')
      assert.equal(headers['x-frame-options'], 'DENY', 'viewer denies framing')
      assert.match(String(headers['content-security-policy']), /frame-src about:/, 'viewer CSP pins frame-src')
      const state = await shellState(page)
      assert.equal(state.sandbox, SANDBOX, 'viewer iframe uses the exact sandbox triple')
      const tokens = String(state.sandbox).split(/\s+/)
      assert.deepEqual(tokens.slice().sort(), ['allow-downloads', 'allow-pointer-lock', 'allow-scripts'],
        'sandbox carries no extra tokens')
      assert.ok(!tokens.includes('allow-same-origin'), 'sandbox never grants same-origin')
      assert.equal(state.contentDocumentNull, true, 'the parent cannot reach the sandboxed document')
      assert.equal(state.srcdocDoctype, true, 'the sandboxed document is a full HTML document')
      assert.ok(typeof state.title === 'string' && state.title.length > 0, 'metadata supplies a document title')
    })

    await h.check('share/document-camera-tracks-loop', async () => {
      const { page } = await openShare()
      const markers = await documentMarkers(page)
      assert.equal(markers.doctype, true, 'shared document starts with a doctype')
      assert.equal(markers.hasInitialState, true, 'shared document embeds the frozen editor state')
      assert.equal(markers.hasInitialCamera, true, 'shared document embeds the frozen camera slot')
      assert.equal(markers.initialCameraApplied, true, 'runtime applies INITIAL_CAMERA at boot')
      assert.equal(markers.initializeTracks, true, 'runtime initializes the frozen tracks at boot')
      assert.equal(markers.playingDefault, true, 'playback autoplays by default')
      assert.equal(markers.loopDefault, true, 'playback loops by default')
      assert.equal(markers.animationLoop, true, 'runtime installs an animation loop')
      assert.equal(markers.stateKind, 'object', 'frozen editor state parses as an object')
      assert.ok(typeof markers.stateDuration === 'number' && markers.stateDuration >= 0,
        'frozen timeline duration is preserved')
      assert.equal(markers.tracksArray, true, 'frozen track set is an items array')
      assert.ok(Number.isInteger(markers.trackCount) && markers.trackCount >= 0, 'frozen track count is observable')
      assert.ok(markers.cameraKind === 'captured' || markers.cameraKind === 'null',
        'frozen camera is null or numeric position/target arrays')
    })

    await h.check('share/runtime-render-autoplay', async () => {
      const { page } = await openShare()
      const first = await runtimeState(page)
      if (!first.available) skipCheck('share runtime ' + first.reason + '; shell/document markers are still covered')
      assert.equal(first.errorHidden, true, 'shared document reports no runtime script error')
      assert.ok(first.canvasWidth > 0 && first.canvasHeight > 0, 'shared canvas has a drawing buffer')
      assert.ok(typeof first.hudTime === 'number', 'viewer HUD exposes the playhead clock')
      const statistics = await canvasStatistics(page, first.frame)
      assert.ok(statistics.width > 0 && statistics.height > 0, 'shared canvas renders pixels')
      assert.ok(statistics.colors >= 4, 'shared canvas is not a flat fill')
      assert.ok(statistics.variance > 5, 'shared canvas has visible content')
      await sleep(700)
      const second = await runtimeState(page)
      assert.equal(second.available, true, 'runtime frame stays inspectable')
      assert.ok(typeof second.hudTime === 'number' && second.hudTime !== first.hudTime,
        'playhead advances without user input (autoplay)')
      assert.equal(second.errorHidden, true, 'shared document stays free of script errors')
    })
  },
}
