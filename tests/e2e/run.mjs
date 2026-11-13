#!/usr/bin/env node
// One-command browser E2E runner for the Three.js workbench.
//
// The only address source is WORKBENCH_URL. It is validated as a disposable
// loopback target, handed to the harness, and never printed. WORKBENCH_SHARE_URL
// is an optional read-only share target for the opt-in share checks; the
// default run never creates or revokes shares.
//
// Playwright is resolved dynamically so `node --test tests/*.mjs` never loads
// it. Missing URL, package or a usable Chromium is a clear SKIP with exit 0.
// Every failure writes one screenshot + one sanitized JSON artifact under
// /tmp/three-workbench-e2e-artifacts/<run>/.
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { createHarness } from './lib/harness.mjs'
import { launchEnv, LAUNCH_ARGS, resolveChromium, resolvePlaywright } from './lib/playwright.mjs'
import { redactText, safeError } from './lib/redact.mjs'
import { ARTIFACT_ROOT, scanArtifacts } from './lib/artifact.mjs'

const FORBIDDEN_PORTS = new Set([3081, 3098, 3099, 3105, 3106])

function skip(message) {
  console.log('SKIP browser E2E - ' + redactText(message))
  return 0
}

function validateTarget(raw, label) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(label + ' is not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(label + ' must be an http(s) URL')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error(label + ' must target loopback (127.0.0.1, ::1 or localhost)')
  }
  const port = Number(url.port || (url.protocol === 'https:' ? '443' : '80'))
  if (FORBIDDEN_PORTS.has(port)) {
    throw new Error(label + ' targets a protected port; use a fresh disposable Host')
  }
  return url
}

function runId() {
  return new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex')
}

async function main() {
  const rawBase = process.env.WORKBENCH_URL
  if (rawBase === undefined || rawBase.trim() === '') {
    return skip('WORKBENCH_URL is not set; supply a disposable loopback Host URL to run the browser E2E (the URL is never printed)')
  }

  let baseUrl
  let shareUrl = null
  try {
    baseUrl = validateTarget(rawBase, 'WORKBENCH_URL').href
    if (process.env.WORKBENCH_SHARE_URL !== undefined && process.env.WORKBENCH_SHARE_URL.trim() !== '') {
      shareUrl = validateTarget(process.env.WORKBENCH_SHARE_URL, 'WORKBENCH_SHARE_URL').href
    }
  } catch (error) {
    console.log('FAIL setup - ' + safeError(error).message)
    return 1
  }

  const resolved = await resolvePlaywright(process.env)
  if (!resolved.ok) {
    return skip(resolved.reason + '; install Playwright or set PLAYWRIGHT_MODULE to its module path')
  }
  const chromium = await resolveChromium(process.env)
  if (!chromium.ok) {
    return skip(chromium.reason + '; install the Playwright Chromium build or set PLAYWRIGHT_CHROMIUM_EXECUTABLE')
  }

  let browser = null
  let harness = null
  const id = runId()
  const runDir = path.join(ARTIFACT_ROOT, id)
  let code = 0
  try {
    try {
      browser = await resolved.module.chromium.launch({
        headless: true,
        executablePath: chromium.executablePath,
        args: LAUNCH_ARGS,
        env: launchEnv(process.env),
      })
    } catch (error) {
      const safe = safeError(error)
      return skip('Chromium could not be launched (' + safe.message + '); browser-missing is a SKIP, not a failure')
    }

    harness = createHarness({
      browser,
      baseUrl,
      shareUrl,
      runDir,
      mode: shareUrl === null ? 'live' : 'live+share',
    })

    console.log('P5 browser E2E starting (sequential specs, live Host on a loopback disposable target)')
    console.log('share checks: ' + (shareUrl === null
      ? 'SKIP (WORKBENCH_SHARE_URL not set; no share is created)'
      : 'opt-in read-only share target supplied'))
    console.log('artifacts: ' + runDir)

    const specs = [
      (await import('./specs/10-editor-ui.mjs')).default,
      (await import('./specs/20-protocol-handshake-tree.mjs')).default,
      (await import('./specs/30-protocol-mutation-timeline.mjs')).default,
      (await import('./specs/40-protocol-tracks.mjs')).default,
      (await import('./specs/50-protocol-pick-capture-stats-params.mjs')).default,
      (await import('./specs/60-protocol-share.mjs')).default,
      (await import('./specs/70-studio-logic.mjs')).default,
    ]

    for (const spec of specs) {
      console.log('SPEC ' + spec.name)
      try {
        await spec.run(harness)
      } catch (error) {
        await harness.specFailure(spec.name, error)
      } finally {
        await harness.closeContexts()
      }
    }

    const results = harness.results
    const passed = results.filter(entry => entry.status === 'PASS').length
    const skipped = results.filter(entry => entry.status === 'SKIP').length
    const failed = results.filter(entry => entry.status === 'FAIL').length
    const scanned = await scanArtifacts(runDir)
    console.log('SUMMARY checks=' + results.length + ' pass=' + passed + ' skip=' + skipped + ' fail=' + failed)
    console.log('ARTIFACTS files=' + scanned.files + ' violations=' + scanned.violations.length)
    for (const violation of scanned.violations) {
      console.log('ARTIFACT VIOLATION ' + violation.file + ' - ' + violation.pattern)
    }
    if (failed > 0 || scanned.violations.length > 0) code = 1
    return code
  } catch (error) {
    const safe = safeError(error)
    console.log('FAIL runner - ' + safe.message)
    code = 1
    return code
  } finally {
    if (harness !== null) await harness.closeContexts().catch(() => {})
    if (browser !== null) await browser.close().catch(() => {})
  }
}

main().then(code => {
  process.exitCode = typeof code === 'number' ? code : 1
}).catch(error => {
  console.log('FAIL runner - ' + safeError(error).message)
  process.exitCode = 1
})
