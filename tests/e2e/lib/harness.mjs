// Shared E2E harness: fresh Playwright contexts, fixture routes, protocol
// helpers, DOM gestures and per-check failure artifacts.
import path from 'node:path'
import { writeFailureArtifact } from './artifact.mjs'
import { collectorInit } from './collector.mjs'
import { installFixtureRoutes } from './fixture.mjs'
import { redactText, redactValue, safeError, safeRequestLabel } from './redact.mjs'

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Poll `probe` until it returns a truthy value. The probe may be async.
 * Throws a URL-free timeout error.
 */
export async function waitFor(probe, options = {}) {
  const timeout = options.timeout === undefined ? 10000 : options.timeout
  const interval = options.interval === undefined ? 100 : options.interval
  const label = options.label || 'condition'
  const deadline = Date.now() + timeout
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(interval)
  }
  const suffix = lastError ? ': ' + redactText(lastError.message || lastError) : ''
  throw new Error('Timed out after ' + timeout + 'ms waiting for ' + label + suffix)
}

export async function optionalWaitFor(probe, options = {}) {
  try {
    return await waitFor(probe, options)
  } catch {
    return null
  }
}

/** Shallow/deep-array message matcher used by waitMessageSince. */
export function matchesMessage(message, spec) {
  if (!message || typeof message !== 'object') return false
  for (const [key, expected] of Object.entries(spec)) {
    if (key === 'since') continue
    const actual = message[key]
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual) || actual.length !== expected.length) return false
      for (let index = 0; index < expected.length; index += 1) {
        if (actual[index] !== expected[index]) return false
      }
    } else if (expected !== actual) {
      return false
    }
  }
  return true
}

function pushLimited(list, value, limit = 20) {
  if (list.length < limit) list.push(value)
}

export class SkippedCheck extends Error {
  constructor(reason) {
    super(String(reason))
    this.name = 'SkippedCheck'
    this.reason = String(reason)
  }
}

export function skipCheck(reason) {
  throw new SkippedCheck(reason)
}

function inRange(value, expected, epsilon = 1e-6) {
  return typeof value === 'number' && Math.abs(value - expected) <= epsilon
}

export { inRange }

class WorkbenchHandle {
  constructor(harness, context, page, diagnostics, routeStats) {
    this.harness = harness
    this.context = context
    this.page = page
    this.diagnostics = diagnostics
    this.routeStats = routeStats
    this.closed = false
    this.frameCache = null
  }

  async frame() {
    if (this.closed) throw new Error('workbench handle is closed')
    const cached = this.frameCache
    if (cached) {
      try {
        if (await cached.evaluate(() => window.__p5Ready === true)) return cached
      } catch {
        // Frame detached.
      }
    }
    const frame = await this.harness.waitForProbeFrame(this.page, 30000)
    this.frameCache = frame
    return frame
  }

  async close() {
    if (this.closed) return
    this.closed = true
    await this.harness.closeHandle(this)
  }
}

class Harness {
  constructor(options) {
    this.browser = options.browser
    this.baseUrl = options.baseUrl
    this.shareUrl = options.shareUrl || null
    this.runDir = options.runDir
    this.mode = options.mode || 'live'
    this.results = []
    this.contexts = new Set()
    this.handles = new Set()
    this.currentPage = null
    this.diagnostics = new WeakMap()
    this.routeStats = new WeakMap()
    this.uidCache = new WeakMap()
    this.counter = 0
    this.startedAt = Date.now()
  }

  rememberPage(page) {
    this.currentPage = page
  }

  trackContext(context) {
    this.contexts.add(context)
    return context
  }

  async check(id, fn) {
    const started = Date.now()
    try {
      const value = await fn(this)
      if (value && value.page) this.rememberPage(value.page)
      const ms = Date.now() - started
      this.results.push({ id, status: 'PASS', ms })
      console.log('PASS ' + id + ' (' + ms + ' ms)')
    } catch (error) {
      if (error instanceof SkippedCheck) {
        this.results.push({ id, status: 'SKIP', reason: error.reason })
        console.log('SKIP ' + id + ' - ' + error.reason)
        return
      }
      const ms = Date.now() - started
      const safe = safeError(error)
      const details = await this.collectDetails()
      const artifacts = await writeFailureArtifact({
        runDir: this.runDir,
        id,
        error,
        page: this.currentPage,
        details,
      })
      this.results.push({ id, status: 'FAIL', ms, error: safe, artifacts })
      console.log('FAIL ' + id + ' (' + ms + ' ms) - ' + safe.message)
      if (artifacts.jsonPath) console.log('     artifact: ' + artifacts.jsonPath)
      if (artifacts.pngPath) console.log('     screenshot: ' + artifacts.pngPath)
    } finally {
      // Every check owns a fresh context; close it only after a failure
      // screenshot has been captured.
      await this.closeContexts()
    }
  }

