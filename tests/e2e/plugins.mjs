/**
 * Batch-1 plugin browser probe: action cards, deliverable cards and the
 * voice-input composer button, all through the real standalone server.
 *
 * The mock gateway plays a three_scene call, then a turn that emits both a
 * propose_actions and a save_deliverable tool call, then closing text. The
 * three client-facing plugins are pre-installed through the plugin API, and a
 * stub SpeechRecognition is injected so the dictation button can render even
 * though headless Chromium does not ship the real one.
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePlaywright, resolveChromium, LAUNCH_ARGS, launchEnv } from './lib/playwright.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const home = await mkdtemp(join(tmpdir(), 'three-studio-e2e-plugins-'))
const resolved = await resolvePlaywright(process.env)
const chromium = await resolveChromium(process.env)
if (!resolved.ok || !chromium.ok) {
  console.log('SKIP plugin browser E2E - ' + (resolved.ok ? chromium.reason : resolved.reason))
  await rm(home, { recursive: true, force: true })
  process.exit(0)
}

const SCENE_CODE = 'setCamera([0, 2, 5])\n'
  + "const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x3366ff }))\n"
  + "box.name = 'ProbeBox'\nscene.add(box)"

let providerCalls = 0
const provider = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    providerCalls += 1
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'cache-control': 'no-cache' })
    if (providerCalls === 1) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{
        index: 0, id: 'call-scene', type: 'function',
        function: { name: 'three_scene', arguments: JSON.stringify({ title: 'Probe', code: SCENE_CODE }) },
      }] } }] })}\n\n`)
    } else if (providerCalls === 2) {
      // One turn, two tool calls: an action card and a deliverable.
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
        { index: 0, id: 'call-actions', type: 'function', function: { name: 'propose_actions', arguments: JSON.stringify({ actions: [
          { label: 'Bake lighting', prompt: 'Bake the lighting into the scene script.', note: 'Static look' },
          { label: 'Optimize', prompt: 'Reduce draw calls in the current scene.' },
        ] }) } },
        { index: 1, id: 'call-deliver', type: 'function', function: { name: 'save_deliverable', arguments: JSON.stringify({ name: 'bake.js', text: 'console.log(1)', note: 'Helper script' }) } },
      ] } }] })}\n\n`)
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done.' } }] })}\n\n`)
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
  await fetch(base + '/api/providers/deepseek', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Mock', baseURL: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', models: ['deepseek-chat'] }) })
  await fetch(base + '/api/providers/deepseek/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'mock-key' }) })
  for (const id of ['action-cards', 'deliverables', 'voice-input', 'file-browser', 'document-preview', 'browser-pane']) {
    const result = await fetch(base + '/api/plugins/' + encodeURIComponent(id) + '/install', { method: 'POST' }).then(response => response.json())
    if (result.ok !== true) throw new Error(`install ${id} failed: ${JSON.stringify(result)}`)
  }
  const session = await fetch(base + '/api/sessions', { method: 'POST' }).then(response => response.json())
  await fetch(base + `/api/sessions/${encodeURIComponent(session.id)}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: 'build then hand over actions' }] }),
  })
  await waitFor(async () => {
    const state = await fetch(base + `/api/sessions/${encodeURIComponent(session.id)}/state`).then(response => response.json())
    return state.state.running === false && providerCalls >= 3
  })

  const browser = await resolved.module.chromium.launch({ headless: true, executablePath: chromium.executablePath, args: LAUNCH_ARGS, env: launchEnv(process.env) })
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
    await context.addInitScript(() => {
      localStorage.setItem('three-studio:locale', 'en')
      // Headless Chromium ships no SpeechRecognition; stub the smallest API
      // the button touches so the gated render path is exercised.
      class SpeechRecognitionStub {
        constructor() { this.lang = ''; this.interimResults = false; this.continuous = false }
        start() { if (typeof this.onend === 'function') this.onend() }
        stop() { if (typeof this.onend === 'function') this.onend() }
      }
      window.SpeechRecognition = SpeechRecognitionStub
    })
    const page = await context.newPage()
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-three-workbench-studio="root"]').waitFor({ timeout: 15000 })

    // Action card renders with both buttons; clicking fills the composer.
    const card = page.locator('[data-three-workbench-action-card]')
    await card.waitFor({ timeout: 15000 })
    const buttons = card.locator('button[data-three-workbench-action-button]')
    if (await buttons.count() !== 2) throw new Error('expected 2 action buttons, got ' + String(await buttons.count()))
    await buttons.first().click()
    const filled = page.locator('textarea[aria-label="Send instruction"]')
    await waitFor(async () => (await filled.inputValue()) === 'Bake the lighting into the scene script.')

    // Deliverable card shows the name, note and copy control.
    const deliverable = page.locator('[data-three-workbench-deliverable-card]')
    await deliverable.waitFor({ timeout: 5000 })
    const deliverableText = await deliverable.innerText()
    if (!deliverableText.includes('bake.js') || !deliverableText.includes('Helper script')) {
      throw new Error('deliverable card content missing: ' + deliverableText)
    }
    await deliverable.locator('button[data-three-workbench-deliverable-copy]').click()

    // Voice button renders because the plugin is installed and the stub
    // exists; pressing it starts and immediately ends without breaking.
    const voice = page.locator('button[data-three-workbench-studio-action="ai-voice"]')
    await voice.waitFor({ timeout: 5000 })
    await voice.click()

    // Files panel: browse into the session deliverable and preview it.
    await page.locator('button.twb-studio-rail[aria-label="Workspace files"]').click()
    const filesList = page.locator('[data-three-workbench-files-list]')
    await filesList.waitFor({ timeout: 5000 })
    await filesList.locator('button[data-three-workbench-files-entry="dir"]', { hasText: 'deliverables' }).click()
    await filesList.locator('button[data-three-workbench-files-entry="dir"]').first().waitFor({ timeout: 5000 })
    await filesList.locator('button[data-three-workbench-files-entry="dir"]').first().click()
    const deliverableEntry = filesList.locator('button[data-three-workbench-files-entry="file"]', { hasText: 'bake.js' })
    await deliverableEntry.waitFor({ timeout: 5000 })
    await deliverableEntry.click()
    const preview = page.locator('[data-three-workbench-document-preview]')
    await preview.waitFor({ timeout: 5000 })
    const previewText = await preview.innerText()
    if (!previewText.includes('console.log(1)')) throw new Error('preview content missing: ' + previewText)

    // Web pane: private hosts are refused, public ones open sandboxed.
    await page.locator('button.twb-studio-rail[aria-label="Web pane"]').click()
    const webInput = page.locator('input[aria-label="Web pane"]')
    await webInput.waitFor({ timeout: 5000 })
    await webInput.fill('192.168.1.5')
    await page.locator('button[data-three-workbench-web-open]').click()
    await page.getByText('Only public http(s) addresses are allowed.').waitFor({ timeout: 5000 })
    await webInput.fill('https://example.com')
    await page.locator('button[data-three-workbench-web-open]').click()
    const frame = page.locator('[data-three-workbench-web-panel] iframe')
    await frame.waitFor({ timeout: 15000 })
    const sandbox = await frame.getAttribute('sandbox')
    if (sandbox === null || sandbox.includes('allow-same-origin')) {
      throw new Error('web pane sandbox must not include allow-same-origin: ' + String(sandbox))
    }

    console.log(JSON.stringify({
      actionCard: true, actionPrefill: true, deliverableCard: true, deliverableCopy: true,
      voiceButton: true, filesPanel: true, documentPreview: true, webPane: true,
      webPaneSandbox: true, providerCalls,
    }))
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
