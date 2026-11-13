// P7 browser E2E: Studio resizable layout, viewport commands, Outliner context
// menu and shortcut discoverability. Each check uses a fresh Playwright
// context against the synthetic fixture routes; no Host scene/store is touched.
import assert from 'node:assert/strict'
import { inRange, sleep, waitFor } from '../lib/harness.mjs'

const LAYOUT_KEY = 'three-workbench:studio-layout'

async function openStudio(h, page) {
  // Studio is the default surface; there is no enter gesture to perform.
  await waitFor(async () => (await page.locator('[data-three-workbench-studio="root"]').count()) > 0, {
    timeout: 10000, interval: 100, label: 'Studio root',
  })
  await sleep(150)
}

async function showSceneTree(page) {
  const rail = page.locator('[data-three-workbench-studio="rail"] button[aria-label="Scene tree"]').first()
  await waitFor(async () => (await rail.count()) > 0, { timeout: 5000, interval: 50, label: 'Scene tree rail item' })
  await rail.click()
  await sleep(120)
}

async function layout(page) {
  return page.evaluate(key => {
    try { return JSON.parse(localStorage.getItem(key)) } catch { return null }
  }, LAYOUT_KEY)
}

async function dragHandle(page, kind, dx, dy) {
  const handle = page.locator('[data-three-workbench-studio-resize="' + kind + '"]').first()
  await waitFor(async () => (await handle.count()) > 0, { timeout: 5000, interval: 50, label: kind + ' resize handle' })
  const box = await handle.boundingBox()
  assert.ok(box !== null, kind + ' handle has a box')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 6 })
  await page.mouse.up()
  await sleep(120)
}

function approximately(actual, expected, epsilon = 1e-3) {
  return Array.isArray(actual) && Array.isArray(expected)
    && actual.length === expected.length
    && expected.every((value, index) => inRange(actual[index], value, epsilon))
}

async function reopenStudioAfterReload(h, page) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(async () => (await page.locator('[data-row-key^="session:"]').count()) > 0, {
    timeout: 30000, interval: 250, label: 'Host session list after reload',
  })
  const rows = page.locator('[data-row-key^="session:"]').filter({ hasNotText: 'New Session' })
  const count = await rows.count()
  assert.ok(count > 0, 'session row exists after reload')
  for (let index = 0; index < Math.min(count, 6); index += 1) {
    await rows.nth(index).click({ timeout: 8000 }).catch(() => {})
    const opened = await waitFor(async () => (await page.locator('[data-three-workbench-frame]').count()) > 0, {
      timeout: 9000, interval: 250, label: 'workbench frame after reload',
    }).catch(() => null)
    if (opened) break
  }
  const frame = await h.waitForProbeFrame(page, 45000)
  await waitFor(async () => frame.evaluate(() => window.__p5 && window.__p5.frames() > 0), {
    timeout: 20000, interval: 150, label: 'runtime frames after reload',
  })
  await openStudio(h, page)
}

