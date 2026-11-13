// P5-2 protocol: pick shape, stats shape/HUD, capture session guards and
// lifecycle, the recording guard, and expose/params schema + update errors.
import assert from 'node:assert/strict'
import { inRange, skipCheck, waitFor } from '../lib/harness.mjs'

const FRAME = { fps: 30, width: 64, height: 36 }

async function captureFrame(h, page, requestId, index, extra = {}) {
  const since = await h.messageCount(page)
  await h.sendCommand(page, Object.assign({
    command: 'capture-frame',
    requestId,
    index,
    time: index / FRAME.fps,
    fps: FRAME.fps,
    width: FRAME.width,
    height: FRAME.height,
  }, extra))
  return since
}

function frameWait(h, page, since, requestId, index) {
  return h.waitMessageSince(page, since, { type: 'three-workbench:frame', requestId, index }, 10000)
}

function frameErrorWait(h, page, since, requestId) {
  return h.waitMessageSince(page, since, { type: 'three-workbench:frame-error', requestId }, 10000)
}

async function paramsCommand(h, page, requestId, payload) {
  const since = await h.messageCount(page)
  await h.sendCommand(page, Object.assign({ command: 'params', requestId }, payload))
  return h.waitMessageSince(page, since, { type: 'three-workbench:mutation', requestId }, 6000)
}

