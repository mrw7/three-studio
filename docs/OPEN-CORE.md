# Open-core boundary

Three Studio uses an open-core model: the local workbench in this repository
is licensed under **Apache-2.0**, while paid services, release secrets and
private business assets live outside it. This document is the source of truth
for what belongs in the public tree.

## Public in this repository (Apache-2.0)

| Area | Paths |
| --- | --- |
| Studio UI and scene engine | `client.js`, `index.js` |
| Standalone server and agent loop | `standalone/**` |
| Vendored Three.js and export helpers | `runtime/**` (MIT; see `THIRD_PARTY_NOTICES.md`) |
| Desktop shell and license verification | `desktop/main.mjs`, `desktop/preload.cjs`, `desktop/license/core.mjs`, `desktop/scripts/**`, `desktop/build/**`, `desktop/license/public-key.pem` |
| Template-pack contract | `desktop/templates/manifest.json` (empty free pack), `desktop/templates/README.md` |
| Sales demos | `site/**` |
| Manual and film | `client.js` presentation/manual/film UI, `index.js` manual proposal + share `/presentation`, 1080p deterministic export |
| Tests and examples | `tests/**`, `examples/**` |
| Public documentation | `README.md`, `README.zh.md`, `docs/**` (except internal notes) |
| Governance | `LICENSE`, `NOTICE`, `CONTRIBUTING.md`, `DCO`, `SECURITY.md`, `GOVERNANCE.md`, `TRADEMARK.md`, `PRIVACY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `ROADMAP.md` |

The Apache-2.0 core includes the complete local manual/film loop: the
presentation schema, manual step authoring with BOM/hotspots, BOM CSV
import/export, ordered film shots with camera keys/SRT/local music, AI manual
proposals (reviewed/applied locally), the share viewer's manual sidebar with
print-to-PDF/QR and projected hotspot leader lines, and
1080p/16:9/9:16/1:1/4:5 deterministic or sequential four-aspect export.

### Manual and film boundary

**Public in the Apache-2.0 core:**

- All local Manual/Film editing.
- Ordered film shots with eased start→end camera keys and hard cuts.
- SRT captions and sidecar export.
- Local music attachment, preview, and Opus muxing, with a video-only fallback when the browser cannot encode audio.
- Manual BOM and step hotspots, with BOM CSV import/export.
- The share viewer (manual sidebar, BOM/hotspot lists, projected leader lines,
  print-to-PDF, QR).
- 1080p/16:9/9:16/1:1/4:5 deterministic export and sequential local batch
  export of the four aspects.
- A local-only event log: coarse action counters in browser storage, no
  network calls, no telemetry and no hosted dashboards.
- AI manual proposals, applied only after local review.

**Pro/private services (must stay outside this repository):**

- Hosted publishing, comments/review, approvals, team workspaces, SSO, audit logs.
- Hosted analytics and dashboards (the open core only keeps a local event log).
- Translation workflow.
- Stock music/SFX libraries and managed TTS.
- 4K/ProRes.
- Cloud/parallel rendering queues and batch rendering.
- Brand kits and premium templates.

Do not require these services for local editing, viewing or basic 1080p
export. Do not add private imports, license checks or hosted endpoints to the
public core.

The Ed25519 **public** key is intentionally public: it is what the app uses to
verify offline licenses. Publishing it does not let anyone issue licenses.

## Private — never commit, bundle or log

### Secrets and release material

- `~/.three-studio-release/private-key.pem` (license signing key) and any
  issued `*.tslicense` files.
- Code-signing certificates (`CSC_LINK`), `CSC_KEY_PASSWORD`,
  `APPLE_APP_SPECIFIC_PASSWORD`, Apple ID and Team ID.
- Model provider API keys, GitHub/Cloudflare/payment/email tokens, MCP
  environment values, `credentials.json`.
- License-issuance records, order/customer databases, payment webhooks,
  invoices and refunds.

### User and customer data

- `~/.three-studio/**`: `credentials.json` (mode `0600`), `models.json`,
  `search.json`, `mcp.json`, sessions, scenes, revision history, assets, share
  links, plugins, skills and context files.
- Electron's `userData` directory and any exported customer scenes or assets.
- Lead lists, quotes, contracts, support tickets and analytics exports.

### Third-party material without redistribution rights

- Reference clones and audit artifacts under `.preview-tmp/**`.
- `node_modules/`, `desktop/vendor/`, `desktop/dist/`, `desktop/out/`.
- Any model, texture, font, plugin or SDK whose license does not allow
  redistribution.
- Internal notes: `AUDIT.md`, `TODO.md`, `docs/BATCH-*.md`, `docs/P*-*.md`,
  `docs/DESIGN-*.md`, `docs/DECISIONS.md` (already gitignored).

## Private business code and assets

These may be built on top of the open core, but live in separate private
repositories or services:

- Hosted share viewer, comments/review, team workspaces, permissions,
  SSO/SAML, audit logs, billing, usage metering, admin console.
- Model gateway, managed AI credits and rate limiting.
- Marketplace review, payouts and any signed registry that executes
  third-party code.
- Payment checkout and license-fulfillment webhooks.
- Premium template packs and paid asset packs. The current Pro pack lives in a
  separate private `../three-studio-private/pro-templates` directory and is
  assembled only at build time.
- Pricing experiments, outreach scripts, customer lists and unreleased
  security reports.

## Build-time template split

The public repository ships the pack format, not the paid scenes:

```text
desktop/templates/
  manifest.json      # free pack, empty in this repository
  README.md          # contract and build instructions
  pro/               # gitignored; created by the assembler
```

From `desktop/`:

```sh
THREE_STUDIO_PRO_TEMPLATES=/path/to/three-studio-private/pro-templates npm run templates
npm run release-check
npm run dist
```

`scripts/assemble-templates.mjs` validates the manifest (`v: 1`, ids, titles,
flat `.js` filenames), rejects directories, `..` traversal and symlinks, and
atomically replaces `templates/pro/`. `predist` runs it automatically. A missing
pack is skipped for open-source builds; set
`THREE_STUDIO_REQUIRE_PRO_TEMPLATES=1` to fail instead. The assembler removes a
stale `templates/pro/` when the source is absent, so an open-source build cannot
silently bundle an old Pro pack.

## Rules

1. The local core stays fully functional without a license. The Pro receipt
   unlocks the badge, the private template pack and support/update
   entitlements — it is not DRM and there is no paywall in the editor.
2. Private code goes into separate repositories or services. Do not merge it
   into this repository, and do not add private imports to the public core.
3. Only the public key is distributed. The private signing key stays offline
   and is never committed, bundled, logged or pasted into CI.
4. Keep third-party licenses and notices intact; update
   `THIRD_PARTY_NOTICES.md` when vendoring anything new.
5. The Apache-2.0 license covers code, not the project name or logo. Forks must
   follow `TRADEMARK.md`.
6. Contributions are accepted under DCO into the Apache-2.0 core. External
   contributions do not become proprietary.
7. User data stays on the user's machine. Never commit a Studio home, a
   customer scene or a license file.

## What this means for reuse

Apache-2.0 lets anyone run, modify, redistribute and even host the core
commercially, provided they keep the license and notices. The project's moat is
the maintained release channel, signed builds, updates, support, the Pro
template pack, private services and the trademark — not code secrecy. That
trade is deliberate: openness buys distribution and trust; the paid layer sells
convenience, responsibility and ongoing delivery.
