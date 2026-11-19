import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePlaywright, resolveChromium, LAUNCH_ARGS, launchEnv } from './lib/playwright.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const home = await mkdtemp(join(tmpdir(), 'three-studio-e2e-'))
const resolved = await resolvePlaywright(process.env)
const chromium = await resolveChromium(process.env)
if (!resolved.ok || !chromium.ok) {
  console.log('SKIP standalone browser E2E - ' + (resolved.ok ? chromium.reason : resolved.reason))
  await rm(home, { recursive: true, force: true })
  process.exit(0)
}
let calls = 0
const provider = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
  calls += 1
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'cache-control': 'no-cache' })
    const parsed = JSON.parse(body || '{}')
    const text = Array.isArray(parsed.messages) && parsed.messages.some(item => String(item.content).includes('cancel-me')) ? 'canceling' : 'OK'
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
    if (text === 'canceling') {
      setTimeout(() => { res.write('data: [DONE]\n\n'); res.end() }, 8000)
    } else {
      setTimeout(() => { res.write('data: [DONE]\n\n'); res.end() }, 30)
    }
  })
})
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
const providerPort = provider.address().port
const app = spawn(process.env.THREE_STUDIO_NODE || process.execPath, ['standalone/server.mjs'], {
  cwd: repo, env: { ...process.env, THREE_STUDIO_HOME: home, THREE_STUDIO_PORT: '3193' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appOutput = ''
app.stdout.on('data', data => { appOutput += data })
app.stderr.on('data', data => { appOutput += data })
const waitFor = async (fn, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { if (await fn()) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('timeout')
}
try {
  await waitFor(async () => (await fetch('http://127.0.0.1:3193/api/models')).ok)
  const base = 'http://127.0.0.1:3193'
  const update = await fetch(base + '/api/providers/deepseek', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Mock', baseURL: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', models: ['deepseek-chat'] }) })
  if (!update.ok) throw new Error('provider update failed: ' + await update.text())
  const key = await fetch(base + '/api/providers/deepseek/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'mock-key' }) })
  if (!key.ok) throw new Error('key save failed: ' + await key.text())
  const connection = await fetch(base + '/api/providers/deepseek/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-chat' }) }).then(response => response.json())
  if (connection.ok !== true) throw new Error('connection test failed: ' + JSON.stringify(connection))
  const sessions = await fetch(base + '/api/sessions').then(response => response.json())
  const first = sessions.sessions[0].id
  const second = await fetch(base + '/api/sessions', { method: 'POST' }).then(response => response.json()).then(value => value.id)
  for (const [id, text] of [[first, 'first browser session'], [second, 'second browser session']]) {
    const response = await fetch(base + `/api/sessions/${encodeURIComponent(id)}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parts: [{ type: 'text', text }] }) })
    if (response.status !== 202) throw new Error('seed prompt rejected: ' + await response.text())
  }
  await waitFor(async () => {
    const value = await fetch(base + '/api/sessions').then(response => response.json())
    return value.sessions.every(row => row.running === false && row.blank === false)
  })

  const browser = await resolved.module.chromium.launch({ headless: true, executablePath: chromium.executablePath, args: LAUNCH_ARGS, env: launchEnv(process.env) })
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US' })
    await context.addInitScript(() => localStorage.setItem('three-studio:locale', 'en'))
    const page = await context.newPage()
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-three-workbench-presentation="overlay"]').waitFor({ timeout: 15000 })
    await page.setViewportSize({ width: 1200, height: 900 })
    await page.locator('[data-three-workbench-studio="root"]').waitFor({ timeout: 10000 })
    await page.locator('[data-three-workbench-studio="rail"] button[aria-label="Sessions"]').click()
    await page.locator('[data-three-workbench-session-row]').first().waitFor({ timeout: 5000 })
    const rows = page.locator('[data-three-workbench-session-row]')
    if (await rows.count() < 2) throw new Error('session switcher did not show both sessions')
    const sessionCount = await rows.count()
    await rows.nth(1).click()
    await waitFor(async () => (await page.evaluate(() => localStorage.getItem('three-studio:session'))) !== null)
    const switched = await page.evaluate(() => localStorage.getItem('three-studio:session'))
    if (switched !== first && switched !== second) throw new Error('session switch did not persist')
    await page.locator('[data-three-workbench-studio="rail"] button[aria-label="AI prompt"]').click()
    await page.locator('[data-three-workbench-ai-settings-open]').click()
    await page.locator('[data-three-workbench-provider-action="test"]').first().click()
    await page.getByText(/Connected ·/).waitFor({ timeout: 10000 })
    await page.locator('[data-three-workbench-ai-settings-action="back"]').click()
    const input = page.locator('textarea[aria-label="Send instruction"]')
    await input.fill('cancel-me')
    await input.press('Enter')
    await page.locator('[data-three-workbench-studio-action="ai-stop"]').waitFor({ timeout: 5000 })
    await page.locator('[data-three-workbench-studio-action="ai-stop"]').click()
    await page.locator('[data-three-workbench-studio-action="ai-stop"]').waitFor({ state: 'detached', timeout: 5000 })
    await waitFor(async () => {
      const response = await fetch(base + '/api/sessions/' + encodeURIComponent(switched) + '/state')
      const value = await response.json()
      return value.state.running === false
    })
    await input.fill('send-after-cancel')
    await input.press('Enter')
    await waitFor(async () => {
      const response = await fetch(base + '/api/sessions/' + encodeURIComponent(switched) + '/state')
      const value = await response.json()
      return value.state.running === false && value.events.some(event => event.type === 'assistant/message')
    }, 15000)
    const archived = await fetch(base + '/api/sessions/' + encodeURIComponent(second), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: true }) }).then(response => response.json())
    const restored = await fetch(base + '/api/sessions/' + encodeURIComponent(second), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: false }) }).then(response => response.json())
    const removed = await fetch(base + '/api/sessions/' + encodeURIComponent(second), { method: 'DELETE' }).then(response => response.json())
    if (!archived.ok || !restored.ok || !removed.ok) throw new Error('session lifecycle API failed')
    console.log(JSON.stringify({ mobileOverlay: true, desktopAfterMobile: true, sessionsShown: sessionCount, switchedTo: switched, cancelThenSend: true, connectionTest: true, sessionArchiveRestoreDelete: true, providerCalls: calls }))
    await context.close()
  } finally {
    await browser.close()
  }
} finally {
  app.kill('SIGTERM')
  await new Promise(resolve => app.once('exit', resolve))
  provider.close()
  await rm(home, { recursive: true, force: true })
  if (appOutput && app.exitCode !== 0) console.error(appOutput)
}
