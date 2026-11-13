// P5-2 protocol: ready handshake order, scene-tree request ids and source
// guard behaviour, and single-vs-array selection normalization.
import assert from 'node:assert/strict'
import { sleep, waitFor } from '../lib/harness.mjs'

export default {
  name: 'protocol-handshake-tree',
  async run(h) {
    await h.check('protocol/handshake-order', async () => {
      const w = await h.openWorkbench()
      await waitFor(async () => (await h.inbound(w.page)).length >= 11, {
        timeout: 10000,
        interval: 100,
        label: 'parent ready handshake commands',
      })
      const inbound = (await h.inbound(w.page)).slice(0, 11)
      assert.deepEqual(inbound.map(entry => entry.command), [
        'resolution', 'timeline', 'timeline', 'timeline', 'locks', 'tracks',
        'tracks', 'scene-tree', 'select-mode', 'gizmo', 'params',
      ], 'handshake command order is stable')
      assert.deepEqual(inbound.slice(1, 4).map(entry => entry.action), ['set-speed', 'set-loop', 'set-duration'])
      assert.ok(inbound[0].aspect === null || typeof inbound[0].aspect === 'number', 'resolution carries the aspect')
      assert.ok(typeof inbound[0].scale === 'number' && inbound[0].scale > 0, 'resolution carries the scale')
      assert.deepEqual(inbound[4].uids, [], 'no objects are locked in the fixture')
      assert.equal(inbound[5].autoKey, false, 'tracks config carries autoKey')
      assert.ok(inbound[5].stepFps >= 1 && inbound[5].stepFps <= 120, 'tracks config carries stepFps')
      assert.equal(inbound[6].tracksVersion, 1, 'replace-all sends tracksVersion 1')
      assert.equal(inbound[6].tracksVersionField, 1, 'replace-all track set is v1')
      assert.equal(inbound[6].reason, 'load', 'initial replace-all is a load')
      assert.equal(inbound[7].command, 'scene-tree')
      assert.equal(inbound[7].requestId, undefined, 'initial scene-tree has no request id')
      // Studio is the default surface, so the editor is already on when the
      // fresh runtime asks for its handshake: direct manipulation is enabled
      // and the default move gizmo is active from the first command batch.
      assert.equal(inbound[8].enabled, true, 'selection mode follows the default Studio editor')
      assert.equal(inbound[9].mode, 'translate', 'the default Studio gizmo is move mode')
      assert.equal(inbound[9].space, 'world', 'the default gizmo space is world')
      assert.equal(inbound[10].action, 'schema', 'handshake asks for the params schema')

      const messages = await h.messages(w.page)
      const ready = messages.find(message => message.type === 'three-workbench:ready')
      assert.ok(ready, 'runtime announced ready')
      assert.equal(ready.editorVersion, 2, 'ready advertises editor version 2')
      assert.ok(typeof ready.revision === 'number', 'ready carries the scene revision')
      const tree = await waitFor(async () => {
        const current = await h.messages(w.page)
        return current.find(message => message.type === 'three-workbench:scene-tree' && message.reason === 'ready') || null
      }, { timeout: 8000, interval: 80, label: 'ready scene-tree' })
      assert.ok(Array.isArray(tree.nodes) && tree.nodes.some(node => node.name === 'P5Hero'), 'ready tree lists the fixture')
      assert.ok(tree.camera && typeof tree.camera.fov === 'number' && tree.camera.fov > 0, 'ready tree carries the camera')
      await w.close()
    })

    await h.check('protocol/scene-tree-request-id', async () => {
      const w = await h.openWorkbench()
      const firstId = h.nextId('tree-a')
      let since = await h.messageCount(w.page)
      await h.sendCommand(w.page, { command: 'scene-tree', requestId: firstId })
      const first = await h.waitMessageSince(w.page, since, { type: 'three-workbench:scene-tree', requestId: firstId }, 8000)
      assert.equal(first.reason, 'request', 'explicit request is labelled request')
      assert.ok(first.nodes.some(node => node.name === 'P5Hero'), 'reply lists P5Hero')
      assert.ok(Array.isArray(first.camera.position) && Array.isArray(first.camera.target), 'reply carries camera pose')
      assert.ok(typeof first.camera.scriptFov === 'number', 'reply carries the script FOV')

      const secondId = h.nextId('tree-b')
      since = await h.messageCount(w.page)
      await h.sendCommand(w.page, { command: 'scene-tree', requestId: secondId })
      const second = await h.waitMessageSince(w.page, since, { type: 'three-workbench:scene-tree', requestId: secondId }, 8000)
      assert.notEqual(second.requestId, firstId, 'each reply echoes its own request id')

      since = await h.messageCount(w.page)
      await h.sendCommand(w.page, { command: 'scene-tree' })
      const anonymous = await waitFor(async () => {
        const messages = await h.messages(w.page)
        return messages.slice(since).find(message => message.type === 'three-workbench:scene-tree'
          && message.reason === 'request'
          && message.requestId === undefined) || null
      }, { timeout: 8000, interval: 60, label: 'anonymous scene-tree reply' })
      assert.ok(anonymous.nodes.some(node => node.name === 'P5Hero'), 'anonymous reply still lists the fixture')

      // Forge a tree from the runtime frame. The parent source guard must accept
      // it and refresh the outliner; a later real reply must replace it.
      await h.openTab(w.page, 'Scene')
      await h.postFromFrame(w.page, {
        type: 'three-workbench:scene-tree',
        reason: 'request',
        rev: 7,
        nodes: [{
          uid: 's:forged', name: 'P5Forged', type: 'Mesh', depth: 0, parentUid: null,
          alias: '', locked: false, pinned: [], wbId: null, visible: true,
          namedPath: 'P5Forged', ordinalPath: [0],
          position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        }],
        materials: {},
        unresolved: [],
        deleted: [],
        camera: { position: [3.2, 3.2, 6.2], target: [0.8, 0.2, 0], fov: 50, scriptFov: 50 },
      })
      await waitFor(async () => (await w.page.getByText('P5Forged', { exact: true }).count()) > 0, {
        timeout: 5000,
        interval: 80,
        label: 'parent accepts a runtime-shaped forged tree',
      })
      const afterForgedId = h.nextId('tree-after')
      since = await h.messageCount(w.page)
      await h.sendCommand(w.page, { command: 'scene-tree', requestId: afterForgedId })
      await h.waitMessageSince(w.page, since, { type: 'three-workbench:scene-tree', requestId: afterForgedId }, 8000)
      await waitFor(async () => {
        const forged = await w.page.getByText('P5Forged', { exact: true }).count()
        const hero = await w.page.getByText('P5Hero', { exact: true }).count()
        return forged === 0 && hero > 0
      }, { timeout: 5000, interval: 80, label: 'real tree replaces the forged node' })
      await w.close()
    })

    await h.check('protocol/selection-single-array-normalization', async () => {
      const w = await h.openWorkbench()
      const heroUid = await h.resolveUid(w.page, 'P5Hero')
      const otherUid = await h.resolveUid(w.page, 'P5Other')

      let since = await h.messageCount(w.page)
      await h.sendCommand(w.page, { command: 'select', uid: heroUid, requestId: h.nextId('select') })
      const single = await h.waitMessageSince(w.page, since, { type: 'three-workbench:selection' }, 6000)
      assert.equal(single.uid, heroUid, 'single select echoes uid')
      assert.deepEqual(single.uids, [heroUid], 'single select normalizes to one uid')
      assert.equal(single.primary, heroUid, 'single select sets primary')

      since = await h.messageCount(w.page)
      const staleId = h.nextId('select-stale')
      await h.sendCommand(w.page, { command: 'select', uid: 's:missing', requestId: staleId })
      const stale = await h.waitMessageSince(w.page, since, { type: 'three-workbench:mutation', requestId: staleId }, 6000)
      assert.equal(stale.ok, false, 'stale single select is rejected')
      assert.equal(stale.error, 'stale-uid', 'stale single select reports stale-uid')
      await waitFor(async () => {
        const messages = await h.messages(w.page)
        return messages.slice(since).some(message => message.type === 'three-workbench:selection'
          && Array.isArray(message.uids)
          && message.uids.length === 0
          && message.primary === null)
      }, { timeout: 6000, interval: 60, label: 'stale single select clears selection' })

      since = await h.messageCount(w.page)
      const arrayRequestId = h.nextId('select-array')
      const arrayInbound = (await h.inbound(w.page)).length
      await h.sendCommand(w.page, {
        command: 'select',
        uids: [heroUid, 's:missing', heroUid, 42, ''],
        primary: 's:missing',
        requestId: arrayRequestId,
      })
      const arrayCommand = await waitFor(async () => {
        const inbound = await h.inbound(w.page)
        return inbound.slice(arrayInbound).find(entry => entry.requestId === arrayRequestId) || null
      }, { timeout: 6000, interval: 25, label: 'runtime receives array selection' })
      const normalized = await waitFor(async () => {
        const messages = await h.messages(w.page)
        return messages.slice(since).find(message => message.type === 'three-workbench:selection'
          && typeof message.at === 'number' && message.at >= arrayCommand.at
          && Array.isArray(message.uids) && message.uids.length === 1
          && message.uids[0] === heroUid
          && message.primary === heroUid) || null
      }, { timeout: 6000, interval: 25, label: 'array selection normalizes to the available uid' })
      assert.deepEqual(normalized.uids, [heroUid], 'array selection drops stale, duplicate and non-string uids')
      assert.equal(normalized.primary, heroUid, 'array selection falls back to the first available primary')
      await sleep(250)
      const arrayMessages = (await h.messages(w.page)).slice(since)
      assert.ok(!arrayMessages.some(message => message.type === 'three-workbench:mutation' && message.ok === false),
        'stale array members are dropped without a stale-uid mutation')

      since = await h.messageCount(w.page)
      const emptyRequestId = h.nextId('select-empty')
      const emptyInbound = (await h.inbound(w.page)).length
      await h.sendCommand(w.page, {
        command: 'select',
        uids: ['s:missing'],
        primary: otherUid,
        requestId: emptyRequestId,
      })
      const emptyCommand = await waitFor(async () => {
        const inbound = await h.inbound(w.page)
        return inbound.slice(emptyInbound).find(entry => entry.requestId === emptyRequestId) || null
      }, { timeout: 6000, interval: 25, label: 'runtime receives all-stale selection' })
      const empty = await waitFor(async () => {
        const messages = await h.messages(w.page)
        return messages.slice(since).find(message => message.type === 'three-workbench:selection'
          && typeof message.at === 'number' && message.at >= emptyCommand.at
          && Array.isArray(message.uids) && message.uids.length === 0
          && message.primary === null) || null
      }, { timeout: 6000, interval: 25, label: 'all-stale array selection report' })
      assert.deepEqual(empty.uids, [], 'all-stale array becomes an empty selection')
      assert.equal(empty.primary, null, 'all-stale array has no primary')
      await w.close()
    })
  },
}
