// Central redaction for the browser E2E harness. Every path that prints or
// persists text (runner output, failure artifacts, error reports) goes through
// these helpers so a tokenized URL, Session id or share id can never leak.

const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi
const TOKEN_QUERY_RE = /([?&](?:token|access_token|auth|session|id)=)[^&\s"'<>]+/gi
const SESSION_RE = /\bsession-[0-9a-fA-F]{8}-[0-9a-fA-F-]{20,}\b/g
const SHARE_PATH_RE = /(\/three-workbench\/share\/)[A-Za-z0-9_-]{8,}/g
const WORKBENCH_ID_PATH_RE = /(\/three-workbench\/(?:state|scene|thumbnail|assets)\/)[^/?#\s"']+/g
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g
const TOKENISH_RE = /\b[A-Za-z0-9_-]{32,}\b/g

const DROPPED_KEYS = new Set([
  'pixels', 'dataurl', 'srcdoc', 'html', 'code', 'statetext', 'statejson',
  'document', 'documenttext', 'blob', 'buffer', 'localstorage', 'sessionstorage',
  'token', 'url', 'href', 'src', 'navigationurl',
])

/** Redact one string. Safe for console output, errors and artifact fields. */
export function redactText(value) {
  if (value === null || value === undefined) return ''
  let text = String(value)
  text = text.replace(URL_RE, '<redacted-url>')
  text = text.replace(TOKEN_QUERY_RE, '$1<redacted>')
  text = text.replace(SHARE_PATH_RE, '$1<redacted>')
  text = text.replace(WORKBENCH_ID_PATH_RE, '$1<redacted>')
  text = text.replace(SESSION_RE, 'session-<redacted>')
  text = text.replace(UUID_RE, '<redacted-uuid>')
  text = text.replace(TOKENISH_RE, '<redacted-token>')
  return text
}

/** Normalize one throwable into a safe, bounded record. */
export function safeError(error) {
  const base = error !== null && typeof error === 'object' ? error : { message: String(error) }
  return {
    name: typeof base.name === 'string' ? redactText(base.name).slice(0, 120) : 'Error',
    message: redactText(base.message !== undefined ? base.message : base).slice(0, 1200),
    stack: typeof base.stack === 'string' ? redactText(base.stack).slice(0, 4000) : null,
  }
}

/**
 * Recursively sanitize a value for a failure artifact. Drops known payload
 * fields (frame buffers, HTML, state blobs), truncates strings and caps the
 * traversal so an artifact can never become a copy of the page.
 */
export function redactValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return null
  const kind = typeof value
  if (kind === 'string') return redactText(value).slice(0, 2000)
  if (kind === 'number') return Number.isFinite(value) ? value : null
  if (kind === 'boolean') return value
  if (kind === 'bigint') return String(value).slice(0, 80)
  if (kind === 'function' || kind === 'symbol') return undefined
  if (depth >= 5) return '<depth-limit>'
  if (value instanceof ArrayBuffer) return { bytes: value.byteLength }
  if (ArrayBuffer.isView(value)) return { bytes: value.byteLength, view: value.constructor.name }
  if (Array.isArray(value)) {
    return value.slice(0, 40).map(entry => {
      const out = redactValue(entry, depth + 1, seen)
      return out === undefined ? null : out
    })
  }
  if (kind === 'object') {
    if (seen.has(value)) return '<cycle>'
    seen.add(value)
    const out = {}
    let count = 0
    for (const key of Object.keys(value)) {
      if (count >= 50) break
      if (DROPPED_KEYS.has(String(key).toLowerCase())) continue
      const entry = redactValue(value[key], depth + 1, seen)
      if (entry === undefined) continue
      out[key] = entry
      count += 1
    }
    return out
  }
  return null
}

/** A request label that keeps the route class but drops ids and query strings. */
export function safeRequestLabel(request) {
  try {
    const url = new URL(request.url())
    let pathname = url.pathname
    pathname = pathname.replace(/^\/three-workbench\/state\/.*/, '/three-workbench/state/<redacted>')
    pathname = pathname.replace(/^\/three-workbench\/scene\/.*/, '/three-workbench/scene/<redacted>')
    pathname = pathname.replace(/^\/three-workbench\/thumbnail\/.*/, '/three-workbench/thumbnail/<redacted>')
    pathname = pathname.replace(/^\/three-workbench\/assets\/.*/, '/three-workbench/assets/<redacted>')
    pathname = pathname.replace(/^\/three-workbench\/share\/.*/, '/three-workbench/share/<redacted>')
    return redactText((request.method() || 'GET') + ' ' + pathname).slice(0, 200)
  } catch {
    return 'request <redacted>'
  }
}
