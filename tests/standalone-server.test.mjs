import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let home
let port
let child
let output = ''

const freePort = () => new Promise((resolvePort, reject) => {
  const probe = net.createServer()
  probe.on('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const value = probe.address().port
    probe.close(() => resolvePort(value))
  })
})

const request = (path, options = {}) => new Promise((resolveRequest, reject) => {
  const req = http.request({
    host: '127.0.0.1',
    port,
    path,
    method: options.method || 'GET',
    headers: options.headers || {},
    agent: false,
  }, response => {
    const chunks = []
    response.on('data', chunk => chunks.push(chunk))
    response.on('end', () => resolveRequest({
      status: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    }))
  })
  req.on('error', reject)
  req.end(options.body)
})

const waitFor = async (fn, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { if (await fn()) return } catch (error) { void error }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  throw new Error(`timeout\n${output}`)
}

const tokenOf = async () => {
  const response = await request('/')
  const match = /meta name="three-studio-api-token" content="([^"]+)"/.exec(response.body)
  assert.notEqual(match, null, 'index.html must inject the API token meta tag')
  return match[1]
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'three-studio-security-'))
  port = await freePort()
  child = spawn(process.env.THREE_STUDIO_NODE || process.execPath, ['standalone/server.mjs'], {
    cwd: repo,
    env: { ...process.env, THREE_STUDIO_HOME: home, THREE_STUDIO_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  await waitFor(async () => (await request('/api/models')).status === 200)
})

after(async () => {
  if (child !== undefined) {
    child.kill('SIGTERM')
    await new Promise(resolveExit => child.once('exit', resolveExit))
  }
  if (home !== undefined) await rm(home, { recursive: true, force: true })
})

test('index injects the API token and document hardening headers', async () => {
  const response = await request('/')
  assert.equal(response.status, 200)
  assert.match(response.body, /meta name="three-studio-api-token" content="[^"]+"/)
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/)
  assert.equal(response.headers['x-content-type-options'], 'nosniff')
  assert.equal(response.headers['referrer-policy'], 'no-referrer')
})

test('rejects a non-loopback Host on API routes', async () => {
  const response = await request('/api/models', { headers: { host: 'evil.example' } })
  assert.equal(response.status, 421)
})

test('rejects a cross-site Origin on API routes', async () => {
  const response = await request('/api/models', { headers: { origin: 'https://evil.example' } })
  assert.equal(response.status, 403)
})

test('requires the API token for browser-like API writes', async () => {
  const token = await tokenOf()
  const headers = {
    origin: `http://127.0.0.1:${String(port)}`,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  }
  const denied = await request('/api/sessions', { method: 'POST', headers })
  assert.equal(denied.status, 403)
  const allowed = await request('/api/sessions', {
    method: 'POST',
    headers: { ...headers, 'x-three-studio-token': token },
  })
  assert.equal(allowed.status, 201)
})

test('rejects a text/plain body on a JSON API route', async () => {
  const token = await tokenOf()
  const response = await request('/api/sessions', {
    method: 'POST',
    headers: {
      origin: `http://127.0.0.1:${String(port)}`,
      'sec-fetch-site': 'same-origin',
      'content-type': 'text/plain',
      'x-three-studio-token': token,
    },
    body: JSON.stringify({}),
  })
  assert.equal(response.status, 415)
})

test('rejects an oversized API body before reading it', async () => {
  const token = await tokenOf()
  const response = await request('/api/sessions', {
    method: 'POST',
    headers: {
      origin: `http://127.0.0.1:${String(port)}`,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'x-three-studio-token': token,
      'content-length': String(2 * 1024 * 1024),
    },
  })
  assert.equal(response.status, 413)
})

test('rejects cross-site writes to the workbench asset routes', async () => {
  const token = await tokenOf()
  const response = await request('/three-workbench/assets/delete', {
    method: 'POST',
    headers: {
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
      'content-type': 'application/json',
      'x-three-studio-token': token,
    },
  })
  assert.equal(response.status, 403)
})
