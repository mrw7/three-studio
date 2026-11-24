# Three Studio Pro licenses

Pro licenses are **offline, signed JSON documents** (`*.tslicense`). The desktop
app verifies the signature with the public key bundled at
`desktop/license/public-key.pem`; there is no activation server.

This is an entitlement receipt, not DRM. The local editor is Apache-2.0 and
stays fully functional without a license. The Pro license unlocks the PRO badge,
the template pack, support/update entitlements and future paid conveniences.

## Key management

The private signing key must **never** be committed or shipped. Keep it offline
and backed up. Generate a production keypair once:

```sh
cd desktop
node scripts/license.mjs keygen --out ~/.three-studio-release
cp ~/.three-studio-release/public-key.pem license/public-key.pem
```

`license/public-key.pem` is the only key committed. Replace it and rebuild the
desktop app if you rotate keys. Existing licenses signed with the old key stop
verifying after rotation.

## Issue a license

```sh
cd desktop
node scripts/license.mjs issue \
  --key ~/.three-studio-release/private-key.pem \
  --customer "Acme Studio" \
  --email "billing@example.com" \
  --seats 3 \
  --days 365 \
  --out /tmp/acme.tslicense
```

- `--perpetual` instead of `--days` for a lifetime license
- `--features desktop-pro,templates,updates` (default)
- `--seats` is informational/honor-based in this version; no machine binding

Send the resulting `.tslicense` to the customer. In the app:
**Help → Activate Three Studio Pro…** and select the file. The file is copied to
`<userData>/data/license.tslicense` with mode `0600`.

## Verify

```sh
cd desktop
node scripts/license.mjs verify \
  --public license/public-key.pem \
  --license /tmp/acme.tslicense
```

The app verifies:
- Ed25519 signature over a canonical JSON payload
- product/edition
- issue/expiry timestamps
- required `desktop-pro`/`templates` features

## Fulfillment flow (first version)

1. Customer pays via Lemon Squeezy/Paddle/Stripe (or an invoice for services).
2. You run `license.mjs issue` with the order's customer/seats.
3. Email the `.tslicense` file.
4. For 10+ seats or enterprise, issue manually and add support/SLA in the
   contract.

Later this can be automated with a payment webhook that calls the same
`createLicensePayload` + `signLicense` functions. Keep the private key in a
secret manager, never in the webhook repository.

## Limitations

- No machine binding/activation server in v1; a license file can be shared.
  Add optional machine binding only if support abuse becomes a real problem.
- No revocation list; short expirations or support contracts are the mitigation.
- The Apache-2.0 core can be rebuilt by anyone; the paid value is the signed
  build, template pack, updates, support and team/enterprise services.
