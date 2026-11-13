// P5-2 protocol: atomic tracks replace-all, version/shape rejects, locked edit,
// unresolved UIDs and the ack-before-apply failure semantics.
import assert from 'node:assert/strict'
import { waitFor } from '../lib/harness.mjs'

function trackSet(tracks) {
  return { v: 1, items: tracks }
}

function positionTrack(uid, keys) {
  return { uid, path: 'position', enabled: true, keys }
}

const POSITION_KEYS = [
  { t: 0, v: [0, 0, 0], e: 'linear' },
  { t: 1, v: [1, 0, 0], e: 'linear' },
]

async function replaceAll(h, page, requestId, tracks, extra = {}) {
  const since = await h.messageCount(page)
  await h.sendCommand(page, Object.assign({
    command: 'tracks',
    action: 'replace-all',
    tracksVersion: 1,
    tracks: trackSet(tracks),
    reason: 'load',
    requestId,
  }, extra))
  return h.waitMessageSince(page, since, { type: 'three-workbench:mutation', requestId }, 8000)
}

export default {
  name: 'protocol-tracks',
  async run(h) {
    await h.check('protocol/tracks-replace-all-success', async () => {
      const w = await h.openWorkbench()
      const heroUid = await h.resolveUid(w.page, 'P5Hero')
      const ack = await replaceAll(h, w.page, h.nextId('tracks-ok'), [positionTrack(heroUid, POSITION_KEYS)])
      assert.equal(ack.ok, true, 'valid replace-all succeeds')
      assert.equal(ack.command, 'tracks', 'ack is a tracks mutation')
      assert.equal(ack.action, 'replace-all', 'ack names replace-all')
      assert.equal(ack.trackCount, 1, 'ack reports one track')
      assert.equal(ack.keyCount, 2, 'ack reports two keys')
      assert.deepEqual(ack.unresolved, [], 'no unresolved entries')
      const clock = await h.timeline(w.page, { action: 'seek', time: 0.5 })
      assert.ok(Math.abs(clock.time - 0.5) < 1e-6, 'seek reaches the animated time')
      await waitFor(async () => {
        const read = await h.probeRead(w.page)
        return Math.abs(read.hero.position[0] - 0.5) < 1e-4 ? read : null
      }, { timeout: 8000, interval: 80, label: 'track pose at t=0.5' })
      assert.ok(Math.abs((await h.probeRead(w.page)).hero.position[0] - 0.5) < 1e-4, 'position track is evaluated')
      await w.close()
    })

    await h.check('protocol/tracks-version-and-malformed', async () => {
      const w = await h.openWorkbench()
      const heroUid = await h.resolveUid(w.page, 'P5Hero')

      let since = await h.messageCount(w.page)
      let requestId = h.nextId('tracks-version')
      await h.sendCommand(w.page, {
        command: 'tracks', action: 'replace-all', tracksVersion: 2,
        tracks: trackSet([positionTrack(heroUid, POSITION_KEYS)]), reason: 'load', requestId,
      })
      let ack = await h.waitMessageSince(w.page, since, { type: 'three-workbench:mutation', requestId }, 6000)
      assert.equal(ack.error, 'tracks-version', 'unsupported tracksVersion is rejected')

      since = await h.messageCount(w.page)
      requestId = h.nextId('tracks-v2')
      await h.sendCommand(w.page, {
        command: 'tracks', action: 'replace-all', tracksVersion: 1,
        tracks: { v: 2, items: [] }, reason: 'load', requestId,
      })
      ack = await h.waitMessageSince(w.page, since, { type: 'three-workbench:mutation', requestId }, 6000)
      assert.equal(ack.error, 'tracks-version', 'track-set version mismatch is rejected')

      since = await h.messageCount(w.page)
      requestId = h.nextId('tracks-empty')
      await h.sendCommand(w.page, {
        command: 'tracks', action: 'replace-all', tracksVersion: 1,
        tracks: trackSet([{ uid: heroUid, path: 'position', keys: [] }]), reason: 'load', requestId,
      })
      ack = await h.waitMessageSince(w.page, since, { type: 'three-workbench:mutation', requestId }, 6000)
      assert.equal(ack.error, 'tracks-invalid', 'empty track is rejected')

      since = await h.messageCount(w.page)
      requestId = h.nextId('tracks-path')
      await h.sendCommand(w.page, {
        command: 'tracks', action: 'replace-all', tracksVersion: 1,
        tracks: trackSet([{ uid: heroUid, path: 'bogus', keys: [{ t: 0, v: 1, e: 'linear' }] }]),
        reason: 'load', requestId,
      })
      ack = await h.waitMessageSince(w.page, since, { type: 'three-workbench:mutation', requestId }, 6000)
      assert.equal(ack.error, 'tracks-invalid', 'unknown track path is rejected')

      since = await h.messageCount(w.page)
      requestId = h.nextId('tracks-shape')
      await h.sendCommand(w.page, {
        command: 'tracks', action: 'replace-all', tracksVersion: 1,
        tracks: { v: 1, items: 'not-an-array' }, reason: 'load', requestId,
      })
      ack = await h.waitMessageSince(w.page, since, { type: 'three-workbench:mutation', requestId }, 6000)
      assert.equal(ack.error, 'tracks-invalid', 'non-array items is rejected')

      since = await h.messageCount(w.page)
      requestId = h.nextId('tracks-action')
      await h.sendCommand(w.page, {
        command: 'tracks', action: 'insert', tracksVersion: 1,
        tracks: trackSet([]), reason: 'load', requestId,
      })
      ack = await h.waitMessageSince(w.page, since, { type: 'three-workbench:mutation', requestId }, 6000)
      assert.equal(ack.error, 'tracks-invalid', 'non replace-all action is rejected')
      await w.close()
    })

    await h.check('protocol/tracks-locked-edit', async () => {
      const w = await h.openWorkbench()
      const heroUid = await h.resolveUid(w.page, 'P5Hero')
      const initial = await replaceAll(h, w.page, h.nextId('tracks-base'), [positionTrack(heroUid, POSITION_KEYS)])
      assert.equal(initial.ok, true, 'baseline track set is accepted')
      await h.sendCommand(w.page, { command: 'locks', uids: [heroUid] })
      const changed = [
        { t: 0, v: [0, 0, 0], e: 'linear' },
        { t: 1, v: [2, 0, 0], e: 'linear' },
      ]
      const since = await h.messageCount(w.page)
      const requestId = h.nextId('tracks-locked')
      await h.sendCommand(w.page, {
        command: 'tracks', action: 'replace-all', tracksVersion: 1,
        tracks: trackSet([positionTrack(heroUid, changed)]), reason: 'edit', requestId,
      })
      const ack = await h.waitMessageSince(w.page, since, { type: 'three-workbench:mutation', requestId }, 6000)
      assert.equal(ack.ok, false, 'locked edit is rejected')
      assert.equal(ack.error, 'locked', 'locked edit reports locked')
      assert.equal(ack.uid, heroUid, 'locked edit names the locked uid')
      await h.sendCommand(w.page, { command: 'locks', uids: [] })
      const restored = await replaceAll(h, w.page, h.nextId('tracks-restored'), [positionTrack(heroUid, POSITION_KEYS)])
      assert.equal(restored.ok, true, 'unlocked replace-all succeeds again')
      await w.close()
    })

    await h.check('protocol/tracks-unresolved-and-apply-failure', async () => {
      const w = await h.openWorkbench()
      const heroUid = await h.resolveUid(w.page, 'P5Hero')
      const throwUid = await h.resolveUid(w.page, 'P5Throw')
      const ack = await replaceAll(h, w.page, h.nextId('tracks-unresolved'), [
        positionTrack(heroUid, POSITION_KEYS),
        positionTrack('s:missing', [{ t: 0, v: [0, 0, 0], e: 'linear' }]),
      ])
      assert.equal(ack.ok, true, 'unresolved tracks do not fail the atomic replace')
      assert.equal(ack.trackCount, 2, 'ack counts both tracks')
      assert.ok(Array.isArray(ack.unresolved) && ack.unresolved.length === 1, 'one unresolved entry is reported')
      assert.equal(ack.unresolved[0].uid, 's:missing', 'unresolved entry names the missing uid')
      assert.equal(ack.unresolved[0].path, 'position', 'unresolved entry names the path')
      assert.equal(ack.unresolved[0].reason, 'missing-uid', 'unresolved entry reports missing-uid')

      // Ack-before-apply: the runtime acks the atomic set, then applies it. A
      // throwing property setter turns into an internal apply-failed entry and
      // leaves the object unchanged; the ack cannot carry it by design.
      const failed = await replaceAll(h, w.page, h.nextId('tracks-apply'), [
        positionTrack(throwUid, [{ t: 0, v: [13, 0, 0], e: 'linear' }]),
      ])
      assert.equal(failed.ok, true, 'ack is sent before apply and stays ok')
      await waitFor(async () => {
        const read = await h.probeRead(w.page)
        return read.injectedFailures >= 1 ? read : null
      }, { timeout: 5000, interval: 60, label: 'track apply failure ran' })
      assert.ok(Math.abs((await h.probeRead(w.page)).throwing.position[0] - 4) < 1e-4, 'failed track leaves the pose unchanged')
      await w.close()
    })
  },
}