export default {
  name: 'protocol-pick-capture-stats-params',
  async run(h) {
    await h.check('protocol/pick-shape-and-negative', async () => {
      const w = await h.openWorkbench()
      const heroUid = await h.resolveUid(w.page, 'P5Hero')
      await h.sendCommand(w.page, { command: 'pick', enabled: true })
      const since = await h.clickWorld(w.page, 'P5Hero')
      const pick = await h.waitMessageSince(w.page, since, { type: 'three-workbench:pick' }, 8000)
      assert.equal(pick.uid, heroUid, 'pick names the hit object uid')
      assert.deepEqual(pick.uids, [heroUid], 'pick carries the normalized selection')
      assert.equal(pick.primary, heroUid, 'pick carries the primary uid')
      assert.equal(pick.object.name, 'P5Hero', 'pick object carries the name')
      assert.equal(pick.object.type, 'Mesh', 'pick object carries the type')
      assert.ok(Array.isArray(pick.object.position) && pick.object.position.length === 3, 'pick object carries a world position')
      assert.ok(pick.object.position.every(value => typeof value === 'number' && Number.isFinite(value)), 'pick position is finite')
      assert.ok(pick.object.material && typeof pick.object.material === 'object', 'pick object carries material metadata')
      assert.match(String(pick.object.material.color), /^#[0-9a-f]{6}$/i, 'pick material carries a hex color')

      await h.sendCommand(w.page, { command: 'pick', enabled: false })
      const quiet = await h.messageCount(w.page)
      // Bottom-centre clear space: Studio's top-right transform cluster and
      // bottom-left stats HUD are interactive chrome that would swallow the
      // click before it reaches the canvas.
      await h.clickCanvas(w.page, 0.5, 0.92)
      await waitFor(async () => (await h.messageCount(w.page)) > quiet, {
        timeout: 2500,
        interval: 50,
        label: 'a non-pick message after the empty-space click',
      }).catch(() => null)
      const after = (await h.messages(w.page)).slice(quiet)
      assert.ok(!after.some(message => message.type === 'three-workbench:pick'), 'empty space emits no pick when pick mode is off')
      await w.close()
    })

    await h.check('protocol/stats-shape-and-parent-hud', async () => {
      const w = await h.openWorkbench()
      const stats = await h.waitMessageSince(w.page, 0, { type: 'three-workbench:stats' }, 15000)
      assert.ok(Number.isInteger(stats.objects) && stats.objects >= 1, 'stats.objects is a positive integer')
      assert.ok(Number.isInteger(stats.triangles) && stats.triangles >= 1, 'stats.triangles is a positive integer')
      assert.ok(typeof stats.calls === 'number' && stats.calls >= 1, 'stats.calls is a positive number')
      assert.ok(typeof stats.fps === 'number' && stats.fps >= 0, 'stats.fps is a non-negative number')

      // Silence the runtime's 2 Hz stats reports with an active deterministic
      // capture session, then forge one stats message from the runtime frame.
      const requestId = h.nextId('stats-hold')
      const since = await captureFrame(h, w.page, requestId, 0)
      await frameWait(h, w.page, since, requestId, 0)
      await h.postFromFrame(w.page, {
        type: 'three-workbench:stats',
        objects: 123,
        triangles: 456,
        fps: 78.9,
        calls: 9,
      })
      const hud = w.page.locator('button[aria-label="Scene stats"]').first()
      await waitFor(async () => {
        if ((await hud.count()) === 0) return false
        const text = (await hud.textContent()) || ''
        return text.includes('Objects 123') && text.includes('Triangles 456')
          && text.includes('FPS 78.9') && text.includes('Calls 9')
      }, { timeout: 5000, interval: 40, label: 'parent HUD accepts a runtime-shaped stats message' })
      const endSince = await h.messageCount(w.page)
      await h.sendCommand(w.page, { command: 'capture-end', requestId })
      await h.waitMessageSince(w.page, endSince, { type: 'three-workbench:capture-session', requestId, ended: true }, 6000)
      await w.close()
    })

    await h.check('protocol/capture-errors-and-lifecycle', async () => {
      const w = await h.openWorkbench()

      let since = await h.messageCount(w.page)
      await h.sendCommand(w.page, { command: 'capture-frame', index: 0, time: 0, fps: 30, width: 64, height: 36 })
      let error = await frameErrorWait(h, w.page, since, '')
      assert.equal(error.message, 'invalid-request', 'missing requestId is rejected')

      const badId = h.nextId('capture-bad')
      since = await captureFrame(h, w.page, badId, 0, { width: 0 })
      error = await frameErrorWait(h, w.page, since, badId)
      assert.equal(error.message, 'invalid-frame', 'zero width is rejected')

      since = await captureFrame(h, w.page, badId, 0, { fps: 61 })
      error = await frameErrorWait(h, w.page, since, badId)
      assert.equal(error.message, 'invalid-frame', 'fps above 60 is rejected')

      since = await captureFrame(h, w.page, badId, 0, { width: 2000, height: 2000 })
      error = await frameErrorWait(h, w.page, since, badId)
      assert.equal(error.message, 'invalid-frame', 'over-limit frames are rejected')

      const firstId = h.nextId('capture-a')
      since = await captureFrame(h, w.page, firstId, 0)
      const first = await frameWait(h, w.page, since, firstId, 0)
      assert.equal(first.width, FRAME.width, 'first frame echoes its width')
      assert.equal(first.height, FRAME.height, 'first frame echoes its height')
      assert.equal(first.pixelsBytes, FRAME.width * FRAME.height * 4, 'frame pixels are RGBA bytes')

      since = await captureFrame(h, w.page, firstId, 2)
      error = await frameErrorWait(h, w.page, since, firstId)
      assert.equal(error.message, 'unexpected-index', 'skipping an index is rejected')

      since = await captureFrame(h, w.page, firstId, 1, { width: 32 })
      error = await frameErrorWait(h, w.page, since, firstId)
      assert.equal(error.message, 'dimension-mismatch', 'mid-session resize is rejected')

      const secondId = h.nextId('capture-b')
      since = await captureFrame(h, w.page, secondId, 0)
      error = await frameErrorWait(h, w.page, since, secondId)
      assert.equal(error.message, 'capture-busy', 'a second request id is rejected while a session is active')

      since = await captureFrame(h, w.page, firstId, 1)
      await frameWait(h, w.page, since, firstId, 1)

      since = await h.messageCount(w.page)
      await h.sendCommand(w.page, { command: 'capture-end', requestId: firstId })
      let ack = await h.waitMessageSince(w.page, since, { type: 'three-workbench:capture-session', requestId: firstId }, 6000)
      assert.equal(ack.ended, true, 'capture-end acknowledges')
      assert.equal(ack.cancelled, false, 'capture-end is not cancelled')
      since = await h.messageCount(w.page)
      await h.sendCommand(w.page, { command: 'capture-end', requestId: firstId })
      ack = await h.waitMessageSince(w.page, since, { type: 'three-workbench:capture-session', requestId: firstId }, 6000)
      assert.equal(ack.ended, true, 'repeated capture-end stays idempotent')

      const cancelId = h.nextId('capture-cancel')
      since = await captureFrame(h, w.page, cancelId, 0)
      await frameWait(h, w.page, since, cancelId, 0)
      since = await h.messageCount(w.page)
      await h.sendCommand(w.page, { command: 'capture-cancel', requestId: cancelId })
      ack = await h.waitMessageSince(w.page, since, { type: 'three-workbench:capture-session', requestId: cancelId }, 6000)
      assert.equal(ack.cancelled, true, 'capture-cancel reports cancellation')

      const afterId = h.nextId('capture-after')
      since = await captureFrame(h, w.page, afterId, 0)
      await frameWait(h, w.page, since, afterId, 0)
      since = await h.messageCount(w.page)
      await h.sendCommand(w.page, { command: 'capture-cancel', requestId: afterId })
      await h.waitMessageSince(w.page, since, { type: 'three-workbench:capture-session', requestId: afterId, ended: true }, 6000)
      await w.close()
    })

    await h.check('protocol/capture-recording-guard', async () => {
      const w = await h.openWorkbench()
      const since = await h.messageCount(w.page)
      await h.sendCommand(w.page, { command: 'record', durationMs: 1400 })
      const outcome = await waitFor(async () => {
        const slice = (await h.messages(w.page)).slice(since)
        return slice.find(message => message.type === 'three-workbench:recording'
          || message.type === 'three-workbench:error') || null
      }, { timeout: 12000, interval: 80, label: 'recording start or error' })
      if (outcome.type === 'three-workbench:error') {
        skipCheck('MediaRecorder/captureStream is unavailable in this browser context; the recording-active guard cannot be exercised')
      }
      assert.equal(outcome.started, true, 'recording starts')
      const captureId = h.nextId('capture-while-recording')
      const captureSince = await captureFrame(h, w.page, captureId, 0)
      const error = await frameErrorWait(h, w.page, captureSince, captureId)
      assert.equal(error.message, 'recording-active', 'capture-frame is refused while recording')
      await h.waitMessageSince(w.page, since, { type: 'three-workbench:webm' }, 12000)
      const afterSince = await captureFrame(h, w.page, h.nextId('capture-after-record'), 0)
      const frame = await h.waitMessageSince(w.page, afterSince, { type: 'three-workbench:frame' }, 10000)
      assert.equal(frame.index, 0, 'capture works again after recording stops')
      const endId = frame.requestId
      const endSince = await h.messageCount(w.page)
      await h.sendCommand(w.page, { command: 'capture-end', requestId: endId })
      await h.waitMessageSince(w.page, endSince, { type: 'three-workbench:capture-session', requestId: endId, ended: true }, 6000)
      await w.close()
    })

    await h.check('protocol/params-schema-set-reset-errors', async () => {
      const w = await h.openWorkbench()
      const schemaId = h.nextId('params-schema')
      let since = await h.messageCount(w.page)
      await h.sendCommand(w.page, { command: 'params', action: 'schema', requestId: schemaId })
      let schema = await h.waitMessageSince(w.page, since, { type: 'three-workbench:params', action: 'schema', requestId: schemaId }, 6000)
      assert.equal(schema.ok, true, 'schema request succeeds')
      assert.equal(schema.declared, true, 'fixture declares parameters')
      assert.ok(Array.isArray(schema.schema), 'schema is an ordered descriptor array')
      const descriptor = key => schema.schema.find(entry => entry.key === key) || null
      const speed = descriptor('speed')
      const fail = descriptor('fail')
      assert.ok(speed !== null, 'speed descriptor is present')
      assert.ok(fail !== null, 'fail descriptor is present')
      assert.equal(speed.type, 'number', 'speed is a number')
      assert.equal(speed.default, 1, 'speed default is 1')
      assert.equal(speed.min, 0, 'speed min is 0')
      assert.equal(speed.max, 5, 'speed max is 5')
      assert.equal(speed.step, 0.1, 'speed step is 0.1')
      assert.equal(fail.type, 'boolean', 'fail is a boolean')
      assert.equal(schema.values.speed, 1, 'initial speed is the default')
      assert.equal(schema.values.fail, false, 'initial fail is false')

      const setId = h.nextId('params-set')
      let ack = await paramsCommand(h, w.page, setId, { action: 'set', values: { speed: 2.5 } })
      assert.equal(ack.ok, true, 'set succeeds')
      assert.equal(ack.values.speed, 2.5, 'set echoes the committed value')
      await waitFor(async () => (await h.probeRead(w.page)).params.speed === 2.5, {
        timeout: 4000,
        interval: 50,
        label: 'set reaches the live scene',
      })

      ack = await paramsCommand(h, w.page, h.nextId('params-clamp'), { action: 'set', values: { speed: 9 } })
      assert.equal(ack.ok, true, 'out-of-range set succeeds')
      assert.equal(ack.values.speed, 5, 'number set clamps to max')

      ack = await paramsCommand(h, w.page, h.nextId('params-type'), { action: 'set', values: { speed: 'fast' } })
      assert.equal(ack.ok, false, 'wrong value type is rejected')
      assert.equal(ack.error, 'invalid-value', 'wrong value type reports invalid-value')
      assert.equal(ack.key, 'speed', 'wrong value type names the key')

      ack = await paramsCommand(h, w.page, h.nextId('params-unknown'), { action: 'set', values: { bogus: 1 } })
      assert.equal(ack.error, 'unknown-key', 'unknown key is rejected')
      assert.equal(ack.key, 'bogus', 'unknown key is named')

      ack = await paramsCommand(h, w.page, h.nextId('params-array'), { action: 'set', values: [] })
      assert.equal(ack.error, 'invalid-value', 'array payload is rejected')

      ack = await paramsCommand(h, w.page, h.nextId('params-nan'), { action: 'set', values: { speed: Number.NaN } })
      assert.equal(ack.error, 'invalid-value', 'non-finite number is rejected')

      ack = await paramsCommand(h, w.page, h.nextId('params-fail'), { action: 'set', values: { fail: true } })
      assert.equal(ack.ok, false, 'throwing apply is acknowledged as a failure')
      assert.equal(ack.error, 'apply-failed', 'throwing apply reports apply-failed')
      assert.ok(String(ack.message).includes('P5 injected parameter failure'), 'apply failure carries the message')
      assert.equal((await h.probeRead(w.page)).params.speed, 5, 'failed apply leaves the previous value')

      ack = await paramsCommand(h, w.page, h.nextId('params-reset-one'), { action: 'reset', keys: ['speed'] })
      assert.equal(ack.ok, true, 'single reset succeeds')
      assert.equal(ack.values.speed, 1, 'reset restores the descriptor default')
      await waitFor(async () => (await h.probeRead(w.page)).params.speed === 1, {
        timeout: 4000,
        interval: 50,
        label: 'reset reaches the live scene',
      })

      await paramsCommand(h, w.page, h.nextId('params-set-again'), { action: 'set', values: { speed: 3, fail: false } })
      ack = await paramsCommand(h, w.page, h.nextId('params-reset-all'), { action: 'reset' })
      assert.equal(ack.values.speed, 1, 'reset all restores speed')
      assert.equal(ack.values.fail, false, 'reset all restores fail')

      ack = await paramsCommand(h, w.page, h.nextId('params-action'), { action: 'bogus' })
      assert.equal(ack.error, 'invalid', 'unknown action is rejected')

      const liveId = h.nextId('params-live')
      since = await h.messageCount(w.page)
      await h.sendCommand(w.page, { command: 'params', action: 'set', values: { speed: 4 }, live: true, requestId: liveId })
      await waitFor(async () => (await h.probeRead(w.page)).params.speed === 4, {
        timeout: 4000,
        interval: 50,
        label: 'live set reaches the scene without an ack',
      })
      await new Promise(resolve => setTimeout(resolve, 350))
      assert.ok(!(await h.messages(w.page)).slice(since).some(message => message.type === 'three-workbench:mutation'
        && message.requestId === liveId), 'successful live set is fire-and-forget')

      const liveFailId = h.nextId('params-live-fail')
      ack = await paramsCommand(h, w.page, liveFailId, { action: 'set', values: { fail: true }, live: true })
      assert.equal(ack.error, 'apply-failed', 'failed live set still acknowledges')

      const afterId = h.nextId('params-after')
      since = await h.messageCount(w.page)
      await h.sendCommand(w.page, { command: 'params', action: 'schema', requestId: afterId })
      schema = await h.waitMessageSince(w.page, since, { type: 'three-workbench:params', action: 'schema', requestId: afterId }, 6000)
      assert.equal(schema.values.speed, 4, 'failed live apply did not roll back the previous committed value')
      assert.equal(schema.values.fail, false, 'failed live apply did not commit fail')
      await w.close()
    })

    await h.check('protocol/params-ui-error-banner', async () => {
      const w = await h.openWorkbench()
      await h.openEditor(w.page)
      await h.openTab(w.page, 'Parameters')
      const fail = w.page.locator('input[type="checkbox"][aria-label="Fail apply"]').first()
      await fail.waitFor({ state: 'visible', timeout: 8000 })
      assert.equal(await fail.isChecked(), false, 'fail starts unchecked')
      const banner = w.page.getByText(/Could not apply parameter/)
      await fail.click()
      await waitFor(async () => (await banner.count()) > 0, {
        timeout: 8000,
        interval: 60,
        label: 'parameter apply error banner',
      })
      const text = await banner.first().textContent()
      assert.ok(String(text).includes('P5 injected parameter failure'), 'banner carries the apply error')
      assert.equal(await fail.isChecked(), false, 'failed apply leaves the control at the committed value')
      assert.equal((await h.probeRead(w.page)).params.speed, 1, 'failed UI apply leaves the scene unchanged')

      const speed = w.page.locator('input[type="range"][aria-label="Speed"]').first()
      assert.equal(await speed.count(), 1, 'speed slider exists')
      await speed.focus()
      await speed.press('ArrowRight')
      await waitFor(async () => inRange((await h.probeRead(w.page)).params.speed, 1.1, 0.051), {
        timeout: 5000,
        interval: 60,
        label: 'slider commit after the failure',
      })
      await waitFor(async () => (await banner.count()) === 0, {
        timeout: 5000,
        interval: 60,
        label: 'banner clears after a successful commit',
      })
      await w.close()
    })
  },
}
