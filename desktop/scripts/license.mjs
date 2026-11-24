#!/usr/bin/env node
/**
 * Issue and verify offline Three Studio Pro licenses.
 *
 *   node scripts/license.mjs keygen --out ../release-keys
 *   node scripts/license.mjs issue --key ../release-keys/private-key.pem \
 *     --customer "Acme Studio" --email "billing@example.com" --days 365 \
 *     --out /tmp/acme.tslicense
 *   node scripts/license.mjs verify --public ../license/public-key.pem \
 *     --license /tmp/acme.tslicense
 *
 * The private key never belongs in the repository or the app bundle.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import {
  createLicensePayload,
  parseLicenseText,
  signLicense,
  verifyLicense,
} from '../license/core.mjs'

const args = process.argv.slice(2)
const command = args[0]
const option = name => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null
}
const flag = name => args.includes(`--${name}`)
const features = () => (option('features') || 'desktop-pro,templates,updates')
  .split(',').map(value => value.trim()).filter(Boolean)

const usage = `Usage:
  node scripts/license.mjs keygen --out DIR [--force]
  node scripts/license.mjs issue --key PRIVATE_KEY.pem --customer NAME [--email ADDR]
      [--seats N] [--days N | --perpetual] [--features a,b] [--id ID] [--out FILE]
  node scripts/license.mjs verify --public PUBLIC_KEY.pem --license FILE
  node scripts/license.mjs inspect --license FILE

The private key must stay outside the repository. The public key is bundled in
desktop/license/public-key.pem.`

if (!command || command === '--help' || command === '-h') {
  console.log(usage)
  process.exit(command === undefined ? 1 : 0)
}

const keyFrom = async () => {
  const direct = process.env.THREE_STUDIO_LICENSE_PRIVATE_KEY
  if (typeof direct === 'string' && direct.includes('BEGIN PRIVATE KEY')) return direct
  const path = option('key') || direct
  if (typeof path !== 'string' || path === '') throw new Error('--key is required')
  return readFile(resolve(path), 'utf8')
}

try {
  if (command === 'keygen') {
    const out = resolve(option('out') || '')
    if (!option('out')) throw new Error('--out is required')
    await mkdir(out, { recursive: true, mode: 0o700 })
    const privatePath = join(out, 'private-key.pem')
    const publicPath = join(out, 'public-key.pem')
    if (!flag('force')) {
      for (const path of [privatePath, publicPath]) {
        try {
          await readFile(path)
          throw new Error(`refusing to overwrite ${path}; pass --force`)
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    await writeFile(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    await writeFile(publicPath, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 })
    console.log(JSON.stringify({ ok: true, privateKey: privatePath, publicKey: publicPath }, null, 2))
  } else if (command === 'issue') {
    const customer = option('customer')
    if (typeof customer !== 'string' || customer.trim() === '') throw new Error('--customer is required')
    const now = Date.now()
    const perpetual = flag('perpetual')
    const days = Number(option('days') || (perpetual ? 0 : 365))
    if (!perpetual && (!Number.isFinite(days) || days <= 0)) throw new Error('--days must be positive')
    const payload = createLicensePayload({
      id: option('id') || `lic_${randomBytes(9).toString('base64url')}`,
      customer: customer.trim(),
      email: option('email') || undefined,
      issuedAt: now,
      expiresAt: perpetual ? null : now + Math.round(days * 86400000),
      seats: Number(option('seats') || 1),
      features: features(),
    })
    const signed = signLicense(payload, await keyFrom())
    const out = resolve(option('out') || 'license.tslicense')
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, JSON.stringify(signed, null, 2), { mode: 0o600 })
    console.log(JSON.stringify({
      ok: true,
      out,
      id: payload.id,
      customer: payload.customer,
      seats: payload.seats,
      expiresAt: payload.expiresAt,
      features: payload.features,
    }, null, 2))
  } else if (command === 'verify' || command === 'inspect') {
    const licensePath = option('license')
    if (!licensePath) throw new Error('--license is required')
    const parsed = parseLicenseText(await readFile(resolve(licensePath), 'utf8'))
    if (!parsed.ok) throw new Error(`${parsed.reason}: ${parsed.message}`)
    if (command === 'inspect') {
      console.log(JSON.stringify({ ok: true, payload: parsed.license.payload }, null, 2))
      process.exit(0)
    }
    const publicPath = option('public')
    if (!publicPath) throw new Error('--public is required')
    const result = verifyLicense(parsed.license, await readFile(resolve(publicPath), 'utf8'))
    console.log(JSON.stringify(result.ok
      ? { ok: true, license: result.payload }
      : { ok: false, reason: result.reason, message: result.message }, null, 2))
    if (!result.ok) process.exitCode = 1
  } else {
    console.error(`Unknown command: ${command}\n\n${usage}`)
    process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
