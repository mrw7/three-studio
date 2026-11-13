// P5-1 browser E2E: editor commands, gizmo, reset/focus, timeline step, FOV,
// multi-select and keyframe smoke. Every check uses a fresh Playwright context
// and the synthetic fixture routes, so no Host scene/store is touched.
import assert from 'node:assert/strict'
import { inRange, sleep, waitFor } from '../lib/harness.mjs'

const INITIAL_CAMERA = {
  position: [3.2, 3.2, 6.2],
  target: [0.8, 0.2, 0],
}

function approximately(actual, expected, epsilon = 1e-4) {
  return Array.isArray(actual) && Array.isArray(expected)
    && actual.length === expected.length
    && expected.every((value, index) => inRange(actual[index], value, epsilon))
}

async function newEditor(h) {
  const workbench = await h.openWorkbench()
  await h.openEditor(workbench.page)
  return workbench
}

export default {
  name: 'editor-ui',
  async run(h) {
    await h.check('e2e/palette-open-and-run', async () => {
      const w = await newEditor(h)
      const input = await h.openPalette(w.page)
      const items = await h.paletteItems(w.page)
      assert.ok(items.includes('Focus selection (F)'), 'palette lists Focus selection (F)')
      assert.ok(items.includes('Reset view'), 'palette lists Reset view')
      assert.ok(items.includes('Move (W)'), 'palette lists Move (W)')
      await input.fill('Reset view')
      await sleep(200)
      const filtered = await h.paletteItems(w.page)
      assert.ok(filtered.includes('Reset view'), 'query keeps Reset view')
      assert.ok(!filtered.includes('Focus selection (F)'), 'query filters unrelated commands')
      await w.page.keyboard.press('Escape')
      await waitFor(async () => !(await input.isVisible().catch(() => false)), {
        timeout: 4000,
        interval: 80,
        label: 'palette close on Escape',
      })
      await w.close()
    })

    await h.check('e2e/gizmo-drag-undo-redo', async () => {
      const w = await newEditor(h)
      const heroUid = await h.selectObject(w.page, 'P5Hero')
      await h.ensureMoveMode(w.page)
      const before = await h.probeRead(w.page)
      const drag = await h.dragGizmo(w.page, { dx: 72 })
      assert.equal(drag.commit.uid, heroUid, 'commit belongs to the selected hero')
      assert.ok(Array.isArray(drag.commit.position), 'commit carries the exact pose')
      const after = await h.probeRead(w.page)
      assert.notDeepEqual(after.hero.position, before.hero.position, 'gizmo drag moved the object')
      assert.ok(approximately(drag.commit.position, after.hero.position, 1e-3), 'commit pose matches the live pose')
      const moved = after.hero.position.slice()
      await h.clickUndo(w.page)
      await waitFor(async () => {
        const read = await h.probeRead(w.page)
        return approximately(read.hero.position, before.hero.position) ? read : null
      }, { timeout: 8000, interval: 100, label: 'undo restores the pre-drag pose' })
      await h.clickRedo(w.page)
      await waitFor(async () => {
        const read = await h.probeRead(w.page)
        return approximately(read.hero.position, moved) ? read : null
      }, { timeout: 8000, interval: 100, label: 'redo restores the moved pose' })
      await w.close()
    })

    await h.check('e2e/base-reset-all', async () => {
      const w = await newEditor(h)
      await h.selectObject(w.page, 'P5Hero')
      await h.ensureMoveMode(w.page)
      const before = await h.probeRead(w.page)
      await h.dragGizmo(w.page, { dx: 66 })
      const moved = await h.probeRead(w.page)
      assert.notDeepEqual(moved.hero.position, before.hero.position, 'drag produced an override')
      await h.clickResetAll(w.page)
      await waitFor(async () => {
        const read = await h.probeRead(w.page)
        return read && read.frames > 0 && approximately(read.hero.position, [0, 0, 0]) ? read : null
      }, { timeout: 20000, interval: 150, label: 'reset restores the script pose' })
      const undo = w.page.locator('button[aria-label="Undo"]').first()
      assert.equal(await undo.isDisabled(), true, 'reset clears undo history')
      await w.close()
    })

    await h.check('e2e/focus-selection', async () => {
      const w = await newEditor(h)
      await h.selectObject(w.page, 'P5Other')
      const initial = await h.probeRead(w.page)
      const initialDistance = Math.hypot(
        initial.camera.position[0] - initial.camera.target[0],
        initial.camera.position[1] - initial.camera.target[1],
        initial.camera.position[2] - initial.camera.target[2],
      )
      await h.runPalette(w.page, 'Focus selection')
      const focused = await waitFor(async () => {
        const read = await h.probeRead(w.page)
        const distance = Math.hypot(
          read.camera.position[0] - read.camera.target[0],
          read.camera.position[1] - read.camera.target[1],
          read.camera.position[2] - read.camera.target[2],
        )
        return distance < initialDistance - 0.5 ? read : null
      }, { timeout: 10000, interval: 100, label: 'focus shortens the camera distance' })
      assert.ok(approximately(focused.camera.target, [2, 0.25, 0], 0.05), 'focus targets P5Other')
      await h.runPalette(w.page, 'Reset view')
      await waitFor(async () => {
        const read = await h.probeRead(w.page)
        return approximately(read.camera.position, INITIAL_CAMERA.position, 0.05) ? read : null
      }, { timeout: 10000, interval: 100, label: 'Reset view restores the script camera' })
      await w.close()
    })

    await h.check('e2e/frame-step-bounds', async () => {
      const w = await newEditor(h)
      await h.timeline(w.page, { action: 'set-duration', duration: 0.1 })
      await h.timeline(w.page, { action: 'seek', time: 0 })
      const fpsInput = w.page.locator('input[aria-label="FPS"]').first()
      await fpsInput.fill('30')
      await fpsInput.press('Enter')
      const forward = w.page.locator('button[aria-label="Step forward one frame"]').first()
      const backward = w.page.locator('button[aria-label="Step back one frame"]').first()
      assert.equal(await forward.count(), 1, 'step forward button exists')
      assert.equal(await backward.count(), 1, 'step back button exists')
      const times = []
      for (let index = 0; index < 4; index += 1) {
        const expected = [1 / 30, 2 / 30, 0.1, 0.1][index]
        const since = await h.messageCount(w.page)
        await forward.click()
        const message = await waitFor(async () => {
          const reports = (await h.messages(w.page)).slice(since)
            .filter(entry => entry.type === 'three-workbench:timeline' && entry.playing === false)
          return reports.find(entry => inRange(entry.time, expected)) || null
        }, { timeout: 5000, interval: 40, label: 'forward step to ' + expected })
        times.push(message.time)
      }
      assert.ok(inRange(times[0], 1 / 30), 'first forward step is one frame')
      assert.ok(inRange(times[1], 2 / 30), 'second forward step is two frames')
      assert.ok(inRange(times[2], 0.1), 'third forward step reaches the duration')
      assert.ok(inRange(times[3], 0.1), 'forward step clamps at the duration')
      for (let index = 0; index < 4; index += 1) {
        const expected = [2 / 30, 1 / 30, 0, 0][index]
        const since = await h.messageCount(w.page)
        await backward.click()
        const message = await waitFor(async () => {
          const reports = (await h.messages(w.page)).slice(since)
            .filter(entry => entry.type === 'three-workbench:timeline' && entry.playing === false)
          return reports.find(entry => inRange(entry.time, expected)) || null
        }, { timeout: 5000, interval: 40, label: 'back step to ' + expected })
        times.push(message.time)
      }
      assert.ok(inRange(times[4], 2 / 30), 'first back step is one frame below the end')
      assert.ok(inRange(times[5], 1 / 30), 'second back step is two frames below the end')
      assert.ok(inRange(times[6], 0), 'back step reaches zero')
      assert.ok(inRange(times[7], 0), 'back step clamps at zero')
      await w.close()
    })

    await h.check('e2e/fov', async () => {
      const w = await newEditor(h)
      await h.openTab(w.page, 'Inspector')
      const fov = w.page.locator('input[aria-label="FOV"]').first()
      assert.equal(await fov.count(), 1, 'Inspector exposes the FOV field')
      // Camera reports carry pose only; assert the applied projection through
      // the live camera probe.
      let since = await h.messageCount(w.page)
      await fov.fill('35')
      await fov.press('Enter')
      await h.waitMessageSince(w.page, since, { type: 'three-workbench:camera' }, 6000)
      await waitFor(async () => inRange((await h.probeRead(w.page)).camera.fov, 35, 1e-3), {
        timeout: 6000,
        interval: 60,
        label: 'live camera FOV 35',
      })
      since = await h.messageCount(w.page)
      await fov.fill('120')
      await fov.press('Enter')
      await h.waitMessageSince(w.page, since, { type: 'three-workbench:camera' }, 6000)
      await waitFor(async () => inRange((await h.probeRead(w.page)).camera.fov, 120, 1e-3), {
        timeout: 6000,
        interval: 60,
        label: 'live camera FOV 120',
      })
      await w.close()
    })

    await h.check('e2e/multi-select', async () => {
      const w = await newEditor(h)
      const heroUid = await h.selectObject(w.page, 'P5Hero')
      const otherUid = await h.selectObject(w.page, 'P5Other', { ctrl: true })
      await waitFor(async () => {
        const messages = await h.messages(w.page)
        return messages.slice(-20).some(message => message.type === 'three-workbench:selection'
          && Array.isArray(message.uids)
          && message.uids.length === 2
          && message.uids.includes(heroUid)
          && message.uids.includes(otherUid))
      }, { timeout: 8000, interval: 50, label: 'two-object selection' })
      const selected = (await h.messages(w.page)).slice().reverse().find(message => message.type === 'three-workbench:selection')
      assert.equal(selected.primary, otherUid, 'ctrl-click makes the new object primary')
      await h.selectObject(w.page, 'P5Hero', { ctrl: true, expectAbsent: true })
      await waitFor(async () => {
        const messages = await h.messages(w.page)
        return messages.slice(-12).some(message => message.type === 'three-workbench:selection'
          && Array.isArray(message.uids)
          && message.uids.length === 1
          && message.uids[0] === otherUid)
      }, { timeout: 8000, interval: 50, label: 'ctrl-click removes the first object' })
      await w.close()
    })

    await h.check('e2e/keyframes-smoke', async () => {
      const w = await newEditor(h)
      await h.selectObject(w.page, 'P5Hero')
      await h.timeline(w.page, { action: 'seek', time: 0 })
      const add = w.page.locator('button[aria-label="Add track (K)"]').first()
      assert.equal(await add.count(), 1, 'Add track (K) button exists')
      const since = await h.messageCount(w.page)
      await add.click()
      const ack = await waitFor(async () => {
        const messages = await h.messages(w.page)
        return messages.slice(since).find(message => message.type === 'three-workbench:mutation'
          && message.command === 'tracks'
          && message.ok === true) || null
      }, { timeout: 10000, interval: 60, label: 'keyframe track ack' })
      assert.ok(ack.trackCount >= 1, 'keyframe created at least one track')
      assert.ok(ack.keyCount >= 1, 'keyframe created at least one key')
      await waitFor(async () => (await w.page.locator('[data-track-key]').count()) >= 1, {
        timeout: 8000,
        interval: 100,
        label: 'dope-sheet key marker',
      })
      await w.close()
    })
  },
}
