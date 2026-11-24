/**
 * Offline Three Studio Pro license format.
 *
 * A license is a small JSON document with a signed, canonically serialized
 * payload. Verification is local and offline; there is no activation server.
 * The app is Apache-2.0, so this is an entitlement receipt, not DRM: it unlocks
 * the Pro badge, template pack and support/update channel, while the local
 * editor remains fully functional without it.
 */
import { readFileSync } from 'node:fs'
import { sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'

export const LICENSE_VERSION = 1
export const LICENSE_KIND = 'three-studio-license'
export const LICENSE_PRODUCT = 'three-studio-desktop'
export const LICENSE_EDITION = 'pro'
export const LICENSE_FILE = 'license.tslicense'

const FEATURE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const ID_RE = /^[A-Za-z0-9_-]{8,80}$/

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function validPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return 'payload'
  if (payload.v !== LICENSE_VERSION || payload.kind !== LICENSE_KIND) return 'schema'
  if (typeof payload.id !== 'string' || !ID_RE.test(payload.id)) return 'id'
  if (payload.product !== LICENSE_PRODUCT) return 'product'
  if (payload.edition !== LICENSE_EDITION) return 'edition'
  if (typeof payload.customer !== 'string' || payload.customer.length === 0
    || payload.customer.length > 200) return 'customer'
  if (payload.email !== undefined && (typeof payload.email !== 'string'
    || payload.email.length > 254)) return 'email'
  if (!Number.isSafeInteger(payload.issuedAt) || payload.issuedAt < 0) return 'issuedAt'
  if (payload.expiresAt !== null && (!Number.isSafeInteger(payload.expiresAt) || payload.expiresAt < 0)) {
    return 'expiresAt'
  }
  if (!Number.isSafeInteger(payload.seats) || payload.seats < 1 || payload.seats > 10000) return 'seats'
  if (!Array.isArray(payload.features) || payload.features.length > 32
    || !payload.features.every(feature => typeof feature === 'string' && FEATURE_RE.test(feature))) {
    return 'features'
  }
  if (payload.machine !== undefined && (typeof payload.machine !== 'string' || payload.machine.length > 200)) {
    return 'machine'
  }
  return null
}

export function createLicensePayload({
  id,
  customer,
  email,
  issuedAt = Date.now(),
  expiresAt = null,
  seats = 1,
  features = ['desktop-pro'],
  machine,
} = {}) {
  const payload = {
    v: LICENSE_VERSION,
    kind: LICENSE_KIND,
    id,
    product: LICENSE_PRODUCT,
    edition: LICENSE_EDITION,
    customer,
    issuedAt,
    expiresAt,
    seats,
    features: [...new Set(features)].sort(),
    ...(typeof email === 'string' && email !== '' ? { email } : {}),
    ...(typeof machine === 'string' && machine !== '' ? { machine } : {}),
  }
  const invalid = validPayload(payload)
  if (invalid !== null) throw new Error(`invalid license field: ${invalid}`)
  return payload
}

export function signLicense(payload, privateKeyPem) {
  const invalid = validPayload(payload)
  if (invalid !== null) throw new Error(`invalid license field: ${invalid}`)
  const signature = cryptoSign(null, Buffer.from(canonicalJson(payload), 'utf8'), privateKeyPem)
  return { payload, signature: signature.toString('base64url') }
}

export function parseLicenseText(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text))
  } catch (error) {
    return { ok: false, reason: 'json', message: 'License is not valid JSON.' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'schema', message: 'License document is malformed.' }
  }
  if (parsed.payload === undefined || typeof parsed.signature !== 'string') {
    return { ok: false, reason: 'schema', message: 'License payload or signature is missing.' }
  }
  const invalid = validPayload(parsed.payload)
  if (invalid !== null) {
    return { ok: false, reason: invalid, message: `License field "${invalid}" is invalid.` }
  }
  return { ok: true, license: parsed }
}

export function verifyLicense(license, publicKeyPem, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const invalid = validPayload(license?.payload)
  if (invalid !== null) return { ok: false, reason: invalid, message: `License field "${invalid}" is invalid.` }
  let verified = false
  try {
    verified = cryptoVerify(
      null,
      Buffer.from(canonicalJson(license.payload), 'utf8'),
      publicKeyPem,
      Buffer.from(String(license.signature), 'base64url'),
    )
  } catch (error) {
    return { ok: false, reason: 'signature', message: 'License signature could not be verified.' }
  }
  if (!verified) return { ok: false, reason: 'signature', message: 'License signature is invalid.' }
  if (license.payload.issuedAt > now + 5 * 60 * 1000) {
    return { ok: false, reason: 'not-yet-valid', message: 'License is issued in the future.' }
  }
  if (license.payload.expiresAt !== null && now >= license.payload.expiresAt) {
    return { ok: false, reason: 'expired', message: 'License has expired.' }
  }
  const required = Array.isArray(options.requiredFeatures) ? options.requiredFeatures : []
  const missing = required.filter(feature => !license.payload.features.includes(feature))
  if (missing.length > 0) {
    return { ok: false, reason: 'feature', message: `License is missing: ${missing.join(', ')}` }
  }
  return { ok: true, payload: license.payload }
}

export function readPublicKey(path) {
  const fromEnv = process.env.THREE_STUDIO_LICENSE_PUBLIC_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return readFileSync(path, 'utf8')
}

export function licenseSummary(payload) {
  return {
    active: true,
    edition: payload.edition,
    id: payload.id,
    customer: payload.customer,
    seats: payload.seats,
    features: [...payload.features],
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    perpetual: payload.expiresAt === null,
  }
}
