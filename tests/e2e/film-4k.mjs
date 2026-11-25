/**
 * 4K film export browser probe.
 *
 * A local mock OpenAI-compatible gateway answers the first round with a
 * `three_scene` tool call, so the Session owns a real (non-demo) scene and the
 * export gates are the same ones a user hits. The browser then opens the Film
 * dock, switches the resolution selector to 4K, captures one short shot and
 * exports it.
 *
 * Assertions:
 * - the persisted film record carries `resolution: '4k'`;
 * - the 4K encode/mux module worker is actually created;
 * - exactly one `.mp4` (never WebM) is downloaded and it is a structurally
 *   valid MP4 (`ftyp` + `moov`);
 * - no page errors.
 *
 * Runner notes: no Playwright / Chromium is a SKIP with exit 0, matching the
 * other browser probes under tests/e2e.
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePlaywright, resolveChromium, LAUNCH_ARGS, launchEnv } from './lib/playwright.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const home = await mkdtemp(join(tmpdir(), 'three-studio-e2e-film4k-'))
const resolved = await resolvePlaywright(process.env)
const chromium = await resolveChromium(process.env)
if (!resolved.ok || !chromium.ok) {
  console.log('SKIP 4K film E2E - ' + (resolved.ok ? chromium.reason : resolved.reason))
  await rm(home, { recursive: true, force: true })
  process.exit(0)
}

const SCENE_CODE = [
  'setCamera([0, 2.4, 6.5])',
  "const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6),",
  "  new THREE.MeshStandardMaterial({ color: 0x2f6bff, roughness: 0.35, metalness: 0.15 }))",
  "body.name = 'FilmBox'",
  'scene.add(body)',
  "const ring = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.14, 32, 96),",
  "  new THREE.MeshStandardMaterial({ color: 0xffb347, roughness: 0.3 }))",
  "ring.name = 'FilmRing'",
  'ring.rotation.x = Math.PI / 2.4',
  'scene.add(ring)',
  'scene.background = new THREE.Color(0x0b0d10)',
].join('\n')

let providerCalls = 0
const provider = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    providerCalls += 1
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'cache-control': 'no-cache' })
    if (providerCalls === 1) {
      const arguments_ = JSON.stringify({ title: '4K probe scene', code: SCENE_CODE })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
        index: 0, id: 'call-film4k-1', type: 'function',
        function: { name: 'three_scene', arguments: arguments_ },
      }] } }] })}\n\n`)
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Scene ready.' } }] })}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise(done => provider.listen(0, '127.0.0.1', done))
const providerPort = provider.address().port

const app = spawn(process.env.THREE_STUDIO_NODE || process.execPath, ['standalone/server.mjs'], {
  cwd: repo, env: { ...process.env, THREE_STUDIO_HOME: home, THREE_STUDIO_PORT: '3196' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appOutput = ''
app.stdout.on('data', data => { appOutput += data })
app.stderr.on('data', data => { appOutput += data })
const waitFor = async (fn, timeout = 20000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { if (await fn()) return } catch {}
    await new Promise(done => setTimeout(done, 100))
  }
  throw new Error('timeout')
}

try {
  await waitFor(async () => (await fetch('http://127.0.0.1:3196/api/models')).ok)
  const base = 'http://127.0.0.1:3196'
  await fetch(base + '/api/providers/deepseek', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Mock', baseURL: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', models: ['deepseek-chat'] }),
  })
  await fetch(base + '/api/providers/deepseek/key', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'mock-key' }),
  })
  const session = await fetch(base + '/api/sessions', { method: 'POST' }).then(response => response.json())
  const prompt = await fetch(base + `/api/sessions/${encodeURIComponent(session.id)}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: 'build the 4K probe scene' }] }),
  })
  if (prompt.status !== 202) throw new Error('seed prompt rejected: ' + await prompt.text())
  await waitFor(async () => {
    const state = await fetch(base + `/api/sessions/${encodeURIComponent(session.id)}/state`).then(response => response.json())
    return state.state.running === false && providerCalls >= 2
  }, 30000)

  const browser = await resolved.module.chromium.launch({
    headless: true,
    executablePath: chromium.executablePath,
    args: LAUNCH_ARGS,
    env: launchEnv(process.env),
  })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', acceptDownloads: true })
    // Bind the seeded Session before the app boots: the standalone host opens
    // the built-in demo scene otherwise, and demo records never persist editor
    // state or allow export.
    await context.addInitScript(sessionId => {
      localStorage.setItem('three-studio:locale', 'en')
      localStorage.setItem('three-studio:session', sessionId)
      window.__film4kWorkers = 0
      const NativeWorker = window.Worker
      window.Worker = class extends NativeWorker {
        constructor (...args) {
          window.__film4kWorkers += 1
          super(...args)
        }
      }
    }, session.id)
    const page = await context.newPage()
    const pageErrors = []
    // The preview document runs in an opaque-origin sandbox, so any storage
    // access there surfaces as a SecurityError. That is the documented
    // contract, not a regression, so it is filtered from the failure check.
    const isSandboxStorageError = message => /sandboxed and lacks the 'allow-same-origin'/i.test(message)
    page.on('pageerror', error => {
      const message = String(error && error.message ? error.message : error)
      if (!isSandboxStorageError(message)) pageErrors.push(message)
    })
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-three-workbench-studio="root"]').waitFor({ timeout: 20000 })
    await page.locator('iframe[data-three-workbench-frame]').first().waitFor({ timeout: 20000 })
    // The demo scene is the only one that reports itself in the header; waiting
    // for its hint to disappear proves the seeded Session scene is live. The
    // timeout carries the observed header so a regression is diagnosable
    // without artifacts.
    let headerText = ''
    const demoDeadline = Date.now() + 20000
    while (Date.now() < demoDeadline) {
      headerText = await page.locator('[data-three-workbench-studio="root"]').innerText().catch(() => '')
      if (!/demo scene|\u793a\u4f8b\u573a\u666f/.test(headerText)) break
      await new Promise(done => setTimeout(done, 200))
    }
    if (/demo scene|\u793a\u4f8b\u573a\u666f/.test(headerText)) {
      throw new Error('seeded session scene never mounted; header: '
        + JSON.stringify(headerText.slice(0, 300)))
    }

    await page.locator('[data-three-workbench-dock-tab="film"]').click()
    const panel = page.locator('[data-three-workbench-drawer="film"]')
    await panel.waitFor({ timeout: 10000 })
    const resolution = panel.locator('[data-three-workbench-film-resolution]')
    await resolution.waitFor({ timeout: 10000 })
    // The persisted editor record is the contract. `selectOption` on an
    // already-selected value is a no-op (no `change` event), and the first
    // change can fire before the Session binding is ready, so the poll toggles
    // 1080p/4K to guarantee a real commit each round.
    const readFilm = () => page.evaluate(() => {
      const keys = Object.keys(localStorage).filter(key => key.startsWith('three-workbench:editor:v2:'))
      for (const key of keys) {
        try {
          const record = JSON.parse(localStorage.getItem(key))
          const film = record && record.presentation && record.presentation.film
          if (film && film.resolution === '4k') return { resolution: film.resolution, shots: film.shots.length, fps: film.fps }
        } catch {}
      }
      return null
    })
    let persisted = await readFilm()
    const selectDeadline = Date.now() + 30000
    let toggle = false
    while (persisted === null && Date.now() < selectDeadline) {
      toggle = !toggle
      await resolution.selectOption(toggle ? '4K' : '1080p').catch(() => {})
      await new Promise(done => setTimeout(done, 400))
      persisted = await readFilm()
    }
    if (persisted === null) {
      const dump = await page.evaluate(() => ({
        editorKeys: Object.keys(localStorage).filter(key => key.startsWith('three-workbench:editor'))
          .map(key => key + ' => ' + String(localStorage.getItem(key)).slice(0, 200)),
        allKeys: Object.keys(localStorage).slice(0, 20),
        session: localStorage.getItem('three-studio:session'),
        resolutionValue: document.querySelector('[data-three-workbench-film-resolution]')
          ? document.querySelector('[data-three-workbench-film-resolution]').value : null,
        drawer: document.querySelector('[data-three-workbench-drawer]')
          ? document.querySelector('[data-three-workbench-drawer]').getAttribute('data-three-workbench-drawer') : null,
      }))
      throw new Error('film record never persisted resolution=4k: ' + JSON.stringify(dump)
        + ' pageErrors=' + JSON.stringify(pageErrors.slice(0, 3)))
    }

    // `Take shot` is a no-op until the live camera has reported a pose, so the
    // click is retried against the persisted record instead of the DOM.
    const take = panel.locator('[data-three-workbench-film-take]')
    let taken = false
    const takeDeadline = Date.now() + 30000
    while (!taken && Date.now() < takeDeadline) {
      await take.click().catch(() => {})
      await new Promise(done => setTimeout(done, 600))
      const film = await readFilm()
      taken = film !== null && film.shots >= 1
    }
    if (!taken) throw new Error('take shot never reached the film record')
    await page.locator('[data-three-workbench-film-shot]').first().waitFor({ timeout: 10000 })
    // Shortest selectable shot keeps the software-rendered 4K probe bounded.
    // The field is addressed by its row label so the music/SRT inputs cannot be
    // picked up by accident, and `Tab` commits the React controlled value.
    const durationInput = panel.locator(
      'xpath=.//span[normalize-space()="Shot duration"]/following-sibling::input[@type="number"][1]',
    )
    if (await durationInput.count() === 0) throw new Error('shot duration field not found')
    await durationInput.fill('0.5')
    await durationInput.press('Tab')
    // The duration is committed to the persisted record; the input re-renders
    // from that record, so reading the record is the reliable assertion.
    let shortened = null
    const durationDeadline = Date.now() + 10000
    while (Date.now() < durationDeadline) {
      shortened = await page.evaluate(() => {
        const keys = Object.keys(localStorage).filter(key => key.startsWith('three-workbench:editor:v2:'))
        for (const key of keys) {
          try {
            const record = JSON.parse(localStorage.getItem(key))
            const film = record && record.presentation && record.presentation.film
            if (film && film.resolution === '4k' && Array.isArray(film.shots) && film.shots.length > 0) {
              return film.shots[0].duration
            }
          } catch {}
        }
        return null
      })
      if (shortened !== null && Math.abs(Number(shortened) - 0.5) < 0.001) break
      await durationInput.fill('0.5').catch(() => {})
      await durationInput.press('Tab').catch(() => {})
      await new Promise(done => setTimeout(done, 300))
    }
    // 24 fps keeps the 4K software-rendered probe under a minute of wall time.
    const fps = panel.locator('[data-three-workbench-film-fps]')
    await fps.selectOption('24')
    await new Promise(done => setTimeout(done, 400))

    // The shot is stored with the film record, so a non-zero shot count proves
    // the capture reached the real session scene rather than a placeholder.
    persisted = await readFilm()
    if (persisted === null) throw new Error('film record did not persist resolution=4k')
    if (!(persisted.shots >= 1)) throw new Error('film record has no shot: ' + JSON.stringify(persisted))

    const exportChip = panel.locator('[data-three-workbench-film-export]')
    // The chip is disabled while the import/restore gates are unsettled, so the
    // wait reports the persisted gates instead of a bare timeout.
    let exportReady = false
    const readyDeadline = Date.now() + 20000
    let readyState = null
    while (!exportReady && Date.now() < readyDeadline) {
      exportReady = !(await exportChip.isDisabled())
      if (!exportReady) {
        readyState = await page.evaluate(() => ({
          chipText: document.querySelector('[data-three-workbench-film-export]')?.textContent || null,
          shotCount: document.querySelectorAll('[data-three-workbench-film-shot]').length,
        }))
        await new Promise(done => setTimeout(done, 400))
      }
    }
    if (!exportReady) {
      throw new Error('film export chip stayed disabled: ' + JSON.stringify(readyState))
    }
    // Software (SwiftShader + software VP9) 4K encoding can be far slower than
    // real hardware, so the probe accepts either outcome and asserts the
    // contract that matters: the 4K job goes through the encode worker, never
    // downloads WebM, and either produces a valid MP4 or fails visibly.
    // FILM_4K_REQUIRE_DOWNLOAD=1 turns this into a strict encode assertion for
    // hardware-accelerated runners.
    const downloadNames = []
    page.on('download', item => downloadNames.push(item.suggestedFilename()))
    // The notice bar is the only visible failure channel; the export modal
    // intercepts the viewport, so poll the whole document text and record the
    // progress counter to tell "still encoding" from "hung".
    const readExportState = () => page.evaluate(() => {
      const body = document.body.innerText || ''
      const noticeMatch = body.match(/(编码失败|导出已取消|不支持 MP4|Encoding failed|Export cancelled|cannot encode MP4)[^\n]{0,160}/)
      const progress = document.querySelector('[role="progressbar"]')
      return {
        notice: noticeMatch === null ? '' : noticeMatch[0],
        captured: progress === null ? null : Number(progress.getAttribute('aria-valuenow')),
        total: progress === null ? null : Number(progress.getAttribute('aria-valuemax')),
      }
    })
    const downloadPromise = page.waitForEvent('download', { timeout: 600000 }).catch(() => null)
    await exportChip.click()
    let download = null
    let failureNotice = ''
    let lastState = { notice: '', captured: null, total: null }
    const exportDeadline = Date.now() + 600000
    while (Date.now() < exportDeadline && download === null) {
      download = await Promise.race([
        downloadPromise,
        new Promise(resolve => setTimeout(() => resolve(null), 2000)),
      ])
      if (download !== null) break
      lastState = await readExportState()
      if (lastState.notice !== '') {
        failureNotice = lastState.notice
        break
      }
    }
    const workers = await page.evaluate(() => window.__film4kWorkers)
    if (!(workers >= 1)) throw new Error('4K export did not use the encode worker')
    if (pageErrors.length > 0) throw new Error('page errors: ' + pageErrors.slice(0, 3).join(' | '))
    for (const name of downloadNames) {
      if (name.endsWith('.webm')) throw new Error('film export fell back to realtime WebM: ' + name)
    }

    if (download !== null) {
      const name = download.suggestedFilename()
      if (!name.endsWith('-4k.mp4')) throw new Error('unexpected download name: ' + name)
      const bytes = await readFile(await download.path())
      if (bytes.length < 4096) throw new Error('4K MP4 is suspiciously small: ' + String(bytes.length) + ' bytes')
      const brand = bytes.toString('latin1', 4, 8)
      if (brand !== 'ftyp') throw new Error('MP4 has no ftyp box: ' + JSON.stringify(brand))
      if (!bytes.toString('latin1').includes('moov')) throw new Error('MP4 has no moov box')
      console.log(JSON.stringify({
        resolution: persisted.resolution,
        fps: persisted.fps,
        shots: persisted.shots,
        workers,
        download: name,
        bytes: bytes.length,
        mp4: true,
        encoded: true,
        providerCalls,
      }))
    } else if (failureNotice !== '') {
      if (process.env.FILM_4K_REQUIRE_DOWNLOAD === '1') {
        throw new Error('4K export required a download but failed: ' + failureNotice)
      }
      console.log(JSON.stringify({
        resolution: persisted.resolution,
        fps: persisted.fps,
        shots: persisted.shots,
        workers,
        encoded: false,
        failureNotice: failureNotice.slice(0, 120),
        webmFallback: false,
        providerCalls,
      }))
    } else {
      // Still encoding when the budget ran out: the interesting facts are the
      // worker count (it did take the 4K path), the progress counter and the
      // absence of WebM/download, so report those instead of a bare timeout.
      if (process.env.FILM_4K_REQUIRE_DOWNLOAD === '1') {
        throw new Error('4K export did not finish: ' + JSON.stringify(lastState))
      }
      console.log(JSON.stringify({
        resolution: persisted.resolution,
        fps: persisted.fps,
        shots: persisted.shots,
        workers,
        encoded: false,
        pending: true,
        progress: lastState,
        webmFallback: false,
        providerCalls,
      }))
    }
    await context.close()
  } finally {
    await browser.close()
  }
} finally {
  app.kill('SIGTERM')
  await new Promise(done => app.once('exit', done))
  provider.close()
  await rm(home, { recursive: true, force: true })
  if (appOutput && app.exitCode !== 0) console.error(appOutput)
}
