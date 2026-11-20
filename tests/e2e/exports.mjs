/**
 * P2-4 browser probe: USDZ and binary FBX export through the real UI.
 *
 * A local mock OpenAI-compatible gateway answers the first round with a
 * `three_scene` tool call (a small authored scene) and the second round with
 * plain text, so the full prompt -> tool loop -> live preview -> export menu
 * -> download path runs against the real standalone server with no real
 * provider key. The captured files are validated structurally: the USDZ must
 * be a stored (uncompressed) zip containing model.usda, and the FBX must
 * carry the binary Kaydara header with version 7400.
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePlaywright, resolveChromium, LAUNCH_ARGS, launchEnv } from './lib/playwright.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const home = await mkdtemp(join(tmpdir(), 'three-studio-e2e-exports-'))
const resolved = await resolvePlaywright(process.env)
const chromium = await resolveChromium(process.env)
if (!resolved.ok || !chromium.ok) {
  console.log('SKIP export browser E2E - ' + (resolved.ok ? chromium.reason : resolved.reason))
  await rm(home, { recursive: true, force: true })
  process.exit(0)
}

const SCENE_CODE = [
  'setCamera([0, 2, 5])',
  "const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2),",
  "  new THREE.MeshStandardMaterial({ color: 0x3366ff, roughness: 0.4, metalness: 0.1 }))",
  "box.name = 'ProbeBox'",
  'scene.add(box)',
  "const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.6, 0.2, 120, 16),",
  "  new THREE.MeshStandardMaterial({ color: 0xff9944, roughness: 0.25 }))",
  "knot.name = 'ProbeKnot'",
  'knot.position.set(2, 0.4, -1)',
  'scene.add(knot)',
  "onFrame(() => { knot.rotation.y += 0.01 })",
].join('\n')

let providerCalls = 0
const provider = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    providerCalls += 1
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'cache-control': 'no-cache' })
    // First round: emit the scene tool call. Second round: closing text.
    if (providerCalls === 1) {
      const arguments_ = JSON.stringify({ title: 'Probe scene', code: SCENE_CODE })
      const call = { choices: [{ delta: { tool_calls: [{
        index: 0, id: 'call-probe-1', type: 'function',
        function: { name: 'three_scene', arguments: arguments_ },
      }] } }] }
      res.write(`data: ${JSON.stringify(call)}\n\n`)
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Scene delivered.' } }] })}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise(done => provider.listen(0, '127.0.0.1', done))
const providerPort = provider.address().port

const app = spawn(process.env.THREE_STUDIO_NODE || process.execPath, ['standalone/server.mjs'], {
  cwd: repo, env: { ...process.env, THREE_STUDIO_HOME: home, THREE_STUDIO_PORT: '3195' },
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
  await waitFor(async () => (await fetch('http://127.0.0.1:3195/api/models')).ok)
  const base = 'http://127.0.0.1:3195'
  await fetch(base + '/api/providers/deepseek', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Mock', baseURL: `http://127.0.0.1:${providerPort}/v1`, api: 'openai-completions', models: ['deepseek-chat'] }) })
  await fetch(base + '/api/providers/deepseek/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'mock-key' }) })
  const session = await fetch(base + '/api/sessions', { method: 'POST' }).then(response => response.json())
  const prompt = await fetch(base + `/api/sessions/${encodeURIComponent(session.id)}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: 'build the probe scene' }] }),
  })
  if (prompt.status !== 202) throw new Error('seed prompt rejected: ' + await prompt.text())
  await waitFor(async () => {
    const state = await fetch(base + `/api/sessions/${encodeURIComponent(session.id)}/state`).then(response => response.json())
    return state.state.running === false && providerCalls >= 2
  })

  const browser = await resolved.module.chromium.launch({ headless: true, executablePath: chromium.executablePath, args: LAUNCH_ARGS, env: launchEnv(process.env) })
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
    await context.addInitScript(() => localStorage.setItem('three-studio:locale', 'en'))
    const page = await context.newPage()
    await page.goto(base, { waitUntil: 'domcontentloaded' })
    await page.locator('[data-three-workbench-studio="root"]').waitFor({ timeout: 15000 })
    // The fresh agent result auto-opens the preview; wait for the live frame.
    await page.locator('iframe').first().waitFor({ timeout: 15000 })
    await waitFor(async () => (await page.locator('iframe').count()) > 0
      && await page.locator('button[aria-label="More actions"]').count() > 0)

    const captureDownload = async label => {
      const more = page.locator('button[aria-label="More actions"]').last()
      await more.click()
      const item = page.locator('button', { hasText: label })
      await item.first().waitFor({ timeout: 5000 })
      const [path, click] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        item.first().click(),
      ])
      return readFile(await path.path())
    }

    const usdz = await captureDownload('Export USDZ')
    if (!(usdz[0] === 0x50 && usdz[1] === 0x4b && usdz[2] === 0x03 && usdz[3] === 0x04)) {
      throw new Error('USDZ is not a zip archive')
    }
    const usdzText = usdz.toString('latin1')
    if (!usdzText.includes('model.usda')) throw new Error('USDZ missing model.usda')
    // Apple requires stored (uncompressed) entries; method 0 in every local header.
    for (let cursor = 0; cursor + 30 <= usdz.length;) {
      if (usdz[cursor] !== 0x50 || usdz[cursor + 1] !== 0x4b) break
      const method = usdz[cursor + 8] | (usdz[cursor + 9] << 8)
      if (method !== 0) throw new Error('USDZ entry is compressed (method ' + String(method) + ')')
      const nameLength = usdz[cursor + 26] | (usdz[cursor + 27] << 8)
      const extraLength = usdz[cursor + 28] | (usdz[cursor + 29] << 8)
      const size = (usdz[cursor + 18] | (usdz[cursor + 19] << 8) | (usdz[cursor + 20] << 16) | (usdz[cursor + 21] << 24)) >>> 0
      cursor += 30 + nameLength + extraLength + size
    }

    const fbx = await captureDownload('Export FBX')
    const fbxHeader = fbx.toString('latin1', 0, 23)
    if (fbxHeader !== 'Kaydara FBX Binary  \x00\x1a\x00') throw new Error('FBX header magic mismatch: ' + JSON.stringify(fbxHeader))
    const version = fbx.readUInt32LE(23)
    if (version !== 7400) throw new Error('FBX version mismatch: ' + String(version))
    const fbxText = fbx.toString('latin1')
    for (const marker of ['ProbeBox', 'ProbeKnot', 'PolygonVertexIndex', 'DiffuseColor', 'Connections']) {
      if (!fbxText.includes(marker)) throw new Error('FBX missing expected node ' + marker)
    }

    console.log(JSON.stringify({
      usdzBytes: usdz.length, usdzStored: true,
      fbxBytes: fbx.length, fbxVersion: version, fbxNodes: true,
      providerCalls,
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