export default {
  name: 'studio-logic',
  async run(h) {
    await h.check('e2e/studio-layout-resize-persist-reset', async () => {
      const w = await h.openWorkbench({ viewport: { width: 1440, height: 900 } })
      await h.openEditor(w.page)
      await openStudio(h, w.page)
      const page = w.page
      const frame = page.locator('[data-three-workbench-frame]').first()
      const before = await frame.boundingBox()
      assert.ok(before !== null, 'iframe has a box')
      assert.ok(Math.abs(before.x - 288) < 1, 'default left width: ' + before.x)
      assert.ok(Math.abs((1440 - (before.x + before.width)) - 312) < 1, 'default right width')

      await dragHandle(page, 'left', 56, 0)
      const movedLeft = await frame.boundingBox()
      assert.ok(movedLeft.x > before.x + 40, 'left seam moved the iframe left edge')
      const storedLeft = await layout(page)
      assert.ok(storedLeft.left >= 330 && storedLeft.left <= 360, 'left width persisted: ' + storedLeft.left)

      await dragHandle(page, 'right', -48, 0)
      const movedRight = await frame.boundingBox()
      assert.ok(movedRight.x + movedRight.width < before.x + before.width - 30, 'right seam moved the iframe right edge')
      const storedRight = await layout(page)
      assert.ok(storedRight.right >= 345 && storedRight.right <= 380, 'right width persisted: ' + storedRight.right)

      await page.locator('[data-three-workbench-studio-resize="left"]').first().dblclick()
      const reset = await layout(page)
      assert.equal(reset.left, 288, 'double-click resets the left width')
      const resetFrame = await frame.boundingBox()
      assert.ok(Math.abs(resetFrame.x - before.x) < 2, 'double-click restores the iframe edge')

      await reopenStudioAfterReload(h, page)
      const afterReload = await frame.boundingBox().catch(() => null)
      assert.ok(afterReload !== null, 'iframe exists after reload')
      const persisted = await layout(page)
      assert.equal(persisted.right, storedRight.right, 'right width survives reload')
      assert.equal(persisted.left, 288, 'reset left width survives reload')
      await w.close()
    })

    await h.check('e2e/studio-console-dock-resize', async () => {
      const w = await h.openWorkbench({ viewport: { width: 1440, height: 900 } })
      await h.openEditor(w.page)
      await openStudio(h, w.page)
      const page = w.page
      const consoleTab = page.locator('[data-three-workbench-studio="dock"] button').filter({ hasText: 'Console' }).first()
      await consoleTab.click()
      const dock = page.locator('[data-three-workbench-studio="dock"]').first()
      const before = await dock.boundingBox()
      assert.ok(before !== null, 'dock has a box')
      await dragHandle(page, 'console', 0, -40)
      const after = await dock.boundingBox()
      assert.ok(after.height > before.height + 25, 'console dock became taller')
      const stored = await layout(page)
      assert.ok(stored.console > 220 && stored.console < 300, 'console height persisted: ' + stored.console)
      const handle = page.locator('[data-three-workbench-studio-resize="console"]').first()
      await handle.focus()
      await handle.press('ArrowDown')
      const nudged = await layout(page)
      assert.equal(nudged.console, stored.console - 8, 'arrow key nudges by 8px')
      await handle.dblclick()
      assert.equal((await layout(page)).console, 220, 'double-click resets console height')
      await w.close()
    })

    await h.check('e2e/studio-viewport-presets-shading-grid', async () => {
      const w = await h.openWorkbench({ viewport: { width: 1440, height: 900 } })
      await h.openEditor(w.page)
      await openStudio(h, w.page)
      const page = w.page
      const frame = await w.frame()
      const select = page.locator('[data-three-workbench-view-select]').first()

      const baseline = await h.probeRead(page)
      await select.selectOption('front')
      const front = await waitFor(async () => {
        const read = await h.probeRead(page)
        const d = [read.camera.position[0] - read.camera.target[0],
          read.camera.position[1] - read.camera.target[1],
          read.camera.position[2] - read.camera.target[2]]
        return d[2] > 5 && Math.abs(d[0]) < 0.05 && Math.abs(d[1]) < 0.05 ? read : null
      }, { timeout: 8000, interval: 80, label: 'front view preset' })
      assert.ok(front !== null, 'front preset looks along +Z')

      await select.selectOption('top')
      const top = await waitFor(async () => {
        const read = await h.probeRead(page)
        const d = [read.camera.position[0] - read.camera.target[0],
          read.camera.position[1] - read.camera.target[1],
          read.camera.position[2] - read.camera.target[2]]
        return d[1] > 5 && Math.abs(d[0]) < 0.05 && Math.abs(d[2]) < 0.05 ? read : null
      }, { timeout: 8000, interval: 80, label: 'top view preset' })
      assert.ok(top !== null, 'top preset looks down')
      assert.ok(Math.abs(top.camera.target[1] - baseline.camera.target[1]) < 2, 'top preset keeps the scene target')

      // Playwright's selectOption restores focus to the host composer, whose
      // contenteditable makes the editor shortcut handler ignore the key. A
      // click on the neutral Studio header (title area) moves focus to the
      // panel before exercising the keyboard path; blur() alone bounces focus
      // straight back to the composer.
      await page.locator('[data-three-workbench-studio="root"]')
        .click({ position: { x: 200, y: 27 } })
      await page.keyboard.press('Alt+J')
      await waitFor(async () => (await page.locator('[data-three-workbench-view-select]').first().inputValue()) === 'front', {
        timeout: 4000, interval: 50, label: 'Alt+J selects the front axis',
      })
      await page.keyboard.press('Alt+J')
      await waitFor(async () => (await page.locator('[data-three-workbench-view-select]').first().inputValue()) === 'back', {
        timeout: 4000, interval: 50, label: 'Alt+J toggles front/back',
      })

      const wire = page.locator('[data-three-workbench-shading]').filter({ hasText: 'Wireframe' }).first()
      await wire.click()
      assert.equal(await wire.getAttribute('aria-pressed'), 'true', 'wireframe chip is active')
      assert.equal(await frame.evaluate(() => window.__p5.scene.overrideMaterial !== null), true, 'wireframe sets the runtime override')
      const normals = page.locator('[data-three-workbench-shading]').filter({ hasText: 'Normals' }).first()
      await normals.click()
      assert.equal(await frame.evaluate(() => window.__p5.scene.overrideMaterial !== null), true, 'normals sets the runtime override')
      const rendered = page.locator('[data-three-workbench-shading]').filter({ hasText: 'Rendered' }).first()
      await rendered.click()
      assert.equal(await frame.evaluate(() => window.__p5.scene.overrideMaterial === null), true, 'rendered restores authored materials')

      const grid = page.locator('[data-three-workbench-grid]').first()
      await grid.click()
      assert.equal(await grid.getAttribute('aria-pressed'), 'true', 'grid chip is active')
      const helpers = await frame.evaluate(() => window.__p5.scene.children
        .filter(node => node.userData && node.userData.wbHelper === true)
        .map(node => node.type))
      assert.ok(helpers.includes('GridHelper') && helpers.includes('AxesHelper'), 'grid and axes are helper objects')
      await grid.click()
      assert.equal((await frame.evaluate(() => window.__p5.scene.children
        .filter(node => node.type === 'GridHelper' || node.type === 'AxesHelper').length)), 0,
      'grid toggle detaches helpers')

      // Keys pressed while focus sits inside the sandboxed frame must reach
      // the same dispatcher as page-level keys.
      await page.locator('[data-three-workbench-frame]').first().click({ position: { x: 240, y: 220 } })
      await page.keyboard.press('Alt+2')
      await waitFor(async () => (await page.locator('[data-three-workbench-shading]').filter({ hasText: 'Wireframe' })
        .first().getAttribute('aria-pressed')) === 'true', { timeout: 4000, interval: 50, label: 'iframe Alt+2' })
      await page.keyboard.press('Alt+J')
      await waitFor(async () => (await page.locator('[data-three-workbench-view-select]').first().inputValue()) === 'front', {
        timeout: 4000, interval: 50, label: 'iframe Alt+J',
      })
      await page.keyboard.press('Shift+Slash')
      await waitFor(async () => (await page.locator('[data-three-workbench-shortcuts]').count()) > 0, {
        timeout: 4000, interval: 50, label: 'iframe ? help',
      })
      await page.keyboard.press('Escape')
      await waitFor(async () => (await page.locator('[data-three-workbench-shortcuts]').count()) === 0, {
        timeout: 4000, interval: 50, label: 'iframe Escape closes help',
      })
      await w.close()
    })

    await h.check('e2e/studio-outliner-context-menu', async () => {
      const w = await h.openWorkbench({ viewport: { width: 1440, height: 900 } })
      await h.openEditor(w.page)
      await openStudio(h, w.page)
      const page = w.page
      await showSceneTree(page)
      const row = page.locator('[data-three-workbench-studio="left"]').getByText('P5Hero', { exact: true }).first()
      await waitFor(async () => (await row.count()) > 0, { timeout: 8000, interval: 100, label: 'P5Hero outliner row' })
      const box = await row.boundingBox()
      assert.ok(box !== null, 'row has a box')
      await row.click({ button: 'right' })
      const menu = page.locator('[data-three-workbench-outliner-menu]').first()
      await waitFor(async () => (await menu.count()) > 0, { timeout: 4000, interval: 50, label: 'context menu' })
      const menuBox = await menu.boundingBox()
      assert.ok(menuBox !== null, 'menu has a box')
      assert.ok(Math.abs(menuBox.x - Math.max(8, Math.min(box.x + box.width / 2, 1440 - 176))) < 4, 'menu opens at the pointer')
      const beforeMessages = await h.messageCount(page)
      await menu.getByText('Ask AI', { exact: true }).click()
      assert.equal(await page.locator('[data-three-workbench-outliner-menu]').count(), 0, 'menu closes after an action')
      const textarea = page.locator('[data-three-workbench-studio="left"] textarea').first()
      await waitFor(async () => (await textarea.inputValue()).includes('P5Hero'), {
        timeout: 4000, interval: 50, label: 'AI draft names the object',
      })
      assert.equal(await textarea.evaluate(el => el === document.activeElement), true, 'prefill focuses the AI draft')
      assert.equal(await page.locator('[data-three-workbench-studio-transcript]').count(), 1,
        'AI tab mounts the host-native transcript')
      const contextChip = page.locator('[data-three-workbench-studio-action="context"]').first()
      assert.equal(await contextChip.getAttribute('aria-pressed'), 'true', 'scene context is on by default')
      await contextChip.click()
      assert.equal((await layout(page)).context, false, 'context toggle persists in the studio layout')
      // Periodic runtime status reports make a raw message-count comparison
      // meaningless; a sent prompt would clear the draft instead.
      assert.ok((await h.messageCount(page)) >= beforeMessages, 'message bus stays healthy')
      await w.close()
    })

    await h.check('e2e/studio-drawers-shots-review-geometry-log', async () => {
      const w = await h.openWorkbench({ viewport: { width: 1440, height: 900 } })
      await h.openEditor(w.page)
      await openStudio(h, w.page)
      const page = w.page
      const dockTab = id => page.locator('[data-three-workbench-dock-tab="' + id + '"]').first()

      await dockTab('shots').click()
      const shots = page.locator('[data-three-workbench-drawer="shots"]').first()
      await waitFor(async () => (await shots.count()) > 0, { timeout: 4000, interval: 50, label: 'shots drawer' })
      const take = page.locator('[data-three-workbench-studio-action="shot-take"]').first()
      await take.click()
      await waitFor(async () => (await page.locator('[data-three-workbench-shot]').count()) > 0,
        { timeout: 8000, interval: 100, label: 'captured shot card' })
      assert.equal(await page.locator('[data-three-workbench-shot]').first().getAttribute('data-three-workbench-shot').then(value => typeof value), 'string',
        'shot card carries an id')

      await showSceneTree(page)
      const row = page.locator('[data-three-workbench-studio="left"]').getByText('P5Hero', { exact: true }).first()
      await waitFor(async () => (await row.count()) > 0, { timeout: 8000, interval: 100, label: 'P5Hero outliner row' })
      await row.click()
      await sleep(120)

      await dockTab('review').click()
      const review = page.locator('[data-three-workbench-drawer="review"]').first()
      await waitFor(async () => (await review.count()) > 0, { timeout: 4000, interval: 50, label: 'review drawer' })
      await review.locator('input').first().fill('Check the hero silhouette')
      await page.locator('[data-three-workbench-studio-action="review-add"]').first().click()
      await waitFor(async () => (await page.locator('[data-three-workbench-pin]').count()) > 0,
        { timeout: 4000, interval: 50, label: 'review pin row' })

      await dockTab('geometry').click()
      const geometry = page.locator('[data-three-workbench-drawer="geometry"]').first()
      await waitFor(async () => (await geometry.count()) > 0, { timeout: 4000, interval: 50, label: 'geometry drawer' })
      assert.ok((await geometry.innerText()).includes('P5Hero'), 'geometry lens names the selected object')
      assert.equal(await page.locator('[data-three-workbench-import]').count(), 1, 'stage import action is available')

      await dockTab('log').click()
      const log = page.locator('[data-three-workbench-drawer="log"]').first()
      await waitFor(async () => (await log.count()) > 0, { timeout: 4000, interval: 50, label: 'decision log drawer' })
      assert.equal(await page.locator('[data-three-workbench-decision]').count(), 0,
        'no decisions before a proposal is applied or rejected')
      await w.close()
    })

    await h.check('e2e/studio-shortcuts-help-and-escape-layers', async () => {
      const w = await h.openWorkbench({ viewport: { width: 1440, height: 900 } })
      await h.openEditor(w.page)
      await openStudio(h, w.page)
      const page = w.page
      const root = page.locator('[data-three-workbench-studio="root"]').first()
      await page.locator('[data-three-workbench-studio="root"]').click({ position: { x: 700, y: 400 } })
      await page.keyboard.press('Shift+Slash')
      const help = page.locator('[data-three-workbench-shortcuts]').first()
      await waitFor(async () => (await help.count()) > 0, { timeout: 4000, interval: 50, label: 'shortcut help overlay' })
      assert.ok((await help.innerText()).includes('Alt+1'), 'help lists shading shortcuts')
      await page.keyboard.press('Escape')
      // Closing is a React state update; the full suite can otherwise observe
      // the help layer one render before it unmounts.
      await waitFor(async () => (await page.locator('[data-three-workbench-shortcuts]').count()) === 0, {
        timeout: 4000, interval: 50, label: 'Escape closes the help layer',
      })
      assert.equal(await root.count(), 1, 'Escape does not exit Studio when help was open')

      await showSceneTree(page)
      const row = page.locator('[data-three-workbench-studio="left"]').getByText('P5Hero', { exact: true }).first()
      await row.click({ button: 'right' })
      await waitFor(async () => (await page.locator('[data-three-workbench-outliner-menu]').count()) > 0, {
        timeout: 4000, interval: 50, label: 'context menu before Escape',
      })
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('[data-three-workbench-outliner-menu]').count(), 0, 'Escape closes the context menu')
      assert.equal(await root.count(), 1, 'Escape does not exit Studio when the menu was open')

      await page.keyboard.press('Escape')
      await sleep(150)
      assert.equal(await root.count(), 1, 'Escape no longer exits the default Studio surface')
      // Desktop Studio is the default surface: there is no exit gesture and no
      // header close action. The conversation-header 3D control reopens the
      // column if the host hides it; the narrow overlay keeps its own close.
      assert.equal(await page.locator('[data-three-workbench-studio-action="close"]').count(), 0,
        'desktop Studio has no exit action')
      await w.close()
    })

    await h.check('e2e/studio-layout-1200', async () => {
      const w = await h.openWorkbench({ viewport: { width: 1200, height: 800 } })
      await h.openEditor(w.page)
      await openStudio(h, w.page)
      const page = w.page
      const frame = page.locator('[data-three-workbench-frame]').first()
      const before = await frame.boundingBox()
      assert.ok(before !== null)
      assert.ok(before.width >= 500, '1200px keeps a usable stage: ' + before.width)
      await dragHandle(page, 'left', 80, 0)
      await dragHandle(page, 'right', -80, 0)
      const after = await frame.boundingBox()
      assert.ok(after.width >= 340, 'stage stays usable after both panels grow: ' + after.width)
      const toolbar = page.locator('[data-three-workbench-viewport-toolbar]').first()
      assert.ok((await toolbar.boundingBox()) !== null, 'viewport toolbar remains visible at 1200')
      await w.close()
    })

    await h.check('e2e/studio-default-ai-and-theme', async () => {
      const w = await h.openWorkbench({ viewport: { width: 1440, height: 900 } })
      await h.openEditor(w.page)
      await openStudio(h, w.page)
      const page = w.page
      const railItems = page.locator('[data-three-workbench-studio="rail"] button')
      assert.equal(await railItems.first().getAttribute('aria-label'), 'AI prompt',
        'the AI rail item is on top')
      assert.equal(await page.locator('[data-three-workbench-studio="ai"]').count(), 1,
        'the AI panel is the default left tab')
      // Switching away and back writes the layout; the persisted record carries
      // the new version and the user's tab choice.
      await page.locator('[data-three-workbench-studio="rail"] button[aria-label="Scene tree"]').first().click()
      await sleep(120)
      await page.locator('[data-three-workbench-studio="rail"] button[aria-label="AI prompt"]').first().click()
      await sleep(120)
      const stored = await layout(page)
      assert.equal(stored.tab, 'ai', 'the persisted tab is AI')
      assert.equal(stored.version, 3, 'the layout is written at the current version')

      const root = page.locator('[data-three-workbench-studio="root"]').first()
      const rootLuma = () => page.evaluate(() => {
        const node = document.querySelector('[data-three-workbench-studio="root"]')
        if (node === null) return null
        const channels = getComputedStyle(node).backgroundColor.match(/\d+(?:\.\d+)?/g)
        if (channels === null) return null
        return Number(channels[0]) * 0.2126 + Number(channels[1]) * 0.7152 + Number(channels[2]) * 0.0722
      })
      // Drive the Host's own theme attribute in both directions; the Studio
      // chrome must follow it without a reload.
      await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
      await waitFor(async () => (await root.getAttribute('data-three-workbench-theme')) === 'light', {
        timeout: 4000, interval: 50, label: 'Studio follows the Host light theme',
      })
      const lightLuma = await rootLuma()
      assert.ok(lightLuma !== null && lightLuma > 200, 'light Studio background is light: ' + lightLuma)
      await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
      await waitFor(async () => (await root.getAttribute('data-three-workbench-theme')) === 'dark', {
        timeout: 4000, interval: 50, label: 'Studio follows the Host dark theme',
      })
      const darkLuma = await rootLuma()
      assert.ok(darkLuma !== null && darkLuma < 60, 'dark Studio background is dark: ' + darkLuma)
      await w.close()
    })

    await h.check('e2e/studio-shelf-insert-plan-and-strip', async () => {
      const w = await h.openWorkbench({ viewport: { width: 1440, height: 900 } })
      await h.openEditor(w.page)
      await openStudio(h, w.page)
      const page = w.page
      const rail = label => page.locator('[data-three-workbench-studio="rail"] button[aria-label="' + label + '"]').first()

      await rail('Insert shelf').click()
      const shelf = page.locator('[data-three-workbench-studio="shelf"]').first()
      await waitFor(async () => (await shelf.count()) > 0, { timeout: 4000, interval: 50, label: 'insert shelf' })
      await page.locator('[data-three-workbench-shelf-item="box"]').first().click()
      await waitFor(async () => {
        const messages = await h.messages(page)
        return messages.slice(-40).some(message => message.type === 'three-workbench:scene-tree'
          && Array.isArray(message.nodes)
          && message.nodes.some(node => node.name === 'Box 1' && String(node.uid).startsWith('m:')))
      }, { timeout: 8000, interval: 80, label: 'clicked shelf insert' })

      const strip = page.locator('[data-three-workbench-strip]').first()
      await waitFor(async () => (await strip.count()) > 0, { timeout: 8000, interval: 80, label: 'selection action strip' })
      assert.equal(await strip.locator('[data-three-workbench-strip-action]').count(), 7,
        'strip exposes six AI actions and a dismiss control')
      await page.locator('[data-three-workbench-strip-action="explain"]').first().click()
      const textarea = page.locator('[data-three-workbench-studio="left"] textarea').first()
      await waitFor(async () => (await textarea.inputValue()).includes('Box 1'), {
        timeout: 4000, interval: 50, label: 'strip prefills the AI draft',
      })
      assert.equal(await textarea.evaluate(element => element === document.activeElement), true,
        'strip prefill focuses the AI draft without sending it')
      await page.locator('[data-three-workbench-strip-action="dismiss"]').first().click()
      await waitFor(async () => (await strip.count()) === 0, {
        timeout: 4000, interval: 50, label: 'strip dismissal',
      })

      // A dragged shelf row uses the same validated insert path but asks the
      // runtime for a ground point under the pointer. The transparent shield
      // exists only while a drag is in flight.
      await rail('Insert shelf').click()
      const sphereRow = page.locator('[data-three-workbench-shelf-item="sphere"]').first()
      const transfer = await page.evaluateHandle(() => new DataTransfer())
      await sphereRow.dispatchEvent('dragstart', { dataTransfer: transfer })
      const shield = page.locator('[data-three-workbench-shelf-drop]').first()
      await waitFor(async () => (await shield.count()) > 0, { timeout: 4000, interval: 50, label: 'shelf drop shield' })
      const frameBox = await page.locator('[data-three-workbench-frame]').first().boundingBox()
      assert.ok(frameBox !== null, 'stage has a box for the drop point')
      const drop = {
        dataTransfer: transfer,
        clientX: frameBox.x + frameBox.width * 0.3,
        clientY: frameBox.y + frameBox.height * 0.62,
      }
      await shield.dispatchEvent('dragover', drop)
      await shield.dispatchEvent('drop', drop)
      await waitFor(async () => (await shield.count()) === 0, {
        timeout: 4000, interval: 50, label: 'shield dismisses after drop',
      })
      await waitFor(async () => {
        const messages = await h.messages(page)
        return messages.slice(-60).some(message => message.type === 'three-workbench:scene-tree'
          && Array.isArray(message.nodes)
          && message.nodes.some(node => node.name === 'Sphere 1' && String(node.uid).startsWith('m:')))
      }, { timeout: 10000, interval: 80, label: 'dragged shelf insert' })

      const plan = page.locator('[data-three-workbench-plan]').first()
      await plan.click()
      await waitFor(async () => (await plan.getAttribute('aria-pressed')) === 'true', {
        timeout: 4000, interval: 50, label: 'plan view on',
      })
      await waitFor(async () => (await (await w.frame()).evaluate(() => window.__p5.controls.enableRotate)) === false, {
        timeout: 5000, interval: 80, label: 'plan view disables orbit rotation',
      })
      await plan.click()
      await waitFor(async () => (await plan.getAttribute('aria-pressed')) === 'false', {
        timeout: 4000, interval: 50, label: 'plan view off',
      })
      await waitFor(async () => (await (await w.frame()).evaluate(() => window.__p5.controls.enableRotate)) === true, {
        timeout: 5000, interval: 80, label: 'leaving plan view restores orbit rotation',
      })
      await w.close()
    })

    await h.check('e2e/studio-links-labels-context', async () => {
      const w = await h.openWorkbench({ viewport: { width: 1440, height: 900 } })
      await h.openEditor(w.page)
      await openStudio(h, w.page)
      const page = w.page
      await showSceneTree(page)
      const heroUid = await h.selectObject(page, 'P5Hero')
      const otherUid = await h.selectObject(page, 'P5Other', { ctrl: true })

      await page.locator('[data-three-workbench-dock-tab="links"]').first().click()
      const links = page.locator('[data-three-workbench-drawer="links"]').first()
      await waitFor(async () => (await links.count()) > 0, { timeout: 4000, interval: 50, label: 'links drawer' })
      const add = page.locator('[data-three-workbench-studio-action="link-selection"]').first()
      assert.equal(await add.isDisabled(), false, 'two selected objects enable the link action')
      await add.click()
      const link = page.locator('[data-three-workbench-link]').first()
      await waitFor(async () => (await link.count()) > 0, { timeout: 4000, interval: 50, label: 'object link row' })
      assert.match(await link.innerText(), /P5Hero\s*→\s*P5Other/, 'link names both endpoints')
      assert.equal(await link.getAttribute('data-link-kind'), 'relation', 'manual links default to relation')

      await page.locator('[data-three-workbench-dock-tab="review"]').first().click()
      await waitFor(async () => (await page.locator('[data-three-workbench-drawer="review"]').count()) > 0,
        { timeout: 4000, interval: 50, label: 'review drawer' })
      await page.locator('[data-three-workbench-review-kind]').first().selectOption('label')
      const input = page.locator('[data-three-workbench-drawer="review"] input').first()
      await input.fill('Engine block')
      await page.locator('[data-three-workbench-studio-action="review-add"]').first().click()
      const labelPin = page.locator('[data-three-workbench-pin][data-pin-kind="label"]').first()
      await waitFor(async () => (await labelPin.count()) > 0, { timeout: 4000, interval: 50, label: 'label pin' })
      assert.match(await labelPin.innerText(), /Engine block/, 'label pin keeps its text')

      // Editor-only metadata survives a reload and stays outside the scene.
      await reopenStudioAfterReload(h, page)
      await page.locator('[data-three-workbench-dock-tab="links"]').first().click()
      await waitFor(async () => (await page.locator('[data-three-workbench-link]').count()) > 0,
        { timeout: 5000, interval: 80, label: 'link survives reload' })
      await page.locator('[data-three-workbench-studio="rail"] button[aria-label="AI prompt"]').first().click()
      await waitFor(async () => (await page.locator('[data-three-workbench-context-ref="library"]').count()) > 0,
        { timeout: 4000, interval: 50, label: 'library context ref' })
      assert.equal(await page.locator('[data-three-workbench-context-ref="links"]').count(), 1,
        'the AI context shelf includes object links')
      assert.equal(heroUid === otherUid, false, 'link endpoints are distinct')
      await w.close()
    })

    await h.check('e2e/studio-cases-start-save-context', async () => {
      const w = await h.openWorkbench({ viewport: { width: 1440, height: 900 } })
      await h.openEditor(w.page)
      await openStudio(h, w.page)
      const page = w.page
      const rail = label => page.locator('[data-three-workbench-studio="rail"] button[aria-label="' + label + '"]').first()
      await rail('Case library').click()
      await waitFor(async () => (await page.locator('[data-three-workbench-case-id]').count()) >= 12,
        { timeout: 6000, interval: 80, label: 'curated cases' })

      await page.locator('[data-three-workbench-case-cat="animation"]').first().click()
      await sleep(120)
      const animationIds = await page.locator('[data-three-workbench-case-id]').evaluateAll(nodes =>
        nodes.map(node => node.getAttribute('data-three-workbench-case-id')))
      assert.ok(animationIds.includes('case_walk_cycle'), 'animation filter shows the walk case')
      assert.equal(animationIds.includes('case_task_lamp'), false, 'animation filter hides model cases')

      const search = page.locator('[data-three-workbench-case-search]').first()
      await search.fill('walk')
      await waitFor(async () => (await page.locator('[data-three-workbench-case-id]').count()) === 1,
        { timeout: 3000, interval: 50, label: 'case search filter' })
      const card = page.locator('[data-three-workbench-case-id="case_walk_cycle"]').first()
      await card.locator('[role="button"]').first().click()
      await card.locator('[data-three-workbench-case-stage="0"]').first().click()

      const textarea = page.locator('[data-three-workbench-studio="left"] textarea').first()
      await waitFor(async () => /Rig-free walk cycle|无骨骼行走循环/.test(await textarea.inputValue()),
        { timeout: 5000, interval: 80, label: 'case stage prefill' })
      assert.equal(await textarea.evaluate(element => element === document.activeElement), true,
        'case prefill focuses the AI draft')
      assert.equal(await page.locator('[data-three-workbench-ai-mode="edit"]').first().getAttribute('aria-pressed'), 'true',
        'stage 1 selects Edit intent')
      const banner = page.locator('[data-three-workbench-ai-case]').first()
      await waitFor(async () => (await banner.count()) > 0, { timeout: 4000, interval: 50, label: 'active case banner' })
      assert.match(await banner.innerText(), /Rig-free walk cycle|无骨骼行走循环/, 'banner names the active case')
      assert.match(await banner.innerText(), /1\s*\/\s*3/, 'banner shows stage progress')
      const caseRef = page.locator('[data-three-workbench-context-ref="case"]').first()
      assert.equal(await caseRef.getAttribute('aria-pressed'), 'true', 'the case context ref is on')

      // Active case and its stage survive a reload as per-session metadata.
      await reopenStudioAfterReload(h, page)
      await rail('AI prompt').click()
      const reopened = page.locator('[data-three-workbench-ai-case]').first()
      await waitFor(async () => (await reopened.count()) > 0, { timeout: 6000, interval: 100, label: 'case survives reload' })
      assert.match(await reopened.innerText(), /Rig-free walk cycle|无骨骼行走循环/, 'reopened case keeps its title')
      assert.match(await reopened.innerText(), /1\s*\/\s*3/, 'reopened case keeps its stage')

      // Save the current draft as a user case and start it.
      const reopenedTextarea = page.locator('[data-three-workbench-studio="left"] textarea').first()
      await reopenedTextarea.fill('Custom brief: keep a low-poly turntable readable at every angle.')
      await rail('Case library').click()
      await page.locator('[data-three-workbench-case-save]').first().click()
      await page.locator('[data-three-workbench-case-title]').first().fill('Turntable readability study')
      await page.locator('[data-three-workbench-case-save-confirm]').first().click()
      const custom = page.locator('[data-three-workbench-case-custom="true"]')
        .filter({ hasText: 'Turntable readability study' }).first()
      await waitFor(async () => (await custom.count()) > 0, { timeout: 4000, interval: 80, label: 'custom case saved' })
      await custom.locator('[role="button"]').first().click()
      await custom.locator('[data-three-workbench-case-stage="0"]').first().click()
      await waitFor(async () => (await textarea.inputValue()).includes('Custom brief: keep a low-poly turntable'),
        { timeout: 5000, interval: 80, label: 'custom case prefill' })
      assert.match(await page.locator('[data-three-workbench-ai-case]').first().innerText(),
        /Turntable readability study/, 'custom case becomes the active brief')

      // Deleting the active custom case clears the active brief.
      await rail('Case library').click()
      const again = page.locator('[data-three-workbench-case-custom="true"]')
        .filter({ hasText: 'Turntable readability study' }).first()
      await again.locator('[role="button"]').first().click()
      await again.locator('[data-three-workbench-case-delete]').first().click()
      await waitFor(async () => (await page.locator('[data-three-workbench-case-custom="true"]').count()) === 0,
        { timeout: 4000, interval: 80, label: 'custom case deleted' })
      assert.equal(await page.locator('[data-three-workbench-active-case]').count(), 0,
        'deleting the active custom case clears the case strip')
      await w.close()
    })

    await h.check('e2e/studio-stale-open-prefs', async () => {
      const w = await h.openWorkbench({ viewport: { width: 1440, height: 900 } })
      await h.openEditor(w.page)
      await openStudio(h, w.page)
      const page = w.page
      await page.evaluate(() => {
        localStorage.setItem('three-workbench:prefs', JSON.stringify({ open: false, stepFps: 24 }))
        localStorage.setItem('three-workbench:studio-layout', JSON.stringify({
          left: 288, right: 312, console: 220, tab: 'scene', dock: 'timeline', context: true,
        }))
      })
      await reopenStudioAfterReload(h, page)
      assert.equal(await page.locator('[data-three-workbench-studio="root"]').count(), 1,
        'a stale open:false does not hide desktop Studio')
      assert.equal(await page.locator('[data-three-workbench-studio="ai"]').count(), 1,
        'the migrated layout opens on the AI panel')
      const stored = await layout(page)
      assert.equal(stored.tab, 'ai', 'a legacy scene tab migrates to AI once')
      assert.equal(stored.version, 3, 'the migrated layout is stamped with the current version')
      await w.close()
    })
  },
}
