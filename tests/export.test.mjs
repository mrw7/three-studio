/**
 * P2-2 deterministic MP4/GIF export — pure contracts and source invariants.
 *
 * The browser probe (`verify-batch7.mjs`) covers actual encoding, container
 * sample counts, downloads and cancellation; this dependency-free suite pins
 * the frame plan, codec order, filenames, localized copy and the security/
 * determinism invariants that must not regress silently.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const vendorDir = new URL('../runtime/vendor/', import.meta.url)
const readVendor = name => readFile(new URL(name, vendorDir), 'utf8')
const sha256 = text => createHash('sha256').update(text).digest('hex')

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
await import(`${pathToFileURL(new URL('../client.js', import.meta.url).pathname).href}?export=${String(Date.now())}`)
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

test('P2-2 frame plan: 5 s @ 30 fps is exactly 150 fixed-grid samples', () => {
  const plan = plugin.__exportPlan(5, 30)
  assert.deepEqual(plan, {
    width: 960,
    height: 540,
    fps: 30,
    duration: 5,
    frameCount: 150,
    frameDurationUs: 33333,
  })
  assert.equal(plugin.__EXPORT_WIDTH, 960)
  assert.equal(plugin.__EXPORT_HEIGHT, 540)
  assert.equal(plugin.__EXPORT_MAX_FRAMES, 3600)
  assert.equal(plugin.__EXPORT_GIF_MAX_FRAMES, 600)
  assert.equal(plugin.__EXPORT_FRAME_TIMEOUT_MS, 5000)
  assert.equal(plugin.__EXPORT_ACK_TIMEOUT_MS, 2000)
  assert.equal(plugin.__EXPORT_QUEUE_LIMIT, 8)
  // Last sample is one step before the requested duration; the container
  // duration comes from the per-frame sample durations.
  assert.equal(plugin.__exportFrameTimestamp(149, 30), 4_966_667)
  assert.equal(plugin.__exportFrameTimestamp(0, 30), 0)
  assert.equal(plugin.__exportFrameTimestamp(150, 30) - plugin.__exportFrameTimestamp(149, 30), 33333)
  assert.equal(plan.frameDurationUs, 33333)
})

test('P2-2 frame plan clamps duration/fps and survives junk input', () => {
  assert.equal(plugin.__exportPlan(1000, 30).duration, 60)
  assert.equal(plugin.__exportPlan(0, 30).duration, 0.1)
  assert.equal(plugin.__exportPlan(-5, 30).frameCount, 3) // 0.1 s * 30, rounded
  assert.equal(plugin.__exportPlan(5, 1000).fps, 60)
  assert.equal(plugin.__exportPlan(5, 0).fps, 1)
  assert.equal(plugin.__exportPlan(5, Number.NaN).fps, 1)
  assert.equal(plugin.__exportPlan(Number.POSITIVE_INFINITY, 30).duration, 60)
  assert.equal(plugin.__exportPlan(5, Number.POSITIVE_INFINITY).fps, 60)
  assert.equal(plugin.__exportPlan(5, Number.NaN, undefined).frameCount, 5)
  // Exactly 60 s @ 60 fps is the largest selectable plan (3600 frames).
  assert.equal(plugin.__exportPlan(60, 60).frameCount, 3600)
})

test('film plans support 1080p, vertical and square cuts', () => {
  const hd = plugin.__exportPlan(5, 30, { width: 1920, height: 1080 })
  assert.equal(hd.width, 1920)
  assert.equal(hd.height, 1080)
  assert.equal(hd.frameCount, 150)
  const vertical = plugin.__exportPlan(5, 30, { width: 1080, height: 1920 })
  assert.equal(vertical.width, 1080)
  assert.equal(vertical.height, 1920)
  const square = plugin.__exportPlan(5, 30, { width: 1080, height: 1080 })
  assert.equal(square.width, 1080)
  assert.equal(square.height, 1080)
  const social = plugin.__exportPlan(5, 30, { width: 1080, height: 1350 })
  assert.equal(social.width, 1080)
  assert.equal(social.height, 1350)
  const uhd = plugin.__exportPlan(5, 30, { width: 3840, height: 2160 })
  assert.equal(uhd.width, 3840)
  assert.equal(uhd.height, 2160)
  assert.equal(plugin.__exportPlan(5, 30, { width: 2160, height: 3840 }).height, 3840)
  assert.equal(plugin.__exportPlan(5, 30, { width: 2160, height: 2160 }).width, 2160)
  assert.equal(plugin.__exportPlan(5, 30, { width: 2160, height: 2700 }).height, 2700)
  // Above the 4K cap fall back to the 960x540 default rather than creating a
  // plan the capture protocol will later refuse.
  const oversized = plugin.__exportPlan(5, 30, { width: 7680, height: 4320 })
  assert.equal(oversized.width, 960)
  assert.equal(oversized.height, 540)
  assert.equal(plugin.__exportFilename(42, 'mp4', 30, 1920, 1080), 'three-scene-42-30fps-1080p.mp4')
  assert.equal(plugin.__exportFilename(42, 'mp4', 30, 1080, 1920), 'three-scene-42-30fps-vertical.mp4')
  assert.equal(plugin.__exportFilename(42, 'mp4', 30, 1080, 1080), 'three-scene-42-30fps-square.mp4')
  assert.equal(plugin.__exportFilename(42, 'mp4', 30, 1080, 1350), 'three-scene-42-30fps-4x5.mp4')
  assert.equal(plugin.__exportFilename(42, 'mp4', 30, 3840, 2160), 'three-scene-42-30fps-4k.mp4')
  assert.equal(plugin.__exportFilename(42, 'mp4', 30, 2160, 3840), 'three-scene-42-30fps-4k-vertical.mp4')
  assert.equal(plugin.__exportFilename(42, 'mp4', 30, 2160, 2160), 'three-scene-42-30fps-4k-square.mp4')
  assert.equal(plugin.__exportFilename(42, 'mp4', 30, 2160, 2700), 'three-scene-42-30fps-4k-4x5.mp4')
})

test('P2-2 caps refuse before frame one: 3600 frames, GIF 600, pixel cap', () => {
  const big = { width: 960, height: 540, frameCount: 3601, fps: 30, duration: 60 }
  assert.equal(plugin.__exportRefusal(big, 'mp4'), 'frames')
  assert.equal(plugin.__exportRefusal(big, 'gif'), 'frames')
  const gifTooLong = { width: 960, height: 540, frameCount: 601, fps: 30, duration: 20 }
  assert.equal(plugin.__exportRefusal(gifTooLong, 'mp4'), null)
  assert.equal(plugin.__exportRefusal(gifTooLong, 'gif'), 'gif-frames')
  const huge = { width: 7680, height: 4320, frameCount: 10 }
  assert.equal(plugin.__exportRefusal(huge, 'mp4'), 'pixels')
  assert.equal(plugin.__exportRefusal(null, 'mp4'), 'pixels')
  assert.equal(plugin.__exportRefusal(plugin.__exportPlan(5, 30), 'mp4'), null)
  assert.equal(plugin.__exportRefusal(plugin.__exportPlan(21, 30), 'gif'), 'gif-frames')
  const uhd = { width: 3840, height: 2160, frameCount: 10 }
  assert.equal(plugin.__exportRefusal(uhd, 'mp4'), null)
  assert.equal(plugin.__exportRefusal(uhd, 'gif'), 'gif-pixels')
  assert.equal(plugin.__EXPORT_MAX_PIXELS, 3840 * 2160)
})

test('P2-2 GIF delays are quantized to centiseconds and documented', () => {
  const timing = plugin.__exportGifTiming(150, 30)
  assert.equal(timing.delayMs, 33)
  assert.equal(timing.delayCs, 3)
  assert.equal(timing.playbackSeconds, 4.5)
  const sixty = plugin.__exportGifTiming(300, 60)
  assert.equal(sixty.delayMs, 17)
  assert.equal(sixty.delayCs, 2)
  assert.equal(sixty.playbackSeconds, 6)
  const slow = plugin.__exportGifTiming(5, 1)
  assert.equal(slow.delayMs, 1000)
  assert.equal(slow.delayCs, 100)
  assert.equal(slow.playbackSeconds, 5)
})

test('P2-2 codec preflight is H.264 then VP9 then fallback', async () => {
  const seen = []
  const vp9 = await plugin.__selectMp4Codec(960, 540, 30, async config => {
    seen.push(config.codec)
    return { supported: config.codec === 'vp09.00.10.08' }
  })
  assert.deepEqual(seen, ['avc1.64002a', 'avc1.640028', 'avc1.42001f', 'vp09.00.10.08'])
  assert.equal(vp9.supported, true)
  assert.equal(vp9.encoderCodec, 'vp09.00.10.08')
  assert.equal(vp9.muxerCodec, 'vp9')
  assert.equal(vp9.encoderConfig.avc, undefined)
  assert.equal(vp9.encoderConfig.latencyMode, 'quality')
  assert.equal(vp9.encoderConfig.hardwareAcceleration, 'no-preference')
  assert.equal(vp9.encoderConfig.framerate, 30)
  assert.equal(vp9.encoderConfig.bitrate, plugin.__exportBitrate(960, 540, 30))

  const seenH264 = []
  const h264 = await plugin.__selectMp4Codec(960, 540, 30, async config => {
    seenH264.push(config.codec)
    return true
  })
  assert.deepEqual(seenH264, ['avc1.64002a'])
  assert.equal(h264.muxerCodec, 'avc')
  assert.deepEqual(h264.encoderConfig.avc, { format: 'avc' })
  assert.equal(h264.attempts.length, 1)

  const seenNone = []
  const none = await plugin.__selectMp4Codec(960, 540, 30, async config => {
    seenNone.push(config.codec)
    return false
  })
  assert.deepEqual(seenNone, ['avc1.64002a', 'avc1.640028', 'avc1.42001f', 'vp09.00.10.08'])
  assert.equal(none.supported, false)
  assert.equal(none.encoderCodec, null)

  // Rejections during preflight are treated as unsupported, never fatal.
  const rejected = await plugin.__selectMp4Codec(960, 540, 30, async () => {
    throw new Error('not supported')
  })
  assert.equal(rejected.supported, false)
  assert.deepEqual(plugin.__EXPORT_CODECS.map(entry => entry.muxerCodec),
    ['avc', 'avc', 'avc', 'avc', 'avc', 'avc', 'vp9'])

  // Above 1080p the preflight starts at High 5.2 and never probes Baseline.
  const seen4k = []
  const uhd = await plugin.__selectMp4Codec(3840, 2160, 30, async config => {
    seen4k.push(config.codec)
    return config.codec === 'avc1.640032'
  })
  assert.deepEqual(seen4k, ['avc1.640034', 'avc1.640033', 'avc1.640032'])
  assert.equal(uhd.encoderCodec, 'avc1.640032')
  assert.equal(uhd.encoderConfig.bitrate, plugin.__exportBitrate(3840, 2160, 30))
})

test('P2-2 bitrate bounds and filenames/MIME carry no Session or token', () => {
  assert.equal(plugin.__exportBitrate(1, 1, 1), 800_000)
  assert.equal(plugin.__exportBitrate(960, 540, 30), 1_866_240)
  assert.equal(plugin.__exportBitrate(3840, 2160, 60), 40_000_000)
  assert.equal(plugin.__EXPORT_MAX_BITRATE, 40_000_000)
  assert.equal(plugin.__exportMime('mp4'), 'video/mp4')
  assert.equal(plugin.__exportMime('gif'), 'image/gif')
  const mp4 = plugin.__exportFilename(42, 'mp4', 30)
  const gif = plugin.__exportFilename(42, 'gif', 30)
  assert.equal(mp4, 'three-scene-42-30fps.mp4')
  assert.equal(gif, 'three-scene-42-30fps.gif')
  for (const name of [mp4, gif]) {
    assert.doesNotMatch(name, /token|session|cookie|auth/i)
    assert.doesNotMatch(name, /[?#&=]/)
  }
  assert.equal(plugin.__exportFilename(-1, 'mp4', 30), 'three-scene-0-30fps.mp4')
  assert.equal(plugin.__exportFilename(7, 'gif', Number.NaN), 'three-scene-7-1fps.gif')
})

test('P2-2 runtime capture session: fixed time, row flip, restore and suppression', () => {
  // Frame evaluation is driven by the plan, not the live clock.
  assert.match(clientSource, /timeline\.time = time/)
  assert.match(clientSource, /lastDelta = index === 0 \? 0 : 1 \/ fps/)
  assert.match(clientSource, /const pixels = readCapturePixels\(session\)/)
  assert.match(clientSource, /gl\.readPixels\(0, 0, width, height, gl\.RGBA, gl\.UNSIGNED_BYTE, pixels\)/)
  assert.match(clientSource, /pixels\.copyWithin\(topOffset, bottomOffset, bottomOffset \+ rowBytes\)/)
  assert.match(clientSource, /sendTransfer\(\{[\s\S]{0,220}pixels: pixels\.buffer/)
  assert.match(clientSource, /\}, \[pixels\.buffer\]\)/)
  // Session remember/restore covers drawing buffer, CSS, aspect, time, rate.
  for (const pattern of [
    /canvasWidth: canvas\.width/,
    /canvasHeight: canvas\.height/,
    /cssWidth: canvas\.style\.width/,
    /pixelRatio: renderer\.getPixelRatio\(\)/,
    /aspect: camera\.aspect/,
    /time: timeline\.time/,
    /playing: timeline\.playing/,
    /restoreHelpers: hideHelpers\(\)/,
    /releaseHold: beginExportHold\(\)/,
    /renderer\.setPixelRatio\(1\)/,
    /renderer\.setSize\(session\.width, session\.height, false\)/,
    /camera\.aspect = session\.width \/ session\.height/,
  ]) assert.match(clientSource, pattern)
  // Timeline/stats chatter is suppressed while capture owns the canvas.
  assert.match(clientSource, /if \(captureSession === null\) \{[\s\S]{0,1600}sendTimeline\(\)/)
  assert.match(clientSource, /id: 'captureSession'|captureSession === null/)
  assert.match(clientSource, /if \(captureSession !== null\) return/)
  // End and cancel both ack exactly once and restore idempotently.
  assert.match(clientSource, /const finishCaptureSession = \(requestId, cancelled\) => \{[\s\S]{0,400}restoreCaptureSession\(\)[\s\S]{0,400}type: 'three-workbench:capture-session'/)
  assert.match(clientSource, /command: 'capture-end'/)
  assert.match(clientSource, /command: 'capture-cancel'/)
  assert.match(clientSource, /const restoreCaptureSession = \(\) => \{[\s\S]{0,200}captureSession = null/)
})

test('P2-2 parent orchestration validates frames, times out and re-checks pending edits', () => {
  assert.match(clientSource, /const expectedBytes = job\.plan\.width \* job\.plan\.height \* 4/)
  assert.match(clientSource, /data\.width === job\.plan\.width/)
  assert.match(clientSource, /data\.pixels instanceof ArrayBuffer/)
  assert.match(clientSource, /data\.pixels\.byteLength === expectedBytes/)
  assert.match(clientSource, /code: 'frame-shape'/)
  assert.match(clientSource, /EXPORT_FRAME_TIMEOUT_MS/)
  assert.match(clientSource, /exportFailure\('frame-timeout'/)
  assert.match(clientSource, /capture-cancel[\s\S]{0,160}awaitCaptureAck/)
  // Per-frame re-check of parameter/structural/key gestures and scene identity.
  assert.match(clientSource, /const exportContextProblem = job =>/)
  assert.match(clientSource, /if \(keyPendingRef\.current\) return t\('editor\.keys\.locked'\)/)
  assert.match(clientSource, /if \(paramsPendingRef\.current\) return t\('editor\.paramsPending'\)/)
  assert.match(clientSource, /if \(structuralBusyRef\.current\) return t\('editor\.structuralBusy'\)/)
  assert.match(clientSource, /current\.revision !== job\.revision/)
  assert.match(clientSource, /captureExportFrames = async \(job, onFrame\)/)
  // One export at a time and re-check before each frame.
  assert.match(clientSource, /if \(exportRef\.current !== null\) \{[\s\S]{0,120}t\('export\.busy'\)/)
  assert.match(clientSource, /for \(let index = 0; index < job\.plan\.frameCount; index \+= 1\)/)
})

test('P2-2 MP4/GIF pipelines follow the binding encoder contract', async () => {
  assert.match(clientSource, /await import\(`\$\{RUNTIME_BASE\}\/vendor\/mp4-muxer\.js`\)/)
  assert.match(clientSource, /await import\(`\$\{RUNTIME_BASE\}\/vendor\/gifenc\.js`\)/)
  assert.match(clientSource, /fastStart: 'in-memory'/)
  assert.match(clientSource, /addVideoChunk\(chunk, meta\)/)
  assert.match(clientSource, /await encoder\.flush\(\)/)
  assert.match(clientSource, /muxer\.finalize\(\)/)
  assert.match(clientSource, /new VideoFrame\(pixels, \{[\s\S]{0,260}format: 'RGBA'/)
  assert.match(clientSource, /timestamp: exportFrameTimestamp\(index, job\.plan\.fps\)/)
  assert.match(clientSource, /duration: job\.plan\.frameDurationUs/)
  assert.match(clientSource, /videoFrame\.close\(\)/)
  assert.match(clientSource, /keyFrame: index % Math\.max\(1, Math\.round\(job\.plan\.fps\)\) === 0/)
  assert.match(clientSource, /addEventListener\('dequeue'/)
  assert.match(clientSource, /EXPORT_QUEUE_LIMIT/)
  assert.match(clientSource, /const palette = quantize\(rgba, 256\)/)
  assert.match(clientSource, /const indexed = applyPalette\(rgba, palette\)/)
  assert.match(clientSource, /gif\.writeFrame\(indexed, job\.plan\.width, job\.plan\.height, \{[\s\S]{0,160}delay: timing\.delayMs/)
  assert.match(clientSource, /gif\.finish\(\)/)
  assert.match(clientSource, /const bytes = gif\.bytes\(\)/)
  // Cancellation closes/discards the encoder and never downloads partial bytes.
  assert.match(clientSource, /const abortExportJob = \(job, notice\) =>/)
  assert.match(clientSource, /closeExportEncoder\(job\)/)
})

test('P2-2 recorder and deterministic export cannot own the canvas together', () => {
  // Parent: export refuses while realtime WebM recording is active.
  assert.match(clientSource, /if \(recordingRef\.current\) \{[\s\S]{0,120}t\('export\.recordingBusy'\)/)
  // Parent: capture/record/mesh exports refuse while an export is active.
  assert.match(clientSource, /if \(exportRef\.current !== null && \['capture', 'record', 'export-gltf', 'export-stl', 'export-obj'\]\.includes\(name\)\)/)
  // Runtime: capture rejects during recording, recording command rejects during capture.
  assert.match(clientSource, /if \(recording\) \{[\s\S]{0,120}'recording-active'/)
  assert.match(clientSource, /data\.command === 'record' && captureSession !== null && !recording/)
})

test('P2-2 progress modal is parent DOM, accessible and localized', () => {
  assert.match(clientSource, /role: 'dialog'/)
  assert.match(clientSource, /'aria-modal': 'true'/)
  assert.match(clientSource, /'aria-labelledby': 'three-workbench-export-title'/)
  assert.match(clientSource, /role: 'progressbar'/)
  assert.match(clientSource, /'aria-valuemin': 0/)
  assert.match(clientSource, /'aria-valuemax': exportJob\.frameCount/)
  assert.match(clientSource, /'aria-valuenow': exportJob\.captured/)
  assert.match(clientSource, /ref: exportCancelButtonRef/)
  assert.match(clientSource, /autoFocus: true/)
  assert.match(clientSource, /event\.key !== 'Escape'/)
  assert.match(clientSource, /cancelExportRef\.current\('user'\)/)
  assert.match(clientSource, /const exportOverlay = exportJob === null \? null :/)
  // The modal is appended to the parent root next to the palette overlay.
  assert.match(clientSource, /paletteOverlay,\s*exportOverlay\)/)
})

test('P2-2 both locales define every export string and menu label', () => {
  const zhStart = clientSource.indexOf('const zh = {')
  const enStart = clientSource.indexOf('const en = {', zhStart)
  const enEnd = clientSource.indexOf('\n    }\n', enStart)
  assert.ok(zhStart > 0 && enStart > zhStart && enEnd > enStart)
  const zhBlock = clientSource.slice(zhStart, enStart)
  const enBlock = clientSource.slice(enStart, enEnd)
  const keys = [
    'action.exportMp4', 'action.exportGif', 'export.title', 'export.format.mp4',
    'export.format.gif', 'export.frame', 'export.cancel', 'export.busy',
    'export.recordingBusy', 'export.success', 'export.fallback', 'export.vp9',
    'export.hidden', 'export.timeout', 'export.encodeFailed', 'export.cap',
    'export.gifTiming', 'export.cancelled', 'export.notReady',
  ]
  for (const key of keys) {
    assert.ok(zhBlock.includes(`'${key}':`), `zh missing ${key}`)
    assert.ok(enBlock.includes(`'${key}':`), `en missing ${key}`)
  }
  // Placeholders used by t() exist in the translated templates.
  for (const placeholder of ['{format}', '{fps}', '{count}', '{index}', '{total}', '{frames}', '{seconds}', '{duration}', '{message}']) {
    assert.ok(zhBlock.includes(placeholder), `zh missing ${placeholder}`)
    assert.ok(enBlock.includes(placeholder), `en missing ${placeholder}`)
  }
})

test('P2-2 sandbox capabilities are unchanged and exports stay token-free', () => {
  assert.match(clientSource, /sandbox: 'allow-scripts allow-pointer-lock allow-downloads'/)
  assert.equal((clientSource.match(/allow-same-origin/g) || []).length, 0)
  assert.equal((clientSource.match(/sandbox: 'allow-scripts allow-pointer-lock allow-downloads'/g) || []).length, 1)
  assert.match(clientSource, /blob, `three-scene-\$\{String\(recordRef\.current === null \? 0 : recordRef\.current\.revision\)\}/)
  // The export identifiers never embed a Session or preview token.
  assert.match(clientSource, /requestId: `p22-\$\{String\(exportSeqRef\.current\)\}`/)
  assert.match(clientSource, /exportFilename\(job\.revision, format, job\.plan\.fps, job\.plan\.width, job\.plan\.height\)/)
  assert.match(clientSource, /startExport\('mp4', \{[\s\S]*?filmShots: shots[\s\S]*?srt: captionsToSrt\(captions\)/)
  assert.match(clientSource, /camera: Array\.isArray\(job\.filmShots\)/)
  assert.match(clientSource, /muxerOptions\.audio = \{ codec: 'opus'/)
})

test('P2-2 vendor files are pinned, licensed and free of network/eval execution', async () => {
  const mp4 = await readVendor('mp4-muxer.js')
  const gif = await readVendor('gifenc.js')
  const mp4License = await readVendor('MP4-MUXER-LICENSE.txt')
  const gifLicense = await readVendor('GIFENC-LICENSE.txt')
  const readme = await readVendor('README.md')
  assert.equal(sha256(mp4), 'd2c4c782f180c86ed30b1f5d9487a34a0d370bf9b4535285734ea187d38f9bb5')
  assert.equal(sha256(gif), 'cec614f6b77348eb6ea6a64921bab65e72d5e7f839a097c8fda8fc883c3146f7')
  assert.match(mp4License, /MIT/)
  assert.match(gifLicense, /MIT/)
  assert.match(readme, /mp4-muxer.*5\.2\.2/s)
  assert.match(readme, /gifenc.*1\.0\.3/s)
  assert.match(readme, /upstream-deprecated/i)
  assert.match(readme, /sourceMappingURL/)
  for (const [name, source] of [['mp4-muxer.js', mp4], ['gifenc.js', gif]]) {
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${name} must not fetch`)
    assert.doesNotMatch(source, /\bXMLHttpRequest\b/, `${name} must not use XHR`)
    assert.doesNotMatch(source, /\beval\s*\(/, `${name} must not eval`)
    assert.doesNotMatch(source, /\bnew\s+Function\b/, `${name} must not compile strings`)
    assert.doesNotMatch(source, /\bimport\s*\(/, `${name} must not dynamically import`)
    const urlLines = source.split('\n').map(line => line.trim()).filter(line => /https?:\/\//.test(line))
    for (const line of urlLines) {
      assert.ok(line.startsWith('//') || line.startsWith('*'), `${name} URL outside a comment: ${line}`)
    }
  }
  assert.match(mp4, /export \{[\s\S]*Muxer/)
  assert.match(mp4, /ArrayBufferTarget/)
  assert.match(gif, /export\{ct as GIFEncoder,nt as applyPalette/)
  assert.match(gif, /H as quantize/)
  // Vendor imports live in the parent half, never in the generated srcDoc.
  const runtimeStart = clientSource.indexOf('function previewDocument')
  const runtimeEnd = clientSource.indexOf('function PreviewPanel')
  assert.ok(runtimeStart > 0 && runtimeEnd > runtimeStart)
  const runtimeSource = clientSource.slice(runtimeStart, runtimeEnd)
  assert.doesNotMatch(runtimeSource, /vendor\/mp4-muxer|vendor\/gifenc/)
  // The parent imports the muxer once for the inline path and once inside the
  // 4K worker source; neither may leak into the generated srcDoc.
  assert.equal((clientSource.match(/\/vendor\/mp4-muxer\.js/g) || []).length, 2)
  assert.equal((clientSource.match(/\/vendor\/gifenc\.js/g) || []).length, 1)
})

test('P2-2 GIF/cap errors map to translated notices and no download', () => {
  assert.match(clientSource, /t\('export\.cap', \{[\s\S]{0,180}EXPORT_GIF_MAX_FRAMES/)
  assert.match(clientSource, /t\('export\.gifTiming', \{[\s\S]{0,180}playbackSeconds/)
  assert.match(clientSource, /code === 'frame-timeout'[\s\S]{0,180}t\('export\.timeout', \{ index: job\.expectedIndex \}\)/)
  assert.match(clientSource, /t\('export\.encodeFailed', \{/)
  assert.match(clientSource, /code === 'fallback'[\s\S]{0,700}setProtocolNotice\(t\('export\.fallback'\)\)/)
  assert.match(clientSource, /job\.film === true[\s\S]{0,120}studio\.film\.exportUnsupported/)
  assert.match(clientSource, /blob = format === 'gif' \? await encodeGifExport\(job\) : await encodeMp4Export\(job\)/)
})

test('4K export uses a longer frame timeout and a local encode worker', () => {
  assert.equal(plugin.__exportFrameTimeout(plugin.__exportPlan(5, 30, { width: 1920, height: 1080 })), 5000)
  assert.equal(plugin.__exportFrameTimeout(plugin.__exportPlan(5, 30, { width: 3840, height: 2160 })), 12000)
  assert.match(plugin.__EXPORT_WORKER_SOURCE, /new VideoEncoder/)
  assert.match(plugin.__EXPORT_WORKER_SOURCE, /new VideoFrame/)
  assert.match(plugin.__EXPORT_WORKER_SOURCE, /import\(data\.muxerUrl\)/)
  assert.match(plugin.__EXPORT_WORKER_SOURCE, /type: 'frame-done'/)
  assert.doesNotMatch(plugin.__EXPORT_WORKER_SOURCE, /fetch\(|XMLHttpRequest|WebSocket|sendBeacon/)
  assert.match(clientSource, /encodeMp4ExportInWorker/)
  assert.match(clientSource, /new Worker\(blobUrl, \{ type: 'module' \}\)/)
  assert.match(clientSource, /typeof Worker === 'function'/)
  assert.match(clientSource, /worker: null/)
})