  skip(id, reason) {
    this.results.push({ id, status: 'SKIP', reason: String(reason) })
    console.log('SKIP ' + id + ' - ' + String(reason))
  }

  async specFailure(name, error) {
    const safe = safeError(error)
    const details = await this.collectDetails()
    const artifacts = await writeFailureArtifact({
      runDir: this.runDir,
      id: 'spec-' + name,
      error,
      page: this.currentPage,
      details,
    })
    this.results.push({ id: 'spec-' + name, status: 'FAIL', error: safe, artifacts })
    console.log('FAIL spec-' + name + ' - ' + safe.message)
    if (artifacts.jsonPath) console.log('     artifact: ' + artifacts.jsonPath)
  }

  async collectDetails() {
    const details = {
      mode: this.mode,
      messages: null,
      inbound: null,
      probe: null,
      pageErrors: [],
      consoleErrors: [],
      failedRequests: [],
      routes: null,
    }
    const page = this.currentPage
    if (!page || page.isClosed()) return details
    const diagnostics = this.diagnostics.get(page)
    if (diagnostics) {
      details.pageErrors = diagnostics.pageErrors.slice(0, 20)
      details.consoleErrors = diagnostics.consoleErrors.slice(0, 20)
      details.failedRequests = diagnostics.failedRequests.slice(0, 20)
    }
    const routes = this.routeStats.get(page)
    if (routes) details.routes = { ...routes }
    try {
      details.messages = await page.evaluate(() => {
        if (!window.__e2e) return null
        return {
          types: window.__e2e.types,
          messages: window.__e2e.messages.slice(-80),
          errors: window.__e2e.errors.slice(0, 20),
          readies: window.__e2e.readies,
        }
      })
    } catch {
      details.messages = null
    }
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue
      try {
        const inbound = await frame.evaluate(() => (window.__e2eInbound || []).slice(-40))
        if (inbound.length > 0) details.inbound = inbound
      } catch {
        // Detached frame.
      }
      try {
        const probe = await frame.evaluate(() => (window.__p5 && typeof window.__p5.read === 'function') ? window.__p5.read() : null)
        if (probe) details.probe = probe
      } catch {
        // Not the runtime frame.
      }
    }
    return details
  }

  async newRawPage(options = {}) {
    const context = await this.browser.newContext({
      viewport: options.viewport || { width: 1440, height: 900 },
      locale: 'en-US',
    })
    this.trackContext(context)
    await context.addInitScript(collectorInit)
    const page = await context.newPage()
    this.rememberPage(page)
    const diagnostics = { pageErrors: [], consoleErrors: [], failedRequests: [] }
    this.diagnostics.set(page, diagnostics)
    page.on('pageerror', error => pushLimited(diagnostics.pageErrors, redactText(error.message).slice(0, 500)))
    page.on('console', message => {
      if (message.type() === 'error') pushLimited(diagnostics.consoleErrors, redactText(message.text()).slice(0, 500))
    })
    page.on('requestfailed', request => pushLimited(diagnostics.failedRequests, safeRequestLabel(request)))
    return { context, page, diagnostics }
  }

  async openWorkbench(options = {}) {
    const { context, page, diagnostics } = await this.newRawPage(options)
    const routeStats = await installFixtureRoutes(page)
    this.routeStats.set(page, routeStats)
    const timeout = options.timeout || 45000
    await page.goto(this.baseUrl, { waitUntil: 'domcontentloaded', timeout })
    await waitFor(async () => (await page.locator('[data-row-key^="session:"]').count()) > 0, {
      timeout: 30000,
      interval: 250,
      label: 'Host session list',
    })
    const rows = page.locator('[data-row-key^="session:"]').filter({ hasNotText: 'New Session' })
    const rowCount = await rows.count()
    if (rowCount === 0) throw new Error('Host session list has no existing session rows')
    let opened = false
    for (let index = 0; index < Math.min(rowCount, 6) && !opened; index += 1) {
      const row = page.locator('[data-row-key^="session:"]').filter({ hasNotText: 'New Session' }).nth(index)
      if ((await row.count()) === 0) break
      await row.click({ timeout: 8000 }).catch(() => {})
      const frame = await optionalWaitFor(
        async () => (await page.locator('[data-three-workbench-frame]').count()) > 0,
        { timeout: 9000, interval: 250, label: 'workbench frame' },
      )
      if (frame) opened = true
    }
    if (!opened) {
      const header = page.locator('[data-three-workbench-header-open]').first()
      if ((await header.count()) > 0) {
        await header.click({ timeout: 5000 }).catch(() => {})
        opened = await optionalWaitFor(
          async () => (await page.locator('[data-three-workbench-frame]').count()) > 0,
          { timeout: 12000, interval: 250, label: 'workbench frame after header' },
        )
      }
    }
    if (!opened) {
      throw new Error('no existing Three.js workbench preview was found in this Host session list; the E2E harness does not create sessions')
    }
    await waitFor(async () => page.evaluate(() => Boolean(window.__e2e && window.__e2e.readies > 0)), {
      timeout: 30000,
      interval: 200,
      label: 'three-workbench:ready',
    })
    const frame = await this.waitForProbeFrame(page, 45000)
    await waitFor(async () => {
      try {
        return await frame.evaluate(() => window.__p5 && window.__p5Ready === true && window.__p5.frames() > 0)
      } catch {
        return false
      }
    }, { timeout: 20000, interval: 150, label: 'runtime fixture frames' })
    const handle = new WorkbenchHandle(this, context, page, diagnostics, routeStats)
    handle.frameCache = frame
    this.handles.add(handle)
    this.rememberPage(page)
    return handle
  }

  async waitForProbeFrame(page, timeout = 30000) {
    return waitFor(async () => {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue
        try {
          if (await frame.evaluate(() => window.__p5Ready === true)) return frame
        } catch {
          // Detached or not the runtime.
        }
      }
      return null
    }, { timeout, interval: 250, label: 'runtime fixture probe' })
  }

  async closeHandle(handle) {
    this.handles.delete(handle)
    this.contexts.delete(handle.context)
    try {
      await handle.context.close()
    } catch {
      // Already gone.
    }
  }

  async closeContexts() {
    for (const handle of Array.from(this.handles)) await this.closeHandle(handle)
    for (const context of Array.from(this.contexts)) {
      try {
        await context.close()
      } catch {
        // Already gone.
      }
      this.contexts.delete(context)
    }
  }

  async openEditor(page) {
    const toolbar = page.locator('[data-three-workbench-gizmo-toolbar]')
    if ((await toolbar.count()) > 0) return
    // Studio is the default surface: the editor is always on once a record is
    // loaded, so just wait for the transform toolbar instead of hunting for
    // the retired Edit toggle.
    if ((await page.locator('[data-three-workbench-studio="root"]').count()) > 0) {
      await waitFor(async () => (await toolbar.count()) > 0,
        { timeout: 10000, interval: 100, label: 'editor toolbar' })
      return
    }
    const edit = page.locator('[data-three-workbench-presentation] button[aria-label="Edit"], [data-three-workbench-presentation] button[title="Edit"]').first()
    if ((await edit.count()) === 0) {
      const header = page.locator('[data-three-workbench-header-open]').first()
      if ((await header.count()) > 0) await header.click({ timeout: 5000 }).catch(() => {})
    }
    const editNow = page.locator('[data-three-workbench-presentation] button[aria-label="Edit"], [data-three-workbench-presentation] button[title="Edit"]').first()
    if ((await editNow.count()) > 0) await editNow.click({ timeout: 5000 })
    await waitFor(async () => (await toolbar.count()) > 0, { timeout: 10000, interval: 100, label: 'editor toolbar' })
  }

  async openTab(page, name) {
    await this.openEditor(page)
    // Studio has no tab strip: the scene tree and parameters are rail modes,
    // and the Inspector is the permanently mounted right panel.
    if ((await page.locator('[data-three-workbench-studio="root"]').count()) > 0) {
      if (name === 'Inspector') {
        await sleep(100)
        return
      }
      const railLabel = name === 'Scene' ? 'Scene tree' : name
      const rail = page.locator('[data-three-workbench-studio="rail"] button[aria-label="' + railLabel + '"]').first()
      if ((await rail.count()) === 0) throw new Error('studio rail mode not found: ' + name)
      await rail.click()
      await sleep(150)
      return
    }
    const exact = new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')
    let button = page.locator('[data-three-workbench-presentation="desktop"] button').filter({ hasText: exact }).first()
    if ((await button.count()) === 0) button = page.getByRole('button', { name, exact: true }).first()
    if ((await button.count()) === 0) throw new Error('editor tab not found: ' + name)
    await button.click()
    await sleep(150)
  }

  async messages(page) {
    if (!page || page.isClosed()) return []
    try {
      return await page.evaluate(() => (window.__e2e ? window.__e2e.messages : []))
    } catch {
      return []
    }
  }

  async messageCount(page) {
    return (await this.messages(page)).length
  }

  async readies(page) {
    try {
      return await page.evaluate(() => (window.__e2e ? window.__e2e.readies : 0))
    } catch {
      return 0
    }
  }

  async waitMessageSince(page, since, spec, timeout = 8000) {
    if (typeof since !== 'number') throw new Error('waitMessageSince requires a baseline message count')
    const found = await waitFor(async () => {
      const messages = await this.messages(page)
      const slice = messages.slice(since)
      return slice.find(message => matchesMessage(message, spec)) || null
    }, { timeout, interval: 50, label: 'message ' + (spec.type || 'match') })
    return found
  }

  async waitAnyMessageSince(page, since, timeout = 8000) {
    return waitFor(async () => {
      const messages = await this.messages(page)
      return messages.length > since ? messages.slice(since) : null
    }, { timeout, interval: 50, label: 'any three-workbench message' })
  }

  async sendCommand(page, command) {
    const payload = Object.assign({ type: 'three-workbench:command' }, command)
    await page.evaluate(cmd => {
      const frame = document.querySelector('[data-three-workbench-frame]')
      if (!frame || !frame.contentWindow) throw new Error('workbench frame is unavailable')
      frame.contentWindow.postMessage(cmd, '*')
    }, payload)
  }

  /**
   * Send a timeline action and return the runtime's report for that command.
   *
   * Timeline reports carry no request id and play mode also broadcasts a
   * report every 250 ms, so a naive "first message after send" can return a
   * stale background report. Wait until the runtime frame has actually
   * received the command, then read the newest report stamped at or after
   * that receipt.
   */
  async timeline(page, action, timeout = 5000) {
    const since = await this.messageCount(page)
    const inboundSince = (await this.inbound(page)).length
    await this.sendCommand(page, Object.assign({ command: 'timeline' }, action))
    const command = await waitFor(async () => {
      const inbound = await this.inbound(page)
      return inbound.length > inboundSince ? inbound[inbound.length - 1] : null
    }, { timeout, interval: 25, label: 'runtime receives timeline command' })
    return waitFor(async () => {
      const reports = (await this.messages(page)).slice(since)
        .filter(message => message.type === 'three-workbench:timeline'
          && typeof message.at === 'number' && message.at >= command.at)
      return reports.length > 0 ? reports[reports.length - 1] : null
    }, { timeout, interval: 25, label: 'timeline report for command' })
  }

  async postFromFrame(page, payload) {
    const frame = await this.waitForProbeFrame(page, 10000)
    await frame.evaluate(message => {
      window.parent.postMessage(message, '*')
    }, payload)
  }

  async inbound(page) {
    const frame = await this.waitForProbeFrame(page, 10000)
    try {
      return await frame.evaluate(() => (window.__e2eInbound || []).slice())
    } catch {
      return []
    }
  }

  async probeRead(page) {
    const frame = await this.waitForProbeFrame(page, 10000)
    return frame.evaluate(() => window.__p5.read())
  }

  async probeCall(page, method, arg) {
    const frame = await this.waitForProbeFrame(page, 10000)
    if (typeof arg === 'undefined') {
      return frame.evaluate(name => window.__p5[name](), method)
    }
    return frame.evaluate(([name, value]) => window.__p5[name](value), [method, arg])
  }

  async resolveUid(page, name) {
    let cache = this.uidCache.get(page)
    if (!cache) {
      cache = new Map()
      this.uidCache.set(page, cache)
    }
    if (cache.has(name)) return cache.get(name)
    const requestId = this.nextId('tree')
    const since = await this.messageCount(page)
    await this.sendCommand(page, { command: 'scene-tree', requestId })
    const message = await this.waitMessageSince(page, since, { type: 'three-workbench:scene-tree', requestId }, 8000)
    const node = Array.isArray(message.nodes) ? message.nodes.find(entry => entry && entry.name === name) : null
    if (!node || typeof node.uid !== 'string') throw new Error('scene-tree has no node named ' + name)
    cache.set(name, node.uid)
    return node.uid
  }

  nextId(prefix) {
    this.counter += 1
    return 'e2e-' + prefix + '-' + String(this.counter)
  }

  /**
   * Return the outliner row element for `name`. Playwright's element click
   * waits for actionability (stable box, visible, receives events), which is
   * more reliable than clicking a previously measured viewport coordinate when
   * the dock re-renders after a selection switches to the Inspector tab.
   */
  async rowHandle(page, name) {
    await this.openTab(page, 'Scene')
    return waitFor(async () => {
      const handle = await page.evaluateHandle(nodeName => {
        const root = document.querySelector('[data-three-workbench-presentation="desktop"]') || document
        const spans = Array.from(root.querySelectorAll('span')).filter(span => span.textContent.trim() === nodeName)
        for (const span of spans) {
          let current = span
          while (current && current !== document.body) {
            const style = current.style
            if (style && style.display === 'flex' && style.paddingLeft !== '') {
              current.scrollIntoView({ block: 'center', inline: 'nearest' })
              const rect = current.getBoundingClientRect()
              if (rect.width > 4 && rect.height > 4) return current
            }
            current = current.parentElement
          }
        }
        return null
      }, name)
      const element = handle.asElement()
      if (element !== null) return element
      await handle.dispose().catch(() => {})
      return null
    }, { timeout: 8000, interval: 100, label: 'outliner row ' + name })
  }

  async selectObject(page, name, options = {}) {
    const uid = await this.resolveUid(page, name)
    const row = await this.rowHandle(page, name)
    const since = await this.messageCount(page)
    try {
      await row.click({
        modifiers: options.ctrl === true ? ['Control'] : [],
        timeout: options.timeout || 8000,
      })
    } finally {
      await row.dispose().catch(() => {})
    }
    await waitFor(async () => {
      const messages = await this.messages(page)
      return messages.slice(since).some(message => {
        if (message.type !== 'three-workbench:selection') return false
        if (options.expectAbsent === true) {
          return Array.isArray(message.uids) && !message.uids.includes(uid)
        }
        if (!Array.isArray(message.uids) || !message.uids.includes(uid)) return false
        if (options.ctrl !== true) return message.primary === uid
        return true
      })
    }, { timeout: options.timeout || 8000, interval: 50, label: 'selection change for ' + name })
    return uid
  }

  async clickCanvas(page, fx, fy) {
    const frame = await this.waitForProbeFrame(page, 10000)
    const canvas = frame.locator('canvas').first()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('runtime canvas has no bounding box')
    await canvas.click({ position: { x: Math.max(1, Math.min(box.width - 1, fx * box.width)), y: Math.max(1, Math.min(box.height - 1, fy * box.height)) } })
  }

  async clickWorld(page, name) {
    const screen = await this.probeCall(page, 'screen', name)
    if (!screen || screen.visible !== true) throw new Error('object is off-screen: ' + name)
    const since = await this.messageCount(page)
    await this.clickCanvas(page, screen.fx, screen.fy)
    return since
  }

  async ensureMoveMode(page) {
    await this.openEditor(page)
    const button = page.locator('[data-three-workbench-gizmo-toolbar] button[data-three-workbench-gizmo="move"]').first()
    if ((await button.count()) === 0) throw new Error('move gizmo button not found')
    // Active state is style-only in the product UI; clicking translate is
    // idempotent, so assert the button exists and select the mode.
    await button.click()
    await sleep(120)
  }

  /**
   * Locate the red X handle in the canvas by decode-counting pixels in a
   * screenshot. Returns page coordinates plus the screenshot dimensions.
   */
  async redHandlePoint(page) {
    await this.ensureMoveMode(page)
    const frame = await this.waitForProbeFrame(page, 10000)
    const canvas = frame.locator('canvas').first()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('runtime canvas has no bounding box')
    let last = null
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const buffer = await canvas.screenshot()
      const analysis = await frame.evaluate(async dataUrl => {
        const image = new Image()
        image.src = dataUrl
        await image.decode()
        const off = document.createElement('canvas')
        off.width = image.width
        off.height = image.height
        const context = off.getContext('2d', { willReadFrequently: true })
        context.drawImage(image, 0, 0)
        const pixels = context.getImageData(0, 0, off.width, off.height).data
        let count = 0
        let sumX = 0
        let sumY = 0
        let maxX = -1
        let tipCount = 0
        let tipSumX = 0
        let tipSumY = 0
        for (let y = 0; y < off.height; y += 1) {
          for (let x = 0; x < off.width; x += 1) {
            const offset = (y * off.width + x) * 4
            const red = pixels[offset]
            const green = pixels[offset + 1]
            const blue = pixels[offset + 2]
            if (red > 185 && green < 135 && blue < 135) {
              count += 1
              sumX += x
              sumY += y
              if (x > maxX) maxX = x
            }
          }
        }
        for (let y = 0; y < off.height; y += 1) {
          for (let x = Math.max(0, maxX - 6); x <= maxX; x += 1) {
            const offset = (y * off.width + x) * 4
            if (pixels[offset] > 185 && pixels[offset + 1] < 135 && pixels[offset + 2] < 135) {
              tipCount += 1
              tipSumX += x
              tipSumY += y
            }
          }
        }
        return {
          width: off.width,
          height: off.height,
          count,
          centerX: count > 0 ? sumX / count : 0,
          centerY: count > 0 ? sumY / count : 0,
          tipX: tipCount > 0 ? tipSumX / tipCount : maxX,
          tipY: tipCount > 0 ? tipSumY / tipCount : 0,
          maxX,
        }
      }, 'data:image/png;base64,' + buffer.toString('base64'))
      last = analysis
      if (analysis.count >= 24) {
        return {
          x: box.x + (analysis.tipX / analysis.width) * box.width,
          y: box.y + (analysis.tipY / analysis.height) * box.height,
          count: analysis.count,
          screenshotWidth: analysis.width,
          screenshotHeight: analysis.height,
        }
      }
      await sleep(180)
    }
    throw new Error('red gizmo handle not found (best pixel count ' + (last ? last.count : 0) + ')')
  }

  async dragGizmo(page, options = {}) {
    const dx = options.dx === undefined ? 60 : options.dx
    const dy = options.dy === undefined ? 0 : options.dy
    const steps = options.steps === undefined ? 7 : options.steps
    const point = await this.redHandlePoint(page)
    const since = await this.messageCount(page)
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    for (let index = 1; index <= steps; index += 1) {
      await page.mouse.move(point.x + (dx * index) / steps, point.y + (dy * index) / steps)
      await sleep(14)
    }
    await page.mouse.up()
    const commit = await this.waitMessageSince(page, since, { type: 'three-workbench:gizmo-commit' }, 8000)
    if (commit.cancelled === true) throw new Error('gizmo commit was unexpectedly cancelled')
    return { point, commit, since, messages: (await this.messages(page)).slice(since) }
  }

  /**
   * Start a real gizmo drag and cancel it with a window blur. The caller must
   * close the handle without releasing the mouse button.
   */
  async cancelGizmoViaBlur(page) {
    const point = await this.redHandlePoint(page)
    const since = await this.messageCount(page)
    await page.mouse.move(point.x, point.y)
    await page.mouse.down()
    for (let index = 1; index <= 4; index += 1) {
      await page.mouse.move(point.x + index * 9, point.y)
      await sleep(16)
    }
    const frame = await this.waitForProbeFrame(page, 10000)
    await frame.evaluate(() => {
      window.dispatchEvent(new Event('blur'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const commit = await this.waitMessageSince(page, since, { type: 'three-workbench:gizmo-commit' }, 6000)
    return { point, commit, since }
  }

  async clickUndo(page) {
    const button = page.locator('button[aria-label="Undo"]').first()
    await waitFor(async () => (await button.count()) > 0 && await button.isEnabled(), {
      timeout: 5000,
      interval: 80,
      label: 'enabled Undo button',
    })
    await button.click()
  }

  async clickRedo(page) {
    const button = page.locator('button[aria-label="Redo"]').first()
    await waitFor(async () => (await button.count()) > 0 && await button.isEnabled(), {
      timeout: 5000,
      interval: 80,
      label: 'enabled Redo button',
    })
    await button.click()
  }

  async clickResetAll(page) {
    const button = page.locator('button[aria-label="Reset all tweaks"]').first()
    await waitFor(async () => (await button.count()) > 0 && await button.isEnabled(), {
      timeout: 5000,
      interval: 80,
      label: 'enabled Reset all tweaks button',
    })
    const readies = await this.readies(page)
    await button.click()
    await waitFor(async () => (await this.readies(page)) > readies, {
      timeout: 20000,
      interval: 150,
      label: 'runtime reload after Reset all tweaks',
    })
    await this.waitForProbeFrame(page, 30000)
  }

  async paletteItems(page) {
    return page.evaluate(() => {
      const out = []
      for (const button of document.querySelectorAll('button')) {
        if (button.offsetParent === null) continue
        const text = (button.textContent || '').trim()
        if (text !== '') out.push(text)
      }
      return out
    })
  }

  async openPalette(page) {
    await page.evaluate(() => {
      if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur()
    })
    await page.keyboard.press('Control+k')
    const input = page.locator('input[aria-label="Command palette"]')
    await input.waitFor({ state: 'visible', timeout: 5000 })
    return input
  }

  /** Run one palette entry by typing a query and pressing Enter. */
  async runPalette(page, query) {
    const input = await this.openPalette(page)
    await input.fill(query)
    await sleep(200)
    const items = await this.paletteItems(page)
    if (!items.some(text => text.toLowerCase().includes(query.toLowerCase()))) {
      await page.keyboard.press('Escape').catch(() => {})
      throw new Error('palette query matched no item: ' + query)
    }
    await page.keyboard.press('Enter')
    await waitFor(async () => {
      if ((await input.count()) === 0) return true
      return !(await input.isVisible().catch(() => false))
    }, { timeout: 5000, interval: 80, label: 'palette close' })
  }

  async canvasStatistics(page) {
    const frame = await this.waitForProbeFrame(page, 10000)
    const canvas = frame.locator('canvas').first()
    const buffer = await canvas.screenshot()
    const stats = await page.evaluate(async dataUrl => {
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
      return {
        width: off.width,
        height: off.height,
        colors: buckets.size,
        mean,
        variance: sumSquares / total - mean * mean,
      }
    }, 'data:image/png;base64,' + buffer.toString('base64'))
    return {
      width: stats.width,
      height: stats.height,
      colors: stats.colors,
      mean: stats.mean,
      variance: stats.variance,
    }
  }

  async screenshotBase64(page) {
    const frame = await this.waitForProbeFrame(page, 10000)
    const canvas = frame.locator('canvas').first()
    const buffer = await canvas.screenshot()
    return buffer.toString('base64')
  }

  /** Fraction of pixels that differ materially between two PNG screenshots. */
  async imageDifference(page, firstBase64, secondBase64) {
    return page.evaluate(async ([firstUrl, secondUrl]) => {
      const load = async url => {
        const image = new Image()
        image.src = url
        await image.decode()
        const off = document.createElement('canvas')
        off.width = image.width
        off.height = image.height
        const context = off.getContext('2d', { willReadFrequently: true })
        context.drawImage(image, 0, 0)
        return { width: off.width, height: off.height, data: context.getImageData(0, 0, off.width, off.height).data }
      }
      const first = await load(firstUrl)
      const second = await load(secondUrl)
      if (first.width !== second.width || first.height !== second.height) return { changed: 1, total: 1, fraction: 1 }
      let changed = 0
      const total = first.width * first.height
      for (let offset = 0; offset < first.data.length; offset += 4) {
        const delta = Math.abs(first.data[offset] - second.data[offset])
          + Math.abs(first.data[offset + 1] - second.data[offset + 1])
          + Math.abs(first.data[offset + 2] - second.data[offset + 2])
        if (delta > 18) changed += 1
      }
      return { changed, total, fraction: changed / total }
    }, ['data:image/png;base64,' + firstBase64, 'data:image/png;base64,' + secondBase64])
  }

  async writeArtifactPath(relative) {
    return path.join(this.runDir, relative)
  }
}

export function createHarness(options) {
  return new Harness(options)
}

export { redactText, redactValue, safeError }
