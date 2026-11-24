import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import {
  canonicalJson,
  createLicensePayload,
  parseLicenseText,
  signLicense,
  verifyLicense,
} from '../desktop/license/core.mjs'

const keys = generateKeyPairSync('ed25519')
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' })

const makeLicense = (overrides = {}) => signLicense(createLicensePayload({
  id: 'lic_test_0001',
  customer: 'Test Studio',
  email: 'test@example.com',
  issuedAt: 1_700_000_000_000,
  expiresAt: 4_000_000_000_000,
  seats: 3,
  features: ['desktop-pro', 'templates'],
  ...overrides,
}), privateKey)

test('canonical JSON is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }),
    '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}')
})

test('a signed Pro license verifies and reports its payload', () => {
  const license = makeLicense()
  const result = verifyLicense(license, publicKey, {
    now: 1_800_000_000_000,
    requiredFeatures: ['desktop-pro'],
  })
  assert.equal(result.ok, true)
  assert.equal(result.payload.customer, 'Test Studio')
  assert.equal(result.payload.seats, 3)

  const parsed = parseLicenseText(JSON.stringify(license))
  assert.equal(parsed.ok, true)
  assert.equal(verifyLicense(parsed.license, publicKey, { now: 1_800_000_000_000 }).ok, true)
})

test('tampering, expiry, future issue and missing features are rejected', () => {
  const license = makeLicense()
  const tampered = structuredClone(license)
  tampered.payload.seats = 99
  assert.equal(verifyLicense(tampered, publicKey, { now: 1_800_000_000_000 }).reason, 'signature')

  assert.equal(verifyLicense(license, publicKey, { now: 4_000_000_000_001 }).reason, 'expired')
  assert.equal(verifyLicense(license, publicKey, { now: 1 }).reason, 'not-yet-valid')
  assert.equal(verifyLicense(license, publicKey, {
    now: 1_800_000_000_000, requiredFeatures: ['missing'],
  }).reason, 'feature')

  const parsed = parseLicenseText('{"payload":{}}')
  assert.equal(parsed.ok, false)
  assert.equal(parseLicenseText('not json').reason, 'json')
})

test('perpetual licenses have no expiry and wrong signatures fail', () => {
  const perpetual = makeLicense({ id: 'lic_perpetual', expiresAt: null })
  assert.equal(verifyLicense(perpetual, publicKey, { now: 9_000_000_000_000 }).ok, true)

  const other = generateKeyPairSync('ed25519')
  const otherPublic = other.publicKey.export({ type: 'spki', format: 'pem' })
  assert.equal(verifyLicense(perpetual, otherPublic, { now: 1_800_000_000_000 }).reason, 'signature')
})
