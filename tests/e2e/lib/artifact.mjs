// One screenshot + one sanitized JSON per failed check. No traces, video, HAR,
// iframe HTML, localStorage, navigation URLs, tokens or Session ids.
import { mkdir, writeFile, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { redactText, redactValue, safeError } from './redact.mjs'

export const ARTIFACT_ROOT = '/tmp/three-workbench-e2e-artifacts'

export function safeCheckId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'check'
}

/**
 * @param {object} options
 * @param {string} options.runDir
 * @param {string} options.id
 * @param {unknown} options.error
 * @param {object|null} options.page Playwright page for the failure screenshot
 * @param {object} [options.details]
 */
export async function writeFailureArtifact({ runDir, id, error, page, details = {} }) {
  await mkdir(runDir, { recursive: true })
  const base = safeCheckId(id)
  const jsonPath = path.join(runDir, base + '.json')
  const pngPath = path.join(runDir, base + '.png')
  const payload = {
    schema: 'three-workbench-e2e-artifact/v1',
    check: String(id),
    at: new Date().toISOString(),
    error: safeError(error),
    details: redactValue(details),
    screenshot: null,
  }
  let screenshotWritten = false
  if (page && typeof page.screenshot === 'function' && !page.isClosed()) {
    try {
      await page.screenshot({ path: pngPath, animations: 'disabled', timeout: 6000 })
      payload.screenshot = base + '.png'
      screenshotWritten = true
    } catch (screenshotError) {
      payload.screenshotError = safeError(screenshotError).message
    }
  }
  await writeFile(jsonPath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  return { jsonPath, pngPath: screenshotWritten ? pngPath : null }
}

const FORBIDDEN_ARTIFACT_PATTERNS = [
  { label: 'token query', regex: /[?&](?:token|access_token)=/i },
  { label: 'http url', regex: /https?:\/\//i },
  { label: 'session id', regex: /\bsession-[0-9a-f]{8}-[0-9a-f-]{20,}/i },
  { label: 'share path id', regex: /\/three-workbench\/share\/[A-Za-z0-9_-]{8,}/ },
  { label: 'iframe html', regex: /<(?:iframe|html)\b/i },
  { label: 'localStorage', regex: /localStorage/i },
]

/** Scan any artifacts produced by a run; returns human-readable violations. */
export async function scanArtifacts(runDir) {
  let entries = []
  try {
    entries = await readdir(runDir)
  } catch {
    return { files: 0, violations: [] }
  }
  const violations = []
  let files = 0
  for (const entry of entries) {
    const target = path.join(runDir, entry)
    let info
    try {
      info = await stat(target)
    } catch {
      continue
    }
    if (!info.isFile()) continue
    files += 1
    let body = ''
    try {
      body = await readFile(target, 'latin1')
    } catch {
      continue
    }
    for (const pattern of FORBIDDEN_ARTIFACT_PATTERNS) {
      if (pattern.regex.test(body)) violations.push({ file: entry, pattern: pattern.label })
    }
  }
  return { files, violations: violations.map(entry => ({ file: entry.file, pattern: redactText(entry.pattern) })) }
}
