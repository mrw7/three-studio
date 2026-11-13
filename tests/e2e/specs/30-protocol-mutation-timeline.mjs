// P5-2 protocol: mutation positive/negative paths and timeline semantics,
// including the intentional duration-0 infinity bound and invalid inputs.
import assert from 'node:assert/strict'
import { inRange, sleep, waitFor } from '../lib/harness.mjs'

function approxArray(actual, expected, epsilon = 1e-6) {
  return Array.isArray(actual) && Array.isArray(expected)
    && actual.length === expected.length
    && expected.every((value, index) => inRange(actual[index], value, epsilon))
}

export default {
  name: 'protocol-mutation-timeline',
  async run(h) {
    await h.check('protocol/mutation-positive-and-errors', async () => {
      const w = await h.openWorkbench()
      const heroUid = await h.resolveUid(w.page, 'P5Hero')
      const otherUid = await h.resolveUid(w.page, 'P5Other')
      const throwUid = await h.resolveUid(w.page, 'P5Throw')

      let since = await h.messageCount(w.page)
      let requestId = h.nextId('mutate')
      await h.sendCommand(w.page, {
        command: 'mutate',
        requestId,
        ops: [{ kind: 'transform', uid: heroUid, position: [1, 0.5, 0] }],
      })
      const transformed = await h.waitMessageSince(w.page, since, { type: 'three-workbench:mutation', requestId }, 6000)
      assert.equal(transformed.ok, true, 'transform mutation succeeds')
      await waitFor(async () => {
        const read = await h.probeRead(w.page)
        return approxArray(read.hero.position, [1, 0.5, 0], 1e-4) ? read : null
      }, { timeout: 6000, interval: 60, label: 'transform reaches the live object' })

      since = await h.messageCount(w.page)
      requestId = h.nextId('visibility')
      await h.sendCommand(w.page, {
        command: 'mutate',
        requestId,
        ops: [{ kind: 'visibility', uid: otherUid, visible: false }],
      })
      await h.waitMessageSince(w.page, since, { type: 'three-workbench:mutation', requestId, ok: true }, 6000)
      await waitFor(async () => {
        const read = await h.probeRead(w.page)
        return read.other.visible === false ? read : null
      }, { timeout: 6000, interval: 60, label: 'visibility reaches the live object' })

      since = await h.messageCount(w.page)
      requestId = h.nextId('bad-kind')
      await h.sendCommand(w.page, {
        command: 'mutate',
        requestId,
        ops: [{ kind: 'bogus', uid: heroUid }],
      })
      const badKind = await h.waitMessageSince(w.page, since, { type: 'three-workbench:mutation', requestId }, 6000)
      assert.equal(badKind.ok, false, 'unknown op kind is rejected')
      assert.equal(badKind.error, 'invalid', 'unknown op kind reports invalid')

      since = await h.messageCount(w.page)
      requestId = h.nextId('stale')
      await h.sendCommand(w.page, {
        command: 'mutate',
        requestId,
        ops: [{ kind: 'transform', uid: 's:missing', position: [9, 9, 9] }],
      })
      const stale = await h.waitMessageSince(w.page, since, { type: 'three-workbench:mutation', requestId }, 6000)
      assert.equal(stale.error, 'stale-uid', 'stale mutation reports stale-uid')

      await h.sendCommand(w.page, { command: 'locks', uids: [heroUid] })
      since = await h.messageCount(w.page)
      requestId = h.nextId('locked')
      await h.sendCommand(w.page, {
        command: 'mutate',
        requestId,
        ops: [{ kind: 'transform', uid: heroUid, position: [3, 3, 3] }],
      })
      const locked = await h.waitMessageSince(w.page, since, { type: 'three-workbench:mutation', requestId }, 6000)
      assert.equal(locked.ok, false, 'locked mutation is rejected')
      assert.equal(locked.error, 'locked', 'locked mutation reports locked')
      assert.ok(approxArray((await h.probeRead(w.page)).hero.position, [1, 0.5, 0], 1e-4), 'locked mutation does not move the object')
      await h.sendCommand(w.page, { command: 'locks', uids: [] })

      // Injected apply failure: the fixture position refuses x=13. The runtime
      // must report apply-failed and leave the previous pose intact.
      since = await h.messageCount(w.page)
      requestId = h.nextId('apply-fail')
      await h.sendCommand(w.page, {
        command: 'mutate',
        requestId,
        ops: [{ kind: 'transform', uid: throwUid, position: [13, 0, 0] }],
      })
      const applyFailed = await h.waitMessageSince(w.page, since, { type: 'three-workbench:mutation', requestId }, 6000)
      assert.equal(applyFailed.ok, false, 'injected apply failure is rejected')
      assert.equal(applyFailed.error, 'apply-failed', 'injected apply failure reports apply-failed')
      await waitFor(async () => {
        const read = await h.probeRead(w.page)
        return read.injectedFailures >= 1 ? read : null
      }, { timeout: 4000, interval: 60, label: 'injected apply failure ran' })
      assert.ok(approxArray((await h.probeRead(w.page)).throwing.position, [4, 0, 0], 1e-4), 'failed apply leaves the pose unchanged')
      await w.close()
    })

    await h.check('protocol/gizmo-cancelled-commit', async () => {
      const w = await h.openWorkbench()
      await h.openEditor(w.page)
      const heroUid = await h.selectObject(w.page, 'P5Hero')
      await h.ensureMoveMode(w.page)
      const before = await h.probeRead(w.page)
      const undo = w.page.locator('button[aria-label="Undo"]').first()
      assert.equal(await undo.isDisabled(), true, 'undo starts empty')
      const cancelled = await h.cancelGizmoViaBlur(w.page)
      assert.equal(cancelled.commit.cancelled, true, 'blur emits a cancelled gizmo commit')
      assert.equal(cancelled.commit.uid, heroUid, 'cancelled commit names the dragged object')
      const slice = (await h.messages(w.page)).slice(cancelled.since)
      assert.ok(slice.some(message => message.type === 'three-workbench:transform-live' && message.uid === heroUid),
        'drag emitted transform-live while the pointer moved')
      assert.ok(!slice.some(message => message.type === 'three-workbench:gizmo-commit' && message.cancelled !== true),
        'cancellation emits no committed pose')
      assert.ok(!slice.some(message => message.type === 'three-workbench:mutation' && message.command === 'tracks'),
        'cancellation creates no keyframe track')
      await sleep(250)
      assert.equal(await undo.isDisabled(), true, 'cancellation records no undo entry')
      assert.ok(approxArray((await h.probeRead(w.page)).hero.position, before.hero.position, 1e-4),
        'cancellation restores the pre-drag pose')
      await w.page.mouse.up().catch(() => {})
      await w.close()
    })

    await h.check('protocol/timeline-bounds-and-invalid-input', async () => {
      const w = await h.openWorkbench()
      let clock = await h.timeline(w.page, { action: 'set-duration', duration: 0.1 })
      assert.equal(clock.duration, 0.1, 'duration is set')
      clock = await h.timeline(w.page, { action: 'seek', time: 0 })
      assert.equal(clock.time, 0, 'seek reaches zero')
      assert.equal(clock.playing, false, 'seek pauses playback')

      const steps = []
      for (let index = 0; index < 4; index += 1) {
        clock = await h.timeline(w.page, { action: 'step', direction: 1, fps: 30 })
        steps.push(clock.time)
      }
      assert.ok(inRange(steps[0], 1 / 30), 'forward step advances one frame')
      assert.ok(inRange(steps[1], 2 / 30), 'forward step advances again')
      assert.ok(inRange(steps[2], 0.1), 'forward step reaches duration')
      assert.ok(inRange(steps[3], 0.1), 'forward step clamps at duration')
      for (let index = 0; index < 4; index += 1) {
        clock = await h.timeline(w.page, { action: 'step', direction: -1, fps: 30 })
        steps.push(clock.time)
      }
      assert.ok(inRange(steps[4], 2 / 30), 'back step moves one frame below duration')
      assert.ok(inRange(steps[5], 1 / 30), 'back step moves again')
      assert.ok(inRange(steps[6], 0), 'back step reaches zero')
      assert.ok(inRange(steps[7], 0), 'back step clamps at zero')

      clock = await h.timeline(w.page, { action: 'seek', time: 5 })
      assert.ok(inRange(clock.time, 0.1), 'seek above duration clamps')
      clock = await h.timeline(w.page, { action: 'seek', time: -3 })
      assert.ok(inRange(clock.time, 0), 'seek below zero clamps')

      // Duration 0 intentionally keeps stepping on an Infinity upper bound.
      clock = await h.timeline(w.page, { action: 'set-duration', duration: 0 })
      assert.equal(clock.duration, 0, 'duration can be zero')
      clock = await h.timeline(w.page, { action: 'seek', time: 0 })
      clock = await h.timeline(w.page, { action: 'step', direction: 1, fps: 30 })
      assert.ok(inRange(clock.time, 1 / 30), 'duration 0 does not clamp forward stepping (Infinity bound)')
      clock = await h.timeline(w.page, { action: 'step', direction: -1, fps: 30 })
      assert.ok(inRange(clock.time, 0), 'duration 0 steps back to zero')
      clock = await h.timeline(w.page, { action: 'step', direction: -1, fps: 30 })
      assert.ok(inRange(clock.time, 0), 'duration 0 back step clamps at zero')

      clock = await h.timeline(w.page, { action: 'set-duration', duration: 1 })
      const beforeInvalid = clock.time
      clock = await h.timeline(w.page, { action: 'step', direction: 1, fps: 0 })
      assert.ok(inRange(clock.time, beforeInvalid), 'fps 0 is ignored')
      clock = await h.timeline(w.page, { action: 'step', direction: 1, fps: -5 })
      assert.ok(inRange(clock.time, beforeInvalid), 'negative fps is ignored')
      clock = await h.timeline(w.page, { action: 'step', direction: 7, fps: 30 })
      assert.ok(inRange(clock.time, beforeInvalid + 1 / 30), 'any direction other than -1 steps forward')
      clock = await h.timeline(w.page, { action: 'seek', time: Number.NaN })
      assert.ok(inRange(clock.time, beforeInvalid + 1 / 30), 'non-finite seek is ignored')

      clock = await h.timeline(w.page, { action: 'set-speed', speed: 0.01 })
      assert.equal(clock.speed, 0.1, 'speed clamps to 0.1')
      clock = await h.timeline(w.page, { action: 'set-speed', speed: 99 })
      assert.equal(clock.speed, 4, 'speed clamps to 4')
      clock = await h.timeline(w.page, { action: 'set-speed', speed: Number.NaN })
      assert.equal(clock.speed, 4, 'non-finite speed is ignored')
      clock = await h.timeline(w.page, { action: 'set-loop', loop: false })
      assert.equal(clock.loop, false, 'loop can be disabled')
      clock = await h.timeline(w.page, { action: 'set-loop', loop: true })
      assert.equal(clock.loop, true, 'loop can be enabled')
      clock = await h.timeline(w.page, { action: 'set-duration', duration: 1e9 })
      assert.equal(clock.duration, 86400, 'duration clamps to 86400')
      clock = await h.timeline(w.page, { action: 'set-duration', duration: -10 })
      assert.equal(clock.duration, 0, 'negative duration clamps to zero')
      await w.close()
    })
  },
}
